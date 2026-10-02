import { execFileSync } from 'node:child_process'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveWatchConfig } from '../src/config.ts'
import {
  BRIDGE_TOKEN_HEADER,
  bridgePinMatches,
  certDerSha256Pin,
  createBridgeFetch,
  type BridgeFetch,
} from '../src/pinned-fetch.ts'

let tempDir = ''
let httpsServer: HttpsServer | null = null
let httpsPort = 0
let httpsPin = ''
let httpsRequests = 0
let httpServer: HttpServer | null = null
let httpPort = 0

function derOf(pem: string): Buffer {
  const b64 = pem.split('\n').filter((line) => !line.includes('-----BEGIN') && !line.includes('-----END')).join('').trim()
  return Buffer.from(b64, 'base64')
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'dsh-watch-pin-'))
  const cert = path.join(tempDir, 'bridge-cert.pem')
  const key = path.join(tempDir, 'bridge-key.pem')
  // Scrub ambient DSH_/BRIDGE_ vars before the nested openssl: fixtures must
  // never depend on the operator shell (openssl ignores these; the scrub is
  // the invariant for every nested subprocess).
  const scrubbed: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^DSH_/u.test(k) || /^BRIDGE_/u.test(k)) continue
    if (v !== undefined) scrubbed[k] = v
  }
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes',
    '-keyout', key, '-out', cert, '-subj', '/CN=pin-test'], { stdio: 'pipe', env: scrubbed })
  const certPem = readFileSync(cert, 'utf8')
  httpsPin = certDerSha256Pin(derOf(certPem))
  httpsServer = createHttpsServer({ cert: certPem, key: readFileSync(key, 'utf8') }, (req, res) => {
    httpsRequests++
    if (req.url === '/watch/redirect') {
      res.writeHead(302, { location: '/watch/capabilities' })
      res.end()
      return
    }
    if (req.headers[BRIDGE_TOKEN_HEADER] !== 'pin-secret') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'bad token' }))
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null }))
    })
  })
  await new Promise<void>((resolve) => httpsServer!.listen(0, '127.0.0.1', resolve))
  httpsPort = (httpsServer.address() as { port: number }).port

  httpServer = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve))
  httpPort = (httpServer.address() as { port: number }).port
}, 30_000)

afterAll(async () => {
  await new Promise<void>((resolve) => httpsServer?.close(() => resolve()) ?? resolve())
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()) ?? resolve())
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

function call(fetchImpl: BridgeFetch, url: string, init?: { method?: string; body?: string }): Promise<{ ok: boolean; status: number; json: unknown }> {
  const controller = new AbortController()
  return fetchImpl(url, {
    method: init?.method ?? 'POST',
    headers: { 'content-type': 'application/json', [BRIDGE_TOKEN_HEADER]: 'pin-secret' },
    body: init?.body ?? JSON.stringify({ action: 'talk_a', sessionId: 'watch-1' }),
    signal: controller.signal,
  }).then(async (res) => ({ ok: res.ok, status: res.status, json: await res.json() }))
}

describe('pinned bridge transport (ephemeral HTTPS, real cert)', () => {
  it('matches pins constant-time and derives the DER-SHA256 convention', () => {
    expect(bridgePinMatches(httpsPin, httpsPin)).toBe(true)
    expect(bridgePinMatches(httpsPin, Buffer.alloc(32, 7).toString('base64'))).toBe(false)
    expect(bridgePinMatches('', httpsPin)).toBe(false)
  })

  it('talks to the pinned bridge with the correct pin', async () => {
    const config = resolveWatchConfig({
      bridgeBaseUrl: `https://127.0.0.1:${httpsPort}`,
      bridgeToken: 'pin-secret',
      bridgeCertPin: `sha256/${httpsPin}`,
    })
    const res = await call(createBridgeFetch(config), `https://127.0.0.1:${httpsPort}/watch/cappi`)
    expect(res.ok).toBe(true)
    expect(res.json).toEqual({ ok: true, echo: { action: 'talk_a', sessionId: 'watch-1' } })
  })

  it('fails closed on a wrong pin and sends nothing (server sees no request)', async () => {
    const seen = httpsRequests
    const config = resolveWatchConfig({
      bridgeBaseUrl: `https://127.0.0.1:${httpsPort}`,
      bridgeToken: 'pin-secret',
      bridgeCertPin: Buffer.alloc(32, 7).toString('base64'),
    })
    await expect(call(createBridgeFetch(config), `https://127.0.0.1:${httpsPort}/watch/cappi`)).rejects.toThrow(/pin mismatch/)
    expect(httpsRequests).toBe(seen)
  })

  it('refuses redirects without following (exactly one request)', async () => {
    const seen = httpsRequests
    const config = resolveWatchConfig({
      bridgeBaseUrl: `https://127.0.0.1:${httpsPort}`,
      bridgeToken: 'pin-secret',
      bridgeCertPin: httpsPin,
    })
    await expect(call(createBridgeFetch(config), `https://127.0.0.1:${httpsPort}/watch/redirect`)).rejects.toThrow(/redirect/)
    expect(httpsRequests).toBe(seen + 1)
  })

  it('refuses token-bearing URLs before any network use', async () => {
    const seen = httpsRequests
    const config = resolveWatchConfig({
      bridgeBaseUrl: `https://127.0.0.1:${httpsPort}`,
      bridgeToken: 'pin-secret',
      bridgeCertPin: httpsPin,
    })
    await expect(
      call(createBridgeFetch(config), `https://127.0.0.1:${httpsPort}/watch/cappi?token=pin-secret`),
    ).rejects.toThrow(/token-bearing URL/)
    expect(httpsRequests).toBe(seen)
  })

  it('keeps explicit loopback http working without a pin (local fixtures only; the default is https+pin)', async () => {
    const config = resolveWatchConfig({
      bridgeBaseUrl: `http://127.0.0.1:${httpPort}`,
      bridgeToken: 'pin-secret',
    })
    const res = await call(createBridgeFetch(config), `http://127.0.0.1:${httpPort}/watch/cappi`)
    expect(res.ok).toBe(true)
  })
})
