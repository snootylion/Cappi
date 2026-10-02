package dev.dsh.watch.core

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.core.content.edit
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.dsh.watch.audio.TtsPlayer
import dev.dsh.watch.cappi.CAPPI_ACTION_TIMEOUT_MS
import dev.dsh.watch.cappi.CharacterAssets
import dev.dsh.watch.cappi.parseCharacterPack
import dev.dsh.watch.cappi.reduceCappiAction
import dev.dsh.watch.net.BridgeClient
import dev.dsh.watch.net.ConnectionSettings
import dev.dsh.watch.net.SecureTransport
import dev.dsh.watch.net.SseReader
import dev.dsh.watch.service.VoiceService
import dev.dsh.watch.util.Haptics
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.HttpURLConnection
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Single source of truth: SSE supervisor (manual line parser, 40s watchdog, 1s→2s→5s
 * capped backoff, forever), local phase state machine, command dispatch, TTS fan-out.
 *
 * One instance per process: it lives in App's ViewModelStore (App.bridgeViewModel()),
 * shared by every activity instance (grid entry + HOME alias), so exactly one SSE
 * connection and one TtsPlayer exist — the bridge broadcasts each audio chunk to every
 * watch stream, so two owners would speak every reply twice.
 */
class BridgeViewModel(app: Application) : AndroidViewModel(app) {

    private val prefs = app.getSharedPreferences("dsh_remote", Context.MODE_PRIVATE)
    private val pendingDismissals = PendingDismissals(prefs.getString("dismissed_pending_v1", "").orEmpty())

