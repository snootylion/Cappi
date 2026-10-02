// dsh.mjs — DSH harness adapter for the watch bridge.
//
// Transport (verified against the installed bundles):
//   - unary RPC   POST /api/<method>  {type:"client-request",rpcId,method,payload:{args:{...}}}
//   - WS mux      ws://127.0.0.1:3083/api/remote.mux  (streams: session/follow,
//                 session/control, $events) — text frames {type:open|item|end|error|cancel}
//   - auth        dsh-auth-* HMAC cookie minted from ~/.dsh/.credentials.yaml
//                 record client-connection/browser-session (sign the base64url body
//                 string with the DECODED 32-byte secret; authority 127.0.0.1:3083).
// Everything else (todos via projections, jobs via control, approvals via
// $events waterfalls, images via session/attachment RPC) rides those carriers.
//
// session/follow frames (dsh-api-session-controller SessionFollowFrame):
//   {type:"snapshot", header, cursor, records[], hasMore, projections, assistantStream?}
//   {type:"event", event:{type, seq, time, data}}                    — durable, gap-free
//   {type:"assistant-stream", frame:{type:"start"|"chunk"|"end", …}}  — process-local
//     streaming of the active attempt; only delivered when the request opts in with
//     `assistantStream: true` (the official client does). Chunk text deltas are
//     {type:"text-delta", index, text} — field `text`, never `delta`.
//   There is no `{type:"chunks"}` frame in this contract; the snapshot's `records`
//   (the opening history window, all interleaved event types included) is what
//   rebuilds the visible assistant turn after a reconnect or bridge restart.

import { createHash, randomUUID } from 'node:crypto'
import { createModelCommands, ModelProjectionCache } from './models.mjs'
import { loadDshSecret, mintCookie, resolveDshHome } from './dsh-auth.mjs'

const DSH = process.env.DSH_BASE || 'http://127.0.0.1:3083'
const WS_URL = DSH.replace(/^http/, 'ws') + '/api/remote.mux'
const AUTHORITY = new URL(DSH).host // 127.0.0.1:3083
// DSH home is configurable (DSH_HOME) so tests and installs never depend on a
// hardcoded ~/.dsh; secret file access stays inside dsh-auth.mjs.
const DSH_HOME = resolveDshHome()

// ---- browser-session cookie (mint, never fetched over the wire) ---------------
// Version-bounded (v1): a harness-side format change must update COOKIE_VERSION.
let COOKIE = null
function cookieHeader () {
  if (COOKIE) return COOKIE
  const secret = loadDshSecret({ dshHome: DSH_HOME })
  COOKIE = mintCookie({ authority: AUTHORITY, secret })
  return COOKIE
}

// ---- unary RPC -----------------------------------------------------------------
let rpcInflight = new Map()
async function rpc (method, args = {}, { timeout = 10000 } = {}) {
  const rpcId = randomUUID()
  const res = await fetch(`${DSH}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader() },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(timeout),
  })
  if (res.status === 401) throw Object.assign(new Error('dsh auth rejected (restart DSH? re-mint cookie)'), { status: 401 })
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`)
  const json = await res.json().catch(() => null)
  if (!json) throw new Error(`${method} empty response`)
  const result = json.result ?? json
  if (result.ok === false || result.error) {
    const err = result.error || {}
    throw new Error(err.message || `${method} failed`)
  }
  return result.value
}

// ---- event fan-out ---------------------------------------------------------------
const listeners = []
export function onDshEvent (cb) { listeners.push(cb) }
function emit (event) { for (const cb of listeners) { try { cb(event) } catch (e) { console.error('[dsh] listener', e.message) } } }

// ---- session tracking -------------------------------------------------------------
let activeSessionId = null
let sessionRevision = 0 // Changes even on A -> B -> A: stale picker requests cannot race back in.
const modelProjection = new ModelProjectionCache()
const modelCommands = createModelCommands({ rpc,
  getTarget: () => ({ sessionId: activeSessionId, revision: sessionRevision }),
  getProjection: () => modelProjection.value,
})
export const listModels = sessionId => modelCommands.models(sessionId)
export const setModel = (sessionId, modelId) => modelCommands.setModel(sessionId, modelId)
export const setReasoning = (sessionId, modelId, reasoningEffort) => modelCommands.setReasoning(sessionId, modelId, reasoningEffort)
// Read-only copy, useful for diagnostics/tests; authoritative writes are host projections.
export function getModelSelectionProjection () { return modelProjection.value && structuredClone(modelProjection.value) }
let sessionPinned = false   // manual watch-side pick survives refresh auto-selection
let running = false
let runningAuthorityAt = 0  // last live turn/status event; beats stale session/list rows
const imagesSeen = new Map()     // ref -> item
const inlineImages = new Map()   // ref -> {contentType, b64} (bounded)
const todosCache = []
const jobsCache = []
let permissionsCache = null   // PermissionSelect {options, currentValue} | null
let activeCwd = null          // watched session's working directory (project)

