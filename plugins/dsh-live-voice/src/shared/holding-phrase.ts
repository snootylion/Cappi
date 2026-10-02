import { spokenVoiceSummaryText } from './voice-text.ts'

export function sanitizeHoldingContext(value: string): string {
  return spokenVoiceSummaryText(value.replace(/https?:\/\/\S+/giu, ' '))
    .replace(/[“”"'`][^“”"'`]{2,}[“”"'`]/gu, 'that')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240)
}

export type HoldingPhraseRejectionReason =
  | 'empty'
  | 'forbidden-format'
  | 'unsafe-language'
  | 'punctuation'
  | 'word-count'
  | 'missing-process-verb'
  | 'disallowed-word'

export type HoldingPhraseInspection =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: HoldingPhraseRejectionReason }

const FORBIDDEN_FORMAT = /[\n\r/\\`*_#<>\[\]{}:=+|@~]|https?:|\b[\p{L}\p{N}_-]+\.(?:[cm]?[jt]sx?|py|json|ya?ml|toml|md|sh)\b/iu
const UNSAFE_LANGUAGE = /\b(?:done|fixed|found|result|answer|will|shall|promise|promised|finished|complete|completed|ready|correct|definitely|guarantee|guaranteed)\b|\b(?:i|we)[’']ll\b/iu
const PROCESS_LANGUAGE = /\b(?:check(?:ing)?|review(?:ing)?|compar(?:e|ing)|examin(?:e|ing)|trac(?:e|ing)|assess(?:ing)?|consider(?:ing)?|explor(?:e|ing)|weigh(?:ing)?|think(?:ing)?(?:\s+through)?|look(?:ing)?\s+into|work(?:ing)?\s+through)\b/iu

export function inspectHoldingPhrase(value: string): HoldingPhraseInspection {
  const raw = value.trim()
  if (!raw) return { ok: false, reason: 'empty' }
  if (FORBIDDEN_FORMAT.test(raw)) return { ok: false, reason: 'forbidden-format' }
  if (UNSAFE_LANGUAGE.test(raw)) return { ok: false, reason: 'unsafe-language' }

  const normalized = raw.replace(/^[“”"']+|[“”"']+$/gu, '').replace(/[.!?]+$/u, '').trim()
  if (/[.,;:!?]/u.test(normalized)) return { ok: false, reason: 'punctuation' }

  const words = normalized.match(/[\p{L}\p{N}’'-]+/gu) ?? []
  if (words.length < 4 || words.length > 14) return { ok: false, reason: 'word-count' }
  if (!PROCESS_LANGUAGE.test(normalized)) return { ok: false, reason: 'missing-process-verb' }
  return { ok: true, text: `${normalized}.` }
}

export function validateHoldingPhrase(value: string): string | undefined {
  const inspection = inspectHoldingPhrase(value)
  return inspection.ok ? inspection.text : undefined
}
