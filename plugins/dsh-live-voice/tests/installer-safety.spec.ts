import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')
const resource = (name: string) => path.join(ROOT, 'resources', name)

const INSTALLERS = [
  'install-common.sh',
  'install-live-voice-runtime.sh',
  'install-mlx-summary.sh',
  'install-shared-desktop-launcher.sh',
  'deploy-profile-plugin.sh',
]

function run(script: string, args: string[], env: Record<string, string> = {}): { status: number; output: string } {
  // Scrub ambient DSH/BRIDGE variables: a leaked DSH_HOME (or maintenance
  // confirmation) or BRIDGE_* token/state from the operator shell would
  // silently redirect the sandbox under test at the real home.
  // Explicit per-test values still win. TMPDIR is left to the system
  // default: isolated homes are created under the system temp root, never
  // inside a fake HOME (containment would misclassify nested homes).
  const scrubbed = { ...process.env }
  for (const key of Object.keys(scrubbed)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)
      && (/^DSH_/u.test(key) || /^BRIDGE_/u.test(key) || key === 'VOICE_SETTINGS_PATH' || key === 'DSH_PROFILE')) {
      delete scrubbed[key]
    }
  }
  try {
    const output = execFileSync('bash', [resource(script), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...scrubbed, ...env } as Record<string, string>,
    })
    return { status: 0, output }
  } catch (error) {
    const err = error as { status?: number; stdout?: unknown; stderr?: unknown }
    return {
      status: err.status ?? 1,
      output: `${String(err.stdout ?? '')}\n${String(err.stderr ?? '')}`,
    }
  }
}