// Visible assistant transcript of the CURRENT turn — see header. Built only from
// durable `assistant/message` text blocks (keyed by seq: replays collapse) plus the
// active attempt's text deltas; reasoning/tool blocks and tool-call deltas are
// excluded at the entry points, so watch text and speech can never see them.
const MSG_SEP = '\n\n'
const assistant = {
  turn: null,
  committed: new Map(),   // durable event seq -> committed message text
  live: '',               // text-delta accumulation of the active attempt
  liveAttempt: null,
  liveTurn: null,
  liveIndex: -1,
  done: false,            // turn/end seen for `turn`
}
let rebuilding = false    // replaying a follow-open snapshot (live emits suppressed)
let anonSeq = 0

export async function dshHealth () {
  try {
    // Tiny parameterless call under the same /api cookie fence as everything
    // else — session/list is 1.8 MB with 6k sessions (far too slow to poll).
    await rpc('session/canOpenWorkspacePath', {}, { timeout: 2500 })
    return 'up'
  } catch (e) {
    if (e.status === 401) return 'auth'
    return 'down'
  }
}

function summarizeSession (s) {
  return { text: s.content ?? s.text ?? s.sessionId, status: s.running ? 'in_progress' : 'pending' }
}

function switchSessionTo (sessionId) {
  activeSessionId = sessionId
  sessionRevision++
  modelProjection.reset()
  resetAssistantContent(null)   // transcript + bridge speech planner are per-session
  activeCwd = null
  // New session's follow snapshot repopulates these; stale lists must not linger.
  todosCache.splice(0, todosCache.length)
  emit({ t: 'todos', items: [] })
  jobsCache.splice(0, jobsCache.length)
  emit({ t: 'jobs', items: [] })
  permissionsCache = null
  emit({ t: 'permissions', options: null, currentValue: null })
  followSession(sessionId)
}

export async function refreshSnapshot () {
  const fetchedAt = Date.now()          // when this list row view was sampled
  const list = await rpc('session/list', { _request: {} })
  const items = list?.items ?? []
  lastSessionList = { items, at: Date.now() }
  if (items.length === 0) {
    const created = await rpc('session/create', { request: {} })
    items.push({ sessionId: created.sessionId, updatedAt: Date.now(), running: false })
  }
  applySessionList(items, fetchedAt)
}

// Apply a fetched session list. `fetchedAt` is when the fetch STARTED: a live
// turn/start | turn/end | api-session/status event that landed after that stamp
// makes this row's `running` stale, and a stale row must never flip the watch
// back to running after a final transcript already landed (or vice versa).
export function applySessionList (items, fetchedAt = Date.now()) {
  const current = activeSessionId && items.find(i => i.sessionId === activeSessionId)
  let next
  if (sessionPinned) {
    // A watch-side pick sticks until its session disappears from the list.
    if (current) next = current
    else sessionPinned = false
  }
  next ??= items.find(i => i.running) ?? current ?? items.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
  const changed = next && next.sessionId !== activeSessionId
  if (changed) switchSessionTo(next.sessionId)
  activeCwd = next?.cwd ?? activeCwd ?? null
  // Running state of the TARGET session specifically (not "anything runs"):
  // the watch queue must flush exactly when the session it feeds goes idle.
  const stale = runningAuthorityAt > fetchedAt
  const effectiveRunning = stale ? running : Boolean(next?.running)
  if (effectiveRunning !== running || changed) {
    running = effectiveRunning
    emit({ t: 'session-running', running, sessionId: activeSessionId, cwd: activeCwd })
  }
  // agents glance card = live children of the watched session only (never the
  // hundreds of archived subagents across the host's whole history)
  const agents = items.filter(i => i.origin === 'subagent' && i.parentSessionId === activeSessionId)
    .map(i => ({ id: i.sessionId, label: `agent ${String(i.sessionId).slice(0, 8)}`, state: i.running ? 'running' : 'idle' }))
  emit({ t: 'agents', items: agents })
  if (imagesSeen.size) emit({ t: 'images', items: [...imagesSeen.values()] })
}

export async function getActiveSession () {
  if (!activeSessionId) await refreshSnapshot().catch(() => {})
  return activeSessionId ? { id: activeSessionId } : null
}

// session/list is a 1.8 MB / ~5 s call on this host — the 5 s refresh loop
// already pays it, so serve the watch from that cache (20 s freshness).
let lastSessionList = null

export async function listSessions ({ includeSubagents = false, maxAgeMs = 20000 } = {}) {
  let items = lastSessionList && Date.now() - lastSessionList.at < maxAgeMs ? lastSessionList.items : null
  if (!items) {
    const list = await rpc('session/list', { _request: {} })
    items = list?.items ?? []
    lastSessionList = { items, at: Date.now() }
  }
  return items
    .filter(i => includeSubagents || i.origin !== 'subagent')   // watch discards subagent rows anyway
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))    // recency is not guaranteed by the RPC
    .slice(0, 100)                                              // newest-first cap; the watch scrolls, not audits
    .map(i => ({
      sessionId: i.sessionId,
      running: Boolean(i.running),
      updatedAt: i.updatedAt ?? 0,
      blank: Boolean(i.blank),
      cwd: i.cwd ?? null,
      title: i.projections?.values?.title ?? null,
      subagent: i.origin === 'subagent',
      workspaceId: workspaceForSession(i.sessionId),
    }))
}