    private val _state = MutableStateFlow(
        UiState(
            base = migrateStoredBase(prefs.getString(KEY_BASE, DEFAULT_BASE) ?: DEFAULT_BASE),
            token = prefs.getString(KEY_TOKEN, "") ?: "",
            certPinSha256 = prefs.getString(KEY_CERT_PIN, "") ?: "",
            allowInsecureLan = prefs.getBoolean(KEY_ALLOW_INSECURE, false),
            deviceId = prefs.getString(KEY_DEVICE_ID, "").orEmpty()
                .ifEmpty { java.util.UUID.randomUUID().toString().also {
                    prefs.edit { putString(KEY_DEVICE_ID, it) } } },
            characterId = CharacterSelection.sanitizeId(prefs.getString(CharacterSelection.PREF_KEY, CharacterSelection.DEFAULT_ID)),
            voiceOutputEnabled = VoiceCenter.readVoiceOutput(prefs),
            offlineClock = prefs.getBoolean("offline_clock", false),
            keepScreenAwake = prefs.getBoolean("keep_screen_awake", true),
            wakeOnActivity = prefs.getBoolean("wake_on_activity", true),
        )
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** Trusted-factory view of the current endpoint (for A/settings wiring). */
    fun connectionSecurity(): SecureTransport.EndpointSecurity = _state.value.endpointSecurity()

    private val tts = TtsPlayer()
    private var sseJob: Job? = null
    private var connectionDeadline: Job? = null
    @Volatile private var connectionGeneration = 0L
    @Volatile private var disconnectedSince: Long? = prefs.getLong("disconnected_since", 0L).takeIf { it > 0L }
    // Persisted wall time: reopening the app must not restart a failing five-minute window.
    @Volatile private var sseConn: HttpURLConnection? = null // live stream; at most one per ViewModel
    private val startedByApp = AtomicBoolean(false) // sessionOwnedByApp
    private var sessionRunning = false
    private var everGotHello = false
    private var helloThisAttempt = false
    private var toastJob: Job? = null
    private var errorJob: Job? = null
    private var cappiJob: Job? = null
    @Volatile private var lastCappiAt = 0L
    private var cappiRevision = 0L
    @Volatile private var expiredCappiAction: String? = null

    @Volatile private var ttsInFlight = false // audio/speech-started seen, not yet done
    @Volatile private var lastPendingBuzzAt = 0L
    @Volatile private var lastAssistantAt = 0L // last live assistant event (snapshot staleness guard)
    @Volatile private var micCaptureIntentActive = false // explicit stop ignores raced terminal events
    private var micDraftStreamId: String? = null // captured question intent, not mutable pending UI

    init {
        tts.setOutputEnabled(_state.value.voiceOutputEnabled)
        tts.start(viewModelScope)
        viewModelScope.launch {
            tts.speakingOutput.collect { playing ->
                _state.update { it.copy(speakingOutput = playing) }
            }
        }
        // Service transport truth: latch micOpen on ACCEPTED (capturing/ready
        // for the current stream), never on start-intent. Stale generations
        // (settings change / stop) never flip the new owner's state.
        viewModelScope.launch {
            dev.dsh.watch.service.MicStatus.flow.collect { snap ->
                if (snap == null) return@collect
                _state.update { st ->
                    if (!micCaptureIntentActive || st.watchStreamId.isEmpty() || snap.streamId != st.watchStreamId ||
                        !dev.dsh.watch.service.MicReceipt.allowsProgress(st.micState, snap.state)) st
                    else st.copy(
                        dictating = if (snap.state in setOf("error", "closed", "cancelled") && snap.streamId == micDraftStreamId) false else st.dictating,
                        dictationSettling = if (snap.state in setOf("error", "closed", "cancelled") && snap.streamId == micDraftStreamId) false else st.dictationSettling,
                        micOpen = snap.state == "capturing" || snap.state == "ready",
                        micState = snap.state,
                        micMessage = snap.message,
                        micTxBytes = snap.txBytes,
                        micTxChunks = snap.txChunks,
                        micLegacyFallback = snap.legacyFallback,
                        error = if (snap.state == "error" && !snap.message.isNullOrEmpty()) snap.message else st.error,
                        phase = if (snap.state == "error" && !snap.message.isNullOrEmpty()) Phase.ERROR else st.phase,
                    )
                }
            }
        }
        if (!_state.value.offlineClock) startSse()
    }

    /** Pause after five continuous minutes without the bridge, rather than retry forever. */
    private fun scheduleConnectionDeadline() {
        connectionDeadline?.cancel()
        if (_state.value.offlineClock || _state.value.connected) return
        val generation = connectionGeneration
        val now = System.currentTimeMillis()
        val started = disconnectedSince ?: now.also {
            disconnectedSince = it
            prefs.edit { putLong("disconnected_since", it) }
        }
        val remaining = SseSupervisor.deadlineRemaining(now, started)
        connectionDeadline = viewModelScope.launch {
            delay(remaining)
            if (generation == connectionGeneration && !_state.value.connected && !_state.value.offlineClock) {
                disconnect()
            }
        }
    }

    /** This pauses DSH networking, not Android Wi-Fi (which third-party apps cannot toggle). */
    fun disconnect() {
        onCappiAction(null)
        connectionGeneration++
        connectionDeadline?.cancel()
        disconnectedSince = null
        prefs.edit { putBoolean("offline_clock", true); remove("disconnected_since") }
        _state.update { it.copy(offlineClock = true, connected = false, micOpen = false, phase = Phase.CONNECTING,
            modelPicker = it.modelPicker?.invalidate()) }
        sseJob?.cancel()
        sseConn?.disconnect()
        sseConn = null
        stopDictation(clear = true)
        abortMicUplink()
        tts.cancelAll()
        if (startedByApp.getAndSet(false)) {
            val st = _state.value
            viewModelScope.launch(Dispatchers.IO) {
                runCatching { BridgeClient.command(st.base, st.token, JSONObject().put("cmd", "stop"), st.endpointSecurity()) }
            }
        }
    }

    fun reconnect() {
        if (!_state.value.offlineClock) return
        connectionGeneration++
        disconnectedSince = null
        prefs.edit { putBoolean("offline_clock", false); remove("disconnected_since") }
        _state.update { it.copy(offlineClock = false, connected = false, phase = Phase.CONNECTING,
            modelPicker = it.modelPicker?.invalidate()) }
        startSse()
    }

    // ---------------------------------------------------------------- SSE supervisor

    private fun startSse() {
        if (_state.value.offlineClock) return
        if (!_state.value.isPairedEndpoint()) {
            // Blank (or documentation-placeholder) base: unpaired. Stay idle —
            // never dial or poll a placeholder address.
            _state.update { it.copy(connected = false, phase = Phase.CONNECTING) }
            return
        }
        scheduleConnectionDeadline()
        sseJob?.cancel()
        // A cancelled supervisor parked in a blocking read keeps its socket open
        // (and consuming events) until the 40s watchdog — close it now so this
        // ViewModel can never hold two live streams, not even transiently.
        sseConn?.runCatching { disconnect() }
        sseConn = null
        sseJob = viewModelScope.launch(Dispatchers.IO) {
            var backoffMs = SseSupervisor.INITIAL_BACKOFF_MS
            while (isActive) {
                val st = _state.value
                helloThisAttempt = false
                var conn: HttpURLConnection? = null
                try {
                    val opened = BridgeClient.openSse(st.base, st.token, st.endpointSecurity())
                    // Settings may have superseded us while connect() was blocked.
                    // Do not adopt that late socket or overwrite the new owner's handle.
                    if (!isActive) {
                        opened.disconnect()
                        return@launch
                    }
                    conn = opened
                    sseConn = opened
                    val reader = SseReader(opened)
                    // readLoop runs until EOF/40s-read-timeout/IOException — all reconnect.
                    // Any line (incl. `: keepalive`) proves liveness; the 40s socket
                    // read timeout is the watchdog itself.
                    reader.readLoop(
                        onEvent = { if (isActive) dispatch(it) }, // superseded supervisor must not consume events
                        onLine = { /* watchdog reset */ },
                    )
                } catch (e: Throwable) {
                    // A pin/trust misconfiguration must surface as setup guidance,
                    // not an endless silent retry (the 5-minute deadline still bounds it).
                    val trust = ConnectionCenter.trustError(_state.value)
                    if (trust != null && _state.value.error == null) {
                        showError(trust)
                    } else if (e is java.io.IOException && (e.message?.contains("pin", ignoreCase = true) == true)) {
                        showError(e.message ?: "bridge trust failed")
                    }
                    // fall through to reconnect
                } finally {
                    if (sseConn === conn) sseConn = null
                }
                // Cancelled by applySettings/onCleared: a newer supervisor (or teardown)
                // owns mic/SSE state now — never stomp it from this dead one.
                if (!isActive) return@launch
                // Dropped (or never connected): back to connecting, abort mic uplink.
                abortMicUplink()
                onCappiAction(null)
                _state.update { it.copy(connected = false, phase = Phase.CONNECTING, micOpen = false,
                    modelPicker = it.modelPicker?.invalidate()) }
                scheduleConnectionDeadline()
                if (helloThisAttempt) {
                    backoffMs = SseSupervisor.INITIAL_BACKOFF_MS // a healthy run resets the backoff
                } else {
                    // Self-heal a stale bridge address (DHCP changes): find the
                    // bridge on the Wi-Fi and save its current URL. Candidates
                    // are verified by certificate pin (or legacy pair-probe)
                    // inside discoverBase before any trust; a superseded
                    // settings generation never overwrites manual settings.
                    val generation = connectionGeneration
                    val stNow = _state.value
                    val found = runCatching {
                        BridgeClient.discoverBase(
                            stNow.token,
                            1500,
                            stNow.endpointSecurity(),
                            isCancelled = { generation != connectionGeneration },
                        )
                    }.getOrNull()
                    if (generation != connectionGeneration) {
                        // Settings changed while discovering: drop the result.
                    } else if (SseSupervisor.shouldAdoptDiscovery(found, _state.value.base) && found != null) {
                        prefs.edit { putString(KEY_BASE, found) }
                        _state.update { it.withQuestionConnection(found, it.token) }
                        backoffMs = SseSupervisor.INITIAL_BACKOFF_MS
                    }
                }
                delay(backoffMs)
                backoffMs = SseSupervisor.nextBackoff(backoffMs) // 1s → 2s → 5s until the five-minute deadline
            }
        }
    }

    /** Called from settings save: new base/token → reconnect now. */
    fun applySettings(base: String, token: String) {
        val st = _state.value
        applySettings(base, token, SecureTransport.displayPin(st.certPinSha256), st.allowInsecureLan)
    }

    /**
     * Full connection save including pairing identity (certificate pin +
     * insecure-LAN opt-in). Validates before saving: an invalid combination
     * surfaces a toast and leaves stored settings untouched. Bumps the
     * connection generation so stale discovery results can never overwrite
     * these manual settings.
     */
    fun applySettings(base: String, token: String, certPinInput: String, allowInsecureLan: Boolean) {
        val err = ConnectionCenter.validate(base, token, certPinInput, allowInsecureLan)
        if (err != null) {
            showToast(err)
            return
        }
        stopDictation(clear = true)
        abortMicUplink() // old input/token/socket closed synchronously before any transport mutation
        onCappiAction(null)
        connectionGeneration++
        val v = ConnectionSettings.validated(base, token, certPinInput, allowInsecureLan)
        prefs.edit {
            putString(KEY_BASE, v.base)
            putString(KEY_TOKEN, v.token)
            putString(KEY_CERT_PIN, v.pin)
            putBoolean(KEY_ALLOW_INSECURE, v.allowInsecureLan)
        }
        _state.update { it.withQuestionConnection(v.base, v.token, v.pin, v.allowInsecureLan) }
        startSse()
    }

    // ---------------------------------------------------------------- character selection (user-owned)

    /**
     * Persist the local character choice and advertise it to the bridge with
     * `{cmd:'character-select', characterId, registryVersion}`. The server
     * answers `{ok:true, characterId}`; any failure toasts and keeps the local
     * choice (the bridge never owns selection).
     */
    fun selectCharacter(characterId: String) {
        val id = CharacterSelection.sanitizeId(characterId)
        if (id == _state.value.characterId) {
            advertiseCharacter()
            return
        }
        prefs.edit { putString(CharacterSelection.PREF_KEY, id) }
        _state.update { it.copy(characterId = id, remoteCharacterId = null) }
        advertiseCharacter()
    }

    /** Fire-and-forget advertisement of the current local choice (hello + manual). */
    fun advertiseCharacter() {
        val st = _state.value
        if (!st.connected || st.offlineClock) return
        val generation = connectionGeneration
        val base = st.base
        val token = st.token
        val security = st.endpointSecurity()
        val id = st.characterId
        viewModelScope.launch(Dispatchers.IO) {
            if (generation != connectionGeneration) return@launch
            runCatching {
                BridgeClient.command(base, token, CharacterSelection.selectCommand(id), security)
            }.onSuccess { resp ->
                val echoed = if (resp.isNull("characterId")) null else resp.optString("characterId")
                if (!echoed.isNullOrEmpty() && echoed != id) {
                    _state.update { cur ->
                        if (cur.characterId == id) cur.copy(remoteCharacterId = echoed) else cur
                    }
                }
            }.onFailure { e ->
                if (generation == connectionGeneration) showToast(e.message ?: "character select failed")
            }
        }
    }

    /** This pack drives alias translation for model cappiAction cues. */
    private var cachedPackId: String? = null
    private var cachedPack: dev.dsh.watch.cappi.CharacterPack? = null

    private fun activePack(): dev.dsh.watch.cappi.CharacterPack? {
        val id = _state.value.characterId
        if (cachedPackId == id && cachedPack != null) return cachedPack
        // Registry default first, then the license-safe hand-authored
        // fallback when Cappi assets are missing or corrupt. Never cache a
        // miss: a corrupt-asset retry must re-read instead of serving stale.
        val pack = loadPack(id)
            ?: loadPack(CharacterSelection.DEFAULT_ID)
            ?: loadPack(CharacterSelection.FALLBACK_ID)
        cachedPackId = id
        cachedPack = pack
        return pack
    }

    private fun loadPack(id: String): dev.dsh.watch.cappi.CharacterPack? {
        if (!CharacterAssets.isSafePackId(id)) return null
        return runCatching {
            val app = getApplication<Application>()
            val path = CharacterAssets.packAssetPath(id) ?: return null
            val text = app.assets.open(path).bufferedReader().use { it.readText() }
            parseCharacterPack(text)
        }.getOrNull()
    }

    /** Incoming bridge `t:'character'` event: observed, never silently applied. */
    private fun onRemoteCharacter(json: JSONObject) {
        val id = json.optString("characterId").trim()
        if (id.isEmpty()) return
        val local = _state.value.characterId
        if (id == local) {
            _state.update { it.copy(remoteCharacterId = null) }
            return
        }
        _state.update { it.copy(remoteCharacterId = id) }
        showToast("Bridge suggests '$id' — keeping '$local' (change it in Settings)")
    }

    // ---------------------------------------------------------------- event dispatch

    private fun dispatch(json: JSONObject) {
        when (json.optString("t")) {
            "hello" -> onHello(json)
            "voice" -> {
                val phase = json.optString("phase")
                val muted = json.optBoolean("muted", _state.value.macMuted)
                _state.update {
                    it.copy(
                        serverVoicePhase = if (phase.isEmpty()) it.serverVoicePhase else phase,
                        voiceActive = json.optBoolean("active", it.voiceActive),
                        macMuted = muted,
                    )
                }
            }
            "speech-started" -> {
                if (!_state.value.voiceOutputEnabled) return
                val id = json.optString("speechId")
                val rate = json.optInt("sampleRate", 24000)
                tts.speechStarted(id, rate)
                ttsInFlight = true
                setPhase(Phase.SPEAKING)
            }
            "audio" -> {
                if (!_state.value.voiceOutputEnabled) return
                val id = json.optString("speechId")
                tts.audio(
                    speechId = id,
                    seq = json.optInt("sequence", json.optInt("seq", 0)),
                    sampleRate = json.optInt("sampleRate", 24000),
                    b64 = json.optString("pcmBase64", json.optString("data", json.optString("audio", ""))),
                )
                ttsInFlight = true
                setPhase(Phase.SPEAKING)
            }
            "audio-done" -> {
                val id = json.optString("speechId")
                val cancelled = json.optBoolean("cancelled", false)
                tts.audioDone(id, cancelled)
                ttsInFlight = false
                if (!cancelled && !sessionRunning) setPhase(Phase.LISTENING)
            }
            "audio-cancel" -> {
                val id = json.optString("speechId").ifEmpty { null }
                tts.cancelAll(id)
                ttsInFlight = false
                if (_state.value.phase == Phase.SPEAKING) setPhase(Phase.LISTENING)
            }
            "asr" -> onAsr(json)
            "cappi" -> onCappiAction(if (json.isNull("action")) null else json.optString("action"))
            "character" -> onRemoteCharacter(json)
            "dictation-partial" -> updateDictation(json, final = false)
            "dictation-final" -> updateDictation(json, final = true)
            "dictation-closed" -> {
                val id = json.optString("requestId")
                _state.update { if (it.dictationRequestId == id) it.copy(dictating = false, dictationSettling = false, dictationPartial = "") else it }
            }
            "session" -> {
                sessionRunning = json.optBoolean("running", false)
                val sid = json.optString("sessionId")
                if (sid.isNotEmpty() && sid != _state.value.sessionId) onCappiAction(null)
                val cwd = if (json.isNull("cwd")) null else json.optString("cwd").takeIf { c -> c.isNotEmpty() }
                _state.update {
                    it.withVisiblePending(it.pending, sid.ifEmpty { it.sessionId }).copy(
                        sessionRunning = sessionRunning,
                        sessionCwd = cwd ?: it.sessionCwd,
                        assistantText = if ((sid.isNotEmpty() && sid != it.sessionId) || (sessionRunning && !it.sessionRunning)) "" else it.assistantText,
                        assistantDone = if ((sid.isNotEmpty() && sid != it.sessionId) || (sessionRunning && !it.sessionRunning)) false else it.assistantDone,
                    )
                }
                if (sessionRunning) {
                    if (_state.value.phase in listOf(Phase.LISTENING, Phase.IDLE, Phase.HEARING)) {
                        _state.update { it.copy(phase = Phase.THINKING, thinkingSince = now()) }
                    }
                } else if (_state.value.phase == Phase.THINKING) {
                    // Turn ended with no (more) spoken reply — don't stick on amber.
                    setPhase(if (ttsInFlight) Phase.SPEAKING else Phase.LISTENING)
                }
            }
            "assistant" -> {
                // The bridge always sends full cumulative `text` plus `done`, and
                // both are authoritative: interim (done:false), final (done:true)
                // or a clear (text:"" at a turn/session boundary). A non-empty
                // guard here would make resets impossible and strand stale text.
                if (json.has("text")) {
                    val text = json.optString("text", "")
                    val done = json.optBoolean("done", false)
                    lastAssistantAt = now()
                    _state.update { it.copy(assistantText = text, assistantDone = done) }
                    if (done && !sessionRunning && !ttsInFlight && _state.value.phase == Phase.THINKING) {
                        setPhase(Phase.LISTENING)
                    }
                }
            }
            "todos" -> _state.update { it.copy(todos = Parse.todos(json.optJSONArray("items") ?: json.optJSONArray("todos"))) }
            "jobs" -> _state.update { it.copy(jobs = Parse.jobs(json.optJSONArray("items") ?: json.optJSONArray("jobs"))) }
            "agents" -> _state.update { it.copy(agents = Parse.agents(json.optJSONArray("items") ?: json.optJSONArray("agents"))) }
            "queue" -> _state.update { it.copy(queue = Parse.queue(json.optJSONArray("items") ?: json.optJSONArray("queue"))) }
            "images" -> _state.update { it.copy(images = Parse.images(json.optJSONArray("items") ?: json.optJSONArray("images"))) }
            "pending" -> {
                // Full-list replace: shrinks (answered elsewhere) and in-place wizard
                // replacement (same id) both come through here.
                val incoming = Parse.approvals(json.optJSONArray("items"))
                val previousSize = _state.value.pending.size
                _state.update { it.withVisiblePending(pendingDismissals.visible(it.base, it.token, incoming)) }
                val items = _state.value.pending
                val grew = items.size > previousSize
                val capture = _state.value.dictationRequestId
                if (capture != null && items.none { it.id == capture && it.title == _state.value.pendingQuestionTitle }) {
                    stopDictation(clear = true)
                }
                if (grew) pendingPing(null)
            }
            "notice" -> {
                // "Something needs you" ping (e.g. a new approval/ask card arrived).
                pendingPing(json.optString("text"))
            }
            "snapshot" -> applySnapshot(json)
            "workspaces" -> _state.update {
                it.copy(
                    workspaces = Parse.workspaces(json.optJSONArray("items") ?: json.optJSONArray("workspaces")),
                    archivedSessionIds = Parse.strList(json.optJSONArray("archivedSessionIds")),
                )
            }
            "permissions" -> _state.update {
                it.copy(permissions = Parse.permissions(json) ?: PermissionsState(emptyList(), null))
            }
            // Watch-mic server events route ONLY the current watch stream:
            // warming|ready|capturing|closed|error + receipt counters. Events
            // without our streamId (Mac mic, other devices, stale turns) are
            // ignored here — they must never overwrite the local capture
            // toggle and never force sessionRunning false.
            "mic" -> onWatchMicEvent(json)
            "error" -> showError(json.optString("message", json.optString("error", "bridge error")))
        }
    }

    /** Debounced "needs you" buzz (notice + pending-growth can both fire for one card). */
    private fun pendingPing(toast: String?) {
        val t = System.currentTimeMillis()
        if (t - lastPendingBuzzAt > 800) {
            lastPendingBuzzAt = t
            viewModelScope.launch(Dispatchers.Main) { Haptics.buzzMedium(getApplication()) }
        }
        if (!toast.isNullOrEmpty()) showToast(toast)
    }

    private fun onHello(json: JSONObject) {
        if (_state.value.offlineClock) return
        connectionGeneration++
        connectionDeadline?.cancel()
        disconnectedSince = null
        prefs.edit { remove("disconnected_since") }
        helloThisAttempt = true
        val isReconnect = everGotHello
        everGotHello = true
        _state.update {
            it.copy(
                connected = true,
                helloQueueDepth = json.optInt("queueDepth", it.queue.size),
                micCancelSupported = json.optJSONObject("features")?.opt("micCancel") as? Boolean ?: false,
                lastEventAt = now(),
            )
        }
        if (isReconnect) {
            viewModelScope.launch(Dispatchers.Main) { Haptics.buzzLight(getApplication()) }
        }
        // Start once per app run, or reacquire our lost lease after a bridge restart;
        // an active bridge voice session may belong to another client, so leave it alone.
        if (!startedByApp.get() || !json.optBoolean("voiceActive", false)) {
            startedByApp.set(true)
            viewModelScope.launch(Dispatchers.IO) {
                if (!_state.value.offlineClock && command(JSONObject().put("cmd", "start").put("sessionOwnedByApp", true))
                    && !_state.value.offlineClock) {
                    _state.update { it.copy(phase = Phase.LISTENING) }
                }
            }
        } else {
            _state.update { it.copy(phase = Phase.LISTENING) }
        }
        // Refresh full snapshot (todos/queue/pending/session...) over GET /watch/state.
        refreshSnapshot()
        // Re-advertise the user-owned character choice on every hello/reconnect.
        advertiseCharacter()
    }

    /**
     * Apply a full bridge snapshot. [requestedAt] is when the caller asked for
     * it: the assistant block is only applied when no newer live assistant event
     * has landed since (a slow GET must never roll the Text screen back).
     * SSE 'snapshot' events pass the default — same-connection order makes them
     * authoritative as written.
     */
    private fun applySnapshot(s: JSONObject, requestedAt: Long = Long.MAX_VALUE) {
        val asst = s.optJSONObject("assistant")
        val restoreAssistant = asst != null && requestedAt >= lastAssistantAt
        val snapshotSession = s.optJSONObject("session")?.optString("sessionId").orEmpty()
        if (snapshotSession.isNotEmpty() && snapshotSession != _state.value.sessionId) onCappiAction(null)
        // Full snapshots are authoritative: absent/null action explicitly clears.
        // Model ids are translated per active pack (legacy/semantic aliases map
        // through roles); state-owned cues can never be cued by the model.
        if (requestedAt >= lastCappiAt) {
            val raw = if (s.isNull("cappiAction")) null else s.optString("cappiAction")
            val pack = activePack()
            val restored = if (pack != null) {
                CharacterSelection.resolveModelAction(pack, raw)
            } else {
                reduceCappiAction(null, raw)
            }
            if (restored == null || (restored != expiredCappiAction && restored != _state.value.cappiAction)) onCappiAction(restored)
        }
        _state.update { st ->
            val sess = s.optJSONObject("session")
            st.withVisiblePending(
                pendingDismissals.visible(st.base, st.token, Parse.approvals(s.optJSONArray("pending"))),
                snapshotSession.ifEmpty { st.sessionId },
            ).copy(
                todos = Parse.todos(s.optJSONArray("todos")),
                jobs = Parse.jobs(s.optJSONArray("jobs")),
                agents = Parse.agents(s.optJSONArray("agents")),
                queue = Parse.queue(s.optJSONArray("queue")),
                queueReorderSupported = s.optJSONObject("features")?.opt("queueReorder") as? Boolean ?: true,
                openMacSupported = s.optJSONObject("features")?.opt("openMac") as? Boolean ?: true,
                micCancelSupported = s.optJSONObject("features")?.opt("micCancel") as? Boolean ?: false,
                images = if (s.has("images")) Parse.images(s.optJSONArray("images")) else st.images,
                serverVoicePhase = s.optJSONObject("voice")?.optString("phase") ?: st.serverVoicePhase,
                voiceActive = s.optJSONObject("voice")?.optBoolean("active") ?: st.voiceActive,
                macMuted = s.optJSONObject("voice")?.optBoolean("muted") ?: st.macMuted,
                sessionRunning = sess?.optBoolean("running") ?: st.sessionRunning,
                sessionId = snapshotSession.ifEmpty { st.sessionId },
                sessionCwd = sess?.let { sc ->
                    if (sc.isNull("cwd")) null else sc.optString("cwd").takeIf { c -> c.isNotEmpty() }
                } ?: st.sessionCwd,
                // Current turn's visible response — restores interim/final Text
                // state after reconnects without waiting for the next event.
                assistantText = if (restoreAssistant && asst != null) asst.optString("text", "") else st.assistantText,
                assistantDone = if (restoreAssistant && asst != null) asst.optBoolean("done", false) else st.assistantDone,
                workspaces = if (s.has("workspaces")) Parse.workspaces(s.optJSONArray("workspaces")) else st.workspaces,
                archivedSessionIds = if (s.has("archivedSessionIds")) Parse.strList(s.optJSONArray("archivedSessionIds")) else st.archivedSessionIds,
                permissions = if (s.has("permissions")) {
                    Parse.permissions(s.optJSONObject("permissions")) ?: PermissionsState(emptyList(), null)
                } else {
                    st.permissions
                },
                helperState = s.optJSONObject("helper")?.optString("state") ?: st.helperState,
                lastEventAt = now(),
            )
        }
        val capture = _state.value.dictationRequestId
        if (capture != null && _state.value.pending.none { it.id == capture && it.title == _state.value.pendingQuestionTitle }) {
            stopDictation(clear = true)
        }
        sessionRunning = _state.value.sessionRunning
    }

    /** Re-fetch GET /watch/state → full snapshot (command-only screens pull on entry). */
    fun refreshSnapshot() {
        val st = _state.value
        val requestedAt = now()   // staleness reference for the assistant block
        val generation = connectionGeneration
        val base = st.base
        val token = st.token
        val security = st.endpointSecurity()
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { BridgeClient.fetchState(base, token, security) }.onSuccess { snap ->
                // A settings change mid-flight owns the new state — never let a
                // stale snapshot roll it back.
                if (generation == connectionGeneration) applySnapshot(snap, requestedAt)
            }
        }
    }

