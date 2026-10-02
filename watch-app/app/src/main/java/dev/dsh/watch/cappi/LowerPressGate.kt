package dev.dsh.watch.cappi

/** Physical lower (canonical Home) button outcomes; no Android or network side effects. */
enum class PressAction { SINGLE, DOUBLE }

/**
 * Delays SINGLE until the double-press window expires. The caller must feed
 * individual input events (not coalescing Compose counters), use a monotonic
 * clock, schedule flush at deadlineMs, and cancel on foreground/session changes.
 *
 * A double consumes both presses; the cooldown swallows a trailing third press
 * so it cannot accidentally send a queued message after a mode toggle.
 * This class is confined to its owner's event thread, not independently thread-safe.
 */
class LowerPressGate(private val windowMs: Long = DEFAULT_WINDOW_MS) {
    companion object {
        // Device HOME intents observed 465–516ms apart. A single steer therefore
        // waits 600ms; this is an application window, not an OS setting change.
        const val DEFAULT_WINDOW_MS = 600L
    }

    init { require(windowMs > 0) { "Double-press window must be positive" } }

    var deadlineMs: Long? = null
        private set
    private var cooldownUntil = 0L

    fun press(nowMs: Long): List<PressAction> {
        if (nowMs < cooldownUntil) return emptyList()
        val due = deadlineMs
        if (due != null && nowMs < due) {
            deadlineMs = null
            cooldownUntil = nowMs + windowMs
            return listOf(PressAction.DOUBLE)
        }
        val actions = flush(nowMs)
        deadlineMs = nowMs + windowMs
        return actions
    }

    fun flush(nowMs: Long): List<PressAction> {
        val due = deadlineMs ?: return emptyList()
        if (nowMs < due) return emptyList()
        deadlineMs = null
        return listOf(PressAction.SINGLE)
    }

    fun cancel() {
        deadlineMs = null
        cooldownUntil = 0L
    }
}
