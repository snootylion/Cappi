package dev.dsh.watch.service

/** Main-thread-only ownership of a capture and the latest service start command. */
internal class VoiceStartOwnership {
    private var generation = 0L
    private var current: Long? = null
    private var latestStartId = 0

    fun noteStart(startId: Int) { latestStartId = startId }

    fun begin(): Long = (++generation).also { current = it }

    /** An old worker must never stop a newer capture/service command. */
    fun finish(token: Long): Int? {
        if (current != token) return null
        current = null
        return latestStartId
    }

    fun isCurrent(token: Long): Boolean = current == token

    fun cancel() { current = null }
}
