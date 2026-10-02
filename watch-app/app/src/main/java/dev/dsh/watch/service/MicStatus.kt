package dev.dsh.watch.service

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Watch-mic transport status (W-owned). Published by [VoiceService] from its
 * IO worker, collected by the ViewModel. Privacy: counters + RMS buckets only
 * — never raw audio, transcripts, URLs, or secrets.
 */
object MicStatus {

    /** Bounded uplink policy shared by service + tests. */
    const val WRITE_WATCHDOG_MS = 40_000L
    const val ABSOLUTE_CAP_MS = 30 * 60_000L

    data class Snapshot(
        val generation: Long,
        val streamId: String,
        /** warming | ready | capturing | closed | error */
        val state: String,
        val txChunks: Long = 0,
        val txBytes: Long = 0,
        val zeroChunks: Long = 0,
        val readErrors: Long = 0,
        /** RMS loudness buckets (0-99) for the ambient mic meter; never audio. */
        val rmsBucket: Int = 0,
        val message: String? = null,
        val legacyFallback: Boolean = false,
    )

    private val _flow = MutableStateFlow<Snapshot?>(null)
    val flow: StateFlow<Snapshot?> = _flow.asStateFlow()

    fun publish(snapshot: Snapshot) {
        _flow.value = snapshot
    }

    fun clear(generation: Long) {
        if (_flow.value?.generation == generation) _flow.value = null
    }
}
