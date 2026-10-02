package dev.dsh.watch.core

/** Only semantic state enters this policy: text/audio chunks and heartbeats are not events. */
data class StateWakeSnapshot(
    val connected: Boolean,
    val sessionId: String,
    val questions: Set<Approval>,
    val speaking: Boolean,
    val working: Boolean,
    val error: Boolean,
) {
    companion object {
        fun from(state: UiState) = StateWakeSnapshot(
            state.connected && !state.offlineClock, state.sessionId, state.unreviewedQuestions,
            state.speakingOutput, state.sessionRunning, state.phase == Phase.ERROR,
        )
    }
}

enum class StateWakeReason { QUESTION, QUESTION_CLEARED, SPEAKING, SPEECH_ENDED, WORKING, WORK_ENDED, ERROR }
enum class StateWakeDecision { BASELINE, UNCHANGED, INELIGIBLE, COOLDOWN, WAKE }

/** Deliberately incapable of retaining a card, credential, thread ID, or text payload. */
data class StateWakeDiagnostics(
    val connected: Boolean, val root: Boolean, val avatar: Boolean, val pref: Boolean,
    val ambient: Boolean, val sdkAmbient: Boolean, val visible: Boolean, val alive: Boolean,
    val owner: Boolean, val foreground: Boolean, val lease: Boolean, val interactive: Boolean,
    val offline: Boolean, val pendingCount: Int, val speaking: Boolean, val working: Boolean,
    val error: Boolean, val decision: StateWakeDecision, val reason: StateWakeReason?, val event: Long,
)

class StateWakeDiagnosticChanges {
    private var previous: StateWakeDiagnostics? = null
    fun changed(value: StateWakeDiagnostics): Boolean {
        if (value == previous) return false
        previous = value
        return true
    }
}

/** Suppressed edges are consumed, never replayed when the user returns to the app. */
class StateWakePolicy(private val cooldownMs: Long = 2_000L, private val speechQuietMs: Long = 1_500L) {
    private var previous: StateWakeSnapshot? = null
    private var quietSince: Long? = null
    private var lastWake: Long? = null
    var decision: StateWakeDecision = StateWakeDecision.BASELINE
        private set
    var reason: StateWakeReason? = null
        private set
    var eventRevision: Long = 0L
        private set

    fun observe(value: StateWakeSnapshot, eligible: Boolean, nowMs: Long): StateWakeReason? {
        reason = null
        val old = previous
        if (old == null || old.sessionId != value.sessionId || old.connected != value.connected) {
            previous = value
            quietSince = null
            decision = StateWakeDecision.BASELINE
            return null // Initial/reconnect/session snapshots are not fresh notifications.
        }
        if (value.speaking) quietSince = null
        else if (old.speaking && quietSince == null) quietSince = nowMs
        // A short AudioTrack drain gap is part of the same speech episode.
        val speaking = value.speaking || (old.speaking && quietSince?.let { nowMs - it < speechQuietMs } == true)
        val next = value.copy(speaking = speaking)
        reason = when {
            value.questions.any { it !in old.questions } -> StateWakeReason.QUESTION
            old.questions.isNotEmpty() && value.questions.isEmpty() -> StateWakeReason.QUESTION_CLEARED
            speaking != old.speaking -> if (speaking) StateWakeReason.SPEAKING else StateWakeReason.SPEECH_ENDED
            value.working != old.working -> if (value.working) StateWakeReason.WORKING else StateWakeReason.WORK_ENDED
            value.error && !old.error -> StateWakeReason.ERROR
            else -> null
        }
        previous = next
        if (reason != null) eventRevision++
        decision = when {
            reason == null -> StateWakeDecision.UNCHANGED
            !eligible || !value.connected -> StateWakeDecision.INELIGIBLE
            lastWake?.let { nowMs - it < cooldownMs } == true -> StateWakeDecision.COOLDOWN
            else -> StateWakeDecision.WAKE
        }
        if (decision != StateWakeDecision.WAKE) return null
        lastWake = nowMs
        return reason
    }
}

/** An ambient lease is established only by a previously foreground app window. */
class AmbientWakeOwnership {
    private var foreground = false
    private var ambientLease = false
    val hasForeground: Boolean get() = foreground
    val hasAmbientLease: Boolean get() = ambientLease
    fun focused() { foreground = true }
    fun enterAmbient() { ambientLease = foreground }
    fun pause(isAmbient: Boolean) { if (!isAmbient || !ambientLease) leave() }
    fun stop(isAmbient: Boolean, windowVisible: Boolean) { if (!isAmbient || !windowVisible) leave() }
    fun leave() { foreground = false; ambientLease = false }
    fun permits(isAmbient: Boolean, windowVisible: Boolean, currentOwner: Boolean) =
        foreground && ambientLease && isAmbient && windowVisible && currentOwner
}
