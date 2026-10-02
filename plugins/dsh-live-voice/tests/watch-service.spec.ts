import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLiveVoiceWatchService, WATCH_PCM } from '../src/watch-service.ts';
import { readWatchConsent, writeWatchConsent } from '../src/watch-consent.ts';
import type { LiveVoiceInputEvent, SpawnHelperFn, WatchHelperChild } from '../src/watch-api.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const nativeRoots: string[] = [];
afterEach(() => { for (const root of nativeRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (!Object.prototype.hasOwnProperty.call(extra, key) && (/^DSH_/u.test(key) || /^BRIDGE_/u.test(key))) delete env[key];
  }
  return { ...env, ...extra } as Record<string, string>;
}

/** Synthetic PCM fixture: s16le mono @16kHz sine (no recordings, no mic). */
function sinePCM(seconds: number, freq = 440, amplitude = 0.3): Uint8Array {
  const n = Math.floor(16000 * seconds);
  const out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / 16000) * amplitude * 32767);
    const s = v < 0 ? v + 0x10000 : v;
    out[i * 2] = s & 0xff;
    out[i * 2 + 1] = (s >> 8) & 0xff;
  }
  return out;
}

interface FakeHelper {
  spawn: SpawnHelperFn;
  emit: (line: string) => void;
  exit: (code: number | null) => void;
  written: Uint8Array[];
  stdinEnded: () => boolean;
  killed: () => boolean;
  killCount: () => number;
  spawnCount: () => number;
  spawnArgs: () => string[][];
}

/**
 * Deterministic TESTONLY double for the native helper.
 * Explicit fake injection only: production never uses this path.
 * Each spawn() records one diagnostics/capture child; emit()/exit() target
 * the latest spawn so `setup()` probe and `createInput()` preflight can each
 * be driven to real native `ready` deterministically.
 */
function makeFake(): FakeHelper {
  const written: Uint8Array[] = [];
  const argsSeen: string[][] = [];
  let onLine: ((line: string) => void) | undefined;
  let onExit: ((code: number | null) => void) | undefined;
  let ended = false;
  let dead = false;
  let killCalls = 0;
  let spawns = 0;
  let child!: WatchHelperChild;
  child = {
    stdinWritable: () => !ended,
    writeStdin: (chunk) => {
      written.push(chunk.slice());
      return true;
    },
    endStdin: () => {
      ended = true;
    },
    kill: () => {
      dead = true;
      killCalls += 1;
    },
    onLine: () => undefined,
    onExit: () => undefined,
  };
  return {
    spawn: (args, hooks) => {
      spawns += 1;
      argsSeen.push([...args]);
      onLine = hooks.onLine;
      onExit = hooks.onExit;
      return child;
    },
    emit: (line) => onLine?.(line),
    exit: (code) => onExit?.(code),
    written,
    stdinEnded: () => ended,
    killed: () => dead,
    killCount: () => killCalls,
    spawnCount: () => spawns,
    spawnArgs: () => argsSeen.map((a) => [...a]),
  };
}

/**
 * Hermetic native fixture: temp helper binary + matching manifest so the
 * readonly tamper guard passes deterministically on any host (no reliance
 * on the real built binary). Services under test point at this fixture
 * with platform 'darwin' and the injected fake spawner.
 */
function makeNativeFixture(architectures = 'arm64 x86_64'): { helperPath: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-watch-native-'));
  nativeRoots.push(dir);
  const binDir = path.join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const helperPath = path.join(binDir, 'watch-asr');
  const bytes = Buffer.from(`test-helper-fixture:${Date.now().toString(36)}`);
  writeFileSync(helperPath, bytes);
  const binarySha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(
    path.join(dir, 'watch-asr.manifest.json'),
    JSON.stringify({
      helper: 'watch-asr',
      source: 'resources/watch-asr.swift',
      sourceSha256: 'test-source-sha',
      plist: 'resources/watch-asr-Info.plist',
      plistSha256: 'test-plist-sha',
      binary: 'resources/bin/watch-asr',
      binarySha256,
      architectures,
      universal: architectures.split(' ').length > 1 ? 1 : 0,
      minOS: '13.0',
    }),
  );
  return { helperPath, dir };
}

function makeService(
  fake: FakeHelper,
  extra: Record<string, unknown> = {},
): { svc: ReturnType<typeof createLiveVoiceWatchService>; native: { helperPath: string; dir: string } } {
  const native = makeNativeFixture();
  const svc = createLiveVoiceWatchService({
    runtime: {},
    spawnHelper: fake.spawn,
    helperPath: native.helperPath,
    platform: 'darwin',
    ...(extra as object),
  });
  return { svc, native };
}

const json = (v: unknown): string => JSON.stringify(v);
const READY_LINE = json({ event: 'ready', sampleRate: 16000 });
const AUTHORIZE_LINE = json({
  tool: 'watch-asr',
  mode: 'authorize',
  locale: 'en-AU',
  authorization: 'authorized',
  authorized: true,
  localeAvailable: true,
  onDeviceRecognition: true,
});

async function tick(ms = 5): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitSpawns(fake: FakeHelper, n: number): Promise<void> {
  for (let i = 0; i < 400 && fake.spawnCount() < n; i += 1) await tick();
  await tick();
}

/** Drive explicit-consent setup through authorize + diagnostics to ready. */
async function setupToReady(
  svc: ReturnType<typeof createLiveVoiceWatchService>,
  fake: FakeHelper,
): Promise<{ status: string; pcm: { encoding: 'pcm16le'; sampleRate: number; channels: 1 } }> {
  const base = fake.spawnCount();
  const pending = svc.setup({ consent: true });
  await waitSpawns(fake, base + 1);
  fake.emit(AUTHORIZE_LINE);
  await waitSpawns(fake, base + 2);
  fake.emit(READY_LINE);
  const out = await pending;
  return out as unknown as { status: string; pcm: { encoding: 'pcm16le'; sampleRate: number; channels: 1 } };
}