    private fun updateDictation(json: JSONObject, final: Boolean) {
        val id = json.optString("requestId")
        val text = json.optString("text").trim()
        _state.update { st ->
            if (st.dictationRequestId != id || st.pending.none { it.id == id && it.kind == "ask" }) st
            else if (final) st.copy(dictationFinal = text, dictationRevision = st.dictationRevision + 1, dictationPartial = "")
            else st.copy(dictationPartial = text)
        }
    }

    /**
     * Server `t:'mic'` for the current watch stream only. Unknown streamIds
     * (Mac mic, sibling devices, raced turns) are ignored. Never touches
     * `sessionRunning`: mic-delivery truth ≠ agent-turn truth, and a slow GET
     * snapshot (generation-guarded in [refreshSnapshot]) wins stale races.
     */
    private fun onWatchMicEvent(json: JSONObject) {
        val sid = json.optString("streamId")
        if (sid.isEmpty()) return
        val current = _state.value.watchStreamId
        if (!micCaptureIntentActive || current.isEmpty() || sid != current) return
        val state = json.optString("state")
        if (state.isEmpty()) return
        val receipt = json.optJSONObject("receipt")
        // Managed close without a receipt is transport EOF, not admission.
        if (state == "closed" && receipt == null && !_state.value.micLegacyFallback) return
        val outcome = when {
            state == "error" -> dev.dsh.watch.service.MicReceipt.failure(json.optString("code"))
            state == "closed" && receipt != null -> dev.dsh.watch.service.MicReceipt.evaluate(
                200, receipt.toString(), sid, sid == micDraftStreamId, _state.value.micLegacyFallback)
            else -> null
        }
        val effectiveState = outcome?.state ?: state
        _state.update {
            if (!micCaptureIntentActive || it.watchStreamId != sid ||
                !dev.dsh.watch.service.MicReceipt.allowsProgress(it.micState, effectiveState)) it else it.copy(
                micState = effectiveState,
                micOpen = effectiveState == "capturing" || effectiveState == "ready",
                micMessage = outcome?.message ?: it.micMessage,
                error = if (effectiveState == "error") outcome?.message ?: it.error else it.error,
                phase = if (effectiveState == "error") Phase.ERROR else it.phase,
                dictating = if (effectiveState == "error" && sid == micDraftStreamId) false else it.dictating,
                dictationSettling = if (effectiveState == "error" && sid == micDraftStreamId) false else it.dictationSettling,
                micTxBytes = receipt?.optLong("txBytes", it.micTxBytes) ?: it.micTxBytes,
                micTxChunks = receipt?.optLong("txChunks", it.micTxChunks) ?: it.micTxChunks,
            )
        }
    }

