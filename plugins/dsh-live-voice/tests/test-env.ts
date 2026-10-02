import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

// Every suite, including subprocess tests, starts without operator DSH/bridge
// state. Child env inheritance can never select the real user's home.
for (const key of Object.keys(process.env)) {
  if (/^(?:DSH_|BRIDGE_)/u.test(key) || key === 'VOICE_SETTINGS_PATH') delete process.env[key]
}
const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-live-voice-tests-')))
process.env.HOME = home
process.env.DSH_HOME = path.join(home, '.dsh')
afterAll(() => rmSync(home, { recursive: true, force: true }))
