package dev.dsh.watch.service

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.IOException

internal interface VoiceInput {
    fun start()
    fun read(buffer: ByteArray): Int
    fun stop()
    fun release()
}

/** Only the real release factory calls this, after authenticated ready + permission. */
@androidx.annotation.RequiresPermission(android.Manifest.permission.RECORD_AUDIO)
internal fun createAndroidVoiceInput(): VoiceInput {
    val min = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    for (source in intArrayOf(MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC)) {
        val record = try { AudioRecord(source, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, 8192)) }
            catch (_: Exception) { null }
        if (record == null) continue
        if (record.state != AudioRecord.STATE_INITIALIZED) { record.release(); continue }
        return object : VoiceInput {
            override fun start() {
                record.startRecording()
                if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) throw IOException("Microphone could not start")
            }
            override fun read(buffer: ByteArray): Int = record.read(buffer, 0, buffer.size)
            override fun stop() { record.stop() }
            override fun release() { record.release() }
        }
    }
    throw IOException("Microphone could not initialize")
}