    private fun onAsr(json: JSONObject) {        val kind = (json.optString("kind").ifEmpty { json.optString("type") })
            .ifEmpty { json.optString("state") }
        when {
            kind.contains("start") -> {
                _state.update { it.copy(phase = Phase.HEARING, partialText = "") }
            }
            kind.contains("partial") -> _state.update { it.copy(partialText = json.optString("text")) }
            kind.contains("final") -> _state.update { it.copy(partialText = json.optString("text")) }
            kind.contains("end") || kind.contains("stop") -> {
                if (_state.value.phase == Phase.HEARING) setPhase(Phase.LISTENING)
            }
            json.has("text") -> _state.update { it.copy(partialText = json.optString("text")) }
        }
    }

    // ---------------------------------------------------------------- phase helpers

    private fun setPhase(p: Phase) {
        _state.update { if (it.phase != p) it.copy(phase = p, thinkingSince = if (p == Phase.THINKING) now() else it.thinkingSince) else it }
    }

    fun dismissError() {
        errorJob?.cancel()
        _state.update {
            it.copy(
                error = null,
                phase = when {
                    !it.connected -> Phase.CONNECTING
                    sessionRunning -> Phase.THINKING
                    else -> Phase.LISTENING
                },
            )
        }
    }

    private fun showError(message: String) {
        viewModelScope.launch(Dispatchers.Main) { Haptics.buzzError(getApplication()) }
        _state.update { it.copy(error = message, phase = Phase.ERROR) }
        errorJob?.cancel()
        errorJob = viewModelScope.launch {
            delay(10_000) // auto-clear a stale error so the ring isn't stuck red
            if (_state.value.phase == Phase.ERROR) dismissError()
        }
    }

