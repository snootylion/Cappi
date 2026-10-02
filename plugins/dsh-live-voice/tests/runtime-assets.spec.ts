import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')
const resource = (name: string) => path.join(ROOT, 'resources', name)
const TOOLCHAIN = path.join(import.meta.dirname, 'fixtures', 'fake-install-toolchain')

function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
  // Central scrub for every subprocess in this file (REPORT-K incident):
  // strip ambient DSH_* and BRIDGE_* first so an inherited operator-shell
  // DSH_HOME/BRIDGE_TOKEN can never redirect an isolated target at the real
  // home. Explicit per-test synthetic values in `extra` win.
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (!Object.prototype.hasOwnProperty.call(extra, key) && (/^DSH_/u.test(key) || /^BRIDGE_/u.test(key))) delete env[key]
  }
  return { ...env, ...extra } as Record<string, string>
}

function runInstaller(script: string, args: string[], extra: Record<string, string>): { status: number; output: string } {
  try {
    const output = execFileSync('bash', [resource(script), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scrubbedEnv(extra),
    })
    return { status: 0, output }
  } catch (error) {
    const err = error as { status?: number; stdout?: unknown; stderr?: unknown }
    return { status: err.status ?? 1, output: `${String(err.stdout ?? '')}\n${String(err.stderr ?? '')}` }
  }
}

