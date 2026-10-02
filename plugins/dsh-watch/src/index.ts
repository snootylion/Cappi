/**
 * DSH host plugin: turnkey watch link (H-owned, in-process default).
 *
 * Default `bridgeMode: 'managed'` (or omitted): self-contained in-process
 * Cappi plugin — managed ephemeral HTTPS server + pairing service +
 * per-device token store + session-binding resolver + Cappi tools. Activates
 * fully with `config {}` when the V `liveVoiceWatch` service is present; no
 * `watchSessionId`/token/env required, and Cappi tools never prompt.
 *
 * Advanced `bridgeMode: 'legacy'`: explicit out-of-process bridge via
 * `bridgeBaseUrl` + token + pin (the pre-turnkey shape). Maintained for
 * fixtures/tests; NOT the default.
 *
 * Host services (exact contract §9.1):
 * `inject = ['tools','sessionController','workspaceController','webServer',
 * 'connection','liveVoiceWatch','permissionPresets']`. Every touched service is injected
 * (DI-before-apply). V owns `provide('liveVoiceWatch', …)`; H only consumes.
 *
 * Lifecycle: exactly ONE runtime per profile, `ctx.effect`-disposed.
 * Startup failure fails loud (no quiet plaintext LAN). Hot reload disposes
 * before re-apply (no port leaks). UDP discovery handles profile collision
 * explicitly (first free port in 8788..8797 + admin flag; exhaustion fails).
 *
 * Auth split (§1.6): DSH-admin routes call
 * `ctx.connection.requestRejection({ headers })` and honor 401/403; watch
 * LAN routes use pinned TLS + per-device `X-Bridge-Token` and NEVER the DSH
 * browser cookie. This plugin never reads `~/.dsh/.credentials.yaml` and
 * never mints browser-session cookies.
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_ACTION_IDS } from './cappi-actions.ts';
import { resolveWatchConfig, type WatchPluginConfig } from './config.ts';
import { handleCappiAction, type CappiToolResult } from './handler.ts';
import { loadOrCreateIdentity } from './cert.ts';
import { TurnkeyStore } from './pairing-store.ts';
import { ManagedTurnkeyRuntime } from './managed-runtime.ts';
import { asHostSessionPort } from './host-adapter.ts';
import { createAdminHandlers } from './admin-routes.ts';

export const name = 'watch';
export const inject = [
  'tools',
  'sessionController',
  'workspaceController',
  'webServer',
  'connection',
  'liveVoiceWatch',
  'permissionPresets',
];

export const CAPPI_TOOL_DESCRIPTION =
  "Show a character animation on the user's paired Wear OS watch (avatar mode). " +
  'Use sparingly: celebrations on real completions, work while doing longer tasks, talk while explaining. ' +
  'Acts only in the watch-linked session; other sessions receive a not-the-watch-session refusal. ' +
  'Callable actions come from the active watch character (GET /watch/capabilities); legacy ids map automatically. ' +
  'Never claim a pending question via this tool — pending items are surfaced by the harness, not faked.';

export const Config = z.object({
  bridgeMode: z.string(),
  dshHome: z.string(),
  serverDisplayName: z.string(),
  discoveryPort: z.number().min(1).max(65535).step(1),
  bridgeBaseUrl: z.string(),
  bridgeToken: z.string(),
  bridgeTokenPath: z.string(),
  bridgeCertPin: z.string(),
  watchSessionId: z.string(),
  manifestPath: z.string(),
  allowInsecureLan: z.boolean(),
  timeoutMs: z.number().min(1_000).max(30_000).step(1),
});

export interface TurnkeyPluginConfig extends WatchPluginConfig {
  bridgeMode?: 'managed' | 'legacy' | undefined;
  dshHome?: string | undefined;
  serverDisplayName?: string | undefined;
  discoveryPort?: number | undefined;
}

const TOOL_PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    description: `Character action id (${MODEL_ACTION_IDS.join(', ')}) or "clear" to resume the auto schedule.`,
  },
} as const;

/** Cordis include's public ctx.baseUrl is anchored at the actual profile
 * root by the vanilla boot path; no invented environment profile identity. */
export function profileStateRoot(ctx: Context): string {
  const baseUrl = (ctx as unknown as { baseUrl?: string }).baseUrl;
  if (typeof baseUrl === 'string' && baseUrl.startsWith('file:')) return fileURLToPath(new URL('.', baseUrl));
  // Standalone tools-only fixtures never start managed state. A real managed
  // deployment without profile metadata must select an explicit private root.
  throw new Error('Managed watch requires the Cordis profile baseUrl or explicit dshHome configuration');
}

