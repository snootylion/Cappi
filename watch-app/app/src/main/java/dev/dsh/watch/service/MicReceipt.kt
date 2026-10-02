package dev.dsh.watch.service

import dev.dsh.watch.net.PairingTransport
import dev.dsh.watch.net.StrictJson
import java.net.HttpURLConnection

/** EOF/HTTP success is not host admission. Never echo receipt text or infer agent state. */
internal object MicReceipt {
    data class Outcome(val state: String, val message: String? = null, val sdkAcknowledged: Boolean = false, val drafted: Boolean = false) {
        val accepted: Boolean get() = state == "closed"
    }

    fun failure(code: String? = null): Outcome = Outcome("error", when (code) {
        "mic-too-large" -> "Microphone upload too large — record a shorter message"
        "bad-token", "trust-mismatch" -> "Microphone authorization failed — re-pair with your Mac"
        "no-speech" -> "No speech was delivered — tap record to retry"
        else -> "Microphone delivery failed — tap record to retry"
    })

    fun read(conn: HttpURLConnection, expectedStreamId: String, draftMode: Boolean, legacyAllowed: Boolean): Outcome {
        val status = conn.responseCode
        // Do not parse or display private error text from failed HTTP uploads.
        if (status !in 200..299) return failure(when (status) { 401 -> "bad-token"; 413 -> "mic-too-large"; else -> null })
        val text = PairingTransport.readBoundedUtf8(conn.inputStream)
        return evaluate(status, text, expectedStreamId, draftMode, legacyAllowed)
    }

    fun evaluate(status: Int, body: String, expectedStreamId: String, draftMode: Boolean, legacyAllowed: Boolean = false): Outcome {
        if (status !in 200..299) return failure(when (status) { 401 -> "bad-token"; 413 -> "mic-too-large"; else -> null })
        return try {
            val map = StrictJson.parse(body)
            StrictJson.rejectUnknown(map, setOf("streamId", "state", "txChunks", "txBytes", "ackFinals", "delivered", "drafted", "utteranceId", "code", "message", "retryable", "ok", "error"), "mic receipt")
            val sid = StrictJson.str(map, "streamId")
            if (sid != null && sid != expectedStreamId) return failure()
            val state = StrictJson.str(map, "state")
            val code = StrictJson.str(map, "code")
            val error = StrictJson.str(map, "error")
            fun bool(key: String): Boolean? {
                if (!map.containsKey(key)) return null
                return map[key] as? Boolean ?: throw java.io.IOException("Invalid receipt boolean")
            }
            val delivered = bool("delivered")
            val drafted = bool("drafted")
            val ok = bool("ok")
            val ack = StrictJson.long(map, "ackFinals")
            if (state == "error" || code != null || error != null || ok == false) return failure(code ?: error)
            if (state != null && state != "closed") return failure()
            if (delivered == null && drafted == null && legacyAllowed) return Outcome("closed")
            // Managed receipts always correlate to the actual current stream.
            if (state != "closed" || sid == null || expectedStreamId.isEmpty() || ack == null || ack < 0) return failure()
            when {
                draftMode && drafted == true && delivered == false && ack == 0L -> Outcome("closed", drafted = true)
                !draftMode && drafted != true && delivered == true && ack >= 1L -> Outcome("closed", sdkAcknowledged = true)
                !draftMode && delivered == false && ack == 0L -> failure("no-speech")
                else -> failure()
            }
        } catch (_: Exception) { failure() }
    }

    /** Same-stream terminal truth never regresses; a new explicit stream resets warming. */
    fun allowsProgress(current: String, incoming: String): Boolean = when {
        current == "error" -> incoming == "error"
        current == "cancelled" -> false
        current == "closed" -> incoming == "closed" || incoming == "error"
        current == "finishing" -> incoming !in setOf("warming", "ready", "capturing")
        else -> true
    }

    /** A deliberate stop/superseded owner must remain quiet; EOF-closed can still fail. */
    fun shouldPublishFailure(running: Boolean, ownsCapture: Boolean, currentState: String?): Boolean =
        running && ownsCapture && currentState != "error"
}