describe('self-contained DSH voice runtime assets', () => {
  it('vendors the complete on-device Apple Speech helper contract', () => {
    const source = readFileSync(resource('dsh-live-voice-input-helper.swift'), 'utf8')
    expect(source).toContain('requiresOnDeviceRecognition = true')
    expect(source).toContain('buffer.format.sampleRate * 0.5')
    expect(source).toContain('finalEmittedForUtterance')
    expect(source).toContain('SFSpeechRecognizer.requestAuthorization')
    expect(source).not.toContain('setVoiceProcessingEnabled(true)')
  })

  it('removes standalone mobile sidebar and menu shadows without changing desktop', () => {
    const source = readFileSync(path.join(ROOT, 'src', 'client', 'styles.ts'), 'utf8')
    expect(source).toContain('@media (display-mode: standalone) and (max-width: 700px)')
    expect(source).toContain('[class*="_sidebarCol"]')
    expect(source).toContain('button[aria-label*="menu" i]')
    expect(source).toContain('box-shadow: none !important')
  })

  it('ships DSH privacy metadata and pinned Kokoro inputs', () => {
    const plist = readFileSync(resource('dsh-live-voice-input-helper-Info.plist'), 'utf8')
    const requirements = readFileSync(resource('kokoro-tts-requirements.txt'), 'utf8')
    const requirementsLock = readFileSync(resource('kokoro-tts-requirements.lock'), 'utf8')
    const modelHashes = readFileSync(resource('kokoro-model-sha256.txt'), 'utf8')
    const installer = readFileSync(resource('install-live-voice-runtime.sh'), 'utf8')
    expect(plist).toContain('ai.deepseek.dsh.live-voice-input')
    expect(plist).toContain('NSMicrophoneUsageDescription')
    expect(plist).toContain('NSSpeechRecognitionUsageDescription')
    expect(requirements).toContain('kokoro-mlx==0.1.2')
    expect(requirements).toContain('mlx==0.32.0')
    expect(requirements).toContain('spacy==3.8.14')
    expect(requirementsLock).toContain('kokoro-mlx==0.1.2')
    expect(requirementsLock).toContain('setuptools==84.0.0')
    expect(requirementsLock).toContain('--hash=sha256:')
    expect(modelHashes).toContain('kokoro-v1_0.safetensors')
    expect(modelHashes).toContain('voices/af_heart.safetensors')
    expect(installer).toContain('kokoro-tts-requirements.lock')
    expect(installer).toContain('kokoro-model-sha256.txt')
    expect(installer).toContain('shasum -a 256 -c')
    expect(installer).toContain('--require-hashes')
    expect(installer).toContain('a71e4d38b236d968966a2002c4c895dbd12b1c3c')
    expect(installer).toContain('dsh-live-voice-input-helper')
    expect(installer).toContain('POCKET_TTS_VERSION="${DSH_POCKET_TTS_VERSION:-3.0.2}"')
    expect(installer).toContain('pocket-tts==$POCKET_TTS_VERSION')
    expect(installer).toContain('pocket-tts-runtime-ready')
    expect(installer).toContain('find "$MODEL_SOURCE" -type l')
    expect(installer).not.toContain('--copy-links')
    expect(installer).not.toMatch(/Applications\/Pi Agent|Application Support\/Pi Agent/u)
    execFileSync('bash', ['-n', resource('install-live-voice-runtime.sh')])
  })

  it('deploys a profile-owned snapshot without worktree links', () => {
    const deploy = readFileSync(resource('deploy-profile-plugin.sh'), 'utf8')
    expect(deploy).toContain('plugins/dsh-live-voice-kokoro')
    expect(deploy).toContain('--exclude=node_modules')
    expect(deploy).toContain('--exclude=.git')
    expect(deploy).not.toContain('--copy-links')
    expect(deploy).toContain('find "$PACKAGE_ROOT"')
    expect(deploy).toContain('link:plugins/dsh-live-voice-kokoro')
    expect(deploy).toContain('DSH_HOME="$DSH_HOME_ROOT"')
    expect(deploy).toContain('DSH_DEPLOY_SKIP_CHECK')
    expect(deploy).toContain('DSH_DEPLOY_DSH_BIN')
    expect(deploy).toContain('PROFILE_METADATA_BACKUP')
    expect(deploy).toContain('node_modules')
    expect(deploy).toContain('realpathSync')
    expect(deploy).toContain('find "$STAGE" -type l')
    execFileSync('bash', ['-n', resource('deploy-profile-plugin.sh')])
  })

  it('restores the plugin and profile metadata when profile installation fails', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-live-voice-deploy-'))
    const dshHome = path.join(root, '.dsh')
    const profile = path.join(dshHome, 'profiles', 'web')
    const plugin = path.join(profile, 'plugins', 'dsh-live-voice-kokoro')
    const originalPackage = '{"dependencies":{"dsh-live-voice-kokoro":"link:plugins/original"}}\n'
    const originalLock = 'original-lock\n'
    const fakeDsh = path.join(root, 'fake-dsh')

    try {
      mkdirSync(plugin, { recursive: true })
      mkdirSync(path.join(root, 'home'), { recursive: true })
      mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
      writeFileSync(path.join(plugin, 'original-marker'), 'original\n')
      writeFileSync(path.join(profile, 'package.json'), originalPackage)
      writeFileSync(path.join(profile, 'pnpm-lock.yaml'), originalLock)
      writeFileSync(path.join(profile, 'node_modules', 'original-marker'), 'original\n')
      writeFileSync(fakeDsh, `#!/usr/bin/env bash
set -eu
profile="$DSH_HOME/profiles/web"
printf '%s\\n' '{"dependencies":{"dsh-live-voice-kokoro":"broken"}}' > "$profile/package.json"
printf '%s\\n' 'broken-lock' > "$profile/pnpm-lock.yaml"
rm -rf "$profile/node_modules"
mkdir -p "$profile/node_modules"
touch "$profile/node_modules/broken-marker"
exit 17
`)
      chmodSync(fakeDsh, 0o755)

      expect(() => execFileSync('bash', [resource('deploy-profile-plugin.sh'), '--apply'], {
        env: scrubbedEnv({
          HOME: path.join(root, 'home'),
          DSH_HOME: dshHome,
          DSH_DEPLOY_SKIP_CHECK: '1',
          DSH_DEPLOY_DSH_BIN: fakeDsh,
        }),
        stdio: 'pipe',
      })).toThrow()
      expect(readFileSync(path.join(plugin, 'original-marker'), 'utf8')).toBe('original\n')
      expect(readFileSync(path.join(profile, 'package.json'), 'utf8')).toBe(originalPackage)
      expect(readFileSync(path.join(profile, 'pnpm-lock.yaml'), 'utf8')).toBe(originalLock)
      expect(readFileSync(path.join(profile, 'node_modules', 'original-marker'), 'utf8')).toBe('original\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('documents the explicit liveness policy and the uid-home escape signal', () => {
    const common = readFileSync(resource('install-common.sh'), 'utf8')
    expect(common).toContain('LIVENESS POLICY')
    expect(common).toContain('os_recorded_home')
    expect(common).toContain('require_within')
    expect(common).toContain('canonical_path')
    const deploy = readFileSync(resource('deploy-profile-plugin.sh'), 'utf8')
    expect(deploy).toContain('require_within')
    expect(deploy).toContain('isolated home')
    execFileSync('bash', ['-n', resource('install-common.sh')])
  })
})

describe('installer --apply against isolated roots (fake toolchain, darwin)', () => {
  it.runIf(process.platform === 'darwin')('install-live-voice-runtime stages helper, kokoro, and pocket artifacts', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-live-voice-apply-'))
    const home = path.join(root, 'home')
    const liveRoot = path.join(home, 'live-voice-kokoro')
    const logDir = path.join(root, 'tool-log')
    mkdirSync(home, { recursive: true })
    try {
      const result = runInstaller('install-live-voice-runtime.sh', ['--apply', '--download-models'], {
        HOME: home,
        DSH_LIVE_VOICE_ROOT: liveRoot,
        DSH_LIVE_VOICE_BOOTSTRAP_PYTHON: path.join(TOOLCHAIN, 'fake-python3.12'),
        FAKE_TOOLCHAIN_LOG_DIR: logDir,
        PATH: `${path.join(TOOLCHAIN, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      })
      expect(result.status).toBe(0)
      expect(result.output).toMatch(/Installed self-contained DSH Live Voice runtime/)
      // Required source/helper/config artifacts, all inside the isolated root.
      expect(existsSync(path.join(liveRoot, 'bin', 'dsh-live-voice-input-helper'))).toBe(true)
      expect(existsSync(path.join(liveRoot, 'kokoro', '.venv', 'bin', 'python'))).toBe(true)
      expect(existsSync(path.join(liveRoot, 'kokoro', 'model', 'config.json'))).toBe(true)
      expect(existsSync(path.join(liveRoot, 'kokoro', 'model', 'kokoro-v1_0.safetensors'))).toBe(true)
      expect(existsSync(path.join(liveRoot, 'kokoro', 'model', 'voices', 'af_heart.safetensors'))).toBe(true)
      expect(existsSync(path.join(liveRoot, 'pocket-tts', '.venv', 'bin', 'python'))).toBe(true)
      // The hash-verification and signing steps ran (faked) — never skipped.
      expect(readFileSync(path.join(logDir, 'shasum.log'), 'utf8')).toMatch(/-c/)
      expect(existsSync(path.join(logDir, 'codesign.log'))).toBe(true)
      // Atomic swap left no staging residue.
      expect(execFileSync('find', [liveRoot, '-name', '.runtime-stage.*', '-o', '-name', '.runtime-backup.*'], { encoding: 'utf8' })).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'darwin')('install-live-voice-runtime refuses a symlinked model source with no partial install', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-live-voice-apply-'))
    const home = path.join(root, 'home')
    const liveRoot = path.join(home, 'live-voice-kokoro')
    const modelSource = path.join(root, 'model-source')
    mkdirSync(path.join(modelSource, 'voices'), { recursive: true })
    writeFileSync(path.join(modelSource, 'config.json'), '{}\n')
    symlinkSync(path.join(modelSource, 'config.json'), path.join(modelSource, 'voices', 'link.safetensors'))
    try {
      const result = runInstaller('install-live-voice-runtime.sh', ['--apply', '--model-source', modelSource], {
        HOME: home,
        DSH_LIVE_VOICE_ROOT: liveRoot,
        DSH_LIVE_VOICE_BOOTSTRAP_PYTHON: path.join(TOOLCHAIN, 'fake-python3.12'),
        PATH: `${path.join(TOOLCHAIN, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      })
      expect(result.status).not.toBe(0)
      expect(result.output).toMatch(/symbolic links/)
      expect(existsSync(path.join(liveRoot, 'bin'))).toBe(false)
      expect(existsSync(path.join(liveRoot, 'kokoro'))).toBe(false)
      expect(existsSync(path.join(liveRoot, 'pocket-tts'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('deploy stages the plugin snapshot and verifies the profile link in an isolated home', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-live-voice-deploy-'))
    const dshHome = path.join(root, 'ux-home')
    const profile = 'web'
    const profileRoot = path.join(dshHome, 'profiles', profile)
    const target = path.join(profileRoot, 'plugins', 'dsh-live-voice-kokoro')
    mkdirSync(profileRoot, { recursive: true })
    writeFileSync(path.join(profileRoot, 'package.json'), '{}\n')
    try {
      const result = runInstaller('deploy-profile-plugin.sh', ['--apply'], {
        HOME: path.join(root, 'home'),
        DSH_HOME: dshHome,
        DSH_DEPLOY_SKIP_CHECK: '1',
        DSH_DEPLOY_DSH_BIN: path.join(TOOLCHAIN, 'fake-dsh'),
        TARGET_DIR: target,
      })
      expect(result.status).toBe(0)
      expect(result.output).toMatch(/Deployed self-contained Live Voice plugin/)
      expect(existsSync(path.join(target, 'package.json'))).toBe(true)
      expect(existsSync(path.join(target, 'resources', 'install-live-voice-runtime.sh'))).toBe(true)
      expect(existsSync(path.join(target, 'lib', 'index.js'))).toBe(true)
      const profilePackage = JSON.parse(readFileSync(path.join(profileRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      expect(profilePackage.dependencies?.['dsh-live-voice-kokoro']).toBe('link:plugins/dsh-live-voice-kokoro')
      const installedLink = path.join(profileRoot, 'node_modules', 'dsh-live-voice-kokoro')
      expect(realpathSync(installedLink)).toBe(realpathSync(target))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