/**
 * LAN host candidates for the Mac pairing wizard (admin-ONLY trusted
 * response): loopback first, then every actual non-loopback IPv4 from
 * `os.networkInterfaces()`, deduped. No placeholder addresses, no stored
 * values, no home-directory paths — purely runtime-derived. Falls back to
 * loopback-only when enumeration fails (never throws at apply time).
 */
export function lanHostCandidates(): string[] {
  const out = ['127.0.0.1'];
  try {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family !== 'IPv4' || addr.internal) continue;
        const ip = addr.address.trim();
        if (!ip || out.includes(ip)) continue;
        out.push(ip);
      }
    }
  } catch { /* loopback-only fallback */ }
  return out;
}

/**
 * AU-wired voice-setup entry: the admin `POST /admin/voice/setup` route calls
 * this AFTER verifying the explicit `{ consent: true }` body, and it calls
 * the ACTUAL V service `setup({ consent: true })` — consent is never
 * defaulted here (the callback takes no arguments at all). Absent service →
 * honest `error` status with an actionable message (the route answers 503).
 */
export function makeBackendSetup(
  svc: import('./watch-api.ts').LiveVoiceWatchService | undefined,
): () => Promise<{ status: string; message?: string | undefined }> {
  return async () => {
    if (!svc) return { status: 'error', message: 'voice backend not installed (liveVoiceWatch unavailable)' };
    try {
      const s = await svc.setup({ consent: true });
      return { status: s.status };
    } catch (e) {
      return { status: 'error', message: (e as Error).message ?? 'voice setup failed' };
    }
  };
}

/**
 * Adapt the host logger (Cordis `Logger`: error/info/warn/debug, NO `.log`)
 * to the runtime's minimal `{ log, error }` shape. Never throws; missing
 * methods degrade to no-ops so logging can never take the runtime down.
 */
function toRuntimeLogger(raw: unknown): Pick<Console, 'log' | 'error'> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const pick = (...names: string[]): ((...args: unknown[]) => void) => {
    for (const name of names) {
      if (typeof r[name] === 'function') {
        const fn = r[name] as (...args: unknown[]) => void;
        return (...args: unknown[]): void => {
          try {
            fn(...args);
          } catch { /* logging never fails the runtime */ }
        };
      }
    }
    return (): void => {};
  };
  return { log: pick('log', 'info', 'debug'), error: pick('error', 'warn') };
}

function resolveMode(raw: TurnkeyPluginConfig): 'managed' | 'legacy' {
  const v = String(raw.bridgeMode ?? '').trim().toLowerCase();
  if (v === 'legacy') return 'legacy';
  return 'managed';
}

function makeLegacyExecute(resolved: ReturnType<typeof resolveWatchConfig>) {
  return async (_args: { readonly action: string }, exec: ToolRunContext): Promise<CappiToolResult> => {
    const caller = exec.agent?.id === undefined ? undefined : String(exec.agent.id);
    return handleCappiAction(caller, _args, resolved);
  };
}

function makeManagedExecute(
  runtime: ManagedTurnkeyRuntime,
  staticSessionId: string,
  logger: Pick<Console, 'log' | 'error'> | undefined,
) {
  return async (_args: { readonly action: string }, exec: ToolRunContext): Promise<CappiToolResult> => {
    const caller = exec.agent?.id === undefined ? undefined : String(exec.agent.id);
    const action = parseAction(_args);
    if (!action.ok) return action;
    // Static override (optional): fail-closed when both absent; log on disagreement.
    const devices = runtime.store.listDevicesPublic().filter((d) => !d.revoked);
    if (devices.length === 0 && !staticSessionId) {
      return { ok: false, error: 'watch is not paired yet: approve a device in DSH Settings → Pairing first' };
    }
    const deviceId = devices.sort((a, b) => b.issuedAtMs - a.issuedAtMs)[0]?.deviceId ?? '';
    if (!deviceId && staticSessionId) {
      // No device yet but a static override exists (legacy wiring): keep the
      // legacy scope check so fixtures stay honest.
      if (!caller || caller !== staticSessionId) return { ok: false, error: 'not the watch session' };
      return { ok: false, error: 'watch is not paired yet: approve a device in DSH Settings → Pairing first' };
    }
    if (staticSessionId) {
      const bound = await runtime.watchedSessionFor(deviceId).catch(() => null);
      if (bound?.watchedSessionId && bound.watchedSessionId !== staticSessionId) {
        logger?.log?.(`[turnkey] static watchSessionId disagrees with device binding (${deviceId}); using binding`);
      }
      if (!caller || caller !== staticSessionId) return { ok: false, error: 'not the watch session' };
      // Static present: still enforce the device binding atomically for the
      // target device (no cross-device actuation).
      return runtime.toolActionFor(deviceId, caller, action.action);
    }
    if (!caller) return { ok: false, error: 'not the watch session' };
    return runtime.toolActionFor(deviceId, caller, action.action);
  };
}

