import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { createSocket, type Socket } from 'node:dgram';
import type { Context } from '@deepseek-ai/cordis';
import { loadOrCreateIdentity, certPaths, type TlsIdentity } from '../src/cert.ts';
import { ManagedTurnkeyRuntime } from '../src/managed-runtime.ts';
import { TurnkeyStore, newOpaqueId, storePath } from '../src/pairing-store.ts';
import { parseStrictObject } from '../src/json-body.ts';
import { modelValue } from '../src/model-wire.ts';
import { apply, profileStateRoot } from '../src/index.ts';
import type { LiveVoiceWatchService } from '../src/watch-api.ts';

const roots: string[] = [];
const runtimes: ManagedTurnkeyRuntime[] = [];
let identity: TlsIdentity;
function home() { const h = mkdtempSync(path.join(realpathSync(tmpdir()), 'watch-sh-')); roots.push(h); return h; }
beforeAll(async () => { identity = await loadOrCreateIdentity(home()); });
afterEach(async () => { await Promise.all(runtimes.splice(0).map(r => r.dispose())); vi.restoreAllMocks(); });
afterAll(() => { for (const h of roots) rmSync(h, { recursive: true, force: true }); });
function voice(overrides: Partial<LiveVoiceWatchService> = {}): LiveVoiceWatchService {
  return { status: async () => ({ status: 'ready', consent: 'granted', pcm: { encoding: 'pcm16le', sampleRate: 16000, channels: 1 } }),
    setup: async () => ({ status: 'ready', pcm: { encoding: 'pcm16le', sampleRate: 16000, channels: 1 } }),
    createInput: async () => ({ writePCM: () => {}, end: async () => {}, dispose: async () => {} }),
    synthesize: async a => { a.onChunk(new Uint8Array(32)); a.onDone({ speechId: a.speechId }); }, ...overrides };
}
function host(overrides: Record<string, unknown> = {}) {
  return { list: async () => ({ items: ['s1', 's2'].map((sessionId, i) => ({ sessionId, updatedAt: 2 - i, running: false, blank: false, cwd: '/synthetic', projections: { values: { title: `Title ${sessionId}` } } })) }),
    create: async () => ({ sessionId: 's-new' }), inspect: async () => ({ header: {}, events: [] }),
    resolveAgent: async () => ({ agent: { id: 's1', session: { id: 's1' } } }), prompt: async () => ({ accepted: true }),
    selectModel: async (a: unknown) => ({ selected: a }), modelCatalog: async () => ({ default: { provider: 'p', model: 'm' }, routableProviders: ['p'],
      groups: [{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }, { id: 'n', name: 'Next' }] }], failures: [] }),
    page: async () => ({ records: [], hasMore: false }),
    follow: () => (async function* () { yield { type: 'snapshot', header: { id: 's1', createdAt: 1, version: 0, cwd: '/synthetic' }, cursor: 0, records: [], hasMore: false,
      projections: { asOfSeq: 0, values: { modelSelection: { next: null, lastUsed: null }, todos: [{ content: 'A real todo', status: 'in_progress' }] } } }; })(),
    control: () => (async function* () {})(), cancel: () => ({ accepted: true }), updateQueue: () => ({ accepted: true }), ...overrides };
}
function fixture(overrides: Partial<ConstructorParameters<typeof ManagedTurnkeyRuntime>[0]> = {}, bind = true) {
  const h = home(); const store = new TurnkeyStore(h); const secret = newOpaqueId();
  const row = store.createPending({ deviceAlias: 'Synthetic watch', enrollmentSecret: secret }); store.approve(row.requestId, true, 'watch');
  const { token, deviceId } = store.consumeApproved(row.requestId, secret); if (bind) store.setBinding(deviceId, 's1', false);
  const runtime = new ManagedTurnkeyRuntime({ dshHome: h, identity, store, sessionController: host(), liveVoiceWatch: voice(), discoveryPorts: [0], ...overrides });
  runtimes.push(runtime); return { runtime, store, token, deviceId, h };
}
function command(r: ManagedTurnkeyRuntime, body: Record<string, unknown>) { return (r as unknown as { handleCommand: (id: string, b: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleCommand('watch', body); }
function control(r: ManagedTurnkeyRuntime, frame: unknown) { (r as unknown as { applyControlFrame: (f: unknown) => void }).applyControlFrame(frame); }
function snapshot(r: ManagedTurnkeyRuntime) { return (r as unknown as { snapshot: (id: string) => Record<string, unknown> }).snapshot('watch'); }
function cards(r: ManagedTurnkeyRuntime) { return (r as unknown as { approvals: Array<{ id: string; title: string; kind: string }> }).approvals; }
function tick() { return new Promise<void>(resolve => setTimeout(resolve, 0)); }
function tap(r: ManagedTurnkeyRuntime) { const events: Record<string, unknown>[] = [];
  (r as unknown as { sse: Set<unknown> }).sse.add({ deviceId: 'watch', res: { write: (s: string) => { if (s.startsWith('data: ')) events.push(JSON.parse(s.slice(6))); } } }); return events; }
function request(r: ManagedTurnkeyRuntime, token: string, url: string, body?: string, contentType = 'application/json'): Promise<{ status: number; value: Record<string, unknown>; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: r.port, path: url, method: body === undefined ? 'GET' : 'POST', rejectUnauthorized: false,
      headers: { 'x-bridge-token': token, 'x-cert-pin': identity.pin, 'content-type': contentType } }, res => {
      const parts: Buffer[] = []; res.on('data', d => parts.push(d)); res.on('end', () => { const bytes = Buffer.concat(parts); let value = {}; try { value = JSON.parse(bytes.toString()); } catch { /* raw image */ } resolve({ status: res.statusCode!, value, bytes }); });
    }); req.on('error', reject); req.end(body);
  });
}
async function udp(): Promise<Socket> { const socket = createSocket('udp4'); await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve)); return socket; }
async function portClosed(port: number) { return new Promise<boolean>(resolve => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', () => resolve(true)); }); }

describe('private files and atomic one-watch capacity', () => {
  it('builtin TLS bootstrap is private and stable across reloads', async () => {
    const h = home(); const first = await loadOrCreateIdentity(h); const second = await loadOrCreateIdentity(h); expect(second.pin).toBe(first.pin);
    const p = certPaths(h); expect(statSync(p.dir).mode & 0o777).toBe(0o700); expect(statSync(p.certFile).mode & 0o777).toBe(0o600); expect(statSync(p.keyFile).mode & 0o777).toBe(0o600);
  });
  it('rejects symlink ancestors and symlink cert/store files without touching targets', async () => {
    const h = home(); const target = home(); symlinkSync(target, path.join(h, 'dsh-watch'));
    expect(() => new TurnkeyStore(h)).toThrow(/symlink/); await expect(loadOrCreateIdentity(h)).rejects.toThrow(/symlink/);
    const h2 = home(); const store = new TurnkeyStore(h2); const targetFile = path.join(target, 'do-not-touch'); writeFileSync(targetFile, 'unchanged'); symlinkSync(targetFile, storePath(h2));
    expect(() => store.createPending({ deviceAlias: 'W', enrollmentSecret: newOpaqueId() })).toThrow(/symlink/); expect(store.pendingCount()).toBe(0); expect(readFileSync(targetFile, 'utf8')).toBe('unchanged');
    const h3 = home(); mkdirSync(certPaths(h3).dir, { recursive: true }); symlinkSync(targetFile, certPaths(h3).certFile); await expect(loadOrCreateIdentity(h3)).rejects.toThrow(/symlink/);
  });
  it('corrupt/duplicate store data fails actionably instead of resetting authentication', () => {
    const h = home(); new TurnkeyStore(h); writeFileSync(storePath(h), '{broken', { mode: 0o600 }); expect(() => new TurnkeyStore(h)).toThrow(/corrupt.*NOT reset/);
    writeFileSync(storePath(h), '{"pending":{},"devices":{},"tokens":{},"bindings":{},"devices":{}}'); expect(() => new TurnkeyStore(h)).toThrow(/corrupt/);
  });
  it('rolls back BEFORE mutation on failed approval delivery, binding and revoke writes', () => {
    const h = home(); const store = new TurnkeyStore(h); const secret = newOpaqueId(); const pending = store.createPending({ deviceAlias: 'W', enrollmentSecret: secret }); store.approve(pending.requestId, true, 'one');
    const backup = readFileSync(storePath(h), 'utf8'); const target = path.join(home(), 'untouched'); writeFileSync(target, 'safe'); rmSync(storePath(h)); symlinkSync(target, storePath(h));
    expect(() => store.consumeApproved(pending.requestId, secret)).toThrow(/symlink/); expect(store.getPending(pending.requestId)?.consumed).toBe(false); expect(store.listDevicesPublic()).toEqual([]);
    rmSync(storePath(h)); writeFileSync(storePath(h), backup, { mode: 0o600 }); const out = store.consumeApproved(pending.requestId, secret); store.setBinding(out.deviceId, 's1', false);
    const committed = readFileSync(storePath(h), 'utf8'); rmSync(storePath(h)); symlinkSync(target, storePath(h));
    expect(() => store.setBinding(out.deviceId, 'wrong', false)).toThrow(/symlink/); expect(store.getBinding(out.deviceId)?.watchedSessionId).toBe('s1');
    expect(() => store.revoke(out.deviceId)).toThrow(/symlink/); expect(store.deviceForToken(out.token)?.revoked).toBe(false); expect(readFileSync(target, 'utf8')).toBe('safe');
    rmSync(storePath(h)); writeFileSync(storePath(h), committed, { mode: 0o600 }); expect(statSync(storePath(h)).mode & 0o777).toBe(0o600);
  });
  it('parallel approvals reserve one slot; revoke is mandatory before replacement delivery', async () => {
    const store = new TurnkeyStore(home()); const secretA = newOpaqueId(), secretB = newOpaqueId();
    const a = store.createPending({ deviceAlias: 'A', enrollmentSecret: secretA }); const b = store.createPending({ deviceAlias: 'B', enrollmentSecret: secretB });
    const results = await Promise.allSettled([Promise.resolve().then(() => store.approve(a.requestId, true, 'a')), Promise.resolve().then(() => store.approve(b.requestId, true, 'b'))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    const old = store.consumeApproved(a.requestId, secretA); expect(() => store.approve(b.requestId, true, 'b')).toThrow(/one active watch/); expect(store.deviceForToken(old.token)).toBeTruthy();
    store.revoke(old.deviceId); store.approve(b.requestId, true, 'b'); const next = store.consumeApproved(b.requestId, secretB);
    expect(store.deviceForToken(old.token)).toBeUndefined(); expect(store.deviceForToken(next.token)).toBeTruthy(); expect(store.listDevicesPublic().filter(d => !d.revoked)).toHaveLength(1);
    expect(new TurnkeyStore((store as unknown as { file: string }).file.replace('/dsh-watch/turnkey/store.json', '')).deviceForToken(next.token)).toBeTruthy();
  });
});

describe('actual host commands and canonical watch projection', () => {
  it('starts normal no-session watch transport without creating a Mac/watch input', async () => {
    const input = vi.fn(voice().createInput); const create = vi.fn(async () => ({ sessionId: 's-new' }));
    const f = fixture({ sessionController: host({ list: async () => ({ items: [] }), create }), liveVoiceWatch: voice({ createInput: input }) }, false);
    expect(await command(f.runtime, { cmd: 'start', sessionOwnedByApp: true })).toMatchObject({ voiceActive: true }); expect(input).not.toHaveBeenCalled();
    expect(snapshot(f.runtime).voice).toMatchObject({ active: true, phase: 'listening' });
    expect(await command(f.runtime, { cmd: 'new-session', cwd: '/synthetic/project' })).toEqual({ sessionId: 's-new' }); expect(create).toHaveBeenCalledWith({ cwd: '/synthetic/project' });
    await command(f.runtime, { cmd: 'stop' }); expect(snapshot(f.runtime).voice).toMatchObject({ active: false });
  });
  it('creates only real host sessions, validates cwd/workspace exclusivity, never a local fallback id', async () => {
    const create = vi.fn(async () => ({ sessionId: 'created' })); const f = fixture({ sessionController: host({ create }) });
    await command(f.runtime, { cmd: 'new-session', workspaceId: 'workspace' }); expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace' });
    await expect(command(f.runtime, { cmd: 'new-session', cwd: '/x', workspaceId: 'w' })).rejects.toMatchObject({ status: 400 });
    const bad = fixture({ sessionController: undefined }); await expect(command(bad.runtime, { cmd: 'new-session' })).rejects.toMatchObject({ status: 503 }); expect(bad.store.getBinding('watch')?.watchedSessionId).toBe('s1');
    await expect(command(f.runtime, { cmd: 'select-session', sessionId: 'phantom' })).rejects.toMatchObject({ status: 404 });
  });
  it('uses acknowledged SDK queue occurrences and actual steer prompt mode; no local mutation', async () => {
    const updateQueue = vi.fn(() => ({ accepted: true })); const prompt = vi.fn(async () => ({ accepted: true })); const f = fixture({ sessionController: host({ updateQueue, prompt }) });
    await f.runtime.ensureFollowFor('watch'); control(f.runtime, { type: 'queue', sessionId: 's1', items: [{ id: 'real-id', placement: 'queued', message: { content: [{ type: 'text', text: 'Queued' }] } }] });
    await command(f.runtime, { cmd: 'steer', id: 'real-id' }); expect(updateQueue).toHaveBeenCalledWith({ sessionId: 's1', itemId: 'real-id', action: { kind: 'steer' } });
    expect(snapshot(f.runtime).queue).toEqual([{ id: 'real-id', text: 'Queued', state: 'queued' }]);
    await command(f.runtime, { cmd: 'queue-remove', id: 'real-id' }); expect(updateQueue).toHaveBeenLastCalledWith({ sessionId: 's1', itemId: 'real-id', action: { kind: 'remove' } });
    await expect(command(f.runtime, { cmd: 'queue-remove', id: 'real-id', sessionId: 's2' })).rejects.toMatchObject({ status: 409 }); expect(updateQueue).toHaveBeenCalledTimes(2);
    await command(f.runtime, { cmd: 'steer', text: 'New direction', sessionId: 's1' }); expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', mode: 'steer', content: [{ type: 'text', text: 'New direction' }] }), expect.any(AbortSignal));
    await expect(command(f.runtime, { cmd: 'queue-move', id: 'real-id', to: 0 })).rejects.toMatchObject({ status: 501 }); expect(snapshot(f.runtime).features).toMatchObject({ queueReorder: false });
  });
  it('consumes typed host control/workspace baselines into direct wire keys and maps session title', async () => {
    const f = fixture({ sessionController: host({ control: () => (async function* () { yield { type: 'baseline', value: { queues: { s1: [{ id: 'q', placement: 'queued', message: { content: [{ type: 'text', text: 'Q' }] } }] }, jobs: { s1: [{ id: 'j', label: 'Build', kind: 'bash', status: 'running', startedAt: 1 }] }, projections: { s1: { asOfSeq: 0, values: { todos: [{ content: 'Host todo', status: 'completed' }], modelSelection: { next: null, lastUsed: null } } } } } }; })() }),
      workspaceController: { follow: () => (async function* () { yield { type: 'baseline', value: { items: [{ workspaceId: 'w', path: '/synthetic', title: 'Workspace', sessionIds: ['s1'] }], archivedSessionIds: ['archived'] } }; })() } });
    await f.runtime.ensureFollowFor('watch'); await tick(); await f.runtime.start(); await tick();
    const s = snapshot(f.runtime); expect(s.todos).toEqual([{ text: 'Host todo', status: 'completed' }]); expect(s.jobs).toEqual([{ id: 'j', label: 'Build', state: 'running' }]); expect(s.queue).toEqual([{ id: 'q', text: 'Q', state: 'queued' }]); expect(s.workspaces).toHaveLength(1); expect(s.archivedSessionIds).toEqual(['archived']); expect(s.session).toMatchObject({ sessionId: 's1', cwd: '/synthetic' });
    const sessions = await command(f.runtime, { cmd: 'sessions' }); expect(sessions.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 's1', title: 'Title s1', workspaceId: 'w', subagent: false })]));
  });
  it('maps modelId/currentValue and reasoning choices, rejects stale or mismatched caller binding', async () => {
    const selectModel = vi.fn(async (r: Record<string, unknown>) => ({ selected: { provider: r.provider, model: r.model, ...(r.reasoningEffort ? { reasoningEffort: r.reasoningEffort } : {}) } }));
    const f = fixture({ sessionController: host({ selectModel }) }); await f.runtime.ensureFollowFor('watch'); await tick();
    const models = await command(f.runtime, { cmd: 'models', sessionId: 's1' }); expect(models).toMatchObject({ sessionId: 's1', currentValue: modelValue('p', 'm'), options: expect.arrayContaining([expect.objectContaining({ value: modelValue('p', 'm'), modelId: 'm' })]) });
    await command(f.runtime, { cmd: 'set-reasoning', sessionId: 's1', modelId: modelValue('p', 'm'), reasoningEffort: 'effort:high' }); expect(selectModel).toHaveBeenCalledWith({ sessionId: 's1', provider: 'p', model: 'm', reasoningEffort: 'high' });
    await expect(command(f.runtime, { cmd: 'set-model', sessionId: 's2', modelId: modelValue('p', 'n') })).rejects.toMatchObject({ status: 409 });
    await expect(command(f.runtime, { cmd: 'set-model', sessionId: 's1', modelId: 'invented' })).rejects.toMatchObject({ status: 400 });
    await expect(command(f.runtime, { cmd: 'set-model', sessionId: 's1', modelId: modelValue('p', 'm'), reasoningEffort: 'invalid' })).rejects.toMatchObject({ status: 400 }); expect(selectModel).toHaveBeenCalledTimes(1);
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const native = host(); native.modelCatalog = async () => { await gate; return host().modelCatalog(); };
    const stale = fixture({ sessionController: native }); await stale.runtime.ensureFollowFor('watch'); await tick();
    const write = command(stale.runtime, { cmd: 'set-model', sessionId: 's1', modelId: modelValue('p', 'n') }); await tick(); stale.store.setBinding('watch', 's2', false); release(); await expect(write).rejects.toMatchObject({ status: 409 });
  });
  it('uses resolveAgent and the real permission owner, not a guessed Session method', async () => {
    const set = vi.fn(); const f = fixture({ permissionPresets: { names: ['read-only', 'workspace-write'], optionOf: name => ({ value: name, name }), current: () => 'read-only', set } });
    await expect(command(f.runtime, { cmd: 'set-permission', sessionId: 's2', preset: 'read-only' })).rejects.toMatchObject({ status: 409 });
    const result = await command(f.runtime, { cmd: 'set-permission', sessionId: 's1', preset: 'read-only' }); expect(set).toHaveBeenCalledWith({ id: 's1' }, 'read-only'); expect(result.permissions).toMatchObject({ currentValue: 'read-only' });
  });
});

