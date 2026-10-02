import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readHttpJsonObject } from './http-json.ts'
import { COMMAND_PATH, EVENTS_PATH, SETTINGS_PATH, STATUS_PATH, type KokoroVoiceRuntime } from './runtime.ts'

export const SUMMARY_RELEASE_PATH = '/dsh-kokoro-live-voice/release-summary'

/** Every external route uses the genuine DSH session/Host/Origin gate first.
 * The in-process liveVoiceWatch service deliberately does not use HTTP cookies. */
export function registerVoiceHttpRoutes(
  ctx: Pick<Context, 'connection' | 'webServer'>,
  runtime: Pick<KokoroVoiceRuntime, 'attachEvents' | 'handleCommand' | 'handleSettings' | 'status'>,
  status: () => unknown,
  releaseSummary: () => Promise<void>,
): Array<() => void> {
  type Route = Parameters<Context['webServer']['register']>[0]
  const register = (route: Route) => ctx.webServer.register({
    ...route,
    handler: (req, res) => {
      const rejection = ctx.connection.requestRejection({ headers: req.headers })
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
        return
      }
      return route.handler(req, res)
    },
  })
  return [
    register({ kind: 'exact', path: EVENTS_PATH, handler: (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      runtime.attachEvents(req, res)
    } }),
    register({ kind: 'exact', path: COMMAND_PATH, handler: (req, res) => runtime.handleCommand(req, res) }),
    register({ kind: 'exact', path: SETTINGS_PATH, handler: (req, res) => runtime.handleSettings(req, res) }),
    register({ kind: 'exact', path: STATUS_PATH, handler: (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(JSON.stringify(status()))
    } }),
    register({ kind: 'exact', path: SUMMARY_RELEASE_PATH, handler: async (req, res) => {
      const json = (code: number, error?: string) => {
        res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(error ? { error } : { ok: true }))
      }
      if (req.method !== 'POST') return json(405, 'method not allowed')
      if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers['content-type'] ?? ''))) return json(415, 'content type must be application/json')
      try { await readHttpJsonObject(req) } catch (error) { return json(error instanceof RangeError ? 413 : 400, 'invalid JSON body') }
      const current = runtime.status()
      if (current.event === 'state' && current.active) return json(409, 'Live Voice is active')
      await releaseSummary()
      json(200)
    } }),
  ]
}