export async function hasSession (sessionId) {
  if (!sessionId) return false
  await listSessions({ includeSubagents: true, maxAgeMs: 20000 }).catch(() => {})  // warm/refresh cache
  const rows = lastSessionList?.items ?? []
  if (rows.some(i => i.sessionId === sessionId)) return true
  const list = await rpc('session/list', { _request: {} })   // cache was stale — force once
  lastSessionList = { items: list?.items ?? [], at: Date.now() }
  return lastSessionList.items.some(i => i.sessionId === sessionId)
}

// Distinct working directories seen across sessions — the practical "project
// picker" (the harness exposes no workspace-list RPC; cwd IS the project).
export async function listProjects () {
  const list = await rpc('session/list', { _request: {} })
  const byPath = new Map()
  for (const i of list?.items ?? []) {
    if (!i.cwd || i.origin === 'subagent') continue
    const cur = byPath.get(i.cwd)
    const at = i.updatedAt ?? 0
    if (!cur || at > cur.lastUsed) byPath.set(i.cwd, { path: i.cwd, lastUsed: at, sessions: (cur?.sessions ?? 0) + 1 })
    else cur.sessions++
  }
  return [...byPath.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 20)
}

// Fresh session from scratch; optional cwd/workspaceId selects the project
// (mutually exclusive on the wire). Pins so auto-follow can't walk away.
export async function createSession (cwd, workspaceId) {
  const request = {}
  if (workspaceId) request.workspaceId = String(workspaceId)
  else if (cwd) request.cwd = String(cwd)
  const value = await rpc('session/create', { request })
  const sessionId = value?.sessionId
  if (!sessionId) throw Object.assign(new Error('session/create returned no sessionId'), { status: 502 })
  setActiveSession(sessionId)
  await refreshSnapshot().catch(() => {})
  return { sessionId, cwd: cwd ?? null, workspaceId: workspaceId ?? null }
}

// ---- workspaces (the project registry) --------------------------------------
// Read side is the WS `workspace/follow` stream only (no unary list). Rows:
// WorkspaceView {workspaceId, path, title, sessionIds[], createdAt, updatedAt}.
let workspacesCache = null        // WorkspaceView[] | null (null = not yet seen)
let workspacesArchived = []

export function getWorkspaces () {
  return workspacesCache ? { items: workspacesCache, archivedSessionIds: workspacesArchived } : null
}

export function workspaceForSession (sessionId) {
  if (!sessionId || !workspacesCache) return null
  const hit = workspacesCache.find(w => Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId))
  return hit?.workspaceId ?? null
}

function workspacesEmit () {
  emit({ t: 'workspaces', items: workspacesCache ?? [], archivedSessionIds: workspacesArchived })
}

function handleWorkspaceValue (v) {
  if (!v) return
  if (v.type === 'baseline') {
    workspacesCache = Array.isArray(v.value?.items) ? v.value.items : []
    workspacesArchived = v.value?.archivedSessionIds ?? []
    workspacesEmit()
    return
  }
  if (!workspacesCache) workspacesCache = []
  if (v.type === 'upsert' && v.workspace?.workspaceId) {
    const idx = workspacesCache.findIndex(w => w.workspaceId === v.workspace.workspaceId)
    if (idx >= 0) workspacesCache[idx] = v.workspace
    else workspacesCache.push(v.workspace)
    workspacesEmit()
  } else if (v.type === 'remove' && v.workspaceId) {
    workspacesCache = workspacesCache.filter(w => w.workspaceId !== v.workspaceId)
    workspacesEmit()
  } else if (v.type === 'order' && Array.isArray(v.workspaceIds)) {
    const byId = new Map(workspacesCache.map(w => [w.workspaceId, w]))
    const ordered = v.workspaceIds.map(id => byId.get(id)).filter(Boolean)
    // keep any rows the order list omitted at the tail
    const orderedIds = new Set(v.workspaceIds)
    workspacesCache = [...ordered, ...workspacesCache.filter(w => !orderedIds.has(w.workspaceId))]
    workspacesEmit()
  } else if (v.type === 'archived' && Array.isArray(v.archivedSessionIds)) {
    workspacesArchived = v.archivedSessionIds
    workspacesEmit()
  }
}

// Read side of the `permissions` projection (PermissionSelect value).
export function getPermissions () { return permissionsCache }
export function getActiveCwd () { return activeCwd }
/**
 * Visible assistant state of the followed session for /watch/state snapshots, so
 * an SSE reconnect (or watch restart) restores the current live response and its
 * interim/final label instead of a blank Text screen. `text` is the turn's full
 * visible transcript (retained after turn/end until the next turn boundary).
 */