describe('actual harness request callbacks, never fake approvals or auto prompts', () => {
  it('walks multi-question cards and resolves exact question answer DTO only after last explicit answer', async () => {
    const prompt = vi.fn(); const f = fixture({ sessionController: host({ prompt }) }); await f.runtime.ensureFollowFor('watch'); await tick();
    const result = f.runtime.answerQuestionCallback({ agent: { id: 's1' } as never, questions: [{ id: 'one', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }, { id: 'two', question: 'Explain' }] }, () => new Promise(() => {}));
    await tick(); const id = cards(f.runtime)[0]!.id; expect(snapshot(f.runtime).pending).toEqual(expect.arrayContaining([expect.objectContaining({ id, kind: 'ask', title: 'Choose' })]));
    await expect(command(f.runtime, { cmd: 'approve', requestId: id, choiceId: 'invented' })).rejects.toMatchObject({ status: 400 });
    expect(await command(f.runtime, { cmd: 'approve', requestId: id, choiceId: 'A' })).toEqual({ approved: true, done: false }); expect(cards(f.runtime)[0]?.title).toBe('Explain');
    expect(await command(f.runtime, { cmd: 'approve', requestId: id, choiceId: '_free', text: 'Human answer' })).toEqual({ approved: true, done: true });
    expect(await result).toEqual({ answers: [{ id: 'one', selected: ['A'] }, { id: 'two', selected: [], custom: 'Human answer' }] }); expect(prompt).not.toHaveBeenCalled();
    await expect(command(f.runtime, { cmd: 'approve', requestId: id, choiceId: 'A' })).rejects.toMatchObject({ status: 404 });
  });
  it('maps explicit allow/deny to actual outcomes; unavailable Mac answerer does not erase watch request', async () => {
    const f = fixture(); const result = f.runtime.answerApprovalCallback({ agent: { id: 's1' } as never, toolName: 'synthetic_tool', reason: 'Human decision' }, async () => 'unavailable');
    await tick(); const id = cards(f.runtime)[0]!.id; await expect(command(f.runtime, { cmd: 'approve', requestId: id, choiceId: 'approve' })).rejects.toMatchObject({ status: 400 });
    await command(f.runtime, { cmd: 'approve', requestId: id, choiceId: 'rejected' }); expect(await result).toBe('rejected');
  });
  it('Mac answer wins once, foreign sessions delegate, and rebind invalidates outstanding request effects', async () => {
    const f = fixture(); expect(await f.runtime.answerQuestionCallback({ agent: { id: 's2' } as never, questions: [{ id: 'q', question: 'Foreign' }] }, async () => ({ answers: [{ id: 'q', selected: [], custom: 'Mac' }] }))).toMatchObject({ answers: [{ custom: 'Mac' }] }); expect(cards(f.runtime)).toEqual([]);
    expect(await f.runtime.answerApprovalCallback({ agent: { id: 's1' } as never, toolName: 'T' }, async () => 'allowed-once')).toBe('allowed-once'); expect(cards(f.runtime)).toEqual([]);
    const abort = new AbortController(); const pending = f.runtime.answerApprovalCallback({ agent: { id: 's1' } as never, toolName: 'T', signal: abort.signal }, () => new Promise(() => {})); await tick(); const id = cards(f.runtime)[0]!.id;
    f.store.setBinding('watch', 's2', false); await expect(command(f.runtime, { cmd: 'approve', requestId: id, choiceId: 'allowed-once' })).rejects.toMatchObject({ status: 409 }); abort.abort(); expect(await pending).toBe('cancelled'); expect(cards(f.runtime)).toEqual([]);
  });
  it('new capture cancels OUTPUT only and marks validated question input purpose without auto submitting', async () => {
    let speaking!: Parameters<LiveVoiceWatchService['synthesize']>[0];
    const synthesize: LiveVoiceWatchService['synthesize'] = args => { speaking = args; return new Promise((_, reject) => args.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); };
    const createInput = vi.fn(voice().createInput); const cancel = vi.fn(() => ({ accepted: true }));
    const f = fixture({ liveVoiceWatch: voice({ synthesize, createInput }), sessionController: host({ cancel }) }); await f.runtime.start(); const events = tap(f.runtime);
    const question = f.runtime.answerQuestionCallback({ agent: { id: 's1' } as never, questions: [{ id: 'q', question: 'Done?' }] }, () => new Promise(() => {})); await tick(); const requestId = cards(f.runtime)[0]!.id;
    const speech = f.runtime.speak('watch', 'Synthetic question').catch(() => undefined); await tick();
    const started = await request(f.runtime, f.token, '/watch/mic/start', JSON.stringify({ streamId: 'dictation', requestId })); expect(started.status).toBe(200); await speech;
    expect(speaking.signal?.aborted).toBe(true); expect(createInput).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'dictation' })); expect(cancel).not.toHaveBeenCalled(); expect(events.filter(e => e.t === 'audio-done')).toEqual([expect.objectContaining({ cancelled: true })]);
    await f.runtime.dispose(); await question;
  });
});

