/**
 * Pure tool handler: session scope → input shape → manifest gate →
 * authenticated capabilities → bridge POST. No DSH imports, no prompts, no
 * autosubmit, no forged state. The only state-changing request is the final
 * POST; the capabilities GET is read-only.
 */

import { checkActionCapability, parseCappiInput, parseCharacterManifest, type CharacterManifest } from './cappi-actions.ts'
import { fetchCapabilities, resolveActionCapability } from './capabilities.ts'
import { postWatchAction, readBridgeToken, type BridgeFetch } from './bridge-client.ts'
import { checkBridgeUrl, type ResolvedWatchConfig } from './config.ts'
import { checkWatchSessionScope } from './session-scope.ts'

export type CappiToolResult =
  | { readonly ok: true; readonly action: string | null }
  | { readonly ok: false; readonly error: string }

export interface CappiHandlerDeps {
  readonly readManifestFile?: (path: string) => Promise<string>
  readonly fetchImpl?: BridgeFetch
}

/**
 * Run one `cappi_action` call. Every failure is a `{ ok: false, error }`
 * result — the handler never throws for expected rejections, so the model
 * always receives a usable tool result.
 *
 * `callerSessionId` must be the calling agent's session id
 * (`exec.agent.id` verbatim — see session-scope.ts for the SDK proof). It is
 * passed through to the bridge UNCHANGED for the atomic watched-session
 * match; the plugin never invents, maps, or defaults it.
 */
export async function handleCappiAction(
  callerSessionId: string | undefined,
  args: unknown,
  config: ResolvedWatchConfig,
  deps: CappiHandlerDeps = {},
): Promise<CappiToolResult> {
  const scope = checkWatchSessionScope(callerSessionId, config.watchSessionId)
  if (!scope.ok) return scope
  const parsed = parseCappiInput(args)
  if (!parsed.ok) return parsed
  const manifest = await loadManifest(config, deps.readManifestFile)
  if (!manifest.ok) return manifest
  if (manifest.manifest) {
    const gate = checkActionCapability(parsed.action, manifest.manifest)
    if (!gate.ok) return gate
  }
  const capabilities = await fetchCapabilities(config, deps.fetchImpl)
  if (!capabilities.ok) return capabilities
  const resolved = resolveActionCapability(parsed.action, capabilities.capabilities)
  if (!resolved.ok) return resolved
  return postWatchAction(config, resolved.action, callerSessionId as string, deps.fetchImpl)
}

async function loadManifest(
  config: ResolvedWatchConfig,
  readFile: ((path: string) => Promise<string>) | undefined,
): Promise<{ ok: true; manifest: CharacterManifest | undefined } | { ok: false; error: string }> {
  if (!config.manifestPath) return { ok: true, manifest: undefined }
  if (!readFile) return { ok: false, error: 'character manifest reader is unavailable' }
  let text: string
  try {
    text = await readFile(config.manifestPath)
  } catch {
    return { ok: false, error: `character manifest is unreadable: ${config.manifestPath}` }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, error: 'character manifest is not valid JSON' }
  }
  const parsed = parseCharacterManifest(value)
  if (!parsed.ok) return parsed
  return { ok: true, manifest: parsed.manifest }
}

/** Preflight for operator diagnostics: URL (+pin) and token presence, no network. */
export async function checkBridgeLink(config: ResolvedWatchConfig): Promise<CappiToolResult> {
  const checked = checkBridgeUrl(config.bridgeBaseUrl, config.allowInsecureLan, config.bridgeCertPin)
  if (!checked.ok) return { ok: false, error: checked.error }
  const token = await readBridgeToken(config).catch(() => undefined)
  if (!token) return { ok: false, error: 'bridge token is not configured' }
  return { ok: true, action: null }
}