export function getAssistantState () {
  return { text: deriveAssistantText(), done: assistant.done }
}

// Write side: slash commands never reach the model — they go through the
// unary `commands/execute` (verified: session/prompt of "/permission x"
// would land as plain user text and never parse). Works while running or
// idle; returns the command's own result text.
export async function setPermission (sessionId, preset) {
  const name = String(preset ?? '').trim()
  if (!name) throw Object.assign(new Error('missing preset'), { status: 400 })
  if (permissionsCache?.options?.length && !permissionsCache.options.some(o => o.value === name)) {
    throw Object.assign(new Error(`unknown preset "${name}" (available: ${permissionsCache.options.map(o => o.value).join(', ')})`), { status: 400 })
  }
  // Wire per live descriptor validation: `submittedAttachments` (a sibling
  // build documents this field as `images` — reject-unknown makes the live
  // descriptor authoritative).
  const value = await rpc('commands/execute', { agentId: sessionId, line: `/permission ${name}`, submittedAttachments: [] })
  const r = value?.result
  if (!value || !r) throw Object.assign(new Error('command not accepted (unknown or malformed command)'), { status: 502 })
  if (r.kind === 'error') throw Object.assign(new Error(r.text || 'command failed'), { status: 502 })
  return { ok: true, preset: name, text: r.text ?? null }
}

export function setActiveSession (sessionId) {
  if (!sessionId) { sessionPinned = false; return }   // "" → back to auto-follow
  sessionPinned = true
  if (sessionId === activeSessionId) return
  switchSessionTo(sessionId)
}

export async function prompt (sessionId, text, mode) {
  const value = await rpc('session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId,
      mode: mode === 'steer' ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
    },
  })
  return { ok: value?.accepted === true }
}

// ---- image discovery ----------------------------------------------------------------
function scanForImages (node, depth = 0) {
  if (!node || depth > 12) return
  if (Array.isArray(node)) { for (const x of node) scanForImages(x, depth + 1); return }
  if (typeof node !== 'object') return
  const mediaType = typeof node.mediaType === 'string' ? node.mediaType : undefined
  if (mediaType?.startsWith('image/') && typeof node.attachmentId === 'string') {
    const ref = `${activeSessionId ?? ''}|${node.attachmentId}`
    if (!imagesSeen.has(ref)) {
      imagesSeen.set(ref, {
        ref,
        label: [mediaType.replace('image/', ''), node.width && node.height ? `${node.width}×${node.height}` : '', String(node.attachmentId).slice(0, 6)]
          .filter(Boolean).join(' · '),
      })
      emit({ t: 'images', items: [...imagesSeen.values()] })
    }
  }
  if (mediaType?.startsWith('image/') && typeof node.data === 'string' && node.data.length > 64) {
    const ref = 'inline:' + createHash('sha1').update(node.data).digest('hex').slice(0, 16)
    if (!inlineImages.has(ref)) {
      inlineImages.set(ref, { contentType: mediaType, b64: node.data })
      if (inlineImages.size > 24) inlineImages.delete(inlineImages.keys().next().value)
      if (!imagesSeen.has(ref)) {
        imagesSeen.set(ref, { ref, label: `${mediaType.replace('image/', '')} · inline` })
        emit({ t: 'images', items: [...imagesSeen.values()] })
      }
    }
  }
  for (const v of Object.values(node)) scanForImages(v, depth + 1)
}

export async function fetchImage (ref) {
  if (ref.startsWith('inline:')) {
    const hit = inlineImages.get(ref)
    return hit ? { contentType: hit.contentType, buffer: Buffer.from(hit.b64, 'base64') } : null
  }
  const [sessionId, attachmentId] = String(ref).split('|')
  if (!sessionId || !attachmentId) return null
  const value = await rpc('session/attachment', { request: { sessionId, attachmentId } })
  if (!value?.data) return null
  return { contentType: value.attachment?.mediaType || 'image/png', buffer: Buffer.from(value.data, 'base64') }
}

// ---- approvals / asks ($events waterfalls) -------------------------------------------
const pendingMap = new Map()   // eventId -> watch-shaped approval item
const askStates = new Map()    // eventId -> {questions, qi, answers, kind}
let eventsClientId = null

function watchAskItem (eventId, st) {
  const q = st.questions[st.qi]
  const options = (q.options ?? []).filter(o => typeof o.label === 'string').map(o => ({ id: o.label, label: o.label }))
  const detail = typeof q.description === 'string' && q.description
    ? q.description
    : (q.header && q.header !== q.question ? q.header : undefined)
  return {
    id: eventId,
    kind: 'ask',
    title: q.question ?? q.header ?? 'Question',
    detail,
    options: options.length ? options : [{ id: '_free', label: 'Type answer' }],
    multi: q.multi_select === true,
  }
}

function publishApproval (item) {
  pendingMap.set(item.id, item)
  emit({ t: 'approval', item })
}
function dropApproval (id) {
  if (pendingMap.delete(id)) emit({ t: 'approval-gone', id })
}