describe('revocation, draft isolation and terminal receipt truth', () => {
  it('valid draft receipt is explicitly drafted, then revoke removes access without host cancel or replacement leakage', async () => {
    const cancel = vi.fn(() => ({ accepted: true }));
    const f = fixture({ sessionController: host({ cancel }), liveVoiceWatch: voice({ createInput: async a => ({ writePCM: () => {}, end: async () => { await a.onEvent({ kind: 'final', streamId: a.streamId, utteranceId: 'draft-u', text: 'Private unsent human answer' }); }, dispose: async () => {} }) }) });
    await f.runtime.ensureFollowFor('watch'); await tick(); await f.runtime.start();
    const question = f.runtime.answerQuestionCallback({ agent: { id: 's1' } as never, questions: [{ id: 'q', question: 'Answer?' }] }, () => new Promise(() => {})); await tick(); const requestId = cards(f.runtime)[0]!.id;
    expect((await request(f.runtime, f.token, '/watch/mic/start', JSON.stringify({ streamId: 'draft', requestId }))).status).toBe(200);
    const receipt = await request(f.runtime, f.token, '/watch/mic?streamId=draft', String.fromCharCode(0).repeat(32), 'application/octet-stream');
    expect(receipt.value).toMatchObject({ state: 'closed', ackFinals: 0, delivered: false, drafted: true }); expect(snapshot(f.runtime).drafts).toEqual([{ requestId, text: 'Private unsent human answer' }]);
    await f.runtime.revokeDevice('watch'); expect(cancel).not.toHaveBeenCalled(); expect(f.store.getBinding('watch')).toBeUndefined(); await question;
    const secret = newOpaqueId(); const pending = f.store.createPending({ deviceAlias: 'Replacement', enrollmentSecret: secret }); f.store.approve(pending.requestId, true, 'replacement'); f.store.consumeApproved(pending.requestId, secret); f.store.setBinding('replacement', 's1', false);
    const replacement = (f.runtime as unknown as { snapshot: (id: string) => Record<string, unknown> }).snapshot('replacement'); expect(replacement.drafts).toEqual([]);
    expect(await f.runtime.revokeDevice('watch')).toBe(true); expect(f.store.listDevicesPublic().find(d => d.deviceId === 'replacement')?.revoked).toBe(false);
  });
  it('rebind between preflight and question final never drafts, prompts or fabricates an ACK', async () => {
    const prompt = vi.fn(async () => ({ accepted: true })); const f = fixture({ sessionController: host({ prompt }), liveVoiceWatch: voice({ createInput: async a => ({ writePCM: () => {}, end: async () => { await a.onEvent({ kind: 'final', streamId: a.streamId, utteranceId: 'stale-u', text: 'Held stale answer' }); }, dispose: async () => {} }) }) });
    await f.runtime.start(); const question = f.runtime.answerQuestionCallback({ agent: { id: 's1' } as never, questions: [{ id: 'q', question: 'Answer?' }] }, () => new Promise(() => {})); await tick(); const requestId = cards(f.runtime)[0]!.id;
    await request(f.runtime, f.token, '/watch/mic/start', JSON.stringify({ streamId: 'stale', requestId })); f.store.setBinding('watch', 's2', false);
    const receipt = await request(f.runtime, f.token, '/watch/mic?streamId=stale', String.fromCharCode(0).repeat(32), 'application/octet-stream');
    expect(receipt.value).toMatchObject({ state: 'error', ackFinals: 0, delivered: false, code: 'prompt-delivery-failed', retryable: true }); expect(receipt.value.drafted).toBeUndefined(); expect(snapshot(f.runtime).drafts).toEqual([]); expect(prompt).not.toHaveBeenCalled();
    await f.runtime.dispose(); await question;
  });
  it.each(['no-speech', 'recognition-failed'])('terminal %s preserves an error receipt/SSE, never false closed success', async code => {
    const f = fixture({ liveVoiceWatch: voice({ createInput: async a => ({ writePCM: () => {}, end: async () => { await a.onEvent(code === 'no-speech' ? { kind: 'final', streamId: a.streamId, utteranceId: 'silent', text: '' } : { kind: 'error', streamId: a.streamId, code, message: 'Language assets unavailable', retryable: true }); }, dispose: async () => {} }) }) });
    await f.runtime.start(); const events = tap(f.runtime); await request(f.runtime, f.token, '/watch/mic/start', '{"streamId":"error"}');
    const receipt = await request(f.runtime, f.token, '/watch/mic?streamId=error', String.fromCharCode(0).repeat(32), 'application/octet-stream'); expect(receipt.value).toMatchObject({ state: 'error', ackFinals: 0, delivered: false, code, retryable: true }); expect(receipt.value.drafted).toBeUndefined(); expect(events).toContainEqual(expect.objectContaining({ t: 'mic', state: 'error', code }));
  });
  it('active SSE closes and pending input preflight aborts on disposal without ever acknowledging ready', async () => {
    let signal: AbortSignal | undefined; const createInput = vi.fn<LiveVoiceWatchService['createInput']>(async a => { signal = a.signal; await new Promise((_, reject) => a.signal!.addEventListener('abort', () => reject(new Error('disposed')), { once: true })); throw new Error('unreachable'); });
    const f = fixture({ liveVoiceWatch: voice({ createInput }) }); await f.runtime.start();
    let ended!: Promise<void>;
    const sse = https.get({ host: '127.0.0.1', port: f.runtime.port, path: '/watch/stream', rejectUnauthorized: false, headers: { 'x-bridge-token': f.token } });
    await new Promise<void>((resolve, reject) => { sse.once('error', reject); sse.once('response', res => { ended = new Promise(r => res.once('close', r)); res.once('data', () => resolve()); }); });
    const first = request(f.runtime, f.token, '/watch/mic/start', '{"streamId":"pending"}').catch(() => ({ status: 499 })); for (let i = 0; i < 100 && createInput.mock.calls.length === 0; i++) await new Promise(r => setTimeout(r, 10)); expect(createInput).toHaveBeenCalledOnce();
    expect((await request(f.runtime, f.token, '/watch/mic/start', '{"streamId":"pending"}')).status).toBe(409);
    const port = f.runtime.port; await f.runtime.dispose(); await ended; expect(signal?.aborted).toBe(true); expect((await first).status).toBeGreaterThanOrEqual(400); expect(await portClosed(port)).toBe(true);
  });
});

