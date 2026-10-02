/**
 * Host-adapter regression tests (H-owned).
 *
 * Proves the EXACT rc1 host surface against a strict fake controller:
 * every call asserts the real request shape AND the real AbortSignal arity
 * (`prompt(request, signal)` with `{ requestId, sessionId, mode, content }`
 * — never `{ sessionId, text }`, never a signal-less `list({})`), binding
 * enforcement runs BEFORE any host RPC, and host errors propagate (never a
 * quiet `[]` catch). Ephemeral resources only; no production ports.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  HostSessionHost,
  asHostSessionPort,
  checkSessionBinding,
  textPromptRequest,
  toSessionId,
  withTimeoutSignal,
} from '../src/host-adapter.ts';

function fullStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    list: async (_req: unknown, _sig: unknown) => ({ items: [] }),
    create: async (_req: unknown) => ({ sessionId: 'sess-new' }),
    inspect: async () => ({ header: {}, events: [] }),
    resolveAgent: async () => ({ agent: { id: 'sess-1' } }),
    prompt: async () => ({ accepted: true as const }),
    selectModel: async () => ({ selected: { provider: 'p', model: 'm' } }),
    modelCatalog: async () => ({ groups: [], failures: [] }),
    page: async () => ({ records: [], hasMore: false }),
    follow: (_req: unknown, _sig: unknown) => (async function* () {})(),
    control: (_sig: unknown) => (async function* () {})(),
    cancel: () => ({ accepted: true as const }),
    ...overrides,
  };
}

describe('host-adapter: exact rc1 request shapes', () => {
  it('textPromptRequest builds { requestId, sessionId, mode, content } (never { sessionId, text })', () => {
    const req = textPromptRequest({ sessionId: 'sess-1', text: 'hello watch' });
    expect(req.sessionId).toBe('sess-1');
    expect(req.mode).toBe('queue');
    expect(typeof req.requestId).toBe('string');
    expect(req.requestId.length).toBeGreaterThan(0);
    expect(req.content).toEqual([{ type: 'text', text: 'hello watch' }]);
    expect(req).not.toHaveProperty('text');
    expect(req).not.toHaveProperty('input');
  });

  it('textPromptRequest honors steer mode and caller requestId; rejects empty text', () => {
    const req = textPromptRequest({ sessionId: 's', text: 'x', mode: 'steer', requestId: 'r1' });
    expect(req.mode).toBe('steer');
    expect(req.requestId).toBe('r1');
    expect(() => textPromptRequest({ sessionId: 's', text: '   ' })).toThrow();
  });

  it('toSessionId brands non-empty strings and throws on empty', () => {
    expect(toSessionId('sess-1')).toBe('sess-1');
    expect(() => toSessionId('')).toThrow();
  });
});

describe('host-adapter: binding atomicity', () => {
  it('checkSessionBinding: missing → 400, none → 409, mismatch → 409, match → ok', () => {
    expect(checkSessionBinding('', 'sess-1')).toEqual({ ok: false, status: 400, error: expect.any(String) });
    expect(checkSessionBinding('sess-1', null)).toEqual({ ok: false, status: 409, error: expect.any(String) });
    expect(checkSessionBinding('intruder', 'sess-1')).toEqual({ ok: false, status: 409, error: expect.any(String) });
    expect(checkSessionBinding('sess-1', 'sess-1')).toEqual({ ok: true });
  });

  it('asHostSessionPort narrows only complete controllers (never as-never)', () => {
    expect(asHostSessionPort(fullStub())).toBeTruthy();
    expect(asHostSessionPort({ list: async () => ({ items: [] }) })).toBeUndefined();
    expect(asHostSessionPort(null)).toBeUndefined();
    expect(asHostSessionPort(undefined)).toBeUndefined();
  });
});

describe('host-adapter: HostSessionHost RPC discipline', () => {
  it('listSessions passes ({}, signal) with a real AbortSignal and returns items', async () => {
    let seenArgs: unknown[] = [];
    const list = async (...args: unknown[]): Promise<{ items: Array<{ sessionId: string }> }> => {
      seenArgs = args;
      return { items: [{ sessionId: 'sess-1' }] };
    };
    const host = new HostSessionHost(asHostSessionPort(fullStub({ list }))!);
    const ctl = new AbortController();
    const items = await host.listSessions(ctl.signal);
    expect(items).toEqual([{ sessionId: 'sess-1' }]);
    expect(seenArgs[0]).toEqual({});
    expect(seenArgs[1]).toBe(ctl.signal);
  });

  it('listSessions propagates host errors (no quiet [] catch)', async () => {
    const host = new HostSessionHost(
      asHostSessionPort(fullStub({ list: async () => { throw new Error('store offline'); } }))!,
    );
    await expect(host.listSessions(new AbortController().signal)).rejects.toThrow('store offline');
  });

  it('submitUserText delivers prompt(request, signal) and enforces binding first', async () => {
    const prompt = vi.fn(async () => ({ accepted: true as const }));
    const host = new HostSessionHost(asHostSessionPort(fullStub({ prompt }))!);
    const signal = new AbortController().signal;
    await host.submitUserText({
      callerSessionId: 'sess-1',
      boundSessionId: 'sess-1',
      text: 'hello',
      signal,
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    const [req, sig] = prompt.mock.calls[0] as unknown as [Record<string, unknown>, AbortSignal];
    expect(req.sessionId).toBe('sess-1');
    expect(req.mode).toBe('queue');
    expect(req.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(typeof req.requestId).toBe('string');
    expect(sig).toBe(signal);

    // Mismatch and missing bindings never reach the host.
    await expect(
      host.submitUserText({ callerSessionId: 'intruder', boundSessionId: 'sess-1', text: 'x', signal }),
    ).rejects.toThrow();
    await expect(
      host.submitUserText({ callerSessionId: '', boundSessionId: 'sess-1', text: 'x', signal }),
    ).rejects.toThrow();
    await expect(
      host.submitUserText({ callerSessionId: 'sess-1', boundSessionId: null, text: 'x', signal }),
    ).rejects.toThrow();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('selectModelFor requires a full selection and passes it through', async () => {
    const selectModel = vi.fn(async (req: unknown) => ({ selected: req }));
    const host = new HostSessionHost(asHostSessionPort(fullStub({ selectModel }))!);
    await expect(
      host.selectModelFor({ callerSessionId: 'sess-1', boundSessionId: 'sess-1', provider: '', model: 'm' }),
    ).rejects.toThrow();
    expect(selectModel).not.toHaveBeenCalled();
    const out = await host.selectModelFor({
      callerSessionId: 'sess-1',
      boundSessionId: 'sess-1',
      provider: 'p',
      model: 'm',
      reasoningEffort: 'high',
    });
    expect(selectModel).toHaveBeenCalledTimes(1);
    expect((selectModel.mock.calls[0] as unknown[])[0]).toEqual({
      sessionId: 'sess-1',
      provider: 'p',
      model: 'm',
      reasoningEffort: 'high',
    });
    expect(out.selected).toBeTruthy();
  });

  it('cancelTurn is binding-checked and synchronous', () => {
    const cancel = vi.fn(() => ({ accepted: true as const }));
    const host = new HostSessionHost(asHostSessionPort(fullStub({ cancel }))!);
    expect(host.cancelTurn({ callerSessionId: 'sess-1', boundSessionId: 'sess-1' })).toEqual({ accepted: true });
    expect(() => host.cancelTurn({ callerSessionId: 'intruder', boundSessionId: 'sess-1' })).toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('host-adapter: withTimeoutSignal', () => {
  it('aborts after the timeout and disposes cleanly', async () => {
    const { signal, dispose } = withTimeoutSignal(20);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(signal.aborted).toBe(true);
    dispose();
  });

  it('inherits a parent abort', () => {
    const parent = new AbortController();
    const { signal, dispose } = withTimeoutSignal(10_000, parent.signal);
    parent.abort(new Error('parent gone'));
    expect(signal.aborted).toBe(true);
    dispose();
  });
});