export function makeQuestionAnswer (q, choiceId, text) {
  if (choiceId === '_free') {
    const custom = String(text || '').trim().slice(0, 2000)
    if (!custom) throw Object.assign(new Error('answer is empty'), { status: 400 })
    return { id: q.id, selected: [], custom }
  }
  const selected = Array.isArray(choiceId) ? choiceId.map(String) : [String(choiceId)]
  const valid = new Set((q.options || []).map(o => o.label))
  if (!selected.length || selected.some(label => !valid.has(label)) || (!q.multi_select && selected.length !== 1)) {
    throw Object.assign(new Error('invalid answer choice'), { status: 400 })
  }
  return { id: q.id, selected }
}

export async function answerApproval (requestId, choiceId, text) {
  // Approval kind: outcome is the literal string.
  const item = pendingMap.get(requestId)
  if (!item) throw Object.assign(new Error('question no longer pending'), { status: 404 })
  if (item.kind === 'approval') {
    const value = choiceId === 'rejected' ? 'rejected' : 'allowed-once'
    await rpc('$events/result', { clientId: eventsClientId, eventId: requestId, outcome: { kind: 'result', value } })
    dropApproval(requestId)
    return { done: true }
  }
  // Ask kind: sequential wizard across questions; one result posts all answers.
  const st = askStates.get(requestId)
  if (!st) throw Object.assign(new Error('question no longer pending'), { status: 404 })
  const q = st.questions[st.qi]
  const answer = makeQuestionAnswer(q, choiceId, text)
  if (st.qi + 1 < st.questions.length) {
    st.answers.push(answer)
    st.qi += 1
    publishApproval(watchAskItem(requestId, st)) // next question replaces the card
    return { done: false }
  }
  // Final transmission can fail: don't mutate stored answers until it succeeds.
  await rpc('$events/result', { clientId: eventsClientId, eventId: requestId, outcome: { kind: 'result', value: { answers: [...st.answers, answer] } } })
  askStates.delete(requestId)
  dropApproval(requestId)
  return { done: true }
}

// ---- WS mux -----------------------------------------------------------------------------
let ws = null
let wsBackoff = 1000
let followStreamId = null
const openStreams = new Set()

function openStream (streamId, endpoint, args) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
  openStreams.add(streamId)
}
function followSession (sessionId) {
  if (!sessionId) return
  if (followStreamId) { try { ws?.send(JSON.stringify({ type: 'cancel', streamId: followStreamId })) } catch {} }
  followStreamId = 'follow-' + randomUUID().slice(0, 8)
  // assistantStream:true — opt into the process-local attempt frames (start/chunk/end)
  // so interim text streams while a step is generating, exactly like the web client.
  openStream(followStreamId, 'session/follow', {
    request: { address: { kind: 'session', sessionId }, assistantStream: true },
  })
}

function textBlocksOf (message) {
  const out = []
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text)
  }
  return out
}

// ---- assistant transcript (current turn, visible text only) ---------------------------
function deriveAssistantText () {
  let text = ''
  for (const [, t] of assistant.committed) {
    if (!t) continue
    text = text ? text + MSG_SEP + t : t
  }
  if (assistant.live) text = text ? text + MSG_SEP + assistant.live : assistant.live
  return text
}
function clearLive () {
  assistant.live = ''
  assistant.liveAttempt = null
  assistant.liveTurn = null
  assistant.liveIndex = -1
}
function emitAssistantDelta () { if (!rebuilding) emit({ t: 'assistant-delta', text: deriveAssistantText() }) }
function emitAssistantSnapshot () { emit({ t: 'assistant-snapshot', text: deriveAssistantText(), done: assistant.done }) }

/** Drop transcript content (all of it, or all but the scope marker). */
function resetAssistantContent (turn) {
  const hadContent = assistant.committed.size > 0 || assistant.live !== '' || assistant.done
  assistant.committed.clear()
  clearLive()
  if (turn !== undefined) assistant.turn = turn
  assistant.done = false
  // Informs both the watch Text screen and the bridge speech planner; skipped
  // when there was visibly nothing to clear (avoids reset storms on replay).
  if (hadContent) emit({ t: 'assistant-reset' })
}
/** Adopt or reset the turn scope: a new turn number restarts the reply. */
function ensureTurn (turn) {
  if (turn == null) return
  if (assistant.turn === null) { assistant.turn = turn; return }
  if (assistant.turn !== turn) resetAssistantContent(turn)
}

/** Rebuild live-attempt text from the compact stream in an opening baseline. */
function joinAssistantStream (records) {
  let out = ''
  for (const r of Array.isArray(records) ? records : []) {
    if (r?.type === 'text-chunks' && Array.isArray(r.texts)) out += r.texts.join('')
    else if (r?.type === 'chunk' && r.chunk?.type === 'text-delta' && typeof r.chunk.text === 'string') out += r.chunk.text
  }
  return out
}

