#!/usr/bin/env node
// bridge.mjs — DSH watch bridge.
//
// Watch ⇄ bridge (token auth, LAN/Tailscale) ⇄ DSH loopback voice runtime + harness API.
// Plus: watch mic PCM → Swift ASR helper → transcripts → prompt queue/steer.
//
// Zero dependencies. Node 26+ (global fetch/WebSocket; the Cookie-on-Upgrade
// handshake is verified only on Node 26 — see docs/connection-security.md).

import { spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import * as dsh from './dsh.mjs'
import { loadBridgeConfig } from './config.mjs'
import { ensurePrivateDir, loadOrCreateToken } from './storage.mjs'
import { createBridgeServer, loadTlsCredentials } from './tls.mjs'
import { extractHeaderToken, queryHasToken, tokenOkTimingSafe, validateOpenMacUrl } from './auth.mjs'
import { startDiscovery } from './discovery.mjs'
import { readJson } from './strict-json.mjs'
import { CHARACTER_FILE_NAME, createCharacterStore, parseCharacterRegistry } from './characters.mjs'
import { createWatchActions } from './watch-actions.mjs'
import { checkSessionBinding } from './session-binding.mjs'
import { protocolHello } from './protocol.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
// External runtime state only (config.mjs): no secrets beside the source tree.
const CONFIG = loadBridgeConfig()

/**
 * Authoritative watch route table (regression anchor: the SSE route is
 * /watch/stream — /watch/events never existed on the bridge).
 */
export const WATCH_ROUTES = Object.freeze([
  'GET /watch/health',
  'GET /watch/stream',
  'GET /watch/state',
  'GET /watch/capabilities',
  'GET /watch/image',
  'POST /watch/mic',
  'POST /watch/command',
  'POST /watch/cappi',
  'GET /watch/pair-probe',
])

/**
 * Testable command-scope decisions (pure, no I/O): the exact binding
 * handleCommand enforces before any harness RPC. Exported so offline tests
 * drive the production decision without sockets or credentials.
 *
 * decideSetPermissionTarget: body.sessionId is REQUIRED (the watch sends its
 * calling session id verbatim); matched against the captured watched id.
 * Returns { ok:true, sessionId } or { ok:false, status, error }.
 *
 * decideApprovalScope: body.sessionId is OPTIONAL (legacy watches omit it).
 * When present it must match the captured watched id; when absent the call
 * stays token-auth only. Never invents a session.
 */
export function decideSetPermissionTarget (body, watched) {
  const bound = checkSessionBinding({ claimed: body?.sessionId, watched })
  if (!bound.ok) return { ok: false, status: bound.status, error: bound.error }
  return { ok: true, sessionId: watched }
}

export function decideApprovalScope (body, watched) {
  const raw = body?.sessionId
  if (raw === undefined || raw === null || String(raw) === '') return { ok: true, sessionId: null }
  const bound = checkSessionBinding({ claimed: raw, watched })
  if (!bound.ok) return { ok: false, status: bound.status, error: bound.error }
  return { ok: true, sessionId: watched }
}
const PORT = CONFIG.port
const DSH_BASE = CONFIG.dshBase
const VOICE_EVENTS = `${DSH_BASE}/dsh-kokoro-live-voice/events`
const VOICE_COMMAND = `${DSH_BASE}/dsh-kokoro-live-voice/command`
const ASR_BIN = join(__dir, 'bin', 'watch-asr')

// ---- token -----------------------------------------------------------------
// Resolved lazily (first request or startup): BRIDGE_TOKEN env or the
// external state-dir file (0600). The pre-release source-tree `token` file
// is consulted read-only for one release cycle to migrate upgraders, then
// ignored — never written. Importing this module never touches credentials.
let TOKEN = null
function bridgeToken () {
  if (!TOKEN) {
    TOKEN = loadOrCreateToken({
      stateDir: CONFIG.stateDir,
      envToken: CONFIG.token,
      legacyPath: join(__dir, 'token'),
    })
  }
  return TOKEN
}
function tokenOk (provided) { return tokenOkTimingSafe(provided, bridgeToken()) }

// ---- shared state ------------------------------------------------------------
const state = {
  voice: { phase: 'idle', active: false, muted: false, message: null, sessionId: null },
  config: null,
  session: { running: false, sessionId: null, cwd: null },
  permissions: null,        // PermissionSelect {options, currentValue} | null
  workspaces: [],           // WorkspaceView rows {workspaceId, path, title, sessionIds}
  helper: { state: 'stopped' },
}
let queue = []            // [{id, text, state:'queued'}]
let pendingApprovals = [] // [{id, kind, title, detail, options, multi}]
let todos = []
let jobs = []
let agents = []
let images = []
let wantVoice = false     // watch asked us to hold a voice lease
let myClientId = `watch-bridge-${randomUUID().slice(0, 8)}`
let myLeaseId = null
const submittedUtterances = new Set() // dedupe finals from both mic paths
const recentSpoken = []               // echo suppression reference (runtime mirror)
let seqCounter = 0
let cappiAction = null // last validated model action for the avatar UI (null = auto)

// ---- character registry binding (B-owned data, read-only) ------------------------
// The canonical registry is characters/registry.json (generated by the watch
// CharacterRegistry.toBridgeJson). It is loaded LAZILY — importing this
// module never touches the filesystem — and cached. The selected pack
// persists in the private state dir (character.json, 0600) so a bridge
// restart recovers the watch's pack; an unknown/stale stored id falls back
// to the registry default (selectCharacterId semantics, never throws).
let CHAR_REGISTRY = null
let charStore = null
let watchActions = null

function characterFilePath () {
  return join(CONFIG.stateDir, CHARACTER_FILE_NAME)
}

function loadCharacterRegistry () {
  if (CHAR_REGISTRY) return CHAR_REGISTRY
  const raw = readFileSync(join(__dir, '..', 'characters', 'registry.json'), 'utf8')
  const parsed = parseCharacterRegistry(JSON.parse(raw))
  if (!parsed.ok) throw new Error(`character registry invalid: ${parsed.error}`)
  CHAR_REGISTRY = parsed.registry
  return CHAR_REGISTRY
}

function readStoredCharacterId () {
  try {
    const value = JSON.parse(readFileSync(characterFilePath(), 'utf8'))
    return typeof value?.characterId === 'string' ? value.characterId : null
  } catch {
    return null
  }
}

function persistCharacterId (id) {
  ensurePrivateDir(CONFIG.stateDir)
  writeFileSync(characterFilePath(), JSON.stringify({ characterId: id }) + '\n', { mode: 0o600 })
}

/** Lazily built character stack (registry + store + domain router). */
function characterStack () {
  if (!watchActions) {
    const registry = loadCharacterRegistry()
    charStore = createCharacterStore({
      registry,
      initialId: readStoredCharacterId(),
      persist: persistCharacterId,
    })
    watchActions = createWatchActions({
      getWatchedSession: () => dsh.getWatchedSessionSync(),
      chars: charStore,
      registry,
      getCappiAction: () => cappiAction,
      setCappiAction: (action) => { cappiAction = action },
      notify: watchSend,
    })
  }
  return watchActions
}

// ---- SSE fan-out to watches ---------------------------------------------------
const watchClients = new Set()
function watchSend (obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`
  for (const res of watchClients) { try { res.write(line) } catch { /* closing */ } }
}
function watchComment (text) { for (const res of watchClients) { try { res.write(`: ${text}\n\n`) } catch {} } }

function snapshot () {
  return {
    voice: state.voice,
    config: state.config,
    session: state.session,
    permissions: state.permissions,
    workspaces: state.workspaces,
    // Active character pack + its callable actions (watch restores the pack
    // after an SSE reconnect; unknown keys are ignored by older watches).
    character: characterStack().describeCapabilities(),
    protocol: protocolHello(),
    // Current turn's visible response: restores the Text screen after an SSE
    // reconnect, watch restart or bridge restart (interim vs final via `done`).
    assistant: dsh.getAssistantState(),
    queue: queue.map(q => ({ id: q.id, text: q.text, state: q.state })),
    todos, jobs, agents, images,
    pending: pendingApprovals,
    helper: state.helper,
    // Present only while a model action holds: reconnecting watches restore it,
    // and its absence never clobbers the watch's own auto schedule.
    ...(cappiAction != null ? { cappiAction } : {}),
  }
}

// ---- DSH loopback voice runtime: upstream SSE ---------------------------------
let upstream = null           // { controller, abort }
let upstreamReady = null      // Promise resolved on first successful connect
let upstreamResolve = null
let upstreamConnected = false

function parseSseChunks () {
  let buf = ''
  return {
    push (chunk, onData, onComment) {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line === '') continue                    // event boundary (default-type)
        if (line.startsWith(':')) { onComment(line.slice(1).trim()); continue }
        if (line.startsWith('data:')) onData(line.slice(5).replace(/^ /, ''))
      }
    },
  }
}

async function connectUpstream () {
  for (;;) {
    try {
      const res = await fetch(`${VOICE_EVENTS}?clientId=${encodeURIComponent(myClientId)}`, {
        headers: { accept: 'text/event-stream' },
      })
      if (!res.ok || !res.body) throw new Error(`upstream ${res.status}`)
      upstreamConnected = true
      if (upstreamResolve) { upstreamResolve(); upstreamResolve = null }
      console.log('[upstream] connected to voice events')
      const parser = parseSseChunks()
      const decoder = new TextDecoder()
      for await (const chunk of res.body) {
        parser.push(decoder.decode(chunk, { stream: true }),
          (data) => {
            try { handleVoiceEvent(JSON.parse(data)) } catch (e) { console.error('[upstream] bad event', e.message) }
          },
          (comment) => { if (comment === 'connected') console.log('[upstream] registered', myClientId) })
      }
      throw new Error('upstream stream ended')
    } catch (e) {
      upstreamConnected = false
      watchSend({ t: 'error', message: `voice link: ${e.message}` })
      // Must reconnect well inside the runtime's 5 s owner-grace window.
      await sleep(400)
    }
  }
}

function ensureUpstream () {
  if (!upstreamReady) {
    upstreamResolve = null
    upstreamReady = new Promise((r) => { upstreamResolve = r })
    connectUpstream()
  }
  return upstreamReady
}

// voice runtime → bridge → watch
function handleVoiceEvent (ev) {
  switch (ev.event) {
    case 'state':
      state.voice = { phase: ev.phase, active: ev.active, muted: ev.muted, message: ev.message ?? null, sessionId: ev.sessionId ?? null }
      watchSend({ t: 'voice', ...state.voice })
      // Resilience: we want a lease; runtime lost it (stop/timeout) → re-take.
      if (wantVoice && !ev.active) scheduleRestartVoice()
      break
    case 'config':
      state.config = { ttsBackend: ev.ttsBackend, locale: ev.locale, voice: ev.voice, speechRate: ev.speechRate }
      watchSend({ t: 'voice-config', ...state.config })
      break
    case 'partial':
    case 'final':
      // Watch remote uses its own explicit mic toggle. The Mac runtime also
      // emits transcripts while providing TTS; do not submit those behind the
      // user's back when the watch microphone is off. Legacy Mac input is opt-in.
      if (CONFIG.watchAcceptMacMic !== true) break
      watchSend({ t: 'asr', kind: ev.event === 'partial' ? 'partial' : 'final', text: ev.text, utteranceId: `mac-${ev.utteranceId}` })
      if (ev.event === 'final') void submitTranscript(ev.text, `mac-${ev.utteranceId}`)
      break
    case 'speech-started':
      watchSend({ t: 'speech-started', speechId: ev.speechId })
      break
    case 'audio':
      watchSend({ t: 'audio', speechId: ev.speechId, sequence: ev.sequence, sampleRate: ev.sampleRate, pcmBase64: ev.pcmBase64 })
      break
    case 'audio-done':
      watchSend({ t: 'audio-done', speechId: ev.speechId, cancelled: ev.cancelled })
      break
    case 'audio-cancel':
      watchSend({ t: 'audio-cancel', speechId: ev.speechId })
      break
    case 'holding-ready':
      // Accept immediately so the runtime speaks the filler phrase.
      void voiceCommand({ command: 'accept-holding', clientId: myClientId, leaseId: myLeaseId, requestId: ev.requestId })
      break
    case 'summary-delta':
    case 'summary-done':
      // Owner-client routed on the VOICE SSE — the summarize result bus (they
      // never arrive on dsh events; dropping them lost every long tail).
      handleVoiceSummaryEvent(ev)
      break
    case 'ownership-revoked':
      // Runtime sends the OLD revoked lease ID, including when we replace our own lease.
      // A delayed revocation must not erase the newly acquired lease.
      if (ev.leaseId !== myLeaseId) break
      console.warn('[voice] current lease revoked')
      wantVoice = false // do not fight an intentional takeover by another client
      myLeaseId = null
      watchSend({ t: 'error', message: 'Voice taken over by another client (browser UI?).' })
      break
    case 'dictate-partial':
    case 'dictate-final':
    case 'dictate-error':
      break // we use live mode only
    default:
      break
  }
}

// ---- voice commands (loopback POST) --------------------------------------------
async function voiceCommand (body) {
  const res = await fetch(VOICE_COMMAND, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(json.error || `voice command ${res.status}`)
    err.status = res.status
    throw err
  }
  return json
}

let restartTimer = null
function scheduleRestartVoice () {
  if (restartTimer) return
  restartTimer = setTimeout(async () => {
    restartTimer = null
    if (!wantVoice) return
    try { await startVoice() } catch (e) { console.error('[voice] restart failed', e.message) }
  }, 1000)
}

let voiceStartPromise = null
async function startVoice () {
  if (voiceStartPromise) return voiceStartPromise
  if (myLeaseId && state.voice.active && wantVoice) return
  voiceStartPromise = acquireVoiceLease()
  try { await voiceStartPromise } finally { voiceStartPromise = null }
}

async function acquireVoiceLease () {
  await ensureUpstream()
  await upstreamReady
  await sleep(150) // let the (re)registration settle
  myLeaseId = randomUUID()
  state.session.sessionId = state.session.sessionId || 'watch-remote'
  try {
    await voiceCommand({ command: 'start', sessionId: state.session.sessionId, clientId: myClientId, leaseId: myLeaseId })
    wantVoice = true
    console.log('[voice] started lease', myLeaseId)
  } catch (e) {
    if (e.status === 409) { // SSE not yet known to runtime — retry once
      await sleep(350)
      await voiceCommand({ command: 'start', sessionId: state.session.sessionId, clientId: myClientId, leaseId: myLeaseId })
      wantVoice = true
      console.log('[voice] started lease (retry)', myLeaseId)
    } else throw e
  }
}

async function stopVoice () {
  wantVoice = false
  if (!myLeaseId) return
  try { await voiceCommand({ command: 'stop', clientId: myClientId, leaseId: myLeaseId }) } catch { /* already gone */ }
  myLeaseId = null
}

function requireLease () { if (!myLeaseId) throw Object.assign(new Error('voice session not active'), { status: 409 }) }

// ---- TTS speak planner (visible assistant text → speak/summarize) ------------------
// Mirrors the reference client's ResponseSpeechPlanner against the bridge's
// cumulative turn text: the first two completed sentences of a step speak
// eagerly; an assistant-flush (the step's tools starting) says everything still
// held verbatim; the final unsent tail speaks directly when short, otherwise it
// is summarized (≤3 sentences / ≤45 words) with a verbatim fail-open. The
// spoken boundary is an exact character offset into the cumulative text, so
// reconnect baselines, replayed events and duplicate turns never re-speak a
// prefix — and only text already shown on the watch is ever spoken.

const SUMMARY_MAX_SENTENCES = 3
const SUMMARY_MAX_WORDS = 45
const SPEECH_SENTENCE_MAX_WORDS = 80

let lastUserText = ''

function rememberSpoken (text) {
  const clean = text.trim().toLowerCase().replace(/\s+/g, ' ')
  if (clean) { recentSpoken.push(clean); if (recentSpoken.length > 32) recentSpoken.shift() }
}
function looksLikeEcho (text) {
  const BARGE = /^(stop|wait|pause|cancel|quiet|no|hold on|hang on)$/i
  const words = text.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) || []
  if (words.length === 0) return false
  if (words.length === 1) return recentSpoken.includes(words[0]) && !BARGE.test(text.trim())
  if (BARGE.test(text.trim())) return false
  const set = new Set(words)
  return recentSpoken.some((spoken) => {
    const sw = new Set(spoken.split(' '))
    let inter = 0; for (const w of set) if (sw.has(w)) inter++
    return inter / Math.max(set.size, sw.size) >= 0.8
  })
}

/** Visible markdown → speakable prose (reference voice-text subset): no code
 *  fences, URLs, emphasis glyphs or NULs — never a tool payload either way. */
function spokenText (text) {
  let out = String(text ?? '')
  out = out.replace(/\u0000/g, '')
  out = out.replace(/```[\s\S]*?```/g, ' ')
  out = out.replace(/~~~[\s\S]*?~~~/g, ' ')
  out = out.replace(/`([^`\n]*)`/g, ' ')
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  out = out.replace(/<https?:\/\/[^>\s]+>/gi, ' ')
  out = out.replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, ' ')
  out = out.replace(/(?:^|\s)#{1,6}\s+/g, ' ')
  out = out.replace(/^\s*[-*+]\s+/gm, ' ')
  out = out.replace(/^\s*\d+[.)]\s+/gm, ' ')
  out = out.replace(/\*\*|__|~~|[*_|]/g, ' ')
  return out.replace(/\s+/g, ' ').trim()
}

function limitWords (value, max = SPEECH_SENTENCE_MAX_WORDS) {
  const words = value.split(/\s+/).filter(Boolean)
  if (words.length <= max) return value.trim()
  return `${words.slice(0, max).join(' ').replace(/[,:;\-]+$/, '')}.`
}

function insideWebToken (value, index) {
  let start = index
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1
  const token = value.slice(start, index + 1)
  if (!/^(?:https?:\/\/|www\.)/i.test(token)) return false
  return value[index] !== '.' || value[index + 1] === undefined
}

/** Completed speakable sentences of `region`, with region offsets. */
function extractSentences (region) {
  const sentences = []
  let start = 0
  const push = (end) => {
    const spoken = spokenText(region.slice(start, end))
    if (spoken) sentences.push({ text: limitWords(spoken), start, end })
    start = end
  }
  for (let i = 0; i < region.length; i++) {
    const ch = region[i]
    if (ch === '\n') { push(i + 1); continue }
    if (ch === '.' || ch === '!' || ch === '?') {
      if (insideWebToken(region, i)) continue
      const next = region[i + 1]
      if (next === undefined || /\s/.test(next)) push(i + 1)
    }
  }
  return { sentences, remainderStart: start }
}

function commonPrefixLen (a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

export function createSpeakPlanner ({
  speak,
  canSpeak = () => true,
  summarize,
  onSummary = null,
  userText = () => '',
  idMint = () => randomUUID(),
  maxDirectTailChars = 400,
  maxSummarySentences = SUMMARY_MAX_SENTENCES,
  maxSummaryWords = SUMMARY_MAX_WORDS,
  maxSummarySourceChars = 32000,
  maxContextChars = 4000,
}) {
  let generation = 0
  let chain = Promise.resolve()   // strict FIFO: speak commands never interleave
  let st = freshPlannerState()

  function freshPlannerState () {
    return {
      text: '',           // last cumulative turn text seen
      spokenChars: 0,     // chars of `text` already delivered verbatim
      sentenceCount: 0,   // eager sentences spoken in the current step block
      openings: 0,        // eager sentences spoken this turn (handoff math)
      finalized: false,
      streamed: false,    // any text seen this turn (drives reconnect baselines)
      seen: new Set(),    // normalized utterances spoken this turn (hard dedupe)
      pending: null,      // { id, source, buf, mirror, sentences, words, spoke, leadCount, openings }
    }
  }

  /** Queue one utterance: FIFO, hard-deduped, dropped if the turn reset first. */
  function say (textRaw, opts) {
    const clean = String(textRaw ?? '').trim()
    if (!clean) return chain
    const norm = clean.toLowerCase().replace(/\s+/g, ' ')
    if (st.seen.has(norm)) return chain
    st.seen.add(norm)
    const gen = generation
    chain = chain.then(async () => {
      if (gen !== generation) return   // reset/replaced turn: never replay stale speech
      if (!canSpeak()) return
      await speak(clean, opts)
    }).catch(() => {})
    return chain
  }

  /** Keep the spoken boundary valid across cumulative rewrites/shrinks. */
  function reconcileText (textRaw) {
    const text = typeof textRaw === 'string' ? textRaw : ''
    if (!text.startsWith(st.text)) {
      const lcp = commonPrefixLen(st.text, text)
      st.spokenChars = Math.min(st.spokenChars, lcp)
    }
    st.text = text
    if (text) st.streamed = true
  }

  /** Eagerly speak completed sentences while the block's two-sentence cap allows. */
  function feedEager () {
    const base = st.spokenChars
    const region = st.text.slice(base)
    if (!region) return
    const { sentences } = extractSentences(region)
    for (const s of sentences) {
      if (st.sentenceCount >= 2) break
      st.sentenceCount += 1
      st.openings += 1
      const abs = base + s.end
      if (abs > st.spokenChars) st.spokenChars = abs
      say(s.text)
    }
  }

  function feed (textRaw) {
    if (st.finalized) return
    reconcileText(textRaw)
    feedEager()
  }

  /** Tool boundary: this step's streamed prose is complete — say all of it. */
  function flushBlock () {
    if (st.finalized) return
    const region = st.text.slice(st.spokenChars)
    if (region.trim()) {
      const { sentences, remainderStart } = extractSentences(region)
      for (const s of sentences) say(s.text)
      const fragment = spokenText(region.slice(remainderStart))
      if (fragment) say(limitWords(fragment))
      st.spokenChars = st.text.length
    }
    st.sentenceCount = 0   // the next step block may open with two fresh sentences
  }

  function sayVerbatim (textRaw) {
    const { sentences, remainderStart } = extractSentences(textRaw)
    for (const s of sentences) say(s.text)
    const fragment = spokenText(textRaw.slice(remainderStart))
    if (fragment) say(limitWords(fragment))
  }

  async function finalize (textRaw) {
    if (st.finalized) return
    reconcileText(textRaw)
    st.finalized = true
    feedEager()   // finish the eager lead — short replies end right here
    const tailRaw = st.text.slice(st.spokenChars)
    const tail = spokenText(tailRaw)
    if (!tail || !canSpeak()) return
    if (tail.length <= maxDirectTailChars) { say(tail); return }
    // Long tail: summarize exactly what has NOT been spoken (reference: the
    // remainder after the lead), then stream the result sentence by sentence.
    const lead = spokenText(st.text.slice(0, st.spokenChars)).slice(0, maxContextChars)
    const source = tail.slice(0, maxSummarySourceChars)
    const pending = {
      id: idMint(), source, buf: '', mirror: '',
      sentences: 0, words: 0, spoke: false,
      leadCount: st.sentenceCount, openings: st.openings,
    }
    st.pending = pending
    const ctx = String(userText() ?? '').replace(/\u0000/g, '').slice(0, maxContextChars)
    try {
      await summarize({
        summaryId: pending.id,
        responseText: source,
        spokenLead: lead,
        userText: ctx,
      })
    } catch {
      // Summarization unavailable → fail open to the held visible prose.
      if (st.pending === pending) { st.pending = null; sayVerbatim(source) }
    }
  }

  function speakSummarySentence (p, textRaw) {
    if (p.sentences >= maxSummarySentences || p.words >= maxSummaryWords) return false
    const normalized = spokenText(textRaw)
    if (!normalized) return true
    const words = normalized.split(/\s+/).filter(Boolean)
    const remaining = maxSummaryWords - p.words
    const bounded = words.length <= remaining
      ? normalized
      : `${words.slice(0, remaining).join(' ').replace(/[,:;\-]+$/, '')}.`
    if (!bounded) return false
    say(bounded, { summaryHandoff: !p.spoke && p.leadCount === 1 && p.openings > 1 })
    p.sentences += 1
    p.words += Math.min(words.length, remaining)
    p.spoke = true
    return p.sentences < maxSummarySentences && p.words < maxSummaryWords
  }

  function handleSummaryDelta (id, delta) {
    const p = st.pending
    if (!p || id !== p.id || !delta) return
    p.mirror += delta
    onSummary?.(p.mirror, false)
    if (p.sentences >= maxSummarySentences || p.words >= maxSummaryWords) return
    p.buf += delta
    const { sentences, remainderStart } = extractSentences(p.buf)
    let consumed = 0
    for (const s of sentences) {
      if (!speakSummarySentence(p, s.text)) { p.buf = p.buf.slice(consumed); return }
      consumed = s.end
    }
    p.buf = p.buf.slice(remainderStart)
  }

  function finishSummary (id, ok) {
    const p = st.pending
    if (!p || id !== p.id) return
    st.pending = null
    onSummary?.(p.mirror, true)
    if (ok && p.sentences < maxSummarySentences && p.words < maxSummaryWords) {
      const fragment = spokenText(p.buf)
      if (fragment) speakSummarySentence(p, fragment)
    }
    if (!p.spoke) sayVerbatim(p.source)   // fail open: read the held visible prose
  }

  /**
   * Follow-open snapshot: reconcile the planner with the authoritative transcript.
   * Fresh planner + existing history → adopt as an already-delivered baseline
   * (no re-narration of history after a bridge restart). Mid-stream → continue.
   * done → finalize only if this turn's speech had already begun; a fresh
   * planner adopts the final silently (no stale narration after a restart).
   */
  async function reconcile (textRaw, done) {
    const text = typeof textRaw === 'string' ? textRaw : ''
    if (done) {
      if (st.finalized) return
      if (!st.streamed) {
        st.text = text
        st.spokenChars = text.length
        st.finalized = true
        return
      }
      await finalize(text)
      return
    }
    if (st.finalized) return
    if (!st.streamed && text) {
      st.text = text
      st.spokenChars = text.length
      st.streamed = true
      return
    }
    feed(text)
  }

  function reset () {
    generation += 1   // in-flight queued utterances observe the new generation and drop
    st = freshPlannerState()
  }

  return {
    feed,
    flushBlock,
    finalize,
    reconcile,
    reset,
    handleSummaryDelta,
    finishSummary,
    idle: () => chain,
    state: () => ({
      text: st.text, spokenChars: st.spokenChars,
      sentenceCount: st.sentenceCount, finalized: st.finalized, streamed: st.streamed,
      pending: st.pending?.id ?? null,
    }),
  }
}

let lastSpeechError = null // { message, at } — surface each distinct failure once/min

async function speakNow (text, opts = {}) {
  const { strict = false, ...voiceOpts } = opts
  const body = text.trim().slice(0, 4000)
  if (!body) return
  try {
    requireLease()
    if (!state.voice.active) throw Object.assign(new Error('voice session not active'), { status: 409 })
    await voiceCommand({ command: 'speak', clientId: myClientId, leaseId: myLeaseId, text: body, kind: 'response', ...voiceOpts })
    rememberSpoken(body)
    lastSpeechError = null
  } catch (e) {
    if (strict) throw e // explicit sound tests must never report success without accepting speech
    console.error('[speak]', e.message)   // always logged, never hidden
    if (!wantVoice && /lease|voice session/i.test(e.message)) return  // voice deliberately off/revoked
    const now = Date.now()
    const repeat = lastSpeechError && lastSpeechError.message === e.message && now - lastSpeechError.at < 60000
    if (!repeat) {
      lastSpeechError = { message: e.message, at: now }
      watchSend({ t: 'error', message: `Speech unavailable: ${e.message}` })  // ring once, not per sentence
    }
  }
}

// ---- assistant → watch + speech wiring ----------------------------------------------
// `{t:'assistant', text, done}` is authoritative cumulative state: interim
// (done:false), final (done:true) or clear (text:''). Deduped so reconnect
// snapshots don't churn the watch, resets always go out.

let lastAssistantSent = null
function sendAssistantEvent (text, done) {
  const key = `${done ? 1 : 0}:${text}`
  if (key === lastAssistantSent) return
  lastAssistantSent = key
  watchSend({ t: 'assistant', text, done })
}

function onAssistantDelta (text) {
  sendAssistantEvent(text, false)
  speakPlanner.feed(text)
}
async function onAssistantDone (text) {
  sendAssistantEvent(text, true)
  state.session.running = false
  await speakPlanner.finalize(text)
  flushQueueSoon()
}
function onAssistantSnapshot (text, done) {
  const isDone = Boolean(done)
  sendAssistantEvent(text, isDone)
  void speakPlanner.reconcile(text, isDone)
}
function onAssistantReset () {
  lastAssistantSent = null      // a clear must reach the watch even after ''
  sendAssistantEvent('', false)
  speakPlanner.reset()
}
function onAssistantFlush () { speakPlanner.flushBlock() }

// Summary progress arrives on the VOICE SSE (owner-client routed), not dsh events.
function handleVoiceSummaryEvent (ev) {
  if (ev.event === 'summary-delta') speakPlanner.handleSummaryDelta(ev.summaryId, typeof ev.text === 'string' ? ev.text : '')
  else if (ev.event === 'summary-done') speakPlanner.finishSummary(ev.summaryId, ev.ok === true)
}

const speakPlanner = createSpeakPlanner({
  speak: (text, opts) => speakNow(text, opts),
  canSpeak: () => Boolean(wantVoice && myLeaseId && state.voice.active),
  summarize: ({ summaryId, responseText, spokenLead, userText }) => voiceCommand({
    command: 'summarize', clientId: myClientId, leaseId: myLeaseId,
    summaryId,
    responseText: responseText.slice(0, 32000),
    spokenLead: spokenLead.slice(0, 4000),
    userText: (userText || '').slice(0, 4000),
  }),
  onSummary: (text, done) => watchSend({ t: 'assistant-summary', text, done }),
  userText: () => lastUserText,
})

// ---- prompt queue / steer -------------------------------------------------------
let flushTimer = null
function queueEvent () { watchSend({ t: 'queue', items: queue.map(q => ({ id: q.id, text: q.text, state: q.state })) }) }

async function submitTranscript (text, utteranceId) {
  const clean = (text || '').trim()
  if (!clean) return
  if (utteranceId) {
    if (submittedUtterances.has(utteranceId)) return
    submittedUtterances.add(utteranceId)
    if (submittedUtterances.size > 512) submittedUtterances.delete(submittedUtterances.values().next().value)
  }
  // Watch-mic path only: suppress TTS echo (Mac-mic finals are pre-gated upstream).
  if (utteranceId && !utteranceId.startsWith('mac-') && looksLikeEcho(clean)) {
    console.log('[asr] dropped echo:', clean)
    return
  }
  lastUserText = clean
  if (state.session.running) {
    const item = { id: randomUUID(), text: clean, state: 'queued' }
    queue.push(item)
    queueEvent()
    watchSend({ t: 'notice', kind: 'queued', text: clean, id: item.id })
    return
  }
  await sendPromptNow(clean, 'queue')
}

async function sendPromptNow (text, mode) {
  const session = await dsh.getActiveSession()
  if (!session) throw new Error('no active harness session')
  // Mirror reference: cancel stale speech when starting fresh.
  if (state.voice.active && myLeaseId) {
    void voiceCommand({ command: 'cancel', clientId: myClientId, leaseId: myLeaseId }).catch(() => {})
  }
  if (state.voice.active && myLeaseId) {
    void voiceCommand({
      command: 'holding', clientId: myClientId, leaseId: myLeaseId,
      requestId: `u-${randomUUID().slice(0, 8)}`, userText: text.slice(0, 4000), activity: 'responding',
    }).catch(() => {})
  }
  state.session.running = true
  speakPlanner.reset()
  watchSend({ t: 'session', running: true, sessionId: session.id })
  const result = await dsh.prompt(session.id, text, mode)
  if (!result || !result.ok) {
    state.session.running = false
    watchSend({ t: 'session', running: false, sessionId: session.id })
    watchSend({ t: 'error', message: 'prompt rejected' })
    if (state.voice.active && myLeaseId) {
      void speakNow('Sorry, the prompt could not be sent.', { kind: 'system', replace: true }).catch(() => {})
    }
  }
}

function flushQueueSoon () {
  if (flushTimer) return
  flushTimer = setTimeout(async () => {
    flushTimer = null
    if (state.session.running || queue.length === 0) return
    const next = queue.shift()
    queueEvent()
    try { await sendPromptNow(next.text, 'queue') } catch (e) { watchSend({ t: 'error', message: e.message }) }
  }, 600)
}

async function steerItem (id) {
  const idx = queue.findIndex(q => q.id === id)
  if (idx < 0) throw new Error('not queued')
  const [item] = queue.splice(idx, 1)
  queueEvent()
  lastUserText = item.text
  await sendPromptNow(item.text, 'steer')
}

// ---- approvals / harness push ---------------------------------------------------
function approvalsEvent () { watchSend({ t: 'pending', items: pendingApprovals }) }

dsh.onDshEvent((ev) => {
  switch (ev.t) {
    case 'assistant-delta': onAssistantDelta(ev.text); break
    case 'assistant-done': void onAssistantDone(ev.text); break
    case 'assistant-snapshot': onAssistantSnapshot(ev.text, ev.done); break
    case 'assistant-reset': onAssistantReset(); break
    case 'assistant-flush': onAssistantFlush(); break
    case 'todos': todos = ev.items; watchSend({ t: 'todos', items: todos }); break
    case 'jobs': jobs = ev.items; watchSend({ t: 'jobs', items: jobs }); break
    case 'agents': agents = ev.items; watchSend({ t: 'agents', items: agents }); break
    case 'approval': {
      const idx = pendingApprovals.findIndex(p => p.id === ev.item.id)
      if (idx >= 0) pendingApprovals[idx] = ev.item       // ask wizard: next question replaces the card
      else { pendingApprovals.push(ev.item); buzzNotice('approval') }
      approvalsEvent()
      break
    }
    case 'approval-gone':
      pendingApprovals = pendingApprovals.filter(p => p.id !== ev.id)
      approvalsEvent()
      break
    case 'images': images = ev.items; watchSend({ t: 'images', items: images }); break
    case 'permissions':
      state.permissions = (ev.options && Array.isArray(ev.options)) ? { options: ev.options, currentValue: ev.currentValue ?? null } : null
      watchSend({ t: 'permissions', ...state.permissions })
      break
    case 'workspaces':
      state.workspaces = Array.isArray(ev.items) ? ev.items : []
      watchSend({ t: 'workspaces', items: state.workspaces, archivedSessionIds: ev.archivedSessionIds ?? [] })
      break
    case 'session-cwd':
      state.session.cwd = ev.cwd ?? null
      watchSend({ t: 'session', running: state.session.running, sessionId: state.session.sessionId, cwd: state.session.cwd })
      break
    case 'session-running':
      state.session.running = ev.running
      if (ev.sessionId) state.session.sessionId = ev.sessionId
      if ('cwd' in ev) state.session.cwd = ev.cwd ?? null
      watchSend({ t: 'session', running: ev.running, sessionId: state.session.sessionId, cwd: state.session.cwd })
      if (!ev.running) flushQueueSoon()
      break
    default: break
  }
})

function buzzNotice (kind) { watchSend({ t: 'notice', kind, text: kind }) }

// ---- watch mic → ASR helper -------------------------------------------------------
let asrChild = null
let asrBusy = false

function startAsr (capture = null) {
  if (asrChild && asrChild.exitCode === null) throw Object.assign(new Error('mic already open'), { status: 409 })
  const child = spawn(ASR_BIN, ['--locale', 'en-AU', '--end-turn-ms', '2200'], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {}) // EPIPE if helper exits mid-stream
  asrChild = child
  state.helper = { state: 'starting' }
  watchSend({ t: 'mic', state: 'open' })
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      let ev; try { ev = JSON.parse(line) } catch { continue }
      handleAsrEvent(ev, capture)
    }
  })
  child.stderr.on('data', (d) => process.stderr.write(`[asr] ${d}`))
  child.on('close', (code) => {
    // close follows stdout drain, so the final draft precedes dictation-closed.
    console.log('[asr] helper exit', code)
    if (asrChild === child) { asrChild = null; asrBusy = false; state.helper = { state: 'stopped' } }
    watchSend({ t: 'mic', state: 'closed', message: code === 0 ? undefined : `asr exit ${code}` })
    if (capture) watchSend({ t: 'dictation-closed', requestId: capture.requestId })
  })
  return child
}