describe('authenticated input-only mic cancellation', () => {
  it('cancels a ready no-POST input once, not another capture, voice, TTS or harness turn', async () => {
    const disposers = new Map<string, ReturnType<typeof vi.fn>>(); const callbacks = new Map<string, Parameters<LiveVoiceWatchService['createInput']>[0]>(); const cancel = vi.fn(() => ({ accepted: true }));
    let ttsSignal: AbortSignal | undefined;
    const f = fixture({ sessionController: host({ cancel }), liveVoiceWatch: voice({ createInput: async a => { const dispose = vi.fn(async () => {}); disposers.set(a.streamId, dispose); callbacks.set(a.streamId, a); return { writePCM: () => {}, end: async () => {}, dispose }; }, synthesize: a => { ttsSignal = a.signal; return new Promise((_, reject) => a.signal!.addEventListener('abort', () => reject(new Error('disposed')), { once: true })); } }) });
    await f.runtime.start(); await command(f.runtime, { cmd: 'start' });
    expect((await request(f.runtime, f.token, '/watch/mic/start', '{"streamId":"old"}')).status).toBe(200);
    expect((await request(f.runtime, f.token, '/watch/mic/start', '{"streamId":"new"}')).status).toBe(200);
    const speech = f.runtime.speak('watch', 'Keep output owned separately').catch(() => {}); await tick(); const before = snapshot(f.runtime).voice;
    const result = await request(f.runtime, f.token, '/watch/command', '{"cmd":"mic-cancel","streamId":"old"}'); expect(result).toMatchObject({ status: 200, value: { ok: true, streamId: 'old', cancelled: true } });
    expect(disposers.get('old')).toHaveBeenCalledOnce(); expect(disposers.get('new')).not.toHaveBeenCalled(); expect(ttsSignal?.aborted).toBe(false); expect(cancel).not.toHaveBeenCalled(); expect(snapshot(f.runtime).voice).toEqual(before);
    expect(await command(f.runtime, { cmd: 'mic-cancel', streamId: 'old' })).toEqual({ streamId: 'old', cancelled: false }); expect(await command(f.runtime, { cmd: 'mic-cancel', streamId: 'missing' })).toEqual({ streamId: 'missing', cancelled: false }); expect(disposers.get('old')).toHaveBeenCalledOnce();
    const prompt = vi.spyOn((f.runtime as unknown as { opts: { sessionController: ReturnType<typeof host> } }).opts.sessionController, 'prompt');
    await callbacks.get('old')!.onEvent({ kind: 'final', streamId: 'old', utteranceId: 'late', text: 'Do not submit after force-abort' }); expect(prompt).not.toHaveBeenCalled();
    expect((await request(f.runtime, f.token, '/watch/mic/start', '{"streamId":"old"}')).status).toBe(409);
    expect((await request(f.runtime, f.token, '/watch/capabilities')).value.features).toMatchObject({ micCancel: true });
    await f.runtime.dispose(); await speech;
  });
  it('rejects unauthenticated, malformed and foreign stream cancellation without touching foreign or current input', async () => {
    const f = fixture(); await f.runtime.start(); const foreign = new AbortController(); const own = new AbortController();
    (f.runtime as unknown as { pendingInputs: Map<string, { abort: AbortController; deviceId: string }> }).pendingInputs.set('foreign', { abort: foreign, deviceId: 'old-device' });
    (f.runtime as unknown as { pendingInputs: Map<string, { abort: AbortController; deviceId: string }> }).pendingInputs.set('own', { abort: own, deviceId: 'watch' });
    expect((await request(f.runtime, 'invalid', '/watch/command', '{"cmd":"mic-cancel","streamId":"own"}')).status).toBe(401);
    expect((await request(f.runtime, f.token, '/watch/command', '{"cmd":"mic-cancel","streamId":"foreign"}')).status).toBe(403);
    await expect(command(f.runtime, { cmd: 'mic-cancel', streamId: '../not-a-stream' })).rejects.toMatchObject({ status: 400 }); expect(foreign.signal.aborted).toBe(false); expect(own.signal.aborted).toBe(false);
    for (let i = 0; i < 257; i++) await command(f.runtime, { cmd: 'mic-cancel', streamId: `bounded-${i}` });
    const internals = f.runtime as unknown as { cancelledMic: Map<string, number>; isMicCancelled: (device: string, stream: string) => boolean };
    expect(internals.cancelledMic.size).toBeLessThanOrEqual(256);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 90_001); expect(internals.isMicCancelled('watch', 'bounded-256')).toBe(false); expect(internals.cancelledMic.size).toBe(0);
  });
  it('aborts an allocated pending native preflight and cannot acknowledge ready afterwards', async () => {
    let entered!: () => void; const started = new Promise<void>(r => { entered = r; }); let signal: AbortSignal | undefined;
    const createInput = vi.fn<LiveVoiceWatchService['createInput']>(async a => { signal = a.signal; entered(); await new Promise((_, reject) => a.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); throw new Error('unreachable'); });
    const f = fixture({ liveVoiceWatch: voice({ createInput }) }); await f.runtime.start(); const preflight = request(f.runtime, f.token, '/watch/mic/start', '{"streamId":"pending-cancel"}'); await started;
    expect(await command(f.runtime, { cmd: 'mic-cancel', streamId: 'pending-cancel' })).toEqual({ streamId: 'pending-cancel', cancelled: true }); expect(signal?.aborted).toBe(true); expect((await preflight).status).toBe(499); expect(createInput).toHaveBeenCalledOnce();
    expect(await command(f.runtime, { cmd: 'mic-cancel', streamId: 'pending-cancel' })).toEqual({ streamId: 'pending-cancel', cancelled: false });
  });
  it('cancel racing backend readiness prevents late native allocation while a new ID remains usable', async () => {
    let entered!: () => void, ready!: () => void; const enteredStatus = new Promise<void>(r => { entered = r; }); const readyStatus = new Promise<void>(r => { ready = r; }); const createInput = vi.fn(voice().createInput);
    const f = fixture({ liveVoiceWatch: voice({ status: async () => { entered(); await readyStatus; return { status: 'ready', consent: 'granted', pcm: { encoding: 'pcm16le', sampleRate: 16000, channels: 1 } }; }, createInput }) }); await f.runtime.start();
    const first = request(f.runtime, f.token, '/watch/mic/start', '{"streamId":"before-native"}'); await enteredStatus;
    expect(await command(f.runtime, { cmd: 'mic-cancel', streamId: 'before-native' })).toEqual({ streamId: 'before-native', cancelled: false }); ready(); expect((await first).status).toBe(409); expect(createInput).not.toHaveBeenCalled();
    expect((await request(f.runtime, f.token, '/watch/mic/start', '{"streamId":"fresh-id"}')).status).toBe(200); expect(createInput).toHaveBeenCalledOnce();
  });
});