    private fun showToast(message: String) {
        _state.update { it.copy(toast = message) }
        toastJob?.cancel()
        toastJob = viewModelScope.launch {
            delay(3000)
            _state.update { if (it.toast == message) it.copy(toast = null) else it }
        }
    }

    private fun now() = System.currentTimeMillis()

    // ---------------------------------------------------------------- commands

    /**
     * POST /watch/command → response on success; on failure shows error toast + buzz
     * and returns null. Success = {approved:true} / {ok:true} / neither key present.
     * HTTP 400/409/502 {error} surfaces as a display-ready BridgeCommandException message.
     */
    private suspend fun commandResp(body: JSONObject): JSONObject? {
        val st = _state.value
        return try {
            val resp = BridgeClient.command(st.base, st.token, body, st.endpointSecurity())
            val ok = when {
                resp.has("approved") -> resp.optBoolean("approved", false)
                resp.has("ok") -> resp.optBoolean("ok", false)
                else -> true
            }
            if (ok) {
                resp
            } else {
                viewModelScope.launch(Dispatchers.Main) { Haptics.buzzError(getApplication()) }
                showToast(resp.optString("error", "command failed"))
                null
            }
        } catch (e: Exception) {
            viewModelScope.launch(Dispatchers.Main) { Haptics.buzzError(getApplication()) }
            showToast(e.message ?: "command failed")
            null
        }
    }

    /** Returns true on success; shows a 3s toast on failure. Handles {ok} and {approved}. */
    private suspend fun command(body: JSONObject): Boolean = commandResp(body) != null

    fun submit(text: String) {
        if (text.isBlank()) return
        viewModelScope.launch(Dispatchers.IO) {
            if (command(JSONObject().put("cmd", "submit").put("text", text))) {
                _state.update { it.copy(phase = Phase.THINKING, thinkingSince = now(), partialText = "") }
                viewModelScope.launch(Dispatchers.Main) { Haptics.buzzMedium(getApplication()) }
            }
        }
    }

    /** Menu-entry cue acknowledgement only; cards stay pending and no command is sent. */
    fun reviewPendingQuestions() {
        _state.update { it.acknowledgePendingQuestions() }
    }