// A dictation uplink can only produce a draft; even a stale/closed question
// must NEVER fall through to the normal prompt queue.
export function routeAsrFinal ({ capture, pending, text, utteranceId, draft, prompt }) {
  if (capture) {
    if (pending) draft({ t: 'dictation-final', requestId: capture.requestId, text })
    return 'draft'
  }
  prompt(text, utteranceId)
  return 'prompt'
}

function handleAsrEvent (ev, capture = null) {
  const pending = capture && pendingApprovals.find(p => p.id === capture.requestId && p.kind === 'ask' && p.title === capture.title)
  switch (ev.event) {
    case 'ready':
      state.helper = { state: 'ready' }
      break
    case 'speechStarted':
      if (capture) {
        if (pending) watchSend({ t: 'dictation-started', requestId: capture.requestId })
        break
      }
      watchSend({ t: 'asr', kind: 'speech-started', utteranceId: ev.utteranceId })
      // Barge-in: user speaking over TTS → kill playback (runtime mirror).
      if (state.voice.phase === 'speaking' && myLeaseId) {
        void voiceCommand({ command: 'cancel', clientId: myClientId, leaseId: myLeaseId }).catch(() => {})
      }
      break
    case 'partial':
      if (capture) {
        if (pending) watchSend({ t: 'dictation-partial', requestId: capture.requestId, text: ev.text })
      } else watchSend({ t: 'asr', kind: 'partial', text: ev.text, utteranceId: ev.utteranceId })
      break
    case 'final':
      if (!capture) watchSend({ t: 'asr', kind: 'final', text: ev.text, utteranceId: ev.utteranceId })
      routeAsrFinal({ capture, pending, text: ev.text, utteranceId: ev.utteranceId,
        draft: watchSend, prompt: (text, id) => { void submitTranscript(text, id) } })
      break
    case 'speechEnded':
      if (!capture) watchSend({ t: 'asr', kind: 'speech-ended', utteranceId: ev.utteranceId })
      break
    case 'error':
      state.helper = { state: 'error', message: ev.message }
      watchSend({ t: 'error', message: `mic: ${ev.message}` })
      break
    default:
      break
  }
}

