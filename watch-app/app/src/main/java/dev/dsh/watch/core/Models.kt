package dev.dsh.watch.core

import dev.dsh.watch.net.SecureTransport
import org.json.JSONArray
import org.json.JSONObject

enum class Phase { CONNECTING, IDLE, LISTENING, HEARING, THINKING, SPEAKING, ERROR, MUTED }

/** Home status follows audible output, never the potentially stale transport phase. */
fun UiState.homeDisplayPhase(): Phase = when {
    !connected -> Phase.CONNECTING
    speakingOutput -> Phase.SPEAKING
    sessionRunning -> Phase.THINKING
    phase == Phase.ERROR -> Phase.ERROR
    else -> Phase.IDLE
}

data class TodoItem(val text: String, val status: String)

data class JobItem(val id: String, val label: String, val state: String)

data class QueueLine(val id: String, val text: String, val state: String)

data class ApprovalOption(val id: String, val label: String)

data class Approval(
    val id: String,
    val kind: String, // "approval" | "ask"
    val title: String,
    val detail: String?,
    val options: List<ApprovalOption>,
    val multi: Boolean,
)

data class ImageItem(val ref: String, val label: String)

data class SessionRow(
    val sessionId: String,
    val running: Boolean,
    val updatedAt: Long,
    val blank: Boolean,
    val cwd: String?,
    val title: String?,
    val subagent: Boolean,
    val workspaceId: String?,
)

data class ProjectRow(
    val workspaceId: String?,
    val title: String,
    val path: String,
    val sessions: Int,
)

data class WorkspaceRow(
    val workspaceId: String,
    val path: String,
    val title: String,
    val sessionIds: List<String>,
)

data class PermissionOption(val value: String, val name: String, val description: String?)

data class PermissionsState(val options: List<PermissionOption>, val currentValue: String?)

data class UiState(
    val connected: Boolean = false,
    val offlineClock: Boolean = false, // manually paused or five-minute connection deadline
    val phase: Phase = Phase.CONNECTING,
    val error: String? = null,          // ring error message (tap to dismiss)
    val toast: String? = null,          // transient command-failure toast (auto-clears)
    val partialText: String = "",
    val dictationRequestId: String? = null,
    val dictationPartial: String = "",
    val dictationFinal: String = "",
    val dictationRevision: Int = 0,
    val dictating: Boolean = false,
    val dictationSettling: Boolean = false,
    val assistantText: String = "",
    val assistantDone: Boolean = false,
    val todos: List<TodoItem> = emptyList(),
    val jobs: List<JobItem> = emptyList(),
    val agents: List<JobItem> = emptyList(),
    val queue: List<QueueLine> = emptyList(),
    /** Explicit server capability; absent remains compatible with the legacy local queue. */
    val queueReorderSupported: Boolean = true,
    val openMacSupported: Boolean = true,
    /** New command is opt-in; unlike old capabilities, legacy omission means FALSE. */
    val micCancelSupported: Boolean = false,
    val pending: List<Approval> = emptyList(),
    // Cue acknowledgement, not an answer/dismissal. Retain only visible card identities.
    val reviewedPending: Set<Approval> = emptySet(),
    val modelPicker: ModelPickerState? = null,
    val images: List<ImageItem> = emptyList(),
    val micOpen: Boolean = false,
    /** Current watch uplink correlator (non-secret streamId for preflight). */
    val watchStreamId: String = "",
    /** Watch-mic transport: idle | warming | ready | capturing | finishing | cancelled | closed | error. */
    val micState: String = "idle",
    val micMessage: String? = null,
    val micTxBytes: Long = 0,
    val micTxChunks: Long = 0,
    val micLegacyFallback: Boolean = false,
    /** Stable per-APK device id for turnkey pairing (one paired device per APK). */
    val deviceId: String = "",
    val avatarMode: Boolean = false, // Cappi companion UI vs remote controls; Menu/Settings touch toggle + double-press shortcut
    val cappiAction: String? = null, // validated model request (Phase-4 SSE); null = auto schedule
    val voiceOutputEnabled: Boolean = true,
    val speakingOutput: Boolean = false, // Actual AudioTrack output, including buffered tail.
    val keepScreenAwake: Boolean = true,
    val wakeOnActivity: Boolean = true, // Bounded ambient wake pulses; independent of keep-awake.
    val serverVoicePhase: String = "idle",
    val voiceActive: Boolean = false,
    val macMuted: Boolean = false,
    val sessionRunning: Boolean = false,
    val sessionId: String = "",
    val helperState: String = "",
    val helloQueueDepth: Int = 0,
    val lastEventAt: Long = 0L,
    val thinkingSince: Long = 0L,
    val base: String,
    val token: String,
    // Pinned bridge identity (base64 SHA-256 of the bridge certificate, entered
    // at pairing; blank = unpaired) plus the explicit insecure-LAN legacy
    // opt-in. Persisted by the ViewModel; rendered (never reshaped) by Settings.
    val certPinSha256: String = "",
    val allowInsecureLan: Boolean = false,
    // User-owned avatar choice (persisted `character_id`, default cappi-original).
    // The bridge is notified via `character-select`, never obeyed.
    val characterId: String = "cappi-original",
    // Last bridge-suggested id that differs from the local choice (observed only).
    val remoteCharacterId: String? = null,
    val pendingRequestId: String? = null, // free-text answer target for the Type screen
    val pendingQuestionTitle: String? = null, // guards against a wizard advancing mid-dictation
    val typeMode: String = "submit", // "submit" | "approve" | "new-session"
    val sessions: List<SessionRow> = emptyList(),
    val sessionsActive: String = "",
    val projects: List<ProjectRow> = emptyList(),
    val workspaces: List<WorkspaceRow> = emptyList(),
    val archivedSessionIds: List<String> = emptyList(),
    val permissions: PermissionsState? = null,
    val sessionCwd: String? = null,
)

