package dev.dsh.watch.core

/**
 * Pure SSE-supervisor policy: backoff progression, five-minute connection
 * deadline arithmetic, and discovery-adoption decisions. The
 * [BridgeViewModel] retains the single supervisor coroutine, generation
 * counter, and socket ownership; this object owns only the rules so unit
 * tests exercise the same numbers the watch enforces without duplicating
 * state or behavior.
 */
object SseSupervisor {

    const val INITIAL_BACKOFF_MS = 1000L
    const val MAX_BACKOFF_MS = 5000L
    const val CONNECTION_DEADLINE_MS = 5 * 60_000L

    /** 1s → 2s → 5s cap (callers reset to [INITIAL_BACKOFF_MS] on a healthy run). */
    fun nextBackoff(currentMs: Long): Long =
        (currentMs * 2).coerceAtMost(MAX_BACKOFF_MS)

    /** Remaining ms before the five-minute paused-clock deadline (never negative). */
    fun deadlineRemaining(nowMs: Long, disconnectedSinceMs: Long): Long =
        (CONNECTION_DEADLINE_MS - (nowMs - disconnectedSinceMs).coerceAtLeast(0L)).coerceAtLeast(0L)

    /**
     * Adopt a verified discovery candidate only when it differs from the
     * current base. Null (no candidate / timeout / cancelled) never adopts.
     */
    fun shouldAdoptDiscovery(found: String?, currentBase: String): Boolean =
        found != null && found != currentBase
}
