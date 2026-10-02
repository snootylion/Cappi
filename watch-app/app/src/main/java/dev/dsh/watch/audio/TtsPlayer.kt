package dev.dsh.watch.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Streams bridge TTS: float32-LE base64 PCM chunks over AudioTrack (ENCODING_PCM_FLOAT).
 * Per-speechId queues with seq dedupe, bounded tombstones (64 ids / 30s), ordered playback
 * (speech N+1 buffers while N plays), sample-rate-change track recreation, audio-cancel clearing.
 */
class TtsPlayer {

    private sealed interface Cmd {
        data class Started(val speechId: String, val sampleRate: Int) : Cmd
        data class Audio(val speechId: String, val seq: Int, val sampleRate: Int, val b64: String) : Cmd
        data class Done(val speechId: String, val cancelled: Boolean) : Cmd
        data class Cancel(val speechId: String?) : Cmd
    }

    private class Speech(val id: String, var sampleRate: Int) {
        val chunks = ArrayDeque<String>()
        var lastSeq = -1
        var done = false
    }

    private val _speakingOutput = MutableStateFlow(false)
    val speakingOutput = _speakingOutput.asStateFlow()
    private var framesWritten = 0L
    private var lastHead = 0L
    private var headWrap = 0L

    private fun bufferedOutput(): Boolean {
        val t = track ?: return false
        val raw = runCatching { t.playbackHeadPosition.toLong() and 0xffffffffL }.getOrDefault(0L)
        if (raw < lastHead) headWrap += 0x100000000L
        lastHead = raw
        return hasBufferedSpeech(outputEnabled, framesWritten, headWrap + raw)
    }

    private val channel = Channel<Cmd>(Channel.UNLIMITED)
    private val speeches = LinkedHashMap<String, Speech>() // insertion order = playback order
    private val tombstones = LinkedHashMap<String, Long>() // id -> expiry
    @Volatile private var outputEnabled = true
    @Volatile private var track: AudioTrack? = null

    fun setOutputEnabled(enabled: Boolean) {
        outputEnabled = enabled
        if (!enabled) _speakingOutput.value = false
        track?.runCatching { setVolume(if (enabled) 1f else 0f) }
        if (!enabled) cancelAll()
    }
    private var trackRate = 0
    private var job: Job? = null

    fun start(scope: CoroutineScope) {
        if (job != null) return
        job = scope.launch(Dispatchers.IO) { loop() }
    }

    fun release() {
        job?.cancel()
        job = null
        channel.close()
        _speakingOutput.value = false
        track?.runCatching { release() }
        track = null
    }

    fun speechStarted(speechId: String, sampleRate: Int) {
        channel.trySend(Cmd.Started(speechId, sampleRate))
    }

    fun audio(speechId: String, seq: Int, sampleRate: Int, b64: String) {
        channel.trySend(Cmd.Audio(speechId, seq, sampleRate, b64))
    }

    fun audioDone(speechId: String, cancelled: Boolean) {
        channel.trySend(Cmd.Done(speechId, cancelled))
    }

    /** audio-cancel: clear everything and stop the track immediately. */
    fun cancelAll(speechId: String? = null) {
        channel.trySend(Cmd.Cancel(speechId))
    }

    private suspend fun loop() {
        while (currentCoroutineContext().isActive) {
            var sawCmd = false
            while (true) {
                val c = channel.tryReceive().getOrNull() ?: break
                sawCmd = true
                apply(c)
            }
            pruneTombstones()
            val busy = writeOneChunk()
            val draining = bufferedOutput()
            _speakingOutput.value = draining
            if (!busy && draining) {
                delay(20) // Poll playback head through the buffered tail after transport done.
                continue
            }
            if (!sawCmd && !busy) {
                val c = channel.receiveCatching().getOrNull() ?: break
                apply(c)
            }
        }
    }

    private fun apply(cmd: Cmd) {
        when (cmd) {
            is Cmd.Started -> {
                if (!outputEnabled || isTombstoned(cmd.speechId)) return
                getOrCreate(cmd.speechId, cmd.sampleRate)
            }
            is Cmd.Audio -> {
                if (!outputEnabled || isTombstoned(cmd.speechId)) return
                val s = getOrCreate(cmd.speechId, cmd.sampleRate)
                if (cmd.seq <= s.lastSeq) return // dedupe
                s.lastSeq = cmd.seq
                if (s.chunks.size < MAX_CHUNKS_PER_SPEECH) s.chunks.addLast(cmd.b64)
            }
            is Cmd.Done -> {
                val s = speeches[cmd.speechId] ?: return
                if (cmd.cancelled) {
                    speeches.remove(cmd.speechId)
                    s.chunks.clear() // drop remainder; already-written audio drains at boundary
                    tombstone(cmd.speechId)
                } else {
                    s.done = true
                }
            }
            is Cmd.Cancel -> {
                if (cmd.speechId == null) {
                    // clear everything + stop track immediately
                    val ids = speeches.keys.toList()
                    speeches.clear()
                    ids.forEach { tombstone(it) }
                    stopTrack()
                } else {
                    speeches.remove(cmd.speechId)?.chunks?.clear()
                    tombstone(cmd.speechId)
                }
            }
        }
    }

