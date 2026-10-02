package dev.dsh.watch.cappi

/** A delayed send belongs to the first press's session and oldest queued item. */
data class LowerPressTarget(val sessionId: String, val queueId: String?) {
    fun sendId(currentSession: String, currentOldest: String?, connected: Boolean): String? =
        queueId?.takeIf { connected && currentSession == sessionId && currentOldest == it }
}
