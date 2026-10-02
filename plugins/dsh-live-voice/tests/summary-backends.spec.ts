import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVoiceSummaryBackend } from '../src/index.ts'
import {
  DEFAULT_LOCAL_MLX_MODEL_REPO,
  DEFAULT_LOCAL_MLX_MODEL_REVISION,
  LocalMlxSummaryBackend,
  resolveLocalMlxSummaryConfig,
  resolveVoiceSummaryBackend,
} from '../src/summary-backends.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const FAKE_MODEL = path.join(import.meta.dirname, 'fixtures', 'fake-summary-model')
const FAKE_SIDECAR = path.join(import.meta.dirname, 'fixtures', 'fake-mlx-summary.py')

beforeEach(() => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-local-mlx-test-lease-'))
  process.env.DSH_LOCAL_MLX_LEASE_PATH = path.join(directory, 'active.json')
})

afterEach(() => {
  delete process.env.DSH_KOKORO_TEST_START_LOG
  const lease = process.env.DSH_LOCAL_MLX_LEASE_PATH
  if (lease) {
    try { unlinkSync(lease) } catch {}
    try { rmdirSync(path.dirname(lease)) } catch {}
  }
  delete process.env.DSH_LOCAL_MLX_LEASE_PATH
  vi.restoreAllMocks()
})