// TLS credentials resolve lazily so importing this module (tests) never
// touches the filesystem. Missing cert without explicit insecure opt-in
// fails closed via createBridgeServer.
function tlsCredentials () {
  try {
    return loadTlsCredentials({ certFile: CONFIG.tlsCert, keyFile: CONFIG.tlsKey })
  } catch {
    return null
  }
}

// ---- watch HTTP(S) routes --------------------------------------------------------
// Auth: the token travels ONLY in the X-Bridge-Token header. A ?token= query
// is rejected outright (URLs leak into logs/history; headers do not). The
// server never issues redirects, so clients must not follow any.
async function handleWatchRequest (req, res) {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  if (queryHasToken(url)) return json(res, 401, { ok: false, error: 'token in URL is rejected; send X-Bridge-Token header' })
  const token = extractHeaderToken(req)

  // Health: no auth (used by Settings "Test").
  if (path === '/watch/health') {
    const dshState = await dsh.dshHealth()
    return json(res, 200, { ok: true, dsh: dshState, voice: state.voice.phase, queue: queue.length, pending: pendingApprovals.length, discovery: discoverySocket?.discoveryStatus ?? { state: 'stopped', port: null } })
  }

  // Pair probe: liveness check ONLY — the responder echoes a keyed checksum
  // of the nonce, which any relay can forward verbatim. It confers no trust,
  // proves no identity, and is NOT authentication in any sense. The watch
  // must verify the bridge's pinned TLS certificate fingerprint before
  // sending its token to any discovered address (see
  // docs/connection-security.md).
  if (path === '/watch/pair-probe') {
    const nonce = url.searchParams.get('nonce') || ''
    if (!/^[\w-]{1,64}$/.test(nonce)) return json(res, 400, { ok: false, error: 'bad nonce' })
    console.log('[discovery] pair-probe from', req.socket.remoteAddress)
    return json(res, 200, { ok: true, mac: createHmac('sha256', bridgeToken()).update(nonce).digest('base64url') })
  }

  if (!tokenOk(token)) return json(res, 401, { ok: false, error: 'bad token' })

  try {
    // --- SSE to watch ---
    if (path === '/watch/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
      })
      // hello carries the protocol contract (version + features) and the
      // active character. The watch sends its local character choice back
      // (character-select) on each hello/reconnect; unknown keys are ignored
      // by older peers on both sides.
      const helloCaps = characterStack().describeCapabilities()
      res.write(`data: ${JSON.stringify({ t: 'hello', ...protocolHello(), characterId: helloCaps.characterId, voiceActive: state.voice.active, queueDepth: queue.length })}\n\n`)
      res.write(`data: ${JSON.stringify({ t: 'snapshot', ...snapshot() })}\n\n`)
      watchClients.add(res)
      console.log('[watch] stream open', watchClients.size)
      req.on('close', () => { watchClients.delete(res); console.log('[watch] stream closed', watchClients.size) })
      return
    }

    // --- state snapshot ---
    if (path === '/watch/state' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(snapshot()))
    }

    // --- authenticated capability snapshot (plugins resolve actions here) ---
    if (path === '/watch/capabilities' && req.method === 'GET') {
      return json(res, 200, characterStack().describeCapabilities())
    }

    // --- image bytes (also opened on the Mac via open-mac → Preview) ---
    if (path === '/watch/image' && req.method === 'GET') {
      const ref = url.searchParams.get('ref') || ''
      const img = await dsh.fetchImage(ref)
      if (!img) return json(res, 404, { error: 'no such image' })
      res.writeHead(200, { 'content-type': img.contentType || 'image/png', 'cache-control': 'private, max-age=60' })
      return res.end(img.buffer)
    }

    // --- watch microphone PCM uplink (long-lived chunked POST) ---
    if (path === '/watch/mic' && req.method === 'POST') {
      const requestId = url.searchParams.get('answerRequestId')
      if (asrBusy) {
        if (requestId) watchSend({ t: 'dictation-closed', requestId })
        return json(res, 409, { ok: false, error: 'mic already open' })
      }
      const pending = requestId && pendingApprovals.find(p => p.id === requestId && p.kind === 'ask')
      if (requestId && !pending) return json(res, 404, { ok: false, error: 'question no longer pending' })
      asrBusy = true
      let child
      try { child = startAsr(pending ? { requestId, title: pending.title } : null) }
      catch (error) { asrBusy = false; throw error }
      res.writeHead(200, { 'content-type': 'application/json' })
      req.on('data', (d) => { if (child.stdin.writable) child.stdin.write(d) })
      req.on('end', () => { child.stdin.end(); res.end(JSON.stringify({ ok: true })) })
      req.on('error', () => { child.stdin.end() })
      // stopService() may abort the upload without an 'end' or 'error'; always
      // finish recognition so the final draft and dictation-closed can arrive.
      req.on('close', () => { if (!req.complete) child.stdin.end() })
      return
    }

    // --- commands ---
    if (path === '/watch/command' && req.method === 'POST') {
      const body = await readJson(req)
      const out = await handleCommand(body)
      return json(res, 200, { ok: true, ...out })
    }

    // --- Cappi model-action (avatar UI): session-bound, capability-resolved ---
    // The caller proves its session with body.sessionId (the plugin sends
    // exec.agent.id verbatim); the bridge checks it against the watched
    // session atomically before any effect (see bridge/session-binding.mjs).
    // Legacy action ids map to the active pack's capabilities; state-owned
    // cues (question/static_hold) are never resolvable.
    if (path === '/watch/cappi' && req.method === 'POST') {
      const body = await readJson(req)
      const out = characterStack().handleCappiBody(body)
      return json(res, out.status, out.payload)
    }

    json(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    const status = typeof e?.status === 'number' ? e.status : 500
    json(res, status, { ok: false, error: e.message || 'bridge error' })
  }
}