    /** Local dismissal only: never sends an answer, approval, denial, or cancel. */
    fun dismissPending(item: Approval) {
        val st = _state.value
        if (!QuestionCenter.canDismiss(st, item)) { showToast("Question changed; reopen it"); return }
        val saved = pendingDismissals.dismiss(st.base, st.token, item)
        prefs.edit { putString("dismissed_pending_v1", saved) }
        _state.update { current ->
            if (current.base != st.base || current.token != st.token) current
            else current.withVisiblePending(pendingDismissals.visible(current.base, current.token, current.pending))
        }
        val current = _state.value
        if (current.pendingRequestId == item.id && current.pendingQuestionTitle == item.title) setPendingTarget(null)
        showToast("Dismissed from watch")
    }

    fun approve(requestId: String, choiceId: String, freeText: String? = null, onSuccess: () -> Unit = {}) {
        val st = _state.value
        if (QuestionCenter.approveBlocked(st, requestId, freeText)) {
            showToast("Question changed; reopen it")
            return
        }
        viewModelScope.launch(Dispatchers.IO) {
            val body = JSONObject().put("cmd", "approve").put("requestId", requestId).put("choiceId", choiceId)
            if (freeText != null) body.put("text", freeText)
            if (command(body)) {
                viewModelScope.launch(Dispatchers.Main) {
                    Haptics.buzzDouble(getApplication())
                    onSuccess()
                }
            }
        }
    }

    fun approveChoices(requestId: String, choices: List<String>) {
        val item = _state.value.pending.firstOrNull { it.id == requestId && it.kind == "ask" && it.multi } ?: return
        if (choices.isEmpty() || choices.any { c -> item.options.none { it.id == c } }) return
        viewModelScope.launch(Dispatchers.IO) {
            if (command(JSONObject().put("cmd", "approve").put("requestId", requestId)
                .put("choiceIds", org.json.JSONArray(choices)))) {
                viewModelScope.launch(Dispatchers.Main) { Haptics.buzzDouble(getApplication()) }
            }
        }
    }

    fun stopVoice() {
        viewModelScope.launch(Dispatchers.IO) {
            command(JSONObject().put("cmd", "stop"))
            startedByApp.set(false)
        }
    }

    fun cancelPlayback() {
        viewModelScope.launch(Dispatchers.IO) { command(JSONObject().put("cmd", "cancel")) }
    }

    fun toggleMute() {
        viewModelScope.launch(Dispatchers.IO) {
            val target = !_state.value.macMuted
            if (command(JSONObject().put("cmd", "mute").put("muted", target))) {
                _state.update { it.copy(macMuted = target) }
            }
        }
    }

    fun queueSteer(id: String) {
        viewModelScope.launch(Dispatchers.IO) { command(JSONObject().put("cmd", "steer").put("id", id)) }
    }

    fun queueRemove(id: String) {
        _state.update { it.copy(queue = it.queue.filterNot { q -> q.id == id }) } // optimistic
        viewModelScope.launch(Dispatchers.IO) { command(JSONObject().put("cmd", "queue-remove").put("id", id)) }
    }

    fun queueClear() {
        _state.update { it.copy(queue = emptyList()) }
        viewModelScope.launch(Dispatchers.IO) { command(JSONObject().put("cmd", "queue-clear")) }
    }

    fun queueMove(id: String, to: Int) {
        if (!_state.value.queueReorderSupported) {
            showToast("This host does not support queue reordering — send or remove an item instead")
            return
        }
        viewModelScope.launch(Dispatchers.IO) {
            if (!_state.value.queueReorderSupported) return@launch
            command(JSONObject().put("cmd", "queue-move").put("id", id).put("to", to))
        }
    }

    fun refresh() {
        viewModelScope.launch(Dispatchers.IO) { command(JSONObject().put("cmd", "refresh")) }
    }

    fun speakTest(text: String = "Watch speaker test") {
        viewModelScope.launch(Dispatchers.IO) { command(JSONObject().put("cmd", "speak").put("text", text)) }
    }

    fun openOnMac(url: String) {
        if (!_state.value.openMacSupported) { showToast("Open on Mac is not supported by this host"); return }
        viewModelScope.launch(Dispatchers.IO) { command(JSONObject().put("cmd", "open-mac").put("url", url)) }
    }

    // ---------------------------------------------------------------- thread-scoped model picker

    private val modelRequestIds = java.util.concurrent.atomic.AtomicLong()

    fun openModels(scope: ModelScope) {
        _state.update { st ->
            val picker = ModelPickerState(scope, modelRequestIds.incrementAndGet())
            st.copy(modelPicker = if (scope.matches(st) && scope.sessionId.isNotBlank()) picker else picker.invalidate())
        }
        loadModels(scope)
    }

    fun closeModels(scope: ModelScope) {
        _state.update { if (it.modelPicker?.scope == scope) it.copy(modelPicker = null) else it }
    }

    fun loadModels(scope: ModelScope) = requestModels(scope, null)
    fun setModel(scope: ModelScope, modelId: String) = requestModels(scope, modelId)
    fun setReasoning(scope: ModelScope, modelId: String, effort: String) = requestModels(scope, modelId, effort)

    private fun requestModels(scope: ModelScope, modelId: String?, reasoningEffort: String? = null) {
        val request = modelRequestIds.incrementAndGet()
        _state.update { st ->
            val picker = st.modelPicker ?: return@update st
            if (picker.scope != scope || !picker.accepts(st, picker.requestId) || picker.busy) return@update st
            val allowed = when {
                reasoningEffort != null -> modelId != null && picker.canSetReasoning(st, modelId, reasoningEffort)
                modelId != null -> picker.canSelect(st, modelId)
                else -> true
            }
            if (!allowed) st else st.copy(modelPicker = picker.copy(requestId = request, loading = modelId == null,
                applying = modelId, applyingReasoning = reasoningEffort, error = null))
        }
        if (_state.value.modelPicker?.requestId != request) return
        viewModelScope.launch(Dispatchers.IO) {
            // Do NOT use commandResp: it reads the latest endpoint rather than our captured target.
            val before = _state.value
            val active = before.modelPicker
            if (active == null || active.scope != scope || !active.accepts(before, request)) return@launch
            // Security rides the pre-flight snapshot with the scope: a settings
            // change mid-flight invalidates the scope (accepts/modelPicker
            // guards) instead of mixing endpoints.
            val scopeSecurity = before.endpointSecurity()
            try {
                val cmd = when {
                    reasoningEffort != null -> "set-reasoning"
                    modelId != null -> "set-model"
                    else -> "models"
                }
                val body = JSONObject().put("cmd", cmd).put("sessionId", scope.sessionId)
                if (modelId != null) body.put("modelId", modelId)
                if (reasoningEffort != null) body.put("reasoningEffort", reasoningEffort)
                val response = BridgeClient.command(scope.base, scope.token, body, scopeSecurity)
                if (response.has("ok") && !response.optBoolean("ok")) {
                    error(response.optString("error", "Model request failed"))
                }
                val catalog = Parse.models(response)
                require(catalog.sessionId == scope.sessionId) { "Model response belongs to a different thread" }
                _state.update { it.applyModelCatalog(scope, request, catalog) }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _state.update { it.failModelRequest(scope, request, e.message ?: "Model request failed", modelId != null) }
            }
        }
    }

    // ---------------------------------------------------------------- sessions / projects / permissions