describe('installer safety (dry-run default, portable, live refusal)', () => {
  it.each(INSTALLERS)('%s passes bash syntax check', (script) => {
    execFileSync('bash', ['-n', resource(script)])
  })

  it('install-mlx-summary defaults to a dry run that changes nothing', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-home-'))
    try {
      const before = existsSync(path.join(home, 'Library'))
      const result = run('install-mlx-summary.sh', [], {
        HOME: home,
        DSH_KOKORO_SUMMARY_ROOT: path.join(home, 'summary'),
      })
      expect(result.status).toBe(0)
      expect(result.output).toMatch(/Dry run/)
      expect(existsSync(path.join(home, 'Library'))).toBe(before)
      expect(existsSync(path.join(home, 'summary'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('install-mlx-summary refuses model download without explicit opt-in', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-home-'))
    try {
      const result = run('install-mlx-summary.sh', ['--apply'], {
        HOME: home,
        DSH_KOKORO_SUMMARY_ROOT: path.join(home, 'summary'),
      })
      expect(result.status).not.toBe(0)
      expect(result.output).toMatch(/--download-models/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('install-live-voice-runtime refuses model download without explicit opt-in', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-home-'))
    try {
      const result = run('install-live-voice-runtime.sh', ['--apply'], {
        HOME: home,
        DSH_LIVE_VOICE_ROOT: path.join(home, 'live-voice-kokoro'),
      })
      expect(result.status).not.toBe(0)
      expect(result.output).toMatch(/--download-models/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('deploy states the live requirement in dry-run without changing anything', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-home-'))
    try {
      const before = JSON.stringify(listTree(home))
      const homeEnv = { HOME: home, DSH_HOME: path.join(home, '.dsh') }
      const dry = run('deploy-profile-plugin.sh', [], homeEnv)
      expect(dry.status).toBe(0)
      expect(dry.output).toMatch(/Dry run/)
      expect(JSON.stringify(listTree(home))).toBe(before)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('deploy refuses a live profile (default home or state markers) without maintenance confirmation', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-home-'))
    try {
      // Case 1: existing profile inside the default DSH home is live.
      const profile = path.join(home, '.dsh', 'profiles', 'web')
      mkdirSync(profile, { recursive: true })
      writeFileSync(path.join(profile, 'package.json'), '{}\n')
      const refusedDefault = run('deploy-profile-plugin.sh', ['--apply'], { HOME: home, DSH_HOME: path.join(home, '.dsh'), DSH_DEPLOY_SKIP_CHECK: '1' })
      expect(refusedDefault.status).not.toBe(0)
      expect(refusedDefault.output).toMatch(/refusing to target live/)

      // Case 2: harness state markers make a non-default home live too.
      const marked = path.join(home, 'marked-home')
      mkdirSync(path.join(marked, 'sessions'), { recursive: true })
      const refusedMarked = run(
        'deploy-profile-plugin.sh',
        ['--apply', '--dsh-home', marked, '--profile', 'fresh'],
        { HOME: home, DSH_DEPLOY_SKIP_CHECK: '1' },
      )
      expect(refusedMarked.status).not.toBe(0)
      expect(refusedMarked.output).toMatch(/refusing to target live/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('deploy refuses installer defaults (they resolve to the live home)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-home-'))
    try {
      // No --dsh-home/--profile: defaults land in $HOME/.dsh and must refuse.
      // SKIP_CHECK is a recursion fuse only: refusal happens before any check.
      const refused = run('deploy-profile-plugin.sh', ['--apply'], { HOME: home, DSH_DEPLOY_SKIP_CHECK: '1' })
      expect(refused.status).not.toBe(0)
      expect(refused.output).toMatch(/refusing to target live/)
      expect(existsSync(path.join(home, '.dsh'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('an existing bare profile in an isolated home is not live by itself', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-home-'))
    try {
      const dshHome = path.join(home, 'isolated')
      const profile = path.join(dshHome, 'profiles', 'web')
      mkdirSync(profile, { recursive: true })
      writeFileSync(path.join(profile, 'package.json'), '{}\n')
      const homeEnv = { HOME: home, DSH_HOME: dshHome }
      const dry = run('deploy-profile-plugin.sh', [], homeEnv)
      expect(dry.status).toBe(0)
      expect(dry.output).toMatch(/isolated home/)
      // Past the live gate: with checks skipped and a failing dsh stub, the
      // failure must come from the stub — never from a live-target refusal.
      const attempted = run('deploy-profile-plugin.sh', ['--apply'], {
        ...homeEnv,
        DSH_DEPLOY_SKIP_CHECK: '1',
        DSH_DEPLOY_DSH_BIN: '/bin/false',
      })
      expect(attempted.status).not.toBe(0)
      expect(attempted.output).not.toMatch(/refusing to target live/)
      // Rollback left the pre-existing profile metadata untouched.
      expect(readFileSync(path.join(profile, 'package.json'), 'utf8')).toBe('{}\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('deploy refuses when an ambient DSH_HOME points at the real home under a sandboxed HOME', () => {
    let recordedHome = ''
    try {
      recordedHome = execFileSync('python3', ['-c', 'import os, pwd; print(pwd.getpwuid(os.getuid()).pw_dir)'], { encoding: 'utf8' }).trim()
    } catch {
      return // No passwd lookup on this host; the $HOME signal still applies.
    }
    expect(recordedHome).toMatch(/^\//u)
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-home-'))
    try {
      // Regression: an inherited DSH_HOME once smuggled the real home past a
      // $HOME-only liveness check (live gate passed, npx check executed).
      const refused = run('deploy-profile-plugin.sh', ['--apply'], {
        HOME: home,
        DSH_HOME: path.join(recordedHome, '.dsh'),
        DSH_DEPLOY_SKIP_CHECK: '1',
      })
      expect(refused.status).not.toBe(0)
      expect(refused.output).toMatch(/refusing to target live/)
      expect(existsSync(path.join(home, '.dsh'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('deploy refuses profile traversal and symlink escapes outside the DSH home', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-home-'))
    try {
      const dshHome = path.join(home, 'isolated')
      mkdirSync(dshHome, { recursive: true })
      const homeEnv = { HOME: home, DSH_HOME: dshHome }
      const traversed = run('deploy-profile-plugin.sh', ['--apply', '--profile', '../../escaped'], { ...homeEnv, DSH_DEPLOY_SKIP_CHECK: '1' })
      expect(traversed.status).not.toBe(0)
      expect(traversed.output).toMatch(/escapes/)
      expect(existsSync(path.join(home, 'escaped'))).toBe(false)

      // A symlinked DSH home that resolves into the live default home refuses.
      mkdirSync(path.join(home, '.dsh'), { recursive: true })
      symlinkSync(path.join(home, '.dsh'), path.join(home, 'alias-home'))
      const symlinkRefused = run('deploy-profile-plugin.sh', ['--apply', '--dsh-home', path.join(home, 'alias-home'), '--profile', 'fresh'], { HOME: home, DSH_DEPLOY_SKIP_CHECK: '1' })
      expect(symlinkRefused.status).not.toBe(0)
      expect(symlinkRefused.output).toMatch(/refusing to target live/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('canonical paths collapse dot segments for containment decisions', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-home-'))
    try {
      const dshHome = path.join(home, 'isolated')
      mkdirSync(dshHome, { recursive: true })
      const check = (snippet: string): string => {
        try {
          // Scrub ambient DSH_/BRIDGE_ vars before the nested bash: an inherited
          // DSH_HOME from the operator shell would reseed the sourced
          // installer's inherited-home anchor inside the snippet.
          const scrubbed = { ...process.env }
          for (const key of Object.keys(scrubbed)) {
            if (/^DSH_/u.test(key) || /^BRIDGE_/u.test(key)) delete scrubbed[key]
          }
          return execFileSync('bash', ['-c', `SCRIPT_NAME=t; source "${resource('install-common.sh')}"; ${snippet}`], {
            encoding: 'utf8',
            env: { ...scrubbed, HOME: home } as Record<string, string>,
          }).trim()
        } catch (error) {
          const err = error as { stdout?: unknown }
          return String(err.stdout ?? '')
        }
      }
      // canonical_path resolves symlinked parents (macOS /tmp -> /private/tmp).
      const physicalHome = realpathSync(dshHome)
      expect(check(`canonical_path "${dshHome}/profiles/../profiles/web"`)).toBe(path.join(physicalHome, 'profiles', 'web'))
      expect(check(`canonical_path "${dshHome}//profiles/./web/"`)).toBe(path.join(physicalHome, 'profiles', 'web'))
      expect(check(`path_within "${dshHome}" "${dshHome}/profiles/web" && echo within`)).toBe('within')
      expect(check(`path_within "${dshHome}" "${dshHome}-evil" && echo within || echo outside`)).toBe('outside')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('canonical paths resolve symlink/../ physically and handle file-symlink prefixes (synthetic roots only)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-canon-'))
    try {
      const check = (snippet: string, extraEnv: Record<string, string> = {}): string => {
        const scrubbed = { ...process.env }
        for (const key of Object.keys(scrubbed)) {
          if (/^DSH_/u.test(key) || /^BRIDGE_/u.test(key)) delete scrubbed[key]
        }
        try {
          return execFileSync('bash', ['-c', `SCRIPT_NAME=t; source "${resource('install-common.sh')}"; ${snippet}`], {
            encoding: 'utf8',
            env: { ...scrubbed, HOME: home, ...extraEnv } as Record<string, string>,
          }).trim()
        } catch (error) {
          const err = error as { stdout?: unknown; stderr?: unknown }
          return `ERROR:${String(err.stdout ?? '')}${String(err.stderr ?? '')}`
        }
      }
      // Layout: real/ holds f; link -> real (dir symlink); filelink -> real/f.
      const real = path.join(home, 'real')
      mkdirSync(real, { recursive: true })
      writeFileSync(path.join(real, 'f'), 'x\n')
      symlinkSync(real, path.join(home, 'link'))
      symlinkSync(path.join(real, 'f'), path.join(home, 'filelink'))
      const physicalReal = realpathSync(real)
      // symlink/../ must resolve through the symlink target FIRST (lexical
      // resolution would wrongly escape to $home): link/../real/f == real/f.
      expect(check(`canonical_path "${path.join(home, 'link', '..', 'real', 'f')}"`)).toBe(path.join(physicalReal, 'f'))
      // A file symlink as an existing prefix resolves to the file target.
      expect(check(`canonical_path "${path.join(home, 'filelink')}"`)).toBe(path.join(physicalReal, 'f'))
      // Containment cannot be dodged through the symlink parent.
      expect(check(`path_within "${real}" "${path.join(home, 'link', '..', 'real', 'f')}" && echo within || echo outside`)).toBe('within')
      expect(check(`path_within "${real}" "${path.join(home, 'link', '..', 'outside')}" && echo within || echo outside`)).toBe('outside')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('an inherited custom DSH_HOME with live markers is protected (synthetic live root only)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-home-'))
    try {
      // Synthetic "live" home OUTSIDE every home anchor, made live by harness
      // markers at its own root — no real home touched.
      const liveHome = path.join(home, 'custom-live')
      mkdirSync(path.join(liveHome, 'sessions'), { recursive: true })
      const target = path.join(liveHome, 'profiles', 'web')
      mkdirSync(target, { recursive: true })
      // Target inside the inherited live home refuses without confirmation.
      const refused = run('deploy-profile-plugin.sh', ['--apply', '--dsh-home', liveHome, '--profile', 'web'], {
        HOME: home,
        DSH_HOME: liveHome,
        DSH_DEPLOY_SKIP_CHECK: '1',
      })
      expect(refused.status).not.toBe(0)
      expect(refused.output).toMatch(/refusing to target live/)
      // A synthetic isolated home with no markers and no live anchor stays
      // usable: the inherited-home rule must not self-flag it.
      const isolated = path.join(home, 'isolated')
      mkdirSync(path.join(isolated, 'profiles', 'web'), { recursive: true })
      const dry = run('deploy-profile-plugin.sh', [], { HOME: home, DSH_HOME: isolated })
      expect(dry.status).toBe(0)
      expect(dry.output).toMatch(/isolated home/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a synthetic runtime root under the sandbox home is live; bare temp targets are not', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-installer-home-'))
    try {
      const check = (snippet: string): string => {
        const scrubbed = { ...process.env }
        for (const key of Object.keys(scrubbed)) {
          if (/^DSH_/u.test(key) || /^BRIDGE_/u.test(key)) delete scrubbed[key]
        }
        try {
          return execFileSync('bash', ['-c', `SCRIPT_NAME=t; source "${resource('install-common.sh')}"; ${snippet}`], {
            encoding: 'utf8',
            env: { ...scrubbed, HOME: home } as Record<string, string>,
          }).trim()
        } catch {
          return 'ERROR'
        }
      }
      const liveRuntime = path.join(home, 'Library', 'Application Support', 'DeepSeek Harness', 'live-voice-kokoro')
      mkdirSync(liveRuntime, { recursive: true })
      expect(check(`is_live_target "${liveRuntime}" && echo live || echo not-live`)).toBe('live')
      const bare = path.join(home, 'bare-target')
      mkdirSync(bare, { recursive: true })
      expect(check(`is_live_target "${bare}" && echo live || echo not-live`)).toBe('not-live')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('installers stay portable: no embedded personal tool paths', () => {
    for (const script of INSTALLERS) {
      const source = readFileSync(resource(script), 'utf8')
      expect(source).not.toContain('/opt/homebrew/bin/dsh')
      expect(source).not.toMatch(/\/Users\/[a-z_][\w-]*/u)
    }
    const deploy = readFileSync(resource('deploy-profile-plugin.sh'), 'utf8')
    expect(deploy).toContain('--apply')
    expect(deploy).toContain('DSH_WATCH_MAINTENANCE_CONFIRM')
  })
})

function listTree(root: string): string[] {
  const entries: string[] = []
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name)
      entries.push(path.relative(root, full))
      if (!lstatSync(full).isSymbolicLink() && lstatSync(full).isDirectory()) walk(full)
    }
  }
  walk(root)
  return entries.sort()
}