async function handleCommand (body) {
  switch (body.cmd) {
    case 'ping': return { pong: true }
    case 'start': await startVoice(); return {}
    case 'stop': await stopVoice(); return {}
    case 'cancel':
      requireLease()
      await voiceCommand({ command: 'cancel', clientId: myClientId, leaseId: myLeaseId })
      return {}
    case 'mute':
      requireLease()
      await voiceCommand({ command: 'mute', clientId: myClientId, leaseId: myLeaseId, muted: body.muted === true })
      state.voice.muted = body.muted === true
      return {}
    case 'submit': {
      const text = String(body.text || '').trim().slice(0, 4000)
      if (!text) throw Object.assign(new Error('empty text'), { status: 400 })
      if (state.session.running) {
        const item = { id: randomUUID(), text, state: 'queued' }
        queue.push(item); queueEvent()
        return { queued: true, id: item.id }
      }
      await sendPromptNow(text, 'queue')
      return {}
    }
    case 'steer': await steerItem(String(body.id)); return {}
    case 'queue-remove':
      queue = queue.filter(q => q.id !== body.id); queueEvent(); return {}
    case 'queue-clear': queue = []; queueEvent(); return {}
    case 'queue-move': {
      const i = queue.findIndex(q => q.id === body.id)
      if (i < 0) throw Object.assign(new Error('not queued'), { status: 404 })
      // `to` = absolute target index (the watch sends this); `delta` = relative.
      const j = Object.hasOwn(body, 'to')
        ? Math.max(0, Math.min(queue.length - 1, Number(body.to) || 0))
        : Math.max(0, Math.min(queue.length - 1, i + Number(body.delta || 0)))
      const [it] = queue.splice(i, 1); queue.splice(j, 0, it); queueEvent(); return {}
    }
    case 'approve': {
      // Captured scope: when the watch supplies its calling harness session
      // id (body.sessionId), it must match the currently watched session —
      // checked BEFORE the harness RPC so a stale caller fails 409 with no
      // real effect. Absent sessionId stays legacy-compatible (token-auth
      // only): the watch holds no harness session id on older builds.
      const watchedForApproval = typeof dsh.getWatchedSessionSync === 'function'
        ? dsh.getWatchedSessionSync()
        : state.session.sessionId
      const scope = decideApprovalScope(body, watchedForApproval)
      if (!scope.ok) throw Object.assign(new Error(scope.error), { status: scope.status })
      const item = pendingApprovals.find(p => p.id === body.requestId)
      if (!item) throw Object.assign(new Error('question no longer pending'), { status: 404 })
      const choices = Array.isArray(body.choiceIds) ? body.choiceIds.map(String) : undefined
      const choice = body.choiceId === 'deny' ? 'rejected' : String(body.choiceId || '')
      if (item.kind === 'approval' && (choices || !['allowed-once', 'rejected'].includes(choice))) {
        throw Object.assign(new Error('invalid approval choice'), { status: 400 })
      }
      if (item.kind === 'ask' && choice !== '_free' && !choices && !item.options.some(o => o.id === choice)) {
        throw Object.assign(new Error('invalid answer choice'), { status: 400 })
      }
      const result = await dsh.answerApproval(String(body.requestId), choices ?? choice, body.text ? String(body.text).slice(0, 2000) : undefined)
      // Mid-wizard keeps the card — dsh re-publishes the next question.
      if (result?.done) {
        pendingApprovals = pendingApprovals.filter(p => p.id !== body.requestId)
        approvalsEvent()
      }
      return { approved: true }
    }
    case 'refresh':
      await dsh.refreshSnapshot()
      return { refreshed: true }
    case 'character-select': {
      // Watch-local pack choice (the watch re-sends its choice on each
      // hello/reconnect). Token-authenticated; no harness session binding
      // applies — binding guards model effects, not the watch's own choice.
      const out = characterStack().handleCharacterSelect(body)
      if (!out.payload.ok) throw Object.assign(new Error(out.payload.error), { status: out.status })
      return out.payload
    }
    case 'sessions':
      return { sessions: await dsh.listSessions(), active: state.session.sessionId }
    case 'select-session': {
      const target = String(body.sessionId || '')
      // Validate real ids (a bogus pin would leave the bridge watching a
      // phantom until the next refresh self-heals it).
      if (target && !(await dsh.hasSession(target).catch(() => false))) {
        throw Object.assign(new Error(`unknown session "${target}"`), { status: 404 })
      }
      dsh.setActiveSession(target)
      if (!target) await dsh.refreshSnapshot().catch(() => {})  // unpin → resolve the auto-followed session now
      const active = await dsh.getActiveSession()
      state.session.sessionId = active?.id ?? null
      state.session.cwd = dsh.getActiveCwd()
      return {}
    }
    case 'projects': {
      // Preferred: the workspace registry (title + path + ordered sessions).
      // Fallback: distinct cwds inferred from session history.
      const ws = dsh.getWorkspaces()
      if (ws?.items?.length) {
        return {
          projects: ws.items.map(w => ({
            workspaceId: w.workspaceId, title: w.title ?? w.path ?? w.workspaceId,
            path: w.path, sessions: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
          })),
          archivedSessionIds: ws.archivedSessionIds,
        }
      }
      return { projects: await dsh.listProjects() }
    }
    case 'new-session': {
      const cwd = body.cwd ? String(body.cwd) : undefined
      const workspaceId = body.workspaceId ? String(body.workspaceId) : undefined
      const created = await dsh.createSession(cwd, workspaceId)
      state.session.sessionId = created.sessionId
      state.session.running = false
      state.session.cwd = dsh.getActiveCwd() ?? created.cwd ?? null
      watchSend({ t: 'session', running: false, sessionId: created.sessionId, cwd: state.session.cwd })
      return { sessionId: created.sessionId, cwd: state.session.cwd, workspaceId: workspaceId ?? dsh.workspaceForSession(created.sessionId) }
    }
    // Explicit native model RPCs: never submit text, create a thread, or use a
    // slash-command fallback. The adapter validates the caller's captured thread.
    case 'models': return await dsh.listModels(body.sessionId)
    case 'set-model': return await dsh.setModel(body.sessionId, body.modelId)
    case 'set-reasoning': return await dsh.setReasoning(body.sessionId, body.modelId, body.reasoningEffort)
    case 'set-permission': {
      // Session-bound model effect: the caller proves its session with
      // body.sessionId (the watch sends its calling session id verbatim).
      // The watched id is captured ONCE and matched atomically BEFORE the
      // harness RPC, so a stale caller fails 409 with no real effect:
      // missing → 400, none watched → 409, mismatch → 409.
      const watched = typeof dsh.getWatchedSessionSync === 'function'
        ? dsh.getWatchedSessionSync()
        : state.session.sessionId
      const bound = decideSetPermissionTarget(body, watched)
      if (!bound.ok) throw Object.assign(new Error(bound.error), { status: bound.status })
      return await dsh.setPermission(bound.sessionId, body.preset)
    }
    case 'speak': {
      const text = String(body.text || '').trim().slice(0, 4000)
      if (!text) throw Object.assign(new Error('empty text'), { status: 400 })
      await speakNow(text, { kind: 'local', strict: true })
      return {}
    }
    case 'open-mac': {
      // Prefer {imageRef} for bridge images: the bytes are opened from a
      // private temp file, so the watch token never enters a URL, shell
      // history or Preview recent-items. Raw {url} stays for plain https
      // links only and is never used with an embedded token.
      if (body.imageRef !== undefined) {
        const ref = String(body.imageRef || '').slice(0, 256)
        if (!ref) throw Object.assign(new Error('missing image ref'), { status: 400 })
        const img = await dsh.fetchImage(ref)
        if (!img) throw Object.assign(new Error('no such image'), { status: 404 })
        await openImageBytesOnMac(img)
        return {}
      }
      const target = String(body.url || '')
      const checked = validateOpenMacUrl(target)
      if (!checked.ok) throw Object.assign(new Error(checked.error), { status: 400 })
      const p = spawn('open', [target], { stdio: 'ignore', detached: true })
      p.on('error', () => {})
      p.unref()
      return {}
    }
    default:
      throw Object.assign(new Error(`unknown cmd ${body.cmd}`), { status: 400 })
  }
}