/** Start createInput and resolve it ONLY after the real helper ready line. */
async function createInputToReady(
  svc: ReturnType<typeof createLiveVoiceWatchService>,
  fake: FakeHelper,
  args: { streamId: string; purpose?: 'prompt' | 'dictation'; onEvent: (e: LiveVoiceInputEvent) => void | Promise<void>; signal?: AbortSignal },
): Promise<Awaited<ReturnType<typeof svc.createInput>>> {
  const before = fake.spawnCount();
  const pending = svc.createInput(args);
  for (let i = 0; i < 200 && fake.spawnCount() === before; i += 1) await tick();
  await tick();
  fake.emit(READY_LINE);
  return await pending;
}

describe('liveVoiceWatch status/setup consent', () => {
  it('starts warming/required and reaches ready only on explicit consent', async () => {
    const fake = makeFake();
    const { svc } = makeService(fake);
    expect(await svc.status()).toMatchObject({ status: 'warming', consent: 'required' });
    expect((await svc.status()).pcm).toEqual({ encoding: 'pcm16le', sampleRate: 16000, channels: 1 });
    const denied = await svc.setup({ consent: false });
    expect(denied.status).toBe('warming');
    expect((await svc.status()).consent).toBe('required');
    const granted = await setupToReady(svc, fake);
    expect(granted.status).toBe('ready');
    expect(granted.pcm).toEqual(WATCH_PCM);
    expect((await svc.status()).consent).toBe('granted');
    // First setup spawn is the explicit --authorize gate (machine JSON, no PCM).
    expect(fake.spawnArgs()[0]).toContain('--authorize');
    await svc.dispose();
  });

  it('setup requests Speech authorization on the consent action; denial never reaches diagnostics', async () => {
    const fake = makeFake();
    const { svc } = makeService(fake);
    const pending = svc.setup({ consent: true });
    await waitSpawns(fake, 1);
    expect(fake.spawnArgs()[0]).toContain('--authorize');
    fake.emit(json({ tool: 'watch-asr', mode: 'authorize', authorization: 'denied', authorized: false }));
    const res = await pending;
    expect(res.status).toBe('error');
    expect((await svc.status()).status).toBe('error');
    expect((await svc.status()).message).toMatch(/Speech Recognition/);
    // Denial stops the flow: no diagnostics capture spawn follows.
    await tick(20);
    expect(fake.spawnCount()).toBe(1);
    await svc.dispose();
  });

  it('a tampered binary never spawns: manifest mismatch is a status error', async () => {
    const fake = makeFake();
    const native = makeNativeFixture();
    appendFileSync(native.helperPath, Buffer.from('tamper'));
    let spawned = false;
    const svc = createLiveVoiceWatchService({
      runtime: {},
      helperPath: native.helperPath,
      platform: 'darwin',
      spawnHelper: (...a) => {
        spawned = true;
        return fake.spawn(...a);
      },
    });
    const res = await svc.setup({ consent: true });
    expect(res.status).toBe('error');
    expect((await svc.status()).message).toMatch(/manifest|tamper|match/i);
    await expect(svc.createInput({ streamId: 's1', onEvent: () => undefined })).rejects.toMatchObject({
      code: 'helper-tamper',
    });
    expect(spawned).toBe(false);
    await svc.dispose();
  });

  it('a manifest without this Mac slice never spawns', async () => {
    const fake = makeFake();
    const native = makeNativeFixture('riscv64-unknown');
    let spawned = false;
    const svc = createLiveVoiceWatchService({
      runtime: {},
      helperPath: native.helperPath,
      platform: 'darwin',
      spawnHelper: (...a) => {
        spawned = true;
        return fake.spawn(...a);
      },
    });
    const res = await svc.setup({ consent: true });
    expect(res.status).toBe('error');
    expect((await svc.status()).message).toMatch(/slice|universal|rebuild/i);
    expect(spawned).toBe(false);
    await svc.dispose();
  });

  it('scopes readiness guidance to actual input mode (watch Speech vs Mac Mic+Speech)', async () => {
    const svc = createLiveVoiceWatchService({ runtime: {}, spawnHelper: makeFake().spawn });
    await svc.setup({ consent: false });
    const report = await svc.status();
    expect(report.message).toMatch(/Speech/);
    expect(report.message).toMatch(/Microphone/);
    await svc.dispose();
  });

  it('missing helper binary never reports ready', async () => {
    let spawned = false;
    const svc = createLiveVoiceWatchService({
      runtime: {},
      existsHelper: async () => false,
      spawnHelper: (...a) => {
        spawned = true;
        return makeFake().spawn(...a);
      },
    });
    const res = await svc.setup({ consent: true });
    expect(res.status).toBe('error');
    expect((await svc.status()).status).toBe('error');
    await expect(svc.createInput({ streamId: 's1', onEvent: () => undefined })).rejects.toMatchObject({
      code: 'helper-missing',
    });
    expect(spawned).toBe(false);
    await svc.dispose();
  });

  it('non-Darwin backend never reports ready', async () => {
    let spawned = false;
    const svc = createLiveVoiceWatchService({
      runtime: {},
      platform: 'linux',
      existsHelper: async () => true,
      spawnHelper: (...a) => {
        spawned = true;
        return makeFake().spawn(...a);
      },
    });
    const res = await svc.setup({ consent: true });
    expect(res.status).toBe('error');
    await expect(svc.createInput({ streamId: 's1', onEvent: () => undefined })).rejects.toMatchObject({
      code: 'backend-unsupported',
    });
    expect(spawned).toBe(false);
    await svc.dispose();
  });
});