describe('private voice summary backends', () => {
  it('selects local MLX by default without touching the Harness LLM service', () => {
    const resolveModelInfo = vi.fn()
    const stream = vi.fn()
    const backend = createVoiceSummaryBackend({
      llm: { resolveModelInfo, stream },
      logger: { warn: vi.fn() },
    } as never)

    expect(backend.kind).toBe('local-mlx')
    expect(resolveVoiceSummaryBackend({})).toBe('local-mlx')
    expect(resolveModelInfo).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
  })

  it('keeps the remote Harness adapter as an explicit override only', () => {
    const backend = createVoiceSummaryBackend({
      llm: { resolveModelInfo: vi.fn(), stream: vi.fn() },
      logger: { warn: vi.fn() },
    } as never, { summaryBackend: 'harness-llm' })

    expect(backend.kind).toBe('harness-llm')
    expect(() => resolveVoiceSummaryBackend({ summaryBackend: 'unknown' })).toThrow('Unsupported')
  })

  it('maps local paths independently of planner configuration', () => {
    const config = resolveLocalMlxSummaryConfig({
      summaryRuntimeRoot: '~/custom-summary',
      summaryModelPath: '~/models/base-G9v3-3B',
      summaryIdleMs: 10,
    })

    expect(config.runtimeRoot).toMatch(/\/custom-summary$/)
    expect(config.modelPath).toMatch(/\/models\/base-G9v3-3B$/)
    expect(config.idleMs).toBe(30_000)
  })

  it('requests 154 local tokens for the expanded three-sentence summary budget', async () => {
    const backend = new LocalMlxSummaryBackend({
      runtimeRoot: import.meta.dirname,
      pythonPath: '/usr/bin/python3',
      modelPath: FAKE_MODEL,
      sidecarPath: FAKE_SIDECAR,
      idleMs: 5_000,
    }, { warn: vi.fn() })
    const generatePrompt = vi.spyOn(backend, 'generatePrompt').mockResolvedValue(true)

    await backend.generate(request('expanded summary'), () => undefined, new AbortController().signal)

    expect(generatePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 154 }),
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })

  it('warms once, reuses one process, maps streaming output, and disposes cleanly', async () => {
    mkdirSync(FAKE_MODEL, { recursive: true })
    const backend = new LocalMlxSummaryBackend({
      runtimeRoot: import.meta.dirname,
      pythonPath: '/usr/bin/python3',
      modelPath: FAKE_MODEL,
      sidecarPath: FAKE_SIDECAR,
      idleMs: 5_000,
    }, { warn: vi.fn() })

    await backend.warm()
    const firstPid = backend.status().pid
    const deltas: string[] = []
    const ok = await backend.generate(request('one'), (text) => deltas.push(text), new AbortController().signal)
    await backend.generate(request('two'), () => {}, new AbortController().signal)

    expect(ok).toBe(true)
    expect(deltas.join('')).toBe('Local concise result.')
    expect(firstPid).toBeTypeOf('number')
    expect(backend.status()).toMatchObject({ kind: 'local-mlx', state: 'ready', pid: firstPid })

    await backend.dispose()
    expect(backend.status()).toMatchObject({ state: 'cold' })
  })

  it('coalesces concurrent warm requests into one local model process', async () => {
    const modelPath = mkdtempSync(path.join(tmpdir(), 'dsh-kokoro-summary-model-'))
    const startLog = path.join(modelPath, 'starts.log')
    process.env.DSH_KOKORO_TEST_START_LOG = startLog
    const backend = new LocalMlxSummaryBackend({
      runtimeRoot: import.meta.dirname,
      pythonPath: '/usr/bin/python3',
      modelPath,
      sidecarPath: FAKE_SIDECAR,
      idleMs: 5_000,
    }, { warn: vi.fn() })

    await Promise.all([backend.warm(), backend.warm()])

    expect(readFileSync(startLog, 'utf8').trim().split('\n')).toHaveLength(1)
    await backend.dispose()
  })

  it('cancels an in-flight local request without emitting stale output', async () => {
    mkdirSync(FAKE_MODEL, { recursive: true })
    const backend = new LocalMlxSummaryBackend({
      runtimeRoot: import.meta.dirname,
      pythonPath: '/usr/bin/python3',
      modelPath: FAKE_MODEL,
      sidecarPath: FAKE_SIDECAR,
      idleMs: 5_000,
    }, { warn: vi.fn() })
    await backend.warm()
    const controller = new AbortController()
    const deltas: string[] = []
    const result = backend.generate(request('slow cancellation fixture'), (text) => deltas.push(text), controller.signal)
    setTimeout(() => controller.abort(), 40)

    await expect(result).resolves.toBe(false)
    expect(deltas).toEqual([])
    await backend.dispose()
  })

  it('shuts the warm model down after the configured idle window', async () => {
    mkdirSync(FAKE_MODEL, { recursive: true })
    const backend = new LocalMlxSummaryBackend({
      runtimeRoot: import.meta.dirname,
      pythonPath: '/usr/bin/python3',
      modelPath: FAKE_MODEL,
      sidecarPath: FAKE_SIDECAR,
      idleMs: 25,
    }, { warn: vi.fn() })

    await backend.warm()
    expect(backend.status().state).toBe('ready')
    backend.release()
    await vi.waitFor(() => expect(backend.status().state).toBe('cold'), { timeout: 1_000 })
    await backend.dispose()
  })

  it('keeps G9 cold while the large local main model owns the shared MLX lease', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'dsh-local-mlx-lease-'))
    const lease = path.join(directory, 'active.json')
    process.env.DSH_LOCAL_MLX_LEASE_PATH = lease
    writeFileSync(lease, JSON.stringify({ kind: 'qwen-large', pid: process.pid, createdAt: new Date().toISOString() }))
    mkdirSync(FAKE_MODEL, { recursive: true })
    const backend = new LocalMlxSummaryBackend({ runtimeRoot: import.meta.dirname, pythonPath: '/usr/bin/python3', modelPath: FAKE_MODEL, sidecarPath: FAKE_SIDECAR, idleMs: 5_000 }, { warn: vi.fn() })
    await expect(backend.warm()).rejects.toThrow('local Qwen main model owns MLX memory')
    expect(backend.status()).toMatchObject({ state: 'cold' })
    expect(JSON.parse(readFileSync(lease, 'utf8'))).toMatchObject({ kind: 'qwen-large' })
    await backend.dispose()
  })

  it('keeps G9 cold while the local Ling main model owns the shared MLX lease', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'dsh-local-mlx-ling-lease-'))
    const lease = path.join(directory, 'active.json')
    process.env.DSH_LOCAL_MLX_LEASE_PATH = lease
    writeFileSync(lease, JSON.stringify({ kind: 'ling-tiny', pid: process.pid, createdAt: new Date().toISOString() }))
    mkdirSync(FAKE_MODEL, { recursive: true })
    const backend = new LocalMlxSummaryBackend({ runtimeRoot: import.meta.dirname, pythonPath: '/usr/bin/python3', modelPath: FAKE_MODEL, sidecarPath: FAKE_SIDECAR, idleMs: 5_000 }, { warn: vi.fn() })
    await expect(backend.warm()).rejects.toThrow('local Ling main model owns MLX memory')
    expect(backend.status()).toMatchObject({ state: 'cold' })
    expect(JSON.parse(readFileSync(lease, 'utf8'))).toMatchObject({ kind: 'ling-tiny' })
    await backend.dispose()
  })

  it('keeps G9 cold while the local Ornith main model owns the shared MLX lease', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'dsh-local-mlx-ornith-lease-'))
    const lease = path.join(directory, 'active.json')
    process.env.DSH_LOCAL_MLX_LEASE_PATH = lease
    writeFileSync(lease, JSON.stringify({ kind: 'ornith-9b', pid: process.pid, createdAt: new Date().toISOString() }))
    mkdirSync(FAKE_MODEL, { recursive: true })
    const backend = new LocalMlxSummaryBackend({ runtimeRoot: import.meta.dirname, pythonPath: '/usr/bin/python3', modelPath: FAKE_MODEL, sidecarPath: FAKE_SIDECAR, idleMs: 5_000 }, { warn: vi.fn() })
    await expect(backend.warm()).rejects.toThrow('local Ornith main model owns MLX memory')
    expect(backend.status()).toMatchObject({ state: 'cold' })
    expect(JSON.parse(readFileSync(lease, 'utf8'))).toMatchObject({ kind: 'ornith-9b' })
    await backend.dispose()
  })

  it('fails open at the backend boundary when local artifacts are unavailable', async () => {
    const backend = new LocalMlxSummaryBackend({
      runtimeRoot: import.meta.dirname,
      pythonPath: '/missing/python',
      modelPath: '/missing/model',
      sidecarPath: FAKE_SIDECAR,
      idleMs: 5_000,
    }, { warn: vi.fn() })

    await expect(backend.generate(request('unavailable'), () => {}, new AbortController().signal)).rejects.toThrow()
    expect(backend.status().state).toBe('cold')
    await backend.dispose()
  })

  it('pins the isolated runtime and default quantized model outside git', () => {
    const requirements = readFileSync(path.join(ROOT, 'resources', 'mlx-summary-requirements.txt'), 'utf8')
    const requirementsLock = readFileSync(path.join(ROOT, 'resources', 'mlx-summary-requirements.lock'), 'utf8')
    const installer = readFileSync(path.join(ROOT, 'resources', 'install-mlx-summary.sh'), 'utf8')
    const sidecar = readFileSync(path.join(ROOT, 'resources', 'mlx-summary-sidecar.py'), 'utf8')

    expect(requirements).toContain('mlx-lm==0.31.2')
    expect(requirements).toContain('mlx==0.32.1')
    expect(requirements).toContain('transformers==5.3.0')
    expect(requirementsLock).toContain('mlx-lm==0.31.2')
    expect(requirementsLock).toContain('mlx==0.32.1')
    expect(requirementsLock).toContain('transformers==5.3.0')
    expect(requirementsLock).toContain('--hash=sha256:')
    expect(installer).toContain('mlx-summary-requirements.lock')
    expect(installer).toContain('--require-hashes')
    expect(installer).toContain(DEFAULT_LOCAL_MLX_MODEL_REPO)
    expect(installer).toContain(DEFAULT_LOCAL_MLX_MODEL_REVISION)
    expect(sidecar).toContain('enable_thinking')
    expect(sidecar).toContain('stream_generate')
  })
})

function request(responseText: string) {
  return {
    summaryId: `summary-${responseText}`,
    userText: 'What changed?',
    spokenLead: 'The opening was already spoken.',
    responseText,
  }
}