/** Process-local {type:'assistant-stream'} frames of the active attempt (opt-in). */
function handleAssistantFrame (f) {
  if (!f) return
  if (f.type === 'start') {
    if (f.turn != null) ensureTurn(f.turn)   // defensive: turn/start normally arrives first
    clearLive()
    assistant.liveAttempt = f.attemptId ?? null
    assistant.liveTurn = f.turn ?? assistant.turn
    assistant.liveIndex = -1
    return
  }
  if (f.type === 'chunk') {
    const c = f.chunk
    // text-delta only: reasoning, tool-call, usage and finish chunks are not
    // user-visible commentary and must never reach the screen or the speaker.
    if (!c || c.type !== 'text-delta' || typeof c.text !== 'string' || !c.text) return
    if (assistant.liveAttempt != null && f.attemptId != null && f.attemptId !== assistant.liveAttempt) return
    if (assistant.liveAttempt == null && f.attemptId != null) {
      assistant.liveAttempt = f.attemptId
      assistant.liveIndex = -1
    }
    if (typeof f.index === 'number') {
      if (f.index <= assistant.liveIndex) return   // duplicate or replayed frame
      assistant.liveIndex = f.index
    }
    assistant.live += c.text
    emitAssistantDelta()
    return
  }
  if (f.type === 'end') {
    if (assistant.liveAttempt != null && f.attemptId != null && f.attemptId !== assistant.liveAttempt) return
    // A commit publishes the durable assistant/message BEFORE this marker (it
    // already dropped the live copy); an abandon has no durable message, so its
    // live prose must not linger as — or re-speak as — the visible reply.
    if (assistant.live) {
      clearLive()
      emitAssistantDelta()
    }
  }
}

/** One durable SessionEventEntry, live or replayed from a snapshot window. */
function handleSessionEvent (v) {
  if (v?.type !== 'event') return
  const ev = v.event ?? {}
  const data = ev.data ?? {}
  switch (ev.type) {
    case 'assistant/message': {
      // The step's committed text. Same seq re-sets in place → replay/duplicate
      // events cannot double the transcript.
      if (data.turn != null) ensureTurn(data.turn)
      const parts = textBlocksOf(data.message)
      const key = typeof ev.seq === 'number' ? ev.seq : `n${++anonSeq}`
      assistant.committed.set(key, parts.join('\n'))
      if (data.turn != null && assistant.liveTurn === data.turn) clearLive()  // commit supersedes the attempt
      assistant.done = false
      emitAssistantDelta()
      scanForImages(data)
      break
    }
    case 'user/message':
      // Live steer/input restarts the reply. During a snapshot rebuild the
      // window's own records re-establish committed content afterwards, and a
      // same-turn reopen must not emit a spurious reset over live text — a turn
      // change is handled by turn/start's ensureTurn instead.
      if (!rebuilding) resetAssistantContent()
      scanForImages(data)
      break
    case 'turn/start':
      ensureTurn(data.turn)
      if (!rebuilding) {
        runningAuthorityAt = Date.now()
        if (!running) { running = true; emit({ t: 'session-running', running: true, sessionId: activeSessionId }) }
      }
      break
    case 'turn/end':
      if (data.turn == null || assistant.turn == null || data.turn === assistant.turn) assistant.done = true
      if (rebuilding) break    // the closing assistant-snapshot publishes this state
      runningAuthorityAt = Date.now()
      running = false
      emit({ t: 'assistant-done', text: deriveAssistantText() })
      emit({ t: 'session-running', running: false, sessionId: activeSessionId })
      break
    case 'tool/call':
      // The step's tools are starting, so its streamed commentary is complete:
      // the speech planner flushes whatever it still holds (reference behavior).
      if (!rebuilding && !assistant.done && deriveAssistantText()) emit({ t: 'assistant-flush' })
      scanForImages(data)
      break
    case 'todo/write':
      if (Array.isArray(data.todos)) {
        const mapped = data.todos.map(t => ({ text: t.content ?? t.text ?? '', status: t.status ?? 'pending' }))
        todosCache.splice(0, todosCache.length, ...mapped)
        emit({ t: 'todos', items: todosCache })
      }
      break
    default:
      // Includes assistant/attempt settlements (not a user-visible message) —
      // they carry no message content, so nothing is added or spoken.
      scanForImages(data)
      break
  }
}

/** Replay an opening window to rebuild the visible turn after a reconnect. */
function rebuildAssistantFrom (records) {
  rebuilding = true
  try {
    for (const entry of records) handleSessionEvent(entry)
  } finally {
    rebuilding = false
  }
}

/** Apply snapshot.assistantStream baseline (the active attempt mid-stream). */
function applyAssistantBaseline (base) {
  const active = base?.activeAttempt
  if (!active) { clearLive(); return }   // the attempt ended while we were away
  if (active.turn != null) ensureTurn(active.turn)
  assistant.liveAttempt = active.attemptId ?? null
  assistant.liveTurn = active.turn ?? assistant.turn
  assistant.live = joinAssistantStream(active.stream)
  assistant.liveIndex = (typeof active.nextIndex === 'number' ? active.nextIndex : 1) - 1
}

