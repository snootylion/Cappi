import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HoldingDiagnosticTrace } from '../src/holding-diagnostics.ts'

describe('holding phrase diagnostic trace', () => {
  it('does not create a file while disabled', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'holding-trace-disabled-'))
    const tracePath = path.join(root, 'trace.jsonl')
    const trace = new HoldingDiagnosticTrace(false, tracePath, { warn: vi.fn() })
    trace.record({ event: 'request', requestId: 'one', deadlineMs: 550 })
    await trace.flush()
    await expect(stat(tracePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes only supplied diagnostic fields with user-only permissions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'holding-trace-enabled-'))
    const tracePath = path.join(root, 'trace.jsonl')
    const trace = new HoldingDiagnosticTrace(true, tracePath, { warn: vi.fn() })
    trace.record({
      event: 'generation',
      requestId: 'two',
      backendState: 'ready',
      outcome: 'completed',
      firstDeltaMs: 90,
      completionMs: 140,
      rawPhrase: "I'll look into that.",
      validation: { ok: false, reason: 'disallowed-word' },
    })
    await trace.flush()

    const file = await stat(tracePath)
    const row = JSON.parse((await readFile(tracePath, 'utf8')).trim()) as Record<string, unknown>
    expect(file.mode & 0o777).toBe(0o600)
    expect(row).toMatchObject({ schema: 1, event: 'generation', requestId: 'two' })
    expect(JSON.stringify(row)).not.toMatch(/userText|sanitized|context|cloud|audio/u)
  })

  it('rotates once when the configured byte bound is exceeded', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'holding-trace-rotate-'))
    const tracePath = path.join(root, 'trace.jsonl')
    const trace = new HoldingDiagnosticTrace(true, tracePath, { warn: vi.fn() }, 220)
    trace.record({ event: 'selection', requestId: 'three', source: 'canned', reason: 'deadline', phrase: 'Let me check that carefully.', elapsedMs: 550 })
    trace.record({ event: 'selection', requestId: 'four', source: 'canned', reason: 'deadline', phrase: 'Let me check that carefully.', elapsedMs: 550 })
    await trace.flush()
    await expect(stat(`${tracePath}.1`)).resolves.toBeDefined()
    await expect(stat(tracePath)).resolves.toBeDefined()
  })
})
