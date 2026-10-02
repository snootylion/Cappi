package dev.dsh.watch.net

import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader

/**
 * Minimal SSE line reader for the bridge protocol: `data: {json}\n\n` events plus
 * `: keepalive` comments. Multi-line `data:` payloads are joined per spec.
 * Blocks until the stream ends, the 40s read watchdog trips, or an I/O error occurs —
 * all of which throw so the supervisor reconnects.
 */
class SseReader(private val conn: java.net.HttpURLConnection) {

    /** Reads events until failure/EOF. Returns only by throwing. */
    fun readLoop(onEvent: (JSONObject) -> Unit, onLine: () -> Unit) {
        val reader = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8))
        try {
            val data = StringBuilder()
            while (true) {
                val line = reader.readLine() ?: throw IOException("SSE closed")
                onLine()
                when {
                    line.isEmpty() -> {
                        if (data.isNotEmpty()) {
                            val payload = data.toString()
                            data.setLength(0)
                            val json = runCatching { JSONObject(payload) }.getOrNull()
                            if (json != null) onEvent(json)
                        }
                    }
                    line.startsWith("data:") -> {
                        if (data.isNotEmpty()) data.append('\n')
                        data.append(line.substring(5).trimStart())
                    }
                    line.startsWith(":") -> {
                        // keepalive comment — onLine() already reset the watchdog
                    }
                    else -> {
                        // event:/id:/retry: fields are ignored (default event type)
                    }
                }
            }
        } finally {
            runCatching { reader.close() }
            runCatching { conn.disconnect() }
        }
    }
}