export function handleFollowValue (v) {
  if (!v) return
  if (v.type === 'snapshot' || v.type === 'chunks') {
    if (v.type === 'snapshot') {
      if (Object.hasOwn(v.projections?.values ?? {}, 'modelSelection')) {
        modelProjection.apply(v.projections.values.modelSelection, v.projections.asOfSeq)
      }
      const todos = v.projections?.values?.todos
      if (Array.isArray(todos)) {
        const mapped = todos.map(t => ({ text: t.content ?? t.text ?? '', status: t.status ?? 'pending' }))
        todosCache.splice(0, todosCache.length, ...mapped)
        emit({ t: 'todos', items: todosCache })
      }
      const perms = v.projections?.values?.permissions
      if (perms && Array.isArray(perms.options)) {
        permissionsCache = { options: perms.options, currentValue: perms.currentValue ?? null }
        emit({ t: 'permissions', ...permissionsCache })
      }
      if (v.header?.cwd) { activeCwd = v.header.cwd; emit({ t: 'session-cwd', cwd: activeCwd }) }
      if (Array.isArray(v.records)) rebuildAssistantFrom(v.records)
      if (v.assistantStream !== undefined) applyAssistantBaseline(v.assistantStream)
      // One authoritative (re)sync of the Text screen: current live response,
      // interim or final — survives reconnects and bridge restarts.
      emitAssistantSnapshot()
    }
    scanForImages(v.records ?? v)
    return
  }
  if (v.type === 'assistant-stream') { handleAssistantFrame(v.frame); return }
  if (v.type === 'event') handleSessionEvent(v)
}

export function handleControlValue (v) {
  if (!v) return
  if (v.type === 'baseline') {
    const base = v.value ?? {}
    const modelBaseline = activeSessionId && base.projections?.[activeSessionId]
    if (Object.hasOwn(modelBaseline?.values ?? {}, 'modelSelection')) {
      modelProjection.apply(modelBaseline.values.modelSelection, modelBaseline.asOfSeq)
    }
    // Todos are per-session in the baseline — take ONLY the watched session's,
    // never a merge of every session's list (the host has thousands).
    const watched = activeSessionId && base.projections?.[activeSessionId]?.values?.todos
    if (Array.isArray(watched)) {
      const mapped = watched.map(t => ({ text: t.content ?? t.text ?? '', status: t.status ?? 'pending' }))
      todosCache.splice(0, todosCache.length, ...mapped)
      emit({ t: 'todos', items: todosCache })
    }
    const perms = activeSessionId && base.projections?.[activeSessionId]?.values?.permissions
    if (perms && Array.isArray(perms.options)) {
      permissionsCache = { options: perms.options, currentValue: perms.currentValue ?? null }
      emit({ t: 'permissions', ...permissionsCache })
    }
    // Jobs: the watched session's own jobs plus anything still live anywhere
    // (a running build from a subagent is exactly what a glance should catch).
    const allJobs = []
    for (const [sid, jobs] of Object.entries(base.jobs ?? {})) {
      for (const j of jobs) {
        if (sid === activeSessionId || j.status === 'running' || j.status === 'stopping') {
          allJobs.push({ id: j.id, label: (j.label ?? j.kind ?? j.id).slice(0, 160), state: j.status })
        }
      }
    }
    jobsCache.splice(0, jobsCache.length, ...allJobs)
    emit({ t: 'jobs', items: jobsCache })
    return
  }
  if (v.type === 'projection' && v.key === 'modelSelection' && v.sessionId === activeSessionId) {
    modelProjection.apply(v.value, v.seq)
    return
  }
  if (v.type === 'projection' && v.key === 'todos' && Array.isArray(v.value) && v.sessionId === activeSessionId) {
    const mapped = v.value.map(t => ({ text: t.content ?? t.text ?? '', status: t.status ?? 'pending' }))
    todosCache.splice(0, todosCache.length, ...mapped)
    emit({ t: 'todos', items: todosCache })
    return
  }
  if (v.type === 'projection' && v.key === 'permissions' && v.sessionId === activeSessionId &&
      v.value && Array.isArray(v.value.options)) {
    permissionsCache = { options: v.value.options, currentValue: v.value.currentValue ?? null }
    emit({ t: 'permissions', ...permissionsCache })
    return
  }
  if (v.type === 'jobs') {
    // Scope to the watched session; jobs from other sessions only while live.
    const fromWatched = v.sessionId === activeSessionId
    const incoming = (v.jobs ?? [])
      .filter(j => fromWatched || j.status === 'running' || j.status === 'stopping')
      .map(j => ({ id: j.id, label: (j.label ?? j.kind ?? j.id).slice(0, 160), state: j.status }))
    const droppedIds = new Set((v.jobs ?? []).map(j => j.id))
    const kept = jobsCache.filter(c => !droppedIds.has(c.id) && (fromWatched || c.state === 'running' || c.state === 'stopping'))
    const merged = [...incoming, ...kept]
    jobsCache.splice(0, jobsCache.length, ...merged)
    emit({ t: 'jobs', items: jobsCache })
  }
}