/** Full card identity makes a changed wizard question fresh, even with the same id. */
val UiState.unreviewedQuestions: Set<Approval>
    get() = pending.filterNot { it in reviewedPending }.toSet()

/** Reviewed history is bounded by the current visible list, never an accumulating log. */
fun UiState.withVisiblePending(items: List<Approval>, forSession: String = sessionId): UiState = copy(
    pending = items,
    sessionId = forSession,
    reviewedPending = if (forSession == sessionId) reviewedPending.intersect(items.toSet()) else emptySet(),
    modelPicker = if (forSession == sessionId) modelPicker else modelPicker?.invalidate(),
)

fun UiState.acknowledgePendingQuestions(): UiState = copy(reviewedPending = pending.toSet())

/** Reconnect to the same bridge retains review; changing accounts/endpoints does not. */
fun UiState.withQuestionConnection(newBase: String, newToken: String): UiState =
    withQuestionConnection(newBase, newToken, certPinSha256, allowInsecureLan)

/** Full connection update including pairing identity; any change clears review. */
fun UiState.withQuestionConnection(
    newBase: String,
    newToken: String,
    newPin: String,
    newInsecure: Boolean,
): UiState {
    val same = base == newBase && token == newToken &&
        certPinSha256 == newPin && allowInsecureLan == newInsecure
    return copy(base = newBase, token = newToken, certPinSha256 = newPin,
        allowInsecureLan = newInsecure,
        pending = if (same) pending else emptyList(),
        reviewedPending = if (same) reviewedPending else emptySet(),
        modelPicker = if (same) modelPicker else modelPicker?.invalidate())
}

/** Trusted-factory view of this state's endpoint security (C-owned). */
fun UiState.endpointSecurity(): SecureTransport.EndpointSecurity =
    SecureTransport.EndpointSecurity(
        certPinSha256 = certPinSha256,
        allowInsecureLan = allowInsecureLan,
    )

/** Blank or documentation-placeholder base means unpaired: never dialled. */
fun UiState.isPairedEndpoint(): Boolean {
    val b = base.trim()
    return b.isNotEmpty() && b != "http://192.0.2.1:8787"
}

/**
 * Project label for the active session: workspace title via workspaces membership
 * (row whose sessionIds contains the active session id), else cwd basename.
 */
fun UiState.projectLabel(): String? {
    val wsTitle = workspaces.firstOrNull { sessionId in it.sessionIds }
        ?.title?.takeIf { it.isNotEmpty() }
    if (wsTitle != null) return wsTitle
    val cwd = sessionCwd ?: return null
    return cwd.substringAfterLast('/').takeIf { it.isNotEmpty() }
}