// ---- helpers ---------------------------------------------------------------------------
function json (res, code, obj) {
  const b = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(b)
}
function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

/** Open fetched image bytes on the Mac via a private temp file (no token URL). */
async function openImageBytesOnMac (img) {
  const { chmodSync, mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[img.contentType] || 'png'
  const dir = mkdtempSync(join(tmpdir(), 'dsh-watch-img-'))
  chmodSync(dir, 0o700)
  const file = join(dir, `image.${ext}`)
  writeFileSync(file, img.buffer, { mode: 0o600 })
  const p = spawn('open', [file], { stdio: 'ignore', detached: true })
  p.on('error', () => {})
  p.unref()
}

// ---- LAN discovery (UDP, untrusted) -----------------------------------------
// The watch broadcasts "DSHW1DISCOVER <nonce>" and we answer with our service
// port, so a DHCP address change never strands the watch. Replies are a
// CANDIDATE LIST ONLY: any LAN host can answer, so the watch must verify the
// pinned certificate before sending its token. Bounded by discovery.mjs
// (512-byte cap, nonce/port validation, no secrets in replies).
let discoverySocket = null
function startBridgeDiscovery () {
  return startDiscovery({
    port: CONFIG.discoveryPortExplicit ? CONFIG.discoveryPort : undefined,
    servicePort: PORT,
    log: (m) => console.error(`[discovery] ${m}`), // never take the bridge down over discovery
  })
}

// Startup side effects run only when this file is the process entry point
// (`node bridge.mjs`, relative or absolute). Importing the module — as the
// focused bridge tests do — must not open sockets, touch credentials, start
// timers or print the token. One realpath comparison handles both forms.
function isMainModule () {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  // Server + sockets are startup-only side effects: importing this module
  // (tests) opens nothing, reads no credentials and starts no timers.
  const tls = tlsCredentials()
  const scheme = tls ? 'https' : 'http'
  const server = createBridgeServer({ tls, allowInsecureHttp: CONFIG.allowInsecureHttp, handler: handleWatchRequest })
  // Long-lived connections (watch SSE + chunked mic uplink) must not be killed by
  // Node's default 5-minute request timeout.
  server.requestTimeout = 0
  server.headersTimeout = 45000
  server.keepAliveTimeout = 75000

  // keepalives for watch SSE
  setInterval(() => watchComment('keepalive'), 15000).unref()
  // harness snapshot refresh (todos/approvals/etc.) while anyone is watching
  setInterval(() => { if (watchClients.size > 0) dsh.refreshSnapshot().catch(() => {}) }, 5000).unref()
  // voice upstream watchdog: if SSE died silently, the for-await loop errors itself;
  // nothing else needed.

  ensureUpstream()
  dsh.refreshSnapshot().catch(() => {})
  dsh.subscribeSession()
  discoverySocket = startBridgeDiscovery()

  server.listen(PORT, '0.0.0.0', () => {
    console.log('─'.repeat(60))
    console.log(`DSH watch bridge  : ${scheme}://0.0.0.0:${PORT}`)
    // Never write the persistent watch token or private key to a process log.
    // The certificate SHA-256 pin is public pairing material: copy it to the watch.
    if (tls) console.log(`Certificate pin   : sha256/${tls.fingerprint}`)
    else console.log('TLS               : DISABLED (BRIDGE_ALLOW_INSECURE_HTTP=1 legacy mode)')
    console.log(`Health            : ${scheme}://127.0.0.1:${PORT}/watch/health`)
    console.log(`State dir         : ${CONFIG.stateDir}`)
    console.log(`DSH loopback      : ${DSH_BASE}`)
    console.log(`ASR helper        : ${ASR_BIN} ${existsSync(ASR_BIN) ? '(present)' : '(MISSING — mic uplink will fail)'}`)
    console.log('─'.repeat(60))
  })
}