    /** {cmd:"sessions"} → state.sessions (+sessionsActive pin). Command-only, no SSE event. */
    fun loadSessions() {
        val generation = connectionGeneration
        viewModelScope.launch(Dispatchers.IO) {
            val resp = commandResp(SessionCenter.sessionsCommand()) ?: return@launch
            if (generation != connectionGeneration) return@launch
            _state.update {
                it.copy(
                    sessions = Parse.sessions(resp.optJSONArray("sessions")),
                    sessionsActive = if (resp.isNull("active")) "" else resp.optString("active"),
                )
            }
        }
    }

    /** Pin the followed session ("sessionId" = pin, "" = back to auto-follow). */
    fun selectSession(sessionId: String, onSelected: () -> Unit = {}) {
        viewModelScope.launch(Dispatchers.IO) {
            if (commandResp(SessionCenter.selectSessionCommand(sessionId)) != null) {
                loadSessions() // refresh pin highlight + active
                viewModelScope.launch(Dispatchers.Main) { onSelected() }
            }
        }
    }

    /** {cmd:"projects"} → state.projects. */
    fun loadProjects() {
        val generation = connectionGeneration
        viewModelScope.launch(Dispatchers.IO) {
            val resp = commandResp(SessionCenter.projectsCommand()) ?: return@launch
            if (generation != connectionGeneration) return@launch
            _state.update { it.copy(projects = Parse.projects(resp.optJSONArray("projects"))) }
        }
    }

    /**
     * {cmd:"new-session", workspaceId} OR {cwd} — never both (bridge pins the new session).
     * Toasts "Started <workspace title or cwd basename>", buzzes, then onCreated on main.
     */
    fun newSession(workspaceId: String?, cwd: String?, onCreated: () -> Unit) {
        viewModelScope.launch(Dispatchers.IO) {
            val body = SessionCenter.newSessionCommand(workspaceId, cwd)
            val resp = commandResp(body) ?: return@launch
            val wsId = if (resp.isNull("workspaceId")) null
            else resp.optString("workspaceId").takeIf { s -> s.isNotEmpty() }
            val newCwd = if (resp.isNull("cwd")) null
            else resp.optString("cwd").takeIf { s -> s.isNotEmpty() }
            val title = _state.value.workspaces.firstOrNull { it.workspaceId == wsId }
                ?.title?.takeIf { t -> t.isNotEmpty() }
            val label = title ?: newCwd?.substringAfterLast('/')?.takeIf { b -> b.isNotEmpty() } ?: "session"
            showToast("Started $label")
            viewModelScope.launch(Dispatchers.Main) {
                Haptics.buzzMedium(getApplication())
                onCreated()
            }
        }
    }

    /** {cmd:"set-permission", preset, sessionId}; success buzzes + applies locally, SSE event confirms. */
    fun setPermission(preset: String) {
        // Capture the acted-on session for the bridge 409 binding check; a
        // mid-flight session rotation must not retarget the permission.
        val sessionId = _state.value.sessionId
        viewModelScope.launch(Dispatchers.IO) {
            val resp = commandResp(SessionCenter.setPermissionCommand(preset, sessionId))
                ?: return@launch
            val applied = (if (resp.isNull("preset")) null else resp.optString("preset").takeIf { s -> s.isNotEmpty() })
                ?: preset
            _state.update { st ->
                st.permissions?.let { p -> st.copy(permissions = p.copy(currentValue = applied)) } ?: st
            }
            viewModelScope.launch(Dispatchers.Main) { Haptics.buzzMedium(getApplication()) }
        }
    }

    fun ping(onResult: (String) -> Unit) {
        val st = _state.value
        val generation = connectionGeneration
        val base = st.base
        val token = st.token
        val security = st.endpointSecurity()
        viewModelScope.launch(Dispatchers.IO) {
            if (generation != connectionGeneration) return@launch
            val out = try {
                val h = BridgeClient.health(base, token, security)
                val dsh = h.optString("dsh", h.optString("status", "up"))
                "OK · dsh: $dsh"
            } catch (e: Exception) {
                if (generation != connectionGeneration) return@launch
                "FAIL · ${e.message ?: "unreachable"}"
            }
            if (generation == connectionGeneration) onResult(out)
        }
    }