object Parse {
    fun models(o: JSONObject): ModelCatalog = parseModelCatalog(o.toString())

    fun todos(a: JSONArray?): List<TodoItem> = a.optList { i ->
        TodoItem(i.optString("text"), i.optString("status"))
    }

    fun jobs(a: JSONArray?): List<JobItem> = a.optList { i ->
        JobItem(i.optString("id"), i.optString("label"), i.optString("state"))
    }

    fun agents(a: JSONArray?): List<JobItem> = jobs(a)

    fun queue(a: JSONArray?): List<QueueLine> = a.optList { i ->
        QueueLine(i.optString("id"), i.optString("text"), i.optString("state"))
    }

    fun images(a: JSONArray?): List<ImageItem> = a.optList { i ->
        ImageItem(i.optString("ref"), i.optString("label"))
    }

    fun approval(o: JSONObject): Approval {
        val opts = o.optJSONArray("options")
        val options = ArrayList<ApprovalOption>()
        if (opts != null) {
            for (i in 0 until opts.length()) {
                val x = opts.optJSONObject(i) ?: continue
                options.add(ApprovalOption(x.optString("id"), x.optString("label")))
            }
        }
        return Approval(
            id = o.optString("id"),
            kind = o.optString("kind"),
            title = o.optString("title"),
            detail = if (o.isNull("detail")) null else o.optString("detail"),
            options = options,
            multi = o.optBoolean("multi", false),
        )
    }

    fun approvals(a: JSONArray?): List<Approval> = a.optList { i -> approval(i) }

    fun sessions(a: JSONArray?): List<SessionRow> = a.optList { i ->
        SessionRow(
            sessionId = i.optString("sessionId"),
            running = i.optBoolean("running", false),
            updatedAt = i.optLong("updatedAt", 0L),
            blank = i.optBoolean("blank", false),
            cwd = str(i, "cwd"),
            title = str(i, "title"),
            subagent = i.optBoolean("subagent", false),
            workspaceId = str(i, "workspaceId"),
        )
    }

    fun projects(a: JSONArray?): List<ProjectRow> = a.optList { i ->
        ProjectRow(
            workspaceId = str(i, "workspaceId"),
            title = str(i, "title") ?: "",
            path = str(i, "path") ?: "",
            sessions = i.optInt("sessions", 0),
        )
    }

    fun workspaces(a: JSONArray?): List<WorkspaceRow> = a.optList { i ->
        val ids = i.optJSONArray("sessionIds")?.let { arr ->
            (0 until arr.length()).mapNotNull { n -> arr.optString(n).takeIf { s -> s.isNotEmpty() } }
        } ?: emptyList()
        WorkspaceRow(
            workspaceId = i.optString("workspaceId"),
            path = str(i, "path") ?: "",
            title = str(i, "title") ?: "",
            sessionIds = ids,
        )
    }

    fun permissionOptions(a: JSONArray?): List<PermissionOption> = a.optList { i ->
        PermissionOption(
            value = i.optString("value"),
            name = str(i, "name") ?: i.optString("value"),
            description = str(i, "description"),
        )
    }

    /** Parses a permissions object {options:[...]|null, currentValue}; options null → cleared. */
    fun permissions(o: JSONObject?): PermissionsState? {
        if (o == null) return null
        return PermissionsState(
            options = if (o.isNull("options")) emptyList() else permissionOptions(o.optJSONArray("options")),
            currentValue = str(o, "currentValue"),
        )
    }

    fun strList(a: JSONArray?): List<String> =
        if (a == null) emptyList() else (0 until a.length()).mapNotNull { i -> a.optString(i).takeIf { s -> s.isNotEmpty() } }

    /** null when the key is absent/JSON-null/empty. */
    private fun str(o: JSONObject, key: String): String? =
        if (o.isNull(key)) null else o.optString(key).takeIf { it.isNotEmpty() }

    private inline fun <T> JSONArray?.optList(map: (JSONObject) -> T): List<T> {
        if (this == null) return emptyList()
        val out = ArrayList<T>(length())
        for (i in 0 until length()) {
            val o = optJSONObject(i) ?: continue
            out.add(map(o))
        }
        return out
    }
}