describe('liveVoiceWatch createInput', () => {
  it('rejects without consent and never spawns the helper', async () => {
    let spawned = false;
    const svc = createLiveVoiceWatchService({
      runtime: {},
      spawnHelper: (...a) => {
        spawned = true;
        return makeFake().spawn(...a);
      },
    });
    await expect(svc.createInput({ streamId: 's1', onEvent: () => undefined })).rejects.toThrow(/consent/i);
    expect(spawned).toBe(false);
    await svc.dispose();
  });

  it('resolves only after real native ready; accepts audio after ready (nothing shed)', async () => {
    const fake = makeFake();
    const { svc } = makeService(fake);
    await setupToReady(svc, fake);
    const events: LiveVoiceInputEvent[] = [];
    const pending = svc.createInput({
      streamId: 'warm-1',
      onEvent: (e) => {
        events.push(e);
      },
    });
    // Wait for manifest I/O without a load-sensitive fixed sleep. Still
    // warming: no handle exists until the injected native ready line arrives.
    await waitSpawns(fake, 3);
    expect((await svc.status()).status).toBe('warming');
    expect(fake.spawnCount()).toBe(3);
    fake.emit(READY_LINE);
    const handle = await pending;
    const tone = sinePCM(0.128); // 2 exact 64 ms frames
    handle.writePCM(tone.subarray(0, 2048));
    handle.writePCM(tone.subarray(2048, 4096));
    expect(fake.written.length).toBe(2);
    const finishing = handle.end();
    fake.emit(json({ event: 'final', text: 'synthetic fixture phrase', utteranceId: 'u-1' }));
    await finishing;
    expect(events.some((e) => e.kind === 'final' && (e as { text: string }).text === 'synthetic fixture phrase')).toBe(
      true,
    );
    await handle.dispose();
    await svc.dispose();
  });

  it('declines 409-busy rather than stealing Mac live-voice or dictation leases', async () => {
    const fake1 = makeFake();
    const native1 = makeNativeFixture();
    const busy1 = createLiveVoiceWatchService({
      runtime: { activeSessionId: 'mac-session' },
      spawnHelper: fake1.spawn,
      helperPath: native1.helperPath,
      platform: 'darwin',
    });
    await setupToReady(busy1, fake1);
    await expect(busy1.createInput({ streamId: 'x', onEvent: () => undefined })).rejects.toMatchObject({ code: 'busy' });
    await busy1.dispose();

    const fake2 = makeFake();
    const native2 = makeNativeFixture();
    const busy2 = createLiveVoiceWatchService({
      runtime: { dictateLease: { clientId: 'c', leaseId: 'l', sessionId: 's' } },
      spawnHelper: fake2.spawn,
      helperPath: native2.helperPath,
      platform: 'darwin',
    });
    await setupToReady(busy2, fake2);
    await expect(busy2.createInput({ streamId: 'x', onEvent: () => undefined })).rejects.toMatchObject({ code: 'busy' });
    await busy2.dispose();

    const fake = makeFake();
    const { svc } = makeService(fake);
    await setupToReady(svc, fake);
    const first = await createInputToReady(svc, fake, { streamId: 'first', onEvent: () => undefined });
    await expect(svc.createInput({ streamId: 'second', onEvent: () => undefined })).rejects.toMatchObject({
      code: 'busy',
    });
    await first.dispose();
    await svc.dispose();
  });

  it('surfaces helper exit 2/3 immediately with actionable guidance (never stuck warming)', async () => {
    for (const [code, needle, want] of [
      [2, /Speech Recognition/, 'speech-permission'],
      [3, /locale|Apple Speech/i, 'locale-unavailable'],
    ] as const) {
      const fake = makeFake();
      const { svc } = makeService(fake);
      await setupToReady(svc, fake);
      const events: LiveVoiceInputEvent[] = [];
      const before = fake.spawnCount();
      const pending = svc.createInput({
        streamId: `denied-${code}`,
        onEvent: (e) => {
          events.push(e);
        },
      });
      for (let i = 0; i < 200 && fake.spawnCount() === before; i += 1) await tick();
      await tick();
      fake.exit(code);
      await expect(pending).rejects.toMatchObject({ code: want });
      await tick(20);
      const err = events.find((e) => e.kind === 'error');
      expect(err).toBeDefined();
      expect(String((err as { message: string }).message)).toMatch(needle);
      expect((await svc.status()).status).toBe('error');
      expect(fake.killed()).toBe(true);
      await svc.dispose();
    }
  });

  it('times out a helper that never becomes ready (retryable, not busy-forever)', async () => {
    const fake = makeFake();
    const native = makeNativeFixture();
    const svc = createLiveVoiceWatchService({
      runtime: {},
      spawnHelper: fake.spawn,
      helperPath: native.helperPath,
      platform: 'darwin',
      readyTimeoutMs: 40,
    });
    // Authorize probe itself times out without an answer: never ready.
    const setupRes = await svc.setup({ consent: true });
    expect(setupRes.status).toBe('error');
    const events: LiveVoiceInputEvent[] = [];
    const pending = svc.createInput({
      streamId: 'slow',
      onEvent: (e) => {
        events.push(e);
      },
    });
    await expect(pending).rejects.toMatchObject({ code: 'helper-timeout', retryable: true });
    await tick(20);
    const err = events.find((e) => e.kind === 'error');
    expect(err).toMatchObject({ code: 'helper-timeout', retryable: true });
    // Busy is cleared exactly once: a fresh capture can start after timeout.
    const fresh = makeFake();
    const { svc: svc2 } = makeService(fresh, { readyTimeoutMs: 5000 });
    await setupToReady(svc2, fresh);
    const handle = await createInputToReady(svc2, fresh, {
      streamId: 'after-timeout',
      onEvent: () => undefined,
    });
    await handle.dispose();
    await svc.dispose();
    await svc2.dispose();
  });

  it('delivers the EOF final ack before end() resolves (awaits H async delivery ack)', async () => {
    const fake = makeFake();
    const { svc } = makeService(fake);
    await setupToReady(svc, fake);
    const events: LiveVoiceInputEvent[] = [];
    const handle = await createInputToReady(svc, fake, {
      streamId: 'eof-1',
      onEvent: async (e) => {
        events.push(e);
        await new Promise((r) => setTimeout(r, 10));
      },
    });
    handle.writePCM(sinePCM(0.064));
    const finishing = handle.end();
    // Helper drains 1.0 s finish + 1.1 s EOF in production; the fake answers at once.
    fake.emit(json({ event: 'final', text: 'eof ack phrase', utteranceId: 'u-eof' }));
    await finishing;
    expect(fake.stdinEnded()).toBe(true);
    expect(events.some((e) => e.kind === 'final')).toBe(true);
    await handle.dispose();
    await svc.dispose();
  });

  it('applies a time-bounded echo gate: exact echo suppressed, barge-in passes', async () => {
    const fake = makeFake();
    const native = makeNativeFixture();
    const svc = createLiveVoiceWatchService({
      runtime: {},
      spawnHelper: fake.spawn,
      helperPath: native.helperPath,
      platform: 'darwin',
      synthFile: async (_text, outPath) => {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(outPath, Buffer.from(sinePCM(0.064)));
      },
    });
    await setupToReady(svc, fake);
    const events: LiveVoiceInputEvent[] = [];
    const handle = await createInputToReady(svc, fake, {
      streamId: 'echo-1',
      onEvent: (e) => {
        events.push(e);
      },
    });
    await svc.synthesize({
      text: 'the deployment is ready',
      speechId: 'sp-1',
      onChunk: () => undefined,
      onDone: () => undefined,
    });
    fake.emit(json({ event: 'final', text: 'the deployment is ready', utteranceId: 'u-e' }));
    fake.emit(json({ event: 'partial', text: 'deployment is ready', utteranceId: 'u-tail' }));
    fake.emit(json({ event: 'final', text: 'ready', utteranceId: 'u-single' }));
    fake.emit(json({ event: 'final', text: 'deployment ready is the', utteranceId: 'u-overlap' }));
    for (const word of ['stop', 'wait', 'pause', 'no', 'cancel']) fake.emit(json({ event: 'final', text: word, utteranceId: word }));
    fake.emit(json({ event: 'final', text: 'the deployment is ready, now use the backup instead', utteranceId: 'u-b' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.kind === 'final').map((e) => (e as { text: string }).text)).toEqual([
      'stop', 'wait', 'pause', 'no', 'cancel',
      'the deployment is ready, now use the backup instead',
    ]);
    await handle.dispose();
    await svc.dispose();
  });
});

describe('liveVoiceWatch synthesize (system TTS fallback)', () => {
  it('delivers mono PCM at the explicit rate via argv spawn (spaces/quotes safe), never logging text', async () => {
    const seen: string[] = [];
    const pcm = sinePCM(0.128);
    const fake = makeFake();
    const native = makeNativeFixture();
    const svc = createLiveVoiceWatchService({
      runtime: {},
      spawnHelper: fake.spawn,
      helperPath: native.helperPath,
      platform: 'darwin',
      synthFile: async (text, outPath, rate) => {
        seen.push(`${text}|${outPath}|${rate}`);
        const { writeFile } = await import('node:fs/promises');
        await writeFile(outPath, Buffer.from(pcm));
      },
    });
    await setupToReady(svc, fake);
    const chunks: Uint8Array[] = [];
    let receipt: { speechId: string } | undefined;
    await svc.synthesize({
      text: 'hello "quoted" world; rm -rf /',
      speechId: 'say-1',
      onChunk: (c) => {
        chunks.push(c);
      },
      onDone: (r) => {
        receipt = r;
      },
    });
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatch(/\|16000$/);
    expect(seen[0]?.startsWith('hello "quoted" world; rm -rf /|')).toBe(true); // argv, never a shell string
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBe(pcm.length);
    expect(receipt).toEqual({ speechId: 'say-1' });
    await svc.dispose();
  });

  it('cancels cooperative synthesis without a receipt', async () => {
    const big = sinePCM(2);
    const fake = makeFake();
    const native = makeNativeFixture();
    const svc = createLiveVoiceWatchService({
      runtime: {},
      spawnHelper: fake.spawn,
      helperPath: native.helperPath,
      platform: 'darwin',
      synthFile: async (_text, outPath) => {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(outPath, Buffer.from(big));
      },
    });
    await setupToReady(svc, fake);
    const controller = new AbortController();
    let done = false;
    const chunks: Uint8Array[] = [];
    const pending = svc.synthesize({
      text: 'a long paragraph that will be cancelled mid-stream',
      speechId: 'say-cancel',
      onChunk: (c) => {
        chunks.push(c);
        if (chunks.length === 1) controller.abort();
      },
      onDone: () => {
        done = true;
      },
      signal: controller.signal,
    });
    await pending;
    expect(done).toBe(false);
    await svc.dispose();
  });
});

describe('native helper contract (source + safe invocation)', () => {
  it('bundles the exact bridge helper contract (64 ms frames, silence clock, final drain, exits 2/3)', async () => {
    const source = readFileSync(path.join(ROOT, 'resources', 'watch-asr.swift'), 'utf8');
    expect(source).toContain('frameBytes = 2048');
    expect(source).toContain('requiresOnDeviceRecognition = true');
    expect(source).toContain('finalEmittedForUtterance');
    expect(source).toContain('exit(2)');
    expect(source).toContain('exit(3)');
    expect(source).toContain('"event": "ready"');
    // Explicit diagnostic modes: machine JSON, no PCM, no mic activation.
    expect(source).toContain('--status');
    expect(source).toContain('Locale.current.identifier');
    expect(source).toContain('\"code\": \"recognition-failed\"');
    expect(source).toContain('--authorize');
    expect(source).toContain('"mode": "status"');
    expect(source).toContain('"mode": "authorize"');
    // The helper never activates the Mac microphone: stdin PCM only.
    expect(source).not.toMatch(/AVCaptureSession|AVAudioEngine|AVAudioInputNode/);
    // Manifest guards the binary: source hash must match the bundled copy.
    const manifestPath = path.join(ROOT, 'resources', 'watch-asr.manifest.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { sourceSha256?: string };
      const digest = createHash('sha256').update(source).digest('hex');
      expect(manifest.sourceSha256).toBe(digest);
    }
  });

  it('manifest carries full provenance: plist hash, architectures, minOS, stable identity', () => {
    const manifestPath = path.join(ROOT, 'resources', 'watch-asr.manifest.json');
    if (!existsSync(manifestPath)) {
      expect(true).toBe(true);
      return;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    for (const key of ['sourceSha256', 'plistSha256', 'binarySha256', 'architectures', 'minOS', 'codesignIdentifier']) {
      expect(typeof manifest[key], key).toBe('string');
      expect(String(manifest[key]).length).toBeGreaterThan(0);
    }
    expect(manifest['codesignIdentifier']).toBe('ai.deepseek.dsh.watch-asr');
    expect(manifest['plistEmbedded']).toBe(true);
    // No private identity baked into the manifest (repo-relative paths only).
    expect(JSON.stringify(manifest)).not.toMatch(/\/Users\//);
  });

  it('package files allowlist ships the native payload + build script (no Xcode needed at install)', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { files?: string[] };
    const files = pkg.files ?? [];
    for (const entry of [
      'resources/bin/watch-asr',
      'resources/watch-asr.manifest.json',
      'resources/watch-asr.swift',
      'resources/watch-asr-Info.plist',
      'scripts/build-watch-helpers.sh',
    ]) {
      expect(files, entry).toContain(entry);
    }
  });

  it('built helper answers --help/--status without capture (noncapture safe); real recognition needs owner TCC consent', () => {
    const bin = path.join(ROOT, 'resources', 'bin', 'watch-asr');
    if (!existsSync(bin) || process.platform !== 'darwin') {
      // Non-Mac or source-only checkout: recognition is unavailable here by
      // design. Owner consent path (helper exit 2 actionable message) is
      // covered by the fake-helper denial test above — never a mocked ASR claim.
      expect(true).toBe(true);
      return;
    }
    const out = execFileSync(bin, ['--help'], {
      encoding: 'utf8',
      env: scrubbedEnv({ HOME: process.env.HOME ?? '/tmp' }),
    });
    expect(out).toMatch(/16000 Hz/);
    expect(out).toMatch(/--status/);
    expect(out).toMatch(/--authorize/);
    // --status is a read-only diagnostic: machine JSON, no prompt, no stdin.
    const statusOut = execFileSync(bin, ['--status'], {
      encoding: 'utf8',
      env: scrubbedEnv({ HOME: process.env.HOME ?? '/tmp' }),
      timeout: 15000,
    });
    const statusJson = JSON.parse(statusOut.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
    expect(statusJson['tool']).toBe('watch-asr');
    expect(statusJson['mode']).toBe('status');
    expect(typeof statusJson['authorization']).toBe('string');
    // Actual phrase recognition runs ONLY on a consented Mac (Speech TCC
    // authorized) against a generated synthetic phrase fixture — never
    // silently, never with a real user recording. If Speech permission is
    // denied, the helper exits 2 and setup surfaces owner-consent guidance.
  });

  it('built universal binary carries both slices, embedded plist, stable identity', () => {
    const bin = path.join(ROOT, 'resources', 'bin', 'watch-asr');
    if (!existsSync(bin) || process.platform !== 'darwin') {
      expect(true).toBe(true);
      return;
    }
    const env = scrubbedEnv({ HOME: process.env.HOME ?? '/tmp' });
    const archs = execFileSync('lipo', ['-archs', bin], { encoding: 'utf8', env }).trim().split(/\s+/);
    expect(archs).toContain('arm64');
    expect(archs).toContain('x86_64');
    // Embedded Info plist section (the old script only claimed this).
    const sect = execFileSync('otool', ['-s', '__TEXT', '__info_plist', bin], { encoding: 'utf8', env });
    expect(sect.length).toBeGreaterThan(0);
    // Stable ad-hoc identity (no temp-path churn across rebuilds).
    const cs = spawnSync('codesign', ['-dv', bin], { encoding: 'utf8', env });
    const csText = `${String(cs.stdout ?? '')}\n${String(cs.stderr ?? '')}`;
    expect(csText).toMatch(/Identifier=ai\.deepseek\.dsh\.watch-asr/);
  });

  it('system TTS synthesizes a real generated phrase to a private file (no mic, no playback)', async () => {
    if (process.platform !== 'darwin') {
      expect(true).toBe(true);
      return;
    }
    const say = spawnSync('which', ['say'], { encoding: 'utf8' });
    if (say.status !== 0) {
      expect(true).toBe(true);
      return;
    }
    // Real `say` file synthesis (default synthFile path): short generated
    // phrase, private temp workspace, PCM chunks delivered, receipt issued.
    // Nothing is played back; no microphone is touched.
    const fake = makeFake();
    const { svc } = makeService(fake);
    await setupToReady(svc, fake);
    const chunks: Uint8Array[] = [];
    let receipt: { speechId: string } | undefined;
    await svc.synthesize({
      text: 'acceptance probe phrase',
      speechId: 'np-acceptance-1',
      onChunk: (c) => {
        chunks.push(c);
      },
      onDone: (r) => {
        receipt = r;
      },
    });
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeGreaterThan(0);
    expect(receipt).toEqual({ speechId: 'np-acceptance-1' });
    await svc.dispose();
  }, 20_000);

  it('service never attempts the real microphone during tests (explicit fake injection only)', () => {
    const source = readFileSync(path.join(ROOT, 'src', 'watch-service.ts'), 'utf8');
    expect(source).not.toMatch(/AudioRecord|startRecording|getUserMedia/);
    const spec = readFileSync(path.join(ROOT, 'tests', 'watch-service.spec.ts'), 'utf8');
    expect(spec).toMatch(/synthetic|synth/i);
  });
});


const persistenceRoots: string[] = [];
afterEach(() => { for (const root of persistenceRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function persistentFixture() {
  const native = makeNativeFixture();
  const root = realpathSync(native.dir);
  persistenceRoots.push(root);
  const consentPath = path.join(root, 'private-consent', 'consent.json');
  const make = (fake: FakeHelper, extra: Record<string, unknown> = {}) => createLiveVoiceWatchService({
    runtime: {}, helperPath: native.helperPath, platform: 'darwin', locale: 'en-AU',
    spawnHelper: fake.spawn, consentPath, ...extra,
  });
  return { native, root, consentPath, make };
}
const STATUS_LINE = json({ tool: 'watch-asr', mode: 'status', locale: 'en-AU', authorization: 'authorized', localeAvailable: true, onDeviceRecognition: true });

describe('durable watch-Speech consent (private fixtures only)', () => {
  it('writes nothing before explicit setup and atomically persists private, non-secret watch consent', async () => {
    const f = persistentFixture(); const fake = makeFake(); const svc = f.make(fake);
    expect(await svc.status()).toMatchObject({ status: 'warming', consent: 'required' });
    expect(existsSync(f.consentPath)).toBe(false); expect(fake.spawnCount()).toBe(0);
    await setupToReady(svc, fake);
    expect(await readWatchConsent(f.consentPath)).toEqual({ version: 1, scope: 'watch-asr', consent: true, locale: 'en-AU' });
    expect(statSync(path.dirname(f.consentPath)).mode & 0o777).toBe(0o700);
    expect(statSync(f.consentPath).mode & 0o777).toBe(0o600);
    await svc.dispose();
  });

  it('recreates ready solely after --status validation: no authorize, diagnostics capture or PCM', async () => {
    const f = persistentFixture(); const first = makeFake(); const svc = f.make(first);
    await setupToReady(svc, first); await svc.dispose();
    const fake = makeFake(); const restored = f.make(fake);
    expect(fake.spawnCount()).toBe(0);
    const pending = restored.status(); await waitSpawns(fake, 1);
    expect(fake.spawnArgs()).toEqual([['--status']]); fake.emit(STATUS_LINE);
    expect(await pending).toMatchObject({ status: 'ready', consent: 'granted' });
    expect(fake.written).toHaveLength(0); expect(fake.stdinEnded()).toBe(true); expect(fake.killed()).toBe(true);
    await restored.status(); expect(fake.spawnCount()).toBe(1); await restored.dispose();
  });

  it('setup false durably revokes and recreation does not even spawn --status', async () => {
    const f = persistentFixture(); const fake = makeFake(); const svc = f.make(fake);
    await setupToReady(svc, fake);
    const capture = await createInputToReady(svc, fake, { streamId: 'revoked', onEvent: () => undefined });
    expect((await svc.setup({ consent: false })).status).toBe('warming');
    expect((await readWatchConsent(f.consentPath))?.consent).toBe(false);
    expect(() => capture.writePCM(new Uint8Array(2))).toThrow(/closed/);
    const next = makeFake(); const recreated = f.make(next);
    expect(await recreated.status()).toMatchObject({ status: 'warming', consent: 'required' });
    await expect(recreated.createInput({ streamId: 'no-consent', onEvent: () => undefined })).rejects.toMatchObject({ code: 'consent-required' });
    expect(next.spawnCount()).toBe(0); await svc.dispose(); await recreated.dispose();
  });

  it.each([
    { authorization: 'denied' }, { authorization: 'not-determined' },
    { onDeviceRecognition: false }, { localeAvailable: false },
    { locale: 'fr-FR' }, { onDeviceRecognition: undefined },
  ])('does not restore consent with an invalid readonly OS verdict %j', async (patch) => {
    const f = persistentFixture();
    await writeWatchConsent(f.consentPath, { version: 1, scope: 'watch-asr', consent: true, locale: 'en-AU' });
    const fake = makeFake(); const svc = f.make(fake);
    const pending = svc.status(); await waitSpawns(fake, 1);
    fake.emit(json({ ...JSON.parse(STATUS_LINE), ...patch }));
    expect(await pending).toMatchObject({ status: 'error', consent: 'required' });
    expect(fake.spawnArgs()).toEqual([['--status']]); await svc.dispose();
  });

  it.each(['missing-helper', 'tampered-helper', 'changed-locale', 'invalid-file', 'unsafe-file', 'unsafe-directory', 'symlink-file', 'symlink-directory'])('fails closed without any helper spawn for %s', async (kind) => {
    const f = persistentFixture();
    await writeWatchConsent(f.consentPath, { version: 1, scope: 'watch-asr', consent: true, locale: 'en-AU' });
    const extra: Record<string, unknown> = {};
    if (kind === 'missing-helper') extra.existsHelper = async () => false;
    if (kind === 'tampered-helper') appendFileSync(f.native.helperPath, 'tamper');
    if (kind === 'changed-locale') extra.locale = 'fr-FR';
    if (kind === 'invalid-file') writeFileSync(f.consentPath, '{"consent":true}', { mode: 0o600 });
    if (kind === 'unsafe-file') chmodSync(f.consentPath, 0o644);
    if (kind === 'unsafe-directory') chmodSync(path.dirname(f.consentPath), 0o755);
    if (kind === 'symlink-file') { unlinkSync(f.consentPath); symlinkSync(f.native.helperPath, f.consentPath); }
    if (kind === 'symlink-directory') { rmSync(path.dirname(f.consentPath), { recursive: true }); symlinkSync(path.dirname(f.native.helperPath), path.dirname(f.consentPath)); }
    const fake = makeFake(); const svc = f.make(fake, extra);
    expect((await svc.status()).status).not.toBe('ready'); expect((await svc.status()).consent).toBe('required');
    expect(fake.spawnCount()).toBe(0); await svc.dispose();
  });

  it('refuses unsafe writes instead of swallowing directory/file permission errors', async () => {
    const f = persistentFixture(); mkdirSync(path.dirname(f.consentPath), { mode: 0o755 });
    await expect(writeWatchConsent(f.consentPath, { version: 1, scope: 'watch-asr', consent: true, locale: 'en-AU' })).rejects.toThrow(/private/);
    expect(existsSync(f.consentPath)).toBe(false);
    chmodSync(path.dirname(f.consentPath), 0o700); symlinkSync(f.native.helperPath, f.consentPath);
    await expect(writeWatchConsent(f.consentPath, { version: 1, scope: 'watch-asr', consent: true, locale: 'en-AU' })).rejects.toThrow(/symlink/);
  });

  it('a later revocation cannot be overwritten by an in-flight Setup', async () => {
    const f = persistentFixture(); const fake = makeFake(); const svc = f.make(fake);
    const pending = svc.setup({ consent: true }); await waitSpawns(fake, 1);
    const revoke = svc.setup({ consent: false }); fake.emit(AUTHORIZE_LINE);
    await waitSpawns(fake, 2); fake.emit(READY_LINE); await pending; await revoke;
    expect(await svc.status()).toMatchObject({ status: 'warming', consent: 'required' });
    expect((await readWatchConsent(f.consentPath))?.consent).toBe(false); await svc.dispose();
  });
});


describe('watch consent probe disposal', () => {
  it.each(['authorize', 'diagnostics'])('kills pending %s once; no later ready or consent write after dispose', async (stage) => {
    const f = persistentFixture(); const fake = makeFake(); const svc = f.make(fake);
    const setup = svc.setup({ consent: true }); await waitSpawns(fake, 1);
    if (stage === 'diagnostics') { fake.emit(AUTHORIZE_LINE); await waitSpawns(fake, 2); }
    const before = fake.spawnCount();
    const kills = fake.killCount();
    await svc.dispose(); await setup;
    fake.emit(stage === 'authorize' ? AUTHORIZE_LINE : READY_LINE);
    expect(await svc.status()).toMatchObject({ status: 'closed', consent: 'required' });
    expect(fake.killed()).toBe(true); expect(fake.stdinEnded()).toBe(true);
    expect(fake.killCount()).toBe(kills + 1);
    expect(fake.spawnCount()).toBe(before); expect(existsSync(f.consentPath)).toBe(false);
    expect(await svc.setup({ consent: true })).toMatchObject({ status: 'closed' });
    await expect(svc.createInput({ streamId: 'disposed', onEvent: () => undefined })).rejects.toMatchObject({ code: 'cancelled' });
    await svc.dispose();
    expect(fake.killCount()).toBe(kills + 1);
  });

  it('kills a pending readonly restore, never resurrects ready on late status or starts authorization/capture', async () => {
    const f = persistentFixture();
    await writeWatchConsent(f.consentPath, { version: 1, scope: 'watch-asr', consent: true, locale: 'en-AU' });
    const fake = makeFake(); const svc = f.make(fake);
    const status = svc.status(); await waitSpawns(fake, 1);
    await svc.dispose(); fake.emit(STATUS_LINE);
    expect(await status).toMatchObject({ status: 'closed', consent: 'required' });
    expect(fake.spawnArgs()).toEqual([['--status']]); expect(fake.killed()).toBe(true);
    expect(fake.killCount()).toBe(1);
    expect(await svc.status()).toMatchObject({ status: 'closed', consent: 'required' });
    await svc.dispose();
  });
});


describe('native request failure and explicit dictation intent', () => {
  it('rejects native error before ready immediately and releases capture ownership', async () => {
    const fake = makeFake(); const { svc } = makeService(fake);
    await setupToReady(svc, fake);
    const events: LiveVoiceInputEvent[] = [];
    const pending = svc.createInput({ streamId: 'bad-locale', onEvent: (e) => { events.push(e); } });
    await waitSpawns(fake, 3);
    fake.emit(json({ event: 'error', code: 'on-device-unavailable' }));
    await expect(pending).rejects.toMatchObject({ code: 'on-device-unavailable' });
    expect((await svc.status()).status).toBe('error');
    expect(fake.killed()).toBe(true); expect(events.filter((e) => e.kind === 'error')).toHaveLength(1);
    const retry = await createInputToReady(svc, fake, { streamId: 'retry', onEvent: () => undefined });
    await retry.dispose(); await svc.dispose();
  });

  it('an actual recognition request failure after PCM clears the lease with actionable OS asset guidance', async () => {
    const fake = makeFake(); const { svc } = makeService(fake);
    await setupToReady(svc, fake);
    const events: LiveVoiceInputEvent[] = [];
    const handle = await createInputToReady(svc, fake, { streamId: 'missing-assets', onEvent: (e) => { events.push(e); } });
    handle.writePCM(sinePCM(0.064));
    fake.emit(json({ event: 'error', code: 'recognition-failed' }));
    expect(events).toEqual([expect.objectContaining({ kind: 'error', code: 'recognition-failed', message: expect.stringMatching(/Speech.*Dictation.*language assets/) })]);
    expect((await svc.status()).status).toBe('error'); expect(() => handle.writePCM(sinePCM(0.064))).toThrow(/closed/);
    const retry = await createInputToReady(svc, fake, { streamId: 'retry-assets', onEvent: () => undefined });
    await retry.dispose(); await svc.dispose();
  });

  it('delivers deliberate yes/done dictation answers after prior TTS instead of treating them as playback tails', async () => {
    const fake = makeFake();
    const { svc } = makeService(fake, { synthFile: async (_text: string, out: string) => { writeFileSync(out, Buffer.from(sinePCM(0.064))); } });
    await setupToReady(svc, fake);
    await svc.synthesize({ text: 'Say yes when you are done.', speechId: 'question', onChunk: () => undefined, onDone: () => undefined });
    const events: LiveVoiceInputEvent[] = [];
    const draft = await createInputToReady(svc, fake, { streamId: 'draft-answer', purpose: 'dictation', onEvent: (e) => { events.push(e); } });
    fake.emit(json({ event: 'partial', text: 'yes', utteranceId: 'draft-yes' }));
    fake.emit(json({ event: 'final', text: 'yes', utteranceId: 'draft-yes' }));
    const ending = draft.end(); fake.emit(json({ event: 'final', text: 'done', utteranceId: 'draft-done' })); await ending;
    expect(events.filter((e) => e.kind === 'final').map((e) => (e as { text: string }).text)).toEqual(['yes', 'done']);
    await draft.dispose();
    const prompts: LiveVoiceInputEvent[] = [];
    const prompt = await createInputToReady(svc, fake, { streamId: 'prompt', onEvent: (e) => { prompts.push(e); } });
    await svc.synthesize({ text: 'Say yes when you are done.', speechId: 'during-prompt', onChunk: () => undefined, onDone: () => undefined });
    fake.emit(json({ event: 'final', text: 'Say yes when you are done.', utteranceId: 'echo' }));
    fake.emit(json({ event: 'final', text: 'done', utteranceId: 'tail' }));
    fake.emit(json({ event: 'final', text: 'stop', utteranceId: 'barge' }));
    expect(prompts).toEqual([expect.objectContaining({ kind: 'final', text: 'stop' })]);
    await prompt.dispose(); await svc.dispose();
  });
});


it('a NEW explicit prompt recording preserves yes/ready/done from a completed prior reply', async () => {
  const fake = makeFake();
  const { svc } = makeService(fake, { synthFile: async (_text: string, out: string) => { writeFileSync(out, Buffer.from(sinePCM(0.064))); } });
  await setupToReady(svc, fake);
  await svc.synthesize({ text: 'Yes the deployment is ready and done.', speechId: 'prior-completed-reply', onChunk: () => undefined, onDone: () => undefined });
  const events: LiveVoiceInputEvent[] = [];
  const handle = await createInputToReady(svc, fake, { streamId: 'fresh-explicit-prompt', onEvent: (e) => { events.push(e); } });
  for (const word of ['yes', 'ready', 'done']) fake.emit(json({ event: 'final', text: word, utteranceId: word }));
  expect(events.filter((e) => e.kind === 'final').map((e) => (e as { text: string }).text)).toEqual(['yes', 'ready', 'done']);
  await handle.dispose(); await svc.dispose();
});


it('a busy rejected recording cannot clear the active owner playback-echo references', async () => {
  const fake = makeFake();
  const { svc } = makeService(fake, { synthFile: async (_text: string, out: string) => { writeFileSync(out, Buffer.from(sinePCM(0.064))); } });
  await setupToReady(svc, fake);
  const events: LiveVoiceInputEvent[] = [];
  const owner = await createInputToReady(svc, fake, { streamId: 'echo-owner', onEvent: (e) => { events.push(e); } });
  await svc.synthesize({ text: 'the deployment is ready', speechId: 'owner-playback', onChunk: () => undefined, onDone: () => undefined });
  await expect(svc.createInput({ streamId: 'busy-rejected', onEvent: () => undefined })).rejects.toMatchObject({ code: 'busy' });
  fake.emit(json({ event: 'final', text: 'ready', utteranceId: 'tail' }));
  fake.emit(json({ event: 'final', text: 'the deployment is ready', utteranceId: 'echo' }));
  fake.emit(json({ event: 'final', text: 'stop', utteranceId: 'barge' }));
  expect(events).toEqual([expect.objectContaining({ kind: 'final', text: 'stop' })]);
  await owner.dispose(); await svc.dispose();
});


it.each(['eof', 'no-speech', 'cancel'] as const)('healthy %s closes the INPUT, preserving SERVICE ready for another record without Setup or TTS', async (kind) => {
  const fake = makeFake();
  const { svc } = makeService(fake, { finalTimeoutMs: 120 });
  await setupToReady(svc, fake);
  const controller = new AbortController();
  const events: LiveVoiceInputEvent[] = [];
  const first = await createInputToReady(svc, fake, { streamId: `first-${kind}`, signal: controller.signal, onEvent: (e) => { events.push(e); } });
  if (kind === 'cancel') controller.abort();
  else {
    const finishing = first.end();
    if (kind === 'eof') fake.emit(json({ event: 'final', text: 'first explicit prompt', utteranceId: 'first-final' }));
    else fake.emit(json({ event: 'stopped' }));
    await finishing;
  }
  expect(await svc.status()).toMatchObject({ status: 'ready', consent: 'granted' });
  if (kind !== 'eof') expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: kind === 'cancel' ? 'cancelled' : 'no-speech' }));
  expect(() => first.writePCM(sinePCM(0.064))).toThrow(/closed/);
  const second = await createInputToReady(svc, fake, { streamId: `second-${kind}`, onEvent: () => undefined });
  expect(fake.spawnArgs().filter((args) => args.includes('--authorize'))).toHaveLength(1);
  expect(fake.spawnCount()).toBe(4); // one authorize, diagnostics, two captures
  await first.dispose(); // stale input cannot close/change the newer owner
  expect((await svc.status()).status).toBe('capturing');
  await second.dispose();
  expect((await svc.status()).status).toBe('ready');
  await svc.dispose();
  expect(await svc.status()).toMatchObject({ status: 'closed', consent: 'required' });
});

it.each([2, 3, 1, null])('a genuine helper exit %s AFTER a final/EOF stays fail-closed, never reusable ready', async (code) => {
  const fake = makeFake();
  const { svc } = makeService(fake);
  await setupToReady(svc, fake);
  const events: LiveVoiceInputEvent[] = [];
  const handle = await createInputToReady(svc, fake, { streamId: 'exit-after-final', onEvent: (e) => { events.push(e); } });
  fake.emit(json({ event: 'final', text: 'received a final', utteranceId: 'receipt' }));
  await tick();
  const finish = handle.end();
  fake.exit(code);
  await finish;
  expect((await svc.status()).status).toBe('error');
  expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: code === 2 ? 'speech-permission' : code === 3 ? 'locale-unavailable' : 'helper-exit' }));
  await handle.dispose();
  expect((await svc.status()).status).toBe('error');
  await svc.dispose();
});

it('revocation remains warming/consent-required, even when an old valid capture is closed again', async () => {
  const fake = makeFake();
  const { svc } = makeService(fake);
  await setupToReady(svc, fake);
  const handle = await createInputToReady(svc, fake, { streamId: 'revoked-ready-owner', onEvent: () => undefined });
  await svc.setup({ consent: false });
  await handle.dispose();
  expect(await svc.status()).toMatchObject({ status: 'warming', consent: 'required' });
  await expect(svc.createInput({ streamId: 'must-not-record', onEvent: () => undefined })).rejects.toMatchObject({ code: 'consent-required' });
  await svc.dispose();
  expect((await svc.status()).status).toBe('closed');
});