function parseAction(args: unknown): { ok: true; action: string | null } | { ok: false; error: string } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'bad body' };
  if (!Object.hasOwn(args, 'action')) return { ok: false, error: 'missing action' };
  const action = (args as Record<string, unknown>).action;
  if (action === null || action === 'clear') return { ok: true, action: null };
  if (typeof action !== 'string' || action.length === 0) return { ok: false, error: 'bad action' };
  return { ok: true, action };
}

export async function apply(ctx: Context, config: TurnkeyPluginConfig): Promise<void> {
  const raw = (config ?? {}) as TurnkeyPluginConfig;
  const mode = resolveMode(raw);
  const resolved = resolveWatchConfig(raw);
  const output = {
    schema: { type: 'object', additionalProperties: true } as const,
    render: (): [] => [],
  };

  // Legacy advanced path (explicit out-of-process bridge). Kept honest for
  // fixtures/tests; never the default. Works with a tools-only host.
  const hasHostServer = (ctx as unknown as { webServer?: { register?: unknown } }).webServer
    && typeof (ctx as unknown as { webServer: { register?: unknown } }).webServer.register === 'function';
  if (mode === 'legacy' || !hasHostServer) {
    const execute = makeLegacyExecute(resolved);
    (ctx as unknown as { tools: { register: (d: unknown) => () => void } }).tools.register(defineTool({
      name: 'cappi_action',
      description: CAPPI_TOOL_DESCRIPTION,
      parameters: TOOL_PARAMETERS,
      output,
      timeoutMs: resolved.timeoutMs,
      execute: execute as never,
    }));
    (ctx as unknown as { tools: { register: (d: unknown) => () => void } }).tools.register(defineTool({
      name: 'watch_cappi',
      description: `${CAPPI_TOOL_DESCRIPTION} (Alias of cappi_action.)`,
      parameters: TOOL_PARAMETERS,
      output,
      timeoutMs: resolved.timeoutMs,
      execute: execute as never,
    }));
    return;
  }

  // Managed default: full in-process runtime.
  const c = ctx as unknown as {
    tools: { register: (d: unknown) => () => void };
    webServer: { register: (r: { kind: string; path: string; handler: (req: never, res: never) => void }) => () => void };
    permissionPresets?: import('./managed-runtime.ts').RuntimeOptions['permissionPresets'];
    sessionController?: unknown;
    workspaceController?: unknown;
    connection: { requestRejection: (r: { headers: Record<string, string | string[] | undefined> }) => 401 | 403 | undefined };
    liveVoiceWatch?: import('./watch-api.ts').LiveVoiceWatchService | undefined;
    effect: (setup: () => () => void | Promise<void>, label?: string) => () => void;
    logger?: Pick<Console, 'log' | 'error'> | undefined;
  };
  if (typeof ctx.effect !== 'function') throw new Error('Managed watch requires Cordis lifecycle effects');
  const dshHome = String(raw.dshHome ?? '').trim() || profileStateRoot(ctx);
  const logger = toRuntimeLogger(c.logger);
  // Early effect ownership: registered BEFORE any async start so a profile
  // dispose racing initialization still unwinds ports/handlers/tools (a
  // dispose-while-initializing window otherwise leaks listeners). The same
  // release path also unwinds partial registration when startup throws.
  const owned: {
    runtime: ManagedTurnkeyRuntime | null;
    disposers: Array<() => void>;
    tools: Array<() => void>;
  } = { runtime: null, disposers: [], tools: [] };
  let disposed = false;
  const releaseOwned = async (): Promise<void> => {
    disposed = true;
    for (const disposeTool of owned.tools) {
      try {
        disposeTool();
      } catch { /* disposed */ }
    }
    owned.tools.length = 0;
    for (const dispose of owned.disposers) {
      try {
        dispose();
      } catch { /* disposed */ }
    }
    owned.disposers.length = 0;
    const rt = owned.runtime;
    owned.runtime = null;
    if (rt) {
      try {
        await rt.dispose();
      } catch { /* teardown is best-effort */ }
    }
  };
  c.effect(() => async () => {
    await releaseOwned();
  }, 'dsh-watch: managed turnkey runtime and admin routes');

  let runtime: ManagedTurnkeyRuntime;
  try {
    const identity = await loadOrCreateIdentity(dshHome);
    if (disposed) throw new Error('watch disposed during initialization');
    const store = new TurnkeyStore(dshHome);
    // Checked narrow of the injected host controller (never `as never`):
    // a partial/mock controller yields undefined and the runtime uses its
    // honest local-queue fallback for the prompt leg.
    const sessionPort = asHostSessionPort(c.sessionController);
    if (c.sessionController && !sessionPort) {
      logger?.log?.('[turnkey] injected sessionController is incomplete; host commands are unavailable');
    }
    runtime = new ManagedTurnkeyRuntime({
      dshHome,
      identity,
      store,
      ...(String(raw.serverDisplayName ?? '').trim() ? { serverDisplayName: String(raw.serverDisplayName).trim() } : {}),
      ...(sessionPort ? { sessionController: sessionPort } : {}),
      workspaceController: c.workspaceController,
      permissionPresets: c.permissionPresets,
      liveVoiceWatch: c.liveVoiceWatch,
      logger,
      ...(typeof raw.discoveryPort === 'number' ? { discoveryPort: raw.discoveryPort } : {}),
    });
    owned.runtime = runtime;
    await runtime.start();
    if (disposed) throw new Error('watch disposed during initialization');
  } catch (error) {
    // Startup failure fails loud (never quiet plaintext) and unwinds
    // anything registered so far — apply() itself rejects (no floating
    // profile-activation promise), so the host surfaces the failure.
    logger?.error?.(`[turnkey] managed runtime failed to start: ${(error as Error).message ?? error}`);
    await releaseOwned();
    throw error;
  }

  try {
  const adminHandlers = createAdminHandlers(
    {
      store: runtime.store,
      identity: runtime.identity,
      runtime,
      backendStatus: async (): Promise<{ status: string; message?: string | undefined }> => {
        const svc = c.liveVoiceWatch;
        if (!svc) return { status: 'error', message: 'voice backend not installed (liveVoiceWatch unavailable)' };
        try {
          const s = await svc.status();
          return { status: s.status, ...(s.message ? { message: s.message } : {}) };
        } catch (e) {
          return { status: 'error', message: (e as Error).message ?? 'backend status failed' };
        }
      },
      // AU-wired: the admin voice/setup route calls the ACTUAL V service
      // setup with explicit consent (never defaulted — the callback takes no
      // arguments; the route already required `{ consent: true }`).
      backendSetup: makeBackendSetup(c.liveVoiceWatch),
      hostCandidates: lanHostCandidates,
    },
    (r) => c.connection.requestRejection(r),
  );
  for (const [p, handler] of Object.entries(adminHandlers)) {
    owned.disposers.push(c.webServer.register({ kind: 'exact', path: p, handler }));
  }

  const execute = makeManagedExecute(runtime, resolved.watchSessionId, logger);
  const d1 = c.tools.register(defineTool({
    name: 'cappi_action',
    description: CAPPI_TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output,
    timeoutMs: resolved.timeoutMs,
    execute: execute as never,
  }));
  owned.tools.push(d1);
  const d2 = c.tools.register(defineTool({
    name: 'watch_cappi',
    description: `${CAPPI_TOOL_DESCRIPTION} (Alias of cappi_action.)`,
    parameters: TOOL_PARAMETERS,
    output,
    timeoutMs: resolved.timeoutMs,
    execute: execute as never,
  }));
  owned.tools.push(d2);
  owned.disposers.push(ctx.on('approval/request', (req, next) => runtime.answerApprovalCallback(req, next), { prepend: true }));
  owned.disposers.push(ctx.on('user-questions/request', (req, next) => runtime.answerQuestionCallback(req, next), { prepend: true }));
  // Startup line carries ports + pin prefix only (keys: no tokens, no
  // secrets, no session ids, no credentials).
  logger?.log?.(`[turnkey] managed HTTPS :${runtime.port} (discovery :${runtime.discoveryPortActual}${runtime.discoveryCollision ? ' collision-fallback' : ''}) pin ${runtime.identity.pin.slice(0, 13)}…`);
  } catch (error) { await releaseOwned(); throw error; }
}

export { MODEL_ACTION_IDS, CAPPI_ALLOWLIST } from './cappi-actions.ts';
export { resolveWatchConfig, type ResolvedWatchConfig, type WatchPluginConfig } from './config.ts';
export { handleCappiAction, type CappiToolResult } from './handler.ts';
export type { LiveVoiceWatchService } from './watch-api.ts';
export {
  HostSessionHost,
  asHostSessionPort,
  checkSessionBinding,
  textPromptRequest,
  toSessionId,
  withTimeoutSignal,
  type HostSessionPort,
} from './host-adapter.ts';