    fun imageBytes(ref: String): ByteArray? {
        val st = _state.value
        val generation = connectionGeneration
        if (generation != connectionGeneration) return null
        return try {
            BridgeClient.fetchImage(st.base, st.token, ref, st.endpointSecurity())
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Open-mac URL for an image ref. DEPRECATED: token-bearing URLs are
     * rejected by the bridge. Returns a tokenless bridge URL (unauthenticated
     * on its own); prefer [openImageOnMac], which opens the bytes on the Mac
     * through the authenticated command channel with no token in any URL.
     */
    @Deprecated("Use openImageOnMac(ref): token-bearing URLs are rejected by the bridge.")
    fun imageUrl(ref: String): String {
        val st = _state.value
        return "${st.base}/watch/image?ref=${Uri.encode(ref)}"
    }

    /** Open a bridge image on the Mac via {cmd:'open-mac', imageRef} (no token URL). */
    fun openImageOnMac(ref: String) {
        if (!_state.value.openMacSupported) { showToast("Open on Mac is not supported by this host"); return }
        viewModelScope.launch(Dispatchers.IO) {
            command(JSONObject().put("cmd", "open-mac").put("imageRef", ref))
        }
    }

    // ---------------------------------------------------------------- mic uplink

    fun toggleWakeOnActivity() {
        val enabled = !_state.value.wakeOnActivity
        prefs.edit { putBoolean("wake_on_activity", enabled) }
        _state.update { it.copy(wakeOnActivity = enabled) }
    }

    fun toggleKeepScreenAwake() {
        val enabled = !_state.value.keepScreenAwake
        prefs.edit { putBoolean("keep_screen_awake", enabled) }
        _state.update { it.copy(keepScreenAwake = enabled) }
    }

    /** Avatar-mode toggle. Pure UI-mode flip: no mic, queue, SSE or voice side effects. */
    fun toggleAvatarMode() {
        _state.update { it.copy(avatarMode = !it.avatarMode) }
    }

    /**
     * Model-requested Cappi action (`t: 'cappi'` SSE / snapshot restore).
     * Holds until replaced, cleared, or the timeout below — the auto schedule
     * resumes. The raw id is translated per active pack first (legacy and
     * cross-pack aliases map through roles); state-owned cues never resolve.
     */
    @Synchronized
    private fun onCappiAction(action: String?) {
        expiredCappiAction = null
        lastCappiAt = now()
        val revision = ++cappiRevision
        val pack = activePack()
        val translated = if (pack != null && !action.isNullOrEmpty() && action != "clear") {
            CharacterSelection.resolveModelAction(pack, action)
        } else {
            reduceCappiAction(null, action)
        }
        _state.update { it.copy(cappiAction = reduceCappiAction(it.cappiAction, translated)) }
        cappiJob?.cancel()
        val held = _state.value.cappiAction
        if (held != null) {
            cappiJob = viewModelScope.launch {
                delay(CAPPI_ACTION_TIMEOUT_MS)
                if (cappiRevision == revision) expiredCappiAction = held
                _state.update { if (cappiRevision == revision) it.copy(cappiAction = null) else it }
            }
        }
    }

    fun toggleVoiceOutput() {
        val enabled = !_state.value.voiceOutputEnabled
        _state.update { it.copy(voiceOutputEnabled = enabled) }
        VoiceCenter.persistVoiceOutput(prefs, enabled)
        tts.setOutputEnabled(enabled)
        if (!enabled) {
            ttsInFlight = false
            if (_state.value.phase == Phase.SPEAKING) setPhase(if (sessionRunning) Phase.THINKING else Phase.IDLE)
        }
    }

    fun toggleMic() {
        if (_state.value.micOpen || (micCaptureIntentActive && _state.value.micState == "warming")) stopMicUplink() else startMicUplink()
    }

    fun startMicUplink() {
        val st = _state.value
        val blocker = VoiceCenter.micBlocker(st)
        if (blocker != null) {
            if (st.connected) showToast(blocker)
            return
        }
        if (VoiceService.isActive() || (micCaptureIntentActive && st.micState in setOf("warming", "finishing"))) {
            showToast("Microphone is still finishing — wait a moment")
            return
        }
        // Explicit record is local output-only barge-in, never agent cancellation.
        tts.cancelAll()
        ttsInFlight = false
        // One tap may initiate preflight-then-capture: the service runs
        // POST /watch/mic/start first and only starts AudioRecord after ready.
        // micOpen latches on the service transport outcome (MicStatus flow),
        // not on this intent — a 409/503/denied uplink never shows open.
        val streamId = "watch-${System.currentTimeMillis()}-${(0..999999).random()}"
        micDraftStreamId = null
        micCaptureIntentActive = true
        _state.update { it.copy(watchStreamId = streamId, micState = "warming", micMessage = null) }
        runCatching {
            VoiceService.start(getApplication(), st.base, st.token,
                security = st.endpointSecurity(), streamId = streamId, micCancelSupported = st.micCancelSupported)
        }.onFailure { error ->
            _state.update { it.copy(micOpen = false, micState = "error",
                error = "Microphone could not start: ${error.message}") }
        }
    }

    /** Explicit record-off keeps the stream/generation until EOF + validated receipt. */
    fun stopMicUplink() {
        if (!VoiceService.isActive()) { abortMicUplink(); return }
        VoiceService.finishRecording(_state.value.watchStreamId)
        _state.update { it.copy(micOpen = false, micState = "finishing") }
    }

    /** Security/dispose/explicit agent Stop must never flush a new prompt. */
    fun abortMicUplink() {
        micCaptureIntentActive = false
        runCatching { VoiceService.stop(getApplication()) }
        _state.update { it.copy(micOpen = false, micState = "idle", watchStreamId = "") }
    }

    /** Type-screen target: approval free-text (approve mode) or cleared (back to submit). */
    fun setPendingTarget(id: String?) {
        if (id == null) stopDictation(clear = true)
        _state.update { st -> st.copy(
            pendingRequestId = id,
            pendingQuestionTitle = st.pending.firstOrNull { it.id == id }?.title,
            dictationFinal = "", dictationRevision = 0, dictationPartial = "",
            typeMode = if (id != null) "approve" else "submit",
        ) }
    }

    fun startDictation(requestId: String) {
        val st = _state.value
        val blocker = QuestionCenter.dictationBlocker(st, requestId, st.micOpen)
        if (blocker != null) { showToast(blocker); return }
        if (VoiceService.isActive()) { showToast("Microphone is still finishing — wait a moment"); return }
        // Explicit dictation must not capture the recent spoken question.
        tts.cancelAll()
        ttsInFlight = false
        val streamId = "watch-${System.currentTimeMillis()}-${(0..999999).random()}"
        micDraftStreamId = streamId
        micCaptureIntentActive = true
        _state.update { it.copy(watchStreamId = streamId, micState = "warming", micMessage = null,
            dictationRequestId = requestId, dictationPartial = "", dictating = true, dictationSettling = false) }
        runCatching { VoiceService.start(getApplication(), st.base, st.token, requestId, st.endpointSecurity(), streamId, st.micCancelSupported) }
            .onFailure { error ->
                _state.update { it.copy(dictating = false, dictationSettling = false) }
                showToast("Dictation could not start: ${error.message}")
            }
    }

    fun stopDictation(clear: Boolean = false) {
        if (_state.value.dictationRequestId == null) return
        if (clear) {
            micCaptureIntentActive = false
            runCatching { VoiceService.stop(getApplication()) }
        } else VoiceService.finishRecording(_state.value.watchStreamId)
        _state.update { it.copy(
            micOpen = false,
            micState = if (clear) "idle" else "finishing",
            watchStreamId = if (clear) "" else it.watchStreamId,
            dictating = false,
            dictationSettling = !clear,
            dictationRequestId = if (clear) null else it.dictationRequestId,
            dictationPartial = "",
        ) }
    }

    /** Type screen in "custom cwd" mode (Projects → New session in path…). */
    fun enterPathMode() =
        _state.update { it.copy(typeMode = "new-session", pendingRequestId = null) }

    override fun onCleared() {
        abortMicUplink()
        tts.release()
        sseJob?.cancel()
        sseConn?.runCatching { disconnect() } // a blocked readLoop ignores cancel until I/O ends
        sseConn = null
        // Stop the voice session only if this app started it.
        // With App's store this runs only on explicit store clearing / process
        // teardown — never because one activity instance disappeared.
        if (startedByApp.getAndSet(false)) {
            val st = _state.value
            Thread {
                runCatching { BridgeClient.command(st.base, st.token, JSONObject().put("cmd", "stop"), st.endpointSecurity()) }
            }.start()
        }
        super.onCleared()
    }

    companion object {
        const val KEY_BASE = "base"
        const val KEY_TOKEN = "token"
        const val KEY_CERT_PIN = "cert_pin_sha256"
        const val KEY_ALLOW_INSECURE = "allow_insecure_lan"
        const val KEY_DEVICE_ID = "device_id"
        // Documentation placeholder (RFC 5737): stored only to recognise an
        // unpaired install. Never dialled — see UiState.isPairedEndpoint.
        const val PLACEHOLDER_BASE = "http://192.0.2.1:8787"
        // Blank = unpaired. The real bridge address + certificate pin are
        // entered in Settings; there is no default host and no placeholder
        // polling. Never commit a personal LAN IP here.
        const val DEFAULT_BASE = ""

        /** Stored placeholder from older installs migrates to blank unpaired. */
        fun migrateStoredBase(stored: String): String =
            if (stored.trim() == PLACEHOLDER_BASE) "" else stored
    }

    /**
     * Atomic turnkey persist: base + token + pin (+ device id) in ONE prefs
     * commit, called ONLY for approved poll responses whose pin matches the
     * confirmed immutable record AND the live handshake pin (checked by the
     * caller via [PairingCenter.approvedPersist]). Insecure-LAN stays off.
     */
    fun persistPairing(row: PairingCenter.ApprovedPersist) {
        stopDictation(clear = true)
        abortMicUplink() // captured old credentials only; never hand audio to the new peer
        connectionGeneration++
        prefs.edit {
            putString(KEY_BASE, row.baseUrl)
            putString(KEY_TOKEN, row.token)
            putString(KEY_CERT_PIN, SecureTransport.normalizePin(row.certSha256Pin))
            putBoolean(KEY_ALLOW_INSECURE, false)
            putString(KEY_DEVICE_ID, row.deviceId)
        }
        _state.update {
            it.copy(base = row.baseUrl, token = row.token,
                certPinSha256 = SecureTransport.normalizePin(row.certSha256Pin),
                allowInsecureLan = false, deviceId = row.deviceId,
                micState = "idle", micMessage = null)
        }
        startSse()
    }
}
