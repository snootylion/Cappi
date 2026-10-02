package dev.dsh.watch.util

import android.os.SystemClock
import dev.dsh.watch.cappi.LowerPressGate
import dev.dsh.watch.cappi.LowerPressTarget
import dev.dsh.watch.cappi.PressAction

/**
 * Owns the lower-HOME press gesture state machine for the foreground root.
 *
 * This is the exact gate/target/suppression protocol previously inline in the
 * activity: the delayed SINGLE flushes against the FIRST press's session and
 * oldest queued item, a DOUBLE consumes both presses, and a trailing third
 * press inside the cooldown window is swallowed so it cannot steer a message
 * right after a companion-mode toggle. SINGLE sends are additionally
 * suppressed for 700 ms after each send.
 *
 * Android-free except for the default monotonic clock: tests inject a fake
 * clock. The caller stays responsible for foreground/root gating, Handler
 * scheduling at [flushDueAtMs], and executing the returned actions (companion
 * toggle, queue steer + haptics). Uses [LowerPressGate]/[LowerPressTarget]
 * read-only (cappi-owned); the policy of when to call lives here.
 */
class PressCoordinator(private val clock: () -> Long = SystemClock::uptimeMillis) {

    /** Actions for the caller to execute, in order. No side effects here. */
    sealed interface Outcome {
        data object ToggleCompanion : Outcome
        data class SteerQueue(val queueId: String) : Outcome
    }

    private val gate = LowerPressGate()
    private var target: LowerPressTarget? = null
    private var suppressUntil = 0L

    /** When a pending SINGLE must be flushed; null when idle. */
    val flushDueAtMs: Long?
        get() = gate.deadlineMs

    val hasPending: Boolean
        get() = gate.deadlineMs != null

    /**
     * Feed one physical lower-press event. Snapshot the CURRENT session id,
     * oldest queued id, and connection state at call time; stale flushes are
     * validated against the capture, never the latest state.
     */
    fun press(sessionId: String, oldestQueueId: String?, connected: Boolean): List<Outcome> {
        val now = clock()
        val out = ArrayList<Outcome>(2)
        // Flush the previous gesture against its original capture first
        // (including exact window-boundary presses) before starting the next.
        out += resolve(gate.flush(now), sessionId, oldestQueueId, connected, now)
        if (gate.deadlineMs == null) {
            target = LowerPressTarget(sessionId, oldestQueueId)
        }
        out += resolve(gate.press(now), sessionId, oldestQueueId, connected, now)
        return out
    }

    /** Flush a due SINGLE (called from the scheduled runnable). */
    fun flush(sessionId: String, oldestQueueId: String?, connected: Boolean): List<Outcome> =
        resolve(gate.flush(clock()), sessionId, oldestQueueId, connected, clock())

    fun cancel() {
        gate.cancel()
        target = null
    }

    private fun resolve(
        actions: List<PressAction>,
        sessionId: String,
        oldestQueueId: String?,
        connected: Boolean,
        now: Long,
    ): List<Outcome> = actions.mapNotNull { action ->
        when (action) {
            PressAction.DOUBLE -> Outcome.ToggleCompanion
            PressAction.SINGLE -> {
                val id = target?.sendId(sessionId, oldestQueueId, connected)
                if (now >= suppressUntil && id != null) {
                    suppressUntil = now + SUPPRESS_AFTER_SEND_MS
                    Outcome.SteerQueue(id)
                } else null
            }
        }
    }

    companion object {
        const val SUPPRESS_AFTER_SEND_MS = 700L
    }
}