function handleEventsFrame (v) {
  if (!v) return
  if (v.type === 'ready') { eventsClientId = v.clientId; return }
  if (v.type === 'cancel') { dropApproval(v.eventId); askStates.delete(v.eventId); return }
  if (v.type === 'emit') {
    // Instant running-state flips for the active session (browser-started turns).
    if (v.event === 'api-session/status' && Array.isArray(v.args)) {
      const [sessionId, isRunning] = v.args
      if (sessionId === activeSessionId) {
        runningAuthorityAt = Date.now()   // live status outranks any cached list row
        emit({ t: 'session-running', running: Boolean(isRunning), sessionId })
      }
    }
    return
  }
  if (v.type !== 'waterfall') return
  if (v.event === 'approval/request') {
    const r = v.request ?? {}
    publishApproval({
      id: v.eventId,
      kind: 'approval',
      title: r.toolName ?? 'Approval needed',
      detail: r.reason ?? r.callId,
      options: [{ id: 'allowed-once', label: 'Allow once' }, { id: 'rejected', label: 'Deny' }],
      multi: false,
    })
    return
  }
  if (v.event === 'user-questions/request') {
    const questions = v.request?.questions ?? []
    if (!questions.length) return
    const st = { questions, qi: 0, answers: [] }
    askStates.set(v.eventId, st)
    publishApproval(watchAskItem(v.eventId, st))
  }
}

function connectWs () {
  modelProjection.reset()
  try { ws?.close() } catch {}
  let ready = false
  try {
    ws = new WebSocket(WS_URL, { headers: { Cookie: cookieHeader() } })
  } catch (e) {
    console.error('[dsh] ws construct failed', e.message)
    scheduleReconnect()
    return
  }
  const socket = ws
  ws.onopen = () => {
    if (ws !== socket) return
    ready = true
    wsBackoff = 1000
    console.log('[dsh] mux connected')
    openStream('ctrl', 'session/control', {})
    openStream('ev', '$events', {})
    openStream('wf', 'workspace/follow', {})
    if (activeSessionId) followSession(activeSessionId)
    refreshSnapshot().catch((e) => console.error('[dsh] refresh', e.message))
  }
  ws.onmessage = (msg) => {
    if (ws !== socket) return
    let frame
    try { frame = JSON.parse(typeof msg.data === 'string' ? msg.data : msg.data.toString()) } catch { return }
    switch (frame.type) {
      case 'item':
        if (frame.streamId === followStreamId) handleFollowValue(frame.value)
        else if (frame.streamId === 'ctrl') handleControlValue(frame.value)
        else if (frame.streamId === 'ev') handleEventsFrame(frame.value)
        else if (frame.streamId === 'wf') handleWorkspaceValue(frame.value)
        break
      case 'error':
        if (frame.streamId === followStreamId) console.error('[dsh] follow error', frame.error?.message)
        break
      case 'end':
        break
      default:
        break
    }
  }
  ws.onerror = () => {}
  ws.onclose = () => {
    if (ws !== socket) return
    // A disconnected projection cannot certify the current model; wait for the
    // reconnect baseline rather than presenting stale/default selection as fact.
    modelProjection.reset()
    if (!ready) console.error('[dsh] ws handshake failed (auth?)')
    scheduleReconnect()
  }
}

let reconnectTimer = null
function scheduleReconnect () {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectWs()
    wsBackoff = Math.min(wsBackoff * 2, 5000)
  }, wsBackoff)
}

export function subscribeSession () {
  connectWs()
  // The launch token / cookie do not expire for 30 d; sessions can switch at
  // any time — refresh keeps activeSessionId + running fresh even if WS is down.
  setInterval(() => { refreshSnapshot().catch(() => {}) }, 15000).unref?.()
}

// ---- watched-session binding (bridge character effects) -------------------------
// Synchronous snapshot of the currently followed harness session for the
// atomic session-binding guard (bridge/session-binding.mjs): character
// effects compare the caller's claimed session id against this value with no
// await between the check and the effect, so a session switch cannot slip in
// between (TOCTOU guard). Returns the session id string or null when nothing
// is followed yet. Read-only; no network, no credentials.
export function getWatchedSessionSync () {
  return typeof activeSessionId === 'string' && activeSessionId ? activeSessionId : null
}

/**
 * Test-only: return the module to a known state without touching the network,
 * credentials or any socket. Deterministic offline tests drive handleFollowValue
 * and applySessionList directly and capture events through onDshEvent.
 */
export function __resetDshStateForTests () {
  activeSessionId = null
  sessionRevision++
  modelProjection.reset()
  sessionPinned = false
  running = false
  runningAuthorityAt = 0
  assistant.turn = null
  assistant.committed.clear()
  clearLive()
  assistant.done = false
  rebuilding = false
  anonSeq = 0
  activeCwd = null
  todosCache.splice(0, todosCache.length)
  jobsCache.splice(0, jobsCache.length)
  permissionsCache = null
  lastSessionList = null
  followStreamId = null
}
