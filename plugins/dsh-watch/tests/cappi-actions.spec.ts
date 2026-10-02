import { describe, expect, it } from 'vitest'
import {
  CAPPI_ALLOWLIST,
  checkActionCapability,
  parseCappiInput,
  parseCharacterManifest,
} from '../src/cappi-actions.ts'

describe('cappi input shaping (authority is the bridge, never this list)', () => {
  it('documents the model-facing vocabulary hint without state-owned cues', () => {
    expect(CAPPI_ALLOWLIST).toContain('dance')
    expect(CAPPI_ALLOWLIST).toContain('shadow')
    expect(CAPPI_ALLOWLIST).toContain('celebrate')
    expect(CAPPI_ALLOWLIST).toContain('talk_a')
    expect(CAPPI_ALLOWLIST).toContain('talk2')
    expect(CAPPI_ALLOWLIST).not.toContain('static_hold')
    expect(CAPPI_ALLOWLIST).not.toContain('question')
  })

  it('accepts ids and clear/null (shape only; capabilities resolve later)', () => {
    expect(parseCappiInput({ action: 'dance' })).toEqual({ ok: true, action: 'dance' })
    expect(parseCappiInput({ action: 'celebrate' })).toEqual({ ok: true, action: 'celebrate' })
    expect(parseCappiInput({ action: 'future-pack-id' })).toEqual({ ok: true, action: 'future-pack-id' })
    expect(parseCappiInput({ action: 'clear' })).toEqual({ ok: true, action: null })
    expect(parseCappiInput({ action: null })).toEqual({ ok: true, action: null })
  })

  it('rejects missing, empty, and non-string actions without inventing assets', () => {
    expect(parseCappiInput({})).toEqual({ ok: false, error: 'missing action' })
    expect(parseCappiInput({ action: '' })).toEqual({ ok: false, error: 'bad action' })
    expect(parseCappiInput(null)).toEqual({ ok: false, error: 'bad body' })
    expect(parseCappiInput([])).toEqual({ ok: false, error: 'bad body' })
    expect(parseCappiInput({ action: { url: 'https://example.invalid/x.gif' } })).toEqual({
      ok: false,
      error: 'bad action',
    })
  })
})

describe('manifest capability gating', () => {
  it('passes everything when no manifest is configured', () => {
    expect(checkActionCapability('dance', undefined)).toEqual({ ok: true })
    expect(checkActionCapability(null, undefined)).toEqual({ ok: true })
  })

  it('clear always passes, even with a manifest', () => {
    const parsed = parseCharacterManifest({ actions: { dance: { model_selectable: false } } })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(checkActionCapability(null, parsed.manifest)).toEqual({ ok: true })
    }
  })

  it('honors model_selectable flags in bridge-manifest form', () => {
    const parsed = parseCharacterManifest({
      actions: {
        dance: { model_selectable: true },
        work: { model_selectable: false },
      },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(checkActionCapability('dance', parsed.manifest)).toEqual({ ok: true })
    expect(checkActionCapability('work', parsed.manifest)).toEqual({
      ok: false,
      error: "action 'work' is not model-selectable in the character manifest",
    })
    expect(checkActionCapability('shadow', parsed.manifest)).toEqual({
      ok: false,
      error: "action 'shadow' is not declared in the character manifest",
    })
  })

  it('honors role names in role-pack form', () => {
    const parsed = parseCharacterManifest({
      roles: { dance: ['dot_dance.gif'], idle: ['dot_idle.gif'] },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(checkActionCapability('dance', parsed.manifest)).toEqual({ ok: true })
    expect(checkActionCapability('shadow', parsed.manifest)).toEqual({
      ok: false,
      error: "action 'shadow' has no capability in the character manifest",
    })
  })

  it('fails closed on malformed manifests', () => {
    expect(parseCharacterManifest(null).ok).toBe(false)
    expect(parseCharacterManifest({ pack: 'x' }).ok).toBe(false)
    expect(parseCharacterManifest({ actions: ['dance'] }).ok).toBe(false)
    expect(parseCharacterManifest({ roles: { idle: 'dot_idle.gif' } }).ok).toBe(false)
  })
})