    private fun getOrCreate(id: String, sampleRate: Int): Speech {
        // Bound memory: never more than 64 live speeches.
        while (speeches.size >= MAX_SPEECHES) {
            val victim = speeches.keys.firstOrNull { it != id } ?: break
            speeches.remove(victim)
        }
        var s = speeches[id]
        if (s == null) {
            s = Speech(id, sampleRate)
            speeches[id] = s
        } else {
            s.sampleRate = sampleRate
        }
        return s
    }

    /** Writes exactly one queued chunk (blocking AudioTrack write paces real-time playback). */
    private fun writeOneChunk(): Boolean {
        val head = speeches.values.firstOrNull() ?: return false
        if (head.chunks.isEmpty()) {
            if (head.done || isTombstoned(head.id)) {
                if (bufferedOutput()) return false
                speeches.remove(head.id)
                return true // Advance to an already-buffered next speech without waiting for another event.
            }
            return false
        }
        val b64 = head.chunks.removeFirst()
        val floats = try {
            decodeFloats(b64)
        } catch (_: Exception) {
            return true
        }
        if (floats.isEmpty()) {
            Log.w("DshTts", "Ignoring empty PCM chunk")
            return true
        }
        val t = ensureTrack(head.sampleRate) ?: return true
        try {
            var offset = 0
            while (offset < floats.size && outputEnabled) {
                val written = t.write(floats, offset, minOf(2048, floats.size - offset), AudioTrack.WRITE_BLOCKING)
                check(written > 0) { "AudioTrack write failed: $written" }
                offset += written
                framesWritten += written
                _speakingOutput.value = outputEnabled
            }
            Log.i("DshTts", "PCM written=$offset rate=${head.sampleRate} head=${t.playbackHeadPosition} route=${t.routedDevice?.type}")
        } catch (e: Exception) {
            Log.e("DshTts", "PCM playback failed", e)
            stopTrack()
        }
        return true
    }

    private fun ensureTrack(rate: Int): AudioTrack? {
        val existing = track
        if (existing != null && trackRate == rate && existing.state == AudioTrack.STATE_INITIALIZED) {
            return existing
        }
        existing?.runCatching { release() }
        framesWritten = 0L
        lastHead = 0L
        headWrap = 0L
        track = null
        val min = try {
            AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        } catch (_: Exception) {
            -1
        }
        val bytes = if (min > 0) maxOf(min, rate * 4) else rate * 8 // ≥1s of float mono fallback
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        val fmt = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .setSampleRate(rate)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        val t = try {
            AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(fmt)
                .setBufferSizeInBytes(bytes)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_NONE)
                .build()
        } catch (e: Exception) {
            Log.e("DshTts", "AudioTrack creation failed", e)
            return null
        }
        if (t.state != AudioTrack.STATE_INITIALIZED) {
            t.release()
            return null
        }
        t.setVolume(if (outputEnabled) 1f else 0f)
        t.play()
        track = t
        trackRate = rate
        return t
    }

    private fun stopTrack() {
        track?.runCatching {
            stop()
            release()
        }
        track = null
        trackRate = 0
        framesWritten = 0L
        lastHead = 0L
        headWrap = 0L
        _speakingOutput.value = false
    }

    private fun tombstone(id: String) {
        tombstones[id] = System.currentTimeMillis() + TOMBSTONE_TTL_MS
        while (tombstones.size > MAX_TOMBSTONES) {
            val eldest = tombstones.entries.firstOrNull() ?: break
            if (eldest.value > System.currentTimeMillis() && tombstones.size <= MAX_TOMBSTONES) break
            tombstones.remove(eldest.key)
        }
    }

    private fun isTombstoned(id: String): Boolean {
        val exp = tombstones[id] ?: return false
        return exp > System.currentTimeMillis()
    }

    private fun pruneTombstones() {
        val now = System.currentTimeMillis()
        tombstones.entries.removeAll { it.value <= now }
    }

    private fun decodeFloats(b64: String): FloatArray {
        val bytes = Base64.decode(b64, Base64.DEFAULT)
        val out = FloatArray(bytes.size / 4)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(out)
        return out
    }

    companion object {
        private const val MAX_TOMBSTONES = 64
        private const val TOMBSTONE_TTL_MS = 30_000L
        private const val MAX_SPEECHES = 64
        private const val MAX_CHUNKS_PER_SPEECH = 512
    }
}

/** Transport completion is deliberately not an input: only device drain ends output. */
internal fun hasBufferedSpeech(enabled: Boolean, written: Long, played: Long): Boolean =
    enabled && written > played