describe('managed HTTP, discovery and lifecycle are fail closed', () => {
  it('strict JSON rejects escaped/nested duplicates, wrong content-type and oversized bodies; PCM remains streaming', async () => {
    expect(() => parseStrictObject('{"token":1,"\\u0074oken":2}')).toThrow(/duplicate/); expect(() => parseStrictObject('{"nested":{"x":1,"x":2}}')).toThrow(/duplicate/);
    const f = fixture(); await f.runtime.start();
    expect((await request(f.runtime, f.token, '/watch/command', '{"cmd":"ping","cmd":"start"}')).status).toBe(400);
    expect((await request(f.runtime, f.token, '/watch/command', '{"cmd":"ping"}', 'text/plain')).status).toBe(415);
    expect((await request(f.runtime, f.token, '/watch/command', JSON.stringify({ cmd: 'ping', text: 'x'.repeat(17000) }))).status).toBe(413);
    expect((await request(f.runtime, f.token, '/watch/command', '{"cmd":"start","sessionOwnedByApp":true}')).status).toBe(200);
    expect((await request(f.runtime, f.token, '/watch/mic/start', '{"streamId":"pcm"}')).status).toBe(200);
    expect((await request(f.runtime, f.token, '/watch/mic?streamId=pcm', '\u0000'.repeat(32), 'application/octet-stream')).status).toBe(200);
    expect((await request(f.runtime, f.token, '/watch/capabilities')).value.features).toMatchObject({ queueReorder: false });
  });
  it('uses the next configured private discovery port and fails actionably on exhaustion with no HTTPS leak', async () => {
    const occupied = await udp(); const port = occupied.address().port;
    try {
      const f = fixture({ discoveryPorts: [port, 0] }); await f.runtime.start(); expect(f.runtime.discoveryCollision).toBe(true); expect(f.runtime.discoveryPortActual).not.toBe(port);
      const exhausted = fixture({ discoveryPorts: [port] }); await expect(exhausted.runtime.start()).rejects.toThrow(/All configured discovery ports are occupied/); expect(await portClosed(exhausted.runtime.port)).toBe(true);
      const boundPort = f.runtime.port; await f.runtime.dispose(); await f.runtime.dispose(); expect(await portClosed(boundPort)).toBe(true);
    } finally { occupied.close(); }
  });
  it('only reads attachments authorized by watched session and uses exact safe native opener DTOs', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex'); const attachment = vi.fn(async () => ({ attachment: { mediaType: 'image/png' }, data: png.toString('base64') })); const openWorkspacePath = vi.fn(async (_args: { path: string }, _signal: AbortSignal) => ({ opened: true }));
    const f = fixture({ sessionController: host({ attachment, openWorkspacePath, canOpenWorkspacePath: () => true }) }); await f.runtime.start();
    expect((await request(f.runtime, f.token, '/watch/image?ref=s2%7Cattachment')).status).toBe(404); expect(attachment).not.toHaveBeenCalled();
    const image = await request(f.runtime, f.token, '/watch/image?ref=s1%7Cattachment'); expect(image.status).toBe(200); expect(image.bytes.equals(png)).toBe(true); expect(attachment).toHaveBeenCalledWith({ sessionId: 's1', attachmentId: 'attachment' });
    await command(f.runtime, { cmd: 'open-mac', imageRef: 's1|attachment' }); const opened = openWorkspacePath.mock.calls[0]![0] as { path: string }; expect(opened.path.startsWith(f.h)).toBe(true); expect(statSync(opened.path).mode & 0o777).toBe(0o600);
    await command(f.runtime, { cmd: 'open-mac', url: 'https://example.invalid/article' }); expect(openWorkspacePath).toHaveBeenLastCalledWith({ path: 'https://example.invalid/article' }, expect.any(AbortSignal));
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:password@example.invalid', 'https://example.invalid/?token=secret']) await expect(command(f.runtime, { cmd: 'open-mac', url })).rejects.toMatchObject({ status: 400 }); expect(openWorkspacePath).toHaveBeenCalledTimes(2);
  });
  it('requires genuine profile metadata and registers effect before async initialization can be disposed', async () => {
    const h = home(); expect(profileStateRoot({ baseUrl: `file://${h}/profiles/web/` } as unknown as Context)).toBe(`${h}/profiles/web/`); expect(() => profileStateRoot({} as Context)).toThrow(/profile baseUrl/);
    let dispose!: () => Promise<void>; const register = vi.fn(() => () => {});
    const ctx = { tools: { register }, webServer: { register }, connection: { requestRejection: () => undefined }, sessionController: host(), workspaceController: {}, liveVoiceWatch: voice(), permissionPresets: {},
      effect: (fn: () => () => Promise<void>) => { dispose = fn(); }, on: vi.fn(() => () => {}), logger: () => ({ info: () => {}, error: () => {} }) } as unknown as Context;
    const mounting = apply(ctx, { dshHome: h, discoveryPort: 0 }); expect(dispose).toBeTypeOf('function'); await dispose(); await expect(mounting).rejects.toThrow(/disposed during initialization/); expect(register).not.toHaveBeenCalled();
  });
  it('unwinds real half-start resources if registration fails and permits a fresh hot reload', async () => {
    const h = home(); const owned: ManagedTurnkeyRuntime[] = []; const original = ManagedTurnkeyRuntime.prototype.start;
    vi.spyOn(ManagedTurnkeyRuntime.prototype, 'start').mockImplementation(async function (this: ManagedTurnkeyRuntime) { owned.push(this); return original.call(this); });
    const adminDispose = vi.fn(); const toolDispose = vi.fn(); let tools = 0;
    const ctx = { tools: { register: () => { if (++tools === 2) throw new Error('synthetic registration failure'); return toolDispose; } },
      webServer: { register: () => adminDispose }, connection: { requestRejection: () => undefined }, sessionController: host(), workspaceController: {}, liveVoiceWatch: voice(), permissionPresets: {},
      effect: (fn: () => () => Promise<void>) => fn(), on: () => () => {}, logger: () => ({ info: () => {}, error: () => {} }) } as unknown as Context;
    await expect(apply(ctx, { dshHome: h, discoveryPort: 0 })).rejects.toThrow(/registration failure/); expect(toolDispose).toHaveBeenCalledOnce(); expect(adminDispose).toHaveBeenCalled(); expect(await portClosed(owned[0]!.port)).toBe(true);
    (ctx.tools as unknown as { register: () => () => void }).register = () => toolDispose;
    await apply(ctx, { dshHome: h, discoveryPort: 0 }); await owned[1]!.dispose(); expect(await portClosed(owned[1]!.port)).toBe(true);
  });
});
