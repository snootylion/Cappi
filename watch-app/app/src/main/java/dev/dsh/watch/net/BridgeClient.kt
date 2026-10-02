package dev.dsh.watch.net

import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.Charset
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import android.util.Base64

/** Blocking HTTP helpers for the local bridge. All methods do real I/O — call on Dispatchers.IO. */

/** Command rejected by the bridge (HTTP 400/409/502 with {error}); message is display-ready. */
class BridgeCommandException(message: String) : Exception(message)

object BridgeClient {

    /** Join a stored base (canonical: no trailing slash) with a /watch/ path. */
    private fun endpoint(base: String, path: String): String =
        base.trim().trimEnd('/') + path

    /** UDP port the bridge answers discovery probes on (bridge.mjs DISCOVERY_PORT). */
    private const val DISCOVERY_PORT = 8788

    /** Bounds for discovery: packets, replies, ports and deadlines. */
    private const val MAX_PACKET_BYTES = 512
    private const val MAX_REPLIES = 8

    fun command(base: String, token: String, body: JSONObject): JSONObject =
        command(base, token, body, SecureTransport.EndpointSecurity())

    fun command(
        base: String,
        token: String,
        body: JSONObject,
        security: SecureTransport.EndpointSecurity,
    ): JSONObject {
        val conn = SecureTransport.open(endpoint(base, "/watch/command"), security).apply {
            requestMethod = "POST"
            connectTimeout = 4000
            // {cmd:"sessions"} measures ~5.5s / 1.3MB on the Mac — 8s was too tight for a watch.
            readTimeout = 20000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        SecureTransport.setTokenHeader(conn, token)
        try {
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            SecureTransport.throwOnRedirect(conn)
            val code = conn.responseCode
            val text = readBody(conn, code)
            val json = runCatching { if (text.isBlank()) null else JSONObject(text) }.getOrNull()
            if (code !in 200..299) {
                // Bridge errors: HTTP 400/409/502 with {error:"<message>"} — surface the message.
                val msg = json?.optString("error")?.takeIf { it.isNotEmpty() } ?: "HTTP $code"
                throw BridgeCommandException(msg)
            }
            return json ?: JSONObject()
        } finally {
            conn.disconnect()
        }
    }

    fun health(base: String): JSONObject =
        health(base, SecureTransport.EndpointSecurity())

    /** Legacy compatibility only: managed health still requires its device token. */
    fun health(base: String, security: SecureTransport.EndpointSecurity): JSONObject =
        readHealth(base, null, security)

    fun health(base: String, token: String, security: SecureTransport.EndpointSecurity): JSONObject {
        if (token.isBlank()) throw IOException("paired health requires a device token")
        return readHealth(base, token, security)
    }

    private fun readHealth(base: String, token: String?, security: SecureTransport.EndpointSecurity): JSONObject {
        val conn = SecureTransport.open(endpoint(base, "/watch/health"), security).apply {
            requestMethod = "GET"
            connectTimeout = 4000
            readTimeout = 6000
        }
        // TLS trust manager checks the actual peer PIN before headers reach the wire.
        if (token != null) SecureTransport.setTokenHeader(conn, token)
        try {
            SecureTransport.throwOnRedirect(conn)
            val code = conn.responseCode
            val text = readBody(conn, code)
            if (code !in 200..299) throw IOException("HTTP $code")
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }

    fun fetchState(base: String, token: String): JSONObject =
        fetchState(base, token, SecureTransport.EndpointSecurity())

    fun fetchState(
        base: String,
        token: String,
        security: SecureTransport.EndpointSecurity,
    ): JSONObject {
        val conn = SecureTransport.open(endpoint(base, "/watch/state"), security).apply {
            requestMethod = "GET"
            connectTimeout = 4000
            readTimeout = 8000
        }
        SecureTransport.setTokenHeader(conn, token)
        try {
            SecureTransport.throwOnRedirect(conn)
            val code = conn.responseCode
            val text = readBody(conn, code)
            if (code !in 200..299) throw IOException("HTTP $code")
            return JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }

    /** Decoded image bytes for /watch/image. */
    fun fetchImage(base: String, token: String, ref: String): ByteArray =
        fetchImage(base, token, ref, SecureTransport.EndpointSecurity())

    /** Decoded image bytes for /watch/image. */
    fun fetchImage(
        base: String,
        token: String,
        ref: String,
        security: SecureTransport.EndpointSecurity,
    ): ByteArray {
        val url = endpoint(base, "/watch/image") + "?ref=${URLEncoder.encode(ref, "UTF-8")}"
        val conn = SecureTransport.open(url, security).apply {
            requestMethod = "GET"
            connectTimeout = 5000
            readTimeout = 15000
        }
        SecureTransport.setTokenHeader(conn, token)
        try {
            SecureTransport.throwOnRedirect(conn)
            val code = conn.responseCode
            if (code !in 200..299) throw IOException("HTTP $code")
            if (conn.contentLengthLong > ImageSafety.MAX_BYTES) throw IOException("Image unavailable: exceeds 6 MiB limit")
            return ImageSafety.readBounded(conn.inputStream)
        } finally {
            conn.disconnect()
        }
    }

    /** SSE GET — returns the open connection; caller reads/ closes. */
    fun openSse(base: String, token: String): HttpURLConnection =
        openSse(base, token, SecureTransport.EndpointSecurity())

    /** SSE GET — returns the open connection; caller reads/ closes. */
    fun openSse(
        base: String,
        token: String,
        security: SecureTransport.EndpointSecurity,
    ): HttpURLConnection {
        val conn = SecureTransport.open(endpoint(base, "/watch/stream"), security).apply {
            requestMethod = "GET"
            connectTimeout = 5000
            readTimeout = 40000 // watchdog: no line for 40s → SocketTimeoutException → reconnect
            setRequestProperty("Accept", "text/event-stream")
            setRequestProperty("Cache-Control", "no-cache")
        }
        SecureTransport.setTokenHeader(conn, token)
        SecureTransport.throwOnRedirect(conn)
        val code = conn.responseCode
        if (code !in 200..299) {
            conn.disconnect()
            throw IOException("SSE HTTP $code")
        }
        return conn
    }

    /**
     * LAN self-heal for a stale bridge address (DHCP changes): broadcast a
     * discovery probe and return the first VERIFIED bridge URL, else null.
     * Blocking — call on Dispatchers.IO.
     *
     * Discovery replies are untrusted candidates, never proof: with a pinned
     * certificate configured the candidate is verified over HTTPS (pin check
     * before any token is sent); otherwise the legacy pair-probe liveness
     * check applies (see [pairVerified]). Stale calls stop early via
     * [isCancelled] and their results must be ignored by the caller.
     */
    fun discoverBase(token: String, timeoutMs: Int = 1500): String? =
        discoverBase(token, timeoutMs, SecureTransport.EndpointSecurity(), null)

    fun discoverBase(
        token: String,
        timeoutMs: Int = 1500,
        security: SecureTransport.EndpointSecurity = SecureTransport.EndpointSecurity(),
        isCancelled: (() -> Boolean)? = null,
    ): String? {
        var verifiedBase: String? = null
        try {
            LanDiscovery.scan(timeoutMs, isCancelled) { hostPort, remaining ->
                val candidate = if (security.certPinSha256.isNotBlank()) "https://$hostPort" else "http://$hostPort"
                val verified = if (security.certPinSha256.isNotBlank()) {
                    authenticatedHealthVerified(candidate, token, security, remaining)
                } else if (security.allowInsecureLan) {
                    pairVerified(candidate, token, remaining)
                } else false
                if (verified && isCancelled?.invoke() != true) verifiedBase = candidate
                verified
            }
        } catch (_: Exception) { /* best-effort scan; retain existing trusted record */ }
        return verifiedBase
    }

    /** Stored actual-peer PIN first; then require device-authenticated health success. */
    internal fun authenticatedHealthVerified(
        base: String, token: String, security: SecureTransport.EndpointSecurity, budgetMs: Int,
    ): Boolean {
        if (security.certPinSha256.isBlank() || token.isBlank() || budgetMs <= 0) return false
        val start = System.nanoTime()
        val conn = try {
            SecureTransport.open(endpoint(base, "/watch/health"), security).apply {
                requestMethod = "GET"
                connectTimeout = (budgetMs / 2).coerceAtLeast(1)
                readTimeout = (budgetMs / 2).coerceAtLeast(1)
            }
        } catch (_: Exception) { return false }
        return try {
            SecureTransport.setTokenHeader(conn, token)
            SecureTransport.throwOnRedirect(conn)
            conn.responseCode == 200 && (System.nanoTime() - start) / 1_000_000 < budgetMs
        } catch (_: Exception) { false } finally { conn.disconnect() }
    }

    /**
     * Verify a candidate bridge by its pinned certificate over HTTPS, sending
     * no token. Any HTTP response (even an error status) proves the peer holds
     * the pinned key; a TLS failure proves it does not.
     */
    fun pinVerified(base: String, security: SecureTransport.EndpointSecurity): Boolean {
        if (security.certPinSha256.isBlank()) return false
        val conn = try {
            SecureTransport.open(endpoint(base, "/watch/health"), security).apply {
                requestMethod = "GET"
                connectTimeout = 1500
                readTimeout = 2000
            }
        } catch (_: Exception) {
            return false
        }
        return try {
            // responseCode drives the pinned handshake; redirects are refused.
            SecureTransport.throwOnRedirect(conn)
            conn.responseCode
            true
        } catch (_: Exception) {
            false
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Legacy liveness check: HMAC-SHA256(token, nonce) round-trip over an
     * unauthenticated endpoint. This is NOT relay-proof — a relay forwards
     * the challenge to the real bridge and returns its answer — so it proves
     * liveness/consistency only, never identity. Do not treat a pass as
     * authentication; the pinned certificate is the trust root.
     */
    fun pairVerified(base: String, token: String, budgetMs: Int = 2000): Boolean {
        val nonce = UUID.randomUUID().toString().replace("-", "")
        val url = URL(endpoint(base, "/watch/pair-probe") + "?nonce=${URLEncoder.encode(nonce, "UTF-8")}")
        val conn = try {
            SecureTransport.open(
                url.toString(),
                SecureTransport.EndpointSecurity(allowInsecureLan = true),
            ).apply {
                requestMethod = "GET"
                connectTimeout = (budgetMs / 2).coerceAtLeast(1)
                readTimeout = (budgetMs / 2).coerceAtLeast(1)
            }
        } catch (_: Exception) {
            return false
        }
        return try {
            if (conn.responseCode != 200) false
            else {
                val mac = JSONObject(readBody(conn, 200)).optString("mac")
                mac.isNotEmpty() && mac == hmacSha256UrlSafe(token, nonce)
            }
        } catch (_: Exception) {
            false
        } finally {
            conn.disconnect()
        }
    }

    private fun hmacSha256UrlSafe(key: String, msg: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return Base64.encodeToString(
            mac.doFinal(msg.toByteArray(Charsets.UTF_8)),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )
    }

    private fun readBody(conn: HttpURLConnection, code: Int): String {
        val stream = try {
            if (code >= 400) conn.errorStream else conn.inputStream
        } catch (_: Exception) {
            null
        } ?: return ""
        return stream.use { s ->
            BufferedReader(InputStreamReader(s, Charset.forName("UTF-8"))).use { it.readText() }
        }
    }
}
