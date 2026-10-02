package dev.dsh.watch.net

import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.Charset
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Strict bounded typed JSON reader for the frozen pairing DTOs (no regex on
 * JSON structure; shape allowlist regexes remain as VALUE validators only).
 *
 * Rules: top-level object only, UTF-8 body bounded to [MAX_BODY_BYTES];
 * duplicate keys rejected; unknown top-level keys rejected against the
 * caller-supplied allowlist; wrong value types rejected; trailing data after
 * the closing `}` rejected; nested objects allowed ONLY for the explicitly
 * declared nested keys (currently `fingerprint` with `{full, short}`), with
 * the same duplicate/unknown/type strictness inside; arrays and deeper
 * nesting rejected (nested-spoof fail-closed). Anything else fails closed
 * as a bad body. Numbers decode as Long when integral, Double otherwise.
 */
internal object StrictJson {
    const val MAX_BODY_BYTES = 16 * 1024

    fun parse(text: String): Map<String, Any?> {
        if (text.toByteArray(Charsets.UTF_8).size > MAX_BODY_BYTES) {
            throw IOException("JSON body exceeds ${MAX_BODY_BYTES}B bound")
        }
        val p = Parser(text)
        p.ws()
        if (p.eof() || p.peek() != '{') throw IOException("JSON body is not an object")
        val obj = p.obj(depth = 0)
        p.ws()
        if (!p.eof()) throw IOException("JSON trailing data after object")
        return obj
    }

    fun rejectUnknown(map: Map<String, Any?>, allowed: Set<String>, what: String) {
        for (k in map.keys) {
            if (k !in allowed) throw IOException("$what: unknown field")
        }
    }

    fun str(map: Map<String, Any?>, key: String): String? {
        val v = map[key] ?: return null
        if (v !is String) throw IOException("JSON field \"$key\" must be a string")
        return v
    }

    fun long(map: Map<String, Any?>, key: String): Long? {
        val v = map[key] ?: return null
        return when (v) {
            is Long -> v
            is Double -> {
                if (v % 1.0 != 0.0) throw IOException("JSON field \"$key\" must be an integer")
                val l = v.toLong()
                if (l.toDouble() != v) throw IOException("JSON field \"$key\" out of range")
                l
            }
            else -> throw IOException("JSON field \"$key\" must be a number")
        }
    }

    @Suppress("UNCHECKED_CAST")
    fun nested(map: Map<String, Any?>, key: String, allowed: Set<String>): Map<String, Any?>? {
        val v = map[key] ?: return null
        if (v !is Map<*, *>) throw IOException("JSON field \"$key\" must be an object")
        val m = v as Map<String, Any?>
        rejectUnknown(m, allowed, "JSON field \"$key\"")
        return m
    }

    private class Parser(val s: String) {
        var i = 0
        fun eof(): Boolean = i >= s.length
        fun peek(): Char = s[i]
        fun ws() { while (!eof() && s[i] in " \t\r\n") i++ }
        fun expect(c: Char) {
            if (eof() || s[i] != c) throw IOException("JSON syntax error at offset $i")
            i++
        }

        fun obj(depth: Int): Map<String, Any?> {
            if (depth > 1) throw IOException("JSON nested too deep (spoof?)")
            expect('{')
            val out = LinkedHashMap<String, Any?>()
            ws()
            if (!eof() && peek() == '}') { i++; return out }
            while (true) {
                ws()
                if (eof() || peek() != '"') throw IOException("JSON object key must be a string")
                val key = string()
                if (key in out) throw IOException("JSON duplicate field")
                ws()
                expect(':')
                ws()
                out[key] = value(depth)
                ws()
                if (eof()) throw IOException("JSON unterminated object")
                when (peek()) {
                    ',' -> { i++; continue }
                    '}' -> { i++; return out }
                    else -> throw IOException("JSON syntax error at offset $i")
                }
            }
        }

        fun value(depth: Int): Any? {
            if (eof()) throw IOException("JSON unexpected end")
            return when (val c = peek()) {
                '"' -> string()
                '{' -> obj(depth + 1)
                '[' -> throw IOException("JSON arrays not accepted (spoof?)")
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                '-', in '0'..'9' -> number()
                else -> throw IOException("JSON syntax error at offset $i")
            }
        }

        fun literal(word: String, v: Any?): Any? {
            if (!s.startsWith(word, i)) throw IOException("JSON syntax error at offset $i")
            i += word.length
            return v
        }

        fun number(): Number {
            val start = i
            if (!eof() && peek() == '-') i++
            var digits = 0
            while (!eof() && peek().isDigit()) { i++; digits++ }
            var isDouble = false
            if (!eof() && peek() == '.') {
                isDouble = true; i++
                var frac = 0
                while (!eof() && peek().isDigit()) { i++; frac++ }
                if (frac == 0) throw IOException("JSON bad number at offset $start")
            }
            if (!eof() && (peek() == 'e' || peek() == 'E')) {
                isDouble = true; i++
                if (!eof() && (peek() == '+' || peek() == '-')) i++
                var exp = 0
                while (!eof() && peek().isDigit()) { i++; exp++ }
                if (exp == 0) throw IOException("JSON bad number at offset $start")
            }
            if (digits == 0) throw IOException("JSON bad number at offset $start")
            val raw = s.substring(start, i)
            if (!raw.matches(Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?"))) throw IOException("JSON bad number")
            return try {
                if (isDouble) raw.toDouble() else raw.toLong()
            } catch (_: NumberFormatException) {
                throw IOException("JSON number out of range at offset $start")
            }
        }

        fun string(): String {
            expect('"')
            val out = StringBuilder()
            while (true) {
                if (eof()) throw IOException("JSON unterminated string")
                val c = s[i++]
                when (c) {
                    '"' -> return out.toString()
                    '\\' -> {
                        if (eof()) throw IOException("JSON bad escape at offset $i")
                        when (val e = s[i++]) {
                            '"' -> out.append('"')
                            '\\' -> out.append('\\')
                            '/' -> out.append('/')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) throw IOException("JSON bad \\u escape")
                                val hex = s.substring(i, i + 4)
                                val cp = hex.toIntOrNull(16)
                                    ?: throw IOException("JSON bad \\u escape")
                                i += 4
                                out.append(cp.toChar())
                            }
                            else -> throw IOException("JSON bad escape '\\$e'")
                        }
                    }
                    else -> {
                        if (c.code < 0x20) throw IOException("JSON raw control char at offset $i")
                        out.append(c)
                    }
                }
            }
        }
    }
}

/**
 * Minimal flat-JSON field reader for the frozen pairing DTOs. Hand-rolled
 * (no org.json: unit tests run against the Android stub where org.json
 * methods throw "not mocked"). Only top-level string/number fields are read;
 * nested `fingerprint` is matched with a dedicated pattern. Good enough for
 * the fixed §8 shapes; anything else fails closed as a bad body.
 */

/**
 * Turnkey pairing transport (W-owned, frozen contract §§8–9 + schema v1).
 *
 * Provisional-TLS rule: ONLY [fetchPairInfo] disables pinning, and it retrieves
 * CERT ONLY — no auth, no token, no enrollment secret on that request. The pin
 * is derived from the ACTUAL peer X509 DER seen in the TLS handshake (platform
 * stack), never from trusting the JSON body: the body `certSha256Pin` is a BIND
 * assertion that MUST byte-equal the handshake pin or the call fails
 * `trust-mismatch`, fail-closed, nothing persisted.
 *
 * Every other call ([enroll], [poll], [micStart]) uses the strict pinned
 * [SecureTransport] factory. No URL secrets, no redirects, no userinfo/query/
 * fragment on pairing paths (query is refused outright here).
 */
object PairingTransport {

    const val PAIR_PROTOCOL = "turnkey/1"
    const val PATH_INFO = "/pair/info"
    const val PATH_ENROLL = "/pair/enroll"
    const val PATH_POLL = "/pair/poll"
    const val PATH_MIC_START = "/watch/mic/start"

    /** Explicit watch-confirm header the H enroll gate requires (else 403). */
    const val HEADER_FINGERPRINT_CONFIRMED = "X-Fingerprint-Confirmed"
    /** Public cert pin header (sha256/... pin, never a secret). */
    const val HEADER_CERT_PIN = "X-Cert-Pin"

    /** Request-id / secret shape: opaque ≥128-bit CSPRNG base64url. */
    private val SECRET_RE = Regex("^[A-Za-z0-9_-]{22,128}$")
    private val FULL_FP_RE = Regex("^([0-9a-f]{2}:){31}[0-9a-f]{2}$")
    private val SHORT_FP_RE = Regex("^[0-9a-f]{4}(-[0-9a-f]{4}){5}$")
    private val PIN_RE = Regex("^sha256/[A-Za-z0-9+/]{43}=$")

    data class PairInfoResult(
        val handshakePin: String,
        val bodyPin: String,
        val serverDisplayName: String,
        val nonce: String,
        val fullFingerprint: String,
        val shortFingerprint: String,
    )

    data class EnrollResult(val requestId: String, val expiresAtMs: Long)

    sealed interface PollResult {
        data class Pending(val requestId: String, val expiresAtMs: Long) : PollResult
        data class Approved(
            val deviceId: String,
            val token: String,
            val baseUrl: String?,
            val certSha256Pin: String,
        ) : PollResult
        data class Rejected(val error: String, val retryable: Boolean) : PollResult
    }

    data class MicStartResult(val streamId: String, val ready: Boolean, val message: String?)

    /** Generate a ≥128-bit CSPRNG base64url secret (24 random bytes → 32 chars). */
    fun newSecret(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    fun isSecretShape(s: String): Boolean = SECRET_RE.matches(s)

    /** Full SHA-256 fingerprint, lowercase colon-hex, from a handshake cert. */
    fun fullFingerprint(cert: X509Certificate): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
        return digest.joinToString(":") { "%02x".format(it) }
    }

    /** Minimum 96-bit / 6 groups of 4 hex short form for side-by-side compare. */
    fun shortFingerprint(fullColonHex: String): String {
        val hex = fullColonHex.replace(":", "")
        require(hex.length >= 24) { "fingerprint too short" }
        return (0 until 6).joinToString("-") { hex.substring(it * 4, it * 4 + 4) }
    }

    /** SHA-256 pin (`sha256/` + base64 of 32 bytes) from a handshake cert DER. */
    fun handshakePin(cert: X509Certificate): String =
        "sha256/" + java.util.Base64.getEncoder().encodeToString(
            MessageDigest.getInstance("SHA-256").digest(cert.encoded),
        )

    private fun canonicalBase(base: String): String {
        val b = base.trim().trimEnd('/')
        if (b.isEmpty()) throw IOException("pairing base is empty (unpaired)")
        val url = try { URL(b) } catch (e: Exception) {
            throw IOException("pairing base is malformed: ${e.message}")
        }
        if (!url.userInfo.isNullOrEmpty()) throw IOException("pairing base must not contain userinfo")
        if (url.ref != null) throw IOException("pairing base must not contain a fragment")
        if (!url.query.isNullOrEmpty()) throw IOException("pairing base must not contain a query")
        val scheme = url.protocol.lowercase()
        if (scheme != "https") throw IOException("pairing requires https:// (no insecure auto-downgrade)")
        return b
    }

    /**
     * Provisional cert retrieval: pinning DISABLED for this one endpoint, CERT
     * ONLY. Captures the peer chain via a recording trust manager, derives the
     * pin + fingerprints from the handshake cert, then requires byte-equality
     * with the JSON body pin. Throws on mismatch/redirect/forgery.
     */
    fun fetchPairInfo(candidateBase: String, timeoutMs: Int = 6000): PairInfoResult =
        fetchPairInfo(candidateBase, timeoutMs, null)

    internal fun fetchPairInfo(
        candidateBase: String,
        timeoutMs: Int,
        peerCapture: AtomicReference<X509Certificate?>?,
    ): PairInfoResult {
        val base = canonicalBase(candidateBase)
        val fullUrl = base + PATH_INFO
        val url = URL(fullUrl)
        val captured = peerCapture ?: AtomicReference<X509Certificate?>()
        val recording = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (chain.isEmpty()) throw java.security.cert.CertificateException("empty chain")
                captured.set(chain[0])
                // Provisional: record only, do not authenticate here. Equality
                // with the body pin is enforced below, after the handshake, and
                // explicit user confirmation is still required before enroll.
            }
        }
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf<TrustManager>(recording), SecureRandom())
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = timeoutMs.coerceIn(1000, 10_000)
            readTimeout = timeoutMs.coerceIn(1000, 10_000)
            instanceFollowRedirects = false
            requestMethod = "GET"
            setRequestProperty("Accept", "application/json")
        }
        if (conn is HttpsURLConnection) {
            conn.sslSocketFactory = context.socketFactory
            conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        }
        try {
            throwOnRedirect(conn)
            val code = conn.responseCode
            val text = readBody(conn, code)
            if (code !in 200..299) throw IOException("pair info HTTP $code")
            if (text.isBlank() || !text.trimStart().startsWith("{")) {
                throw IOException("pair info is not JSON")
            }
            val peer = captured.get() ?: throw IOException("pair info: no peer certificate captured")
            val hsPin = handshakePin(peer)
            val parsed = StrictJson.parse(text)
            StrictJson.rejectUnknown(
                parsed,
                setOf("pairProtocol", "certSha256Pin", "serverDisplayName", "nonce", "fingerprint"),
                "pair info",
            )
            val bodyPin = StrictJson.str(parsed, "certSha256Pin").orEmpty()
            if (!PIN_RE.matches(bodyPin)) throw IOException("pair info: bad certSha256Pin shape")
            // BIND assertion: response pin MUST equal the handshake-derived pin.
            if (!SecureTransport.pinMatches(hsPin, bodyPin)) {
                throw IOException("trust-mismatch: body pin != handshake pin (forged body?)")
            }
            if (StrictJson.str(parsed, "pairProtocol") != PAIR_PROTOCOL) {
                throw IOException("pair info: unsupported pairProtocol")
            }
            val fp = StrictJson.nested(parsed, "fingerprint", setOf("full", "short"))
                ?: throw IOException("pair info: missing fingerprint")
            val full = StrictJson.str(fp, "full").orEmpty()
            val short = StrictJson.str(fp, "short").orEmpty()
            if (!FULL_FP_RE.matches(full)) throw IOException("pair info: bad fingerprint.full")
            if (!SHORT_FP_RE.matches(short)) throw IOException("pair info: bad fingerprint.short")
            // Either display MUST match the handshake cert; a forged body that
            // passes the pin check but rewrites the display is rejected here.
            val derivedFull = fullFingerprint(peer)
            if (!derivedFull.equals(full, ignoreCase = true)) {
                throw IOException("trust-mismatch: fingerprint.full != handshake cert")
            }
            val derivedShort = shortFingerprint(derivedFull)
            if (!derivedShort.equals(short, ignoreCase = true)) {
                throw IOException("trust-mismatch: fingerprint.short != handshake cert")
            }
            return PairInfoResult(
                handshakePin = hsPin,
                bodyPin = bodyPin,
                serverDisplayName = StrictJson.str(parsed, "serverDisplayName")?.ifEmpty { "bridge" } ?: "bridge",
                nonce = StrictJson.str(parsed, "nonce").orEmpty(),
                fullFingerprint = derivedFull,
                shortFingerprint = derivedShort,
            )
        } finally {
            conn.disconnect()
        }
    }

    /** POST /pair/enroll over pinned TLS ONLY. No token; secret in body only.
     *
     * Call ONLY after explicit watch Confirm ([PairingCenter.confirmRecord]):
     * the request carries the public handshake pin ([HEADER_CERT_PIN], never
     * a secret) plus the explicit [HEADER_FINGERPRINT_CONFIRMED] `true`
     * assertion the H gate requires (else 403 approval-required). No secret
     * is ever placed in the URL (query refused client-side, 401 server-side).
     */
    fun enroll(
        base: String,
        pin: String,
        deviceAlias: String,
        enrollmentSecret: String,
        timeoutMs: Int = 8000,
    ): EnrollResult {
        if (deviceAlias.isBlank() || deviceAlias.length > 64) throw IOException("device alias is invalid")
        if (!isSecretShape(enrollmentSecret)) throw IOException("enrollment secret shape invalid")
        if (!PIN_RE.matches(pin.trim())) throw IOException("certificate pin shape invalid (sha256/...)")
        val origin = canonicalBase(base)
        val security = SecureTransport.EndpointSecurity(certPinSha256 = pin)
        val conn = SecureTransport.open(origin + PATH_ENROLL, security).apply {
            requestMethod = "POST"
            connectTimeout = 4000
            readTimeout = timeoutMs.coerceIn(1000, 15_000)
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            // Explicit confirm assertions: public pin + true flag. The H
            // enroll gate 403s without X-Fingerprint-Confirmed:true.
            setRequestProperty(HEADER_CERT_PIN, pin.trim())
            setRequestProperty(HEADER_FINGERPRINT_CONFIRMED, "true")
        }
        try {
            val body = "{\"deviceAlias\":\"${jsonEsc(deviceAlias.trim())}\"," +
                "\"enrollmentSecret\":\"${jsonEsc(enrollmentSecret)}\"}"
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            throwOnRedirect(conn)
            val code = conn.responseCode
            val text = readBody(conn, code)
            if (code == 201) {
                val parsed = StrictJson.parse(if (text.isBlank()) "{}" else text)
                StrictJson.rejectUnknown(parsed, setOf("requestId", "expiresAtMs"), "enroll")
                val requestId = StrictJson.str(parsed, "requestId").orEmpty()
                val expiresAtMs = StrictJson.long(parsed, "expiresAtMs")
                if (!SECRET_RE.matches(requestId)) throw IOException("enroll: bad requestId")
                if (expiresAtMs == null || expiresAtMs <= 0) throw IOException("enroll: bad expiresAtMs")
                return EnrollResult(requestId, expiresAtMs)
            }
            throw pairError(code, text)
        } finally {
            conn.disconnect()
        }
    }

    /** POST /pair/poll over pinned TLS ONLY. Secret in body, never in URL. */
    fun poll(
        base: String,
        pin: String,
        requestId: String,
        enrollmentSecret: String,
        timeoutMs: Int = 8000,
    ): PollResult {
        if (!isSecretShape(requestId)) throw IOException("requestId shape invalid")
        if (!isSecretShape(enrollmentSecret)) throw IOException("enrollment secret shape invalid")
        if (!PIN_RE.matches(pin.trim())) throw IOException("certificate pin shape invalid (sha256/...)")
        val origin = canonicalBase(base)
        val security = SecureTransport.EndpointSecurity(certPinSha256 = pin)
        val conn = SecureTransport.open(origin + PATH_POLL, security).apply {
            requestMethod = "POST"
            connectTimeout = 4000
            readTimeout = timeoutMs.coerceIn(1000, 15_000)
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        try {
            val body = "{\"requestId\":\"${jsonEsc(requestId)}\"," +
                "\"enrollmentSecret\":\"${jsonEsc(enrollmentSecret)}\"}"
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            throwOnRedirect(conn)
            val code = conn.responseCode
            val text = readBody(conn, code)
            if (code == 202) {
                val parsed = StrictJson.parse(if (text.isBlank()) "{}" else text)
                StrictJson.rejectUnknown(parsed, setOf("status", "requestId", "expiresAtMs"), "poll")
                if (StrictJson.str(parsed, "status") != "pending") throw IOException("poll: bad pending body")
                return PollResult.Pending(
                    StrictJson.str(parsed, "requestId").orEmpty(),
                    StrictJson.long(parsed, "expiresAtMs") ?: -1L,
                )
            }
            if (code == 200) {
                val parsed = StrictJson.parse(if (text.isBlank()) "{}" else text)
                StrictJson.rejectUnknown(
                    parsed,
                    setOf("status", "deviceId", "token", "certSha256Pin", "baseUrl"),
                    "poll",
                )
                if (StrictJson.str(parsed, "status") != "approved") throw IOException("poll: bad approved body")
                val deviceId = StrictJson.str(parsed, "deviceId").orEmpty()
                val token = StrictJson.str(parsed, "token").orEmpty()
                val pinOut = StrictJson.str(parsed, "certSha256Pin").orEmpty()
                if (deviceId.isBlank() || deviceId.length > 64) throw IOException("poll: bad deviceId")
                if (token.length < 22 || token.length > 256) throw IOException("poll: bad token")
                if (!PIN_RE.matches(pinOut)) throw IOException("poll: bad certSha256Pin")
                return PollResult.Approved(deviceId, token,
                    StrictJson.str(parsed, "baseUrl")?.ifEmpty { null }, pinOut)
            }
            throw pairError(code, text)
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Authenticate + ready preflight: POST /watch/mic/start over the pinned
     * transport BEFORE any AudioRecord start. Returns ready=false with a
     * display message on 503 mic-not-ready; throws on transport failure.
     * `streamId` is a non-secret correlator, never auth (auth is header/pin).
     */
    fun micStart(
        base: String,
        token: String,
        security: SecureTransport.EndpointSecurity,
        streamId: String,
        answerRequestId: String? = null,
        timeoutMs: Int = 8000,
    ): MicStartResult {
        if (streamId.isBlank() || streamId.length > 64) throw IOException("streamId invalid")
        val origin = base.trim().trimEnd('/')
        val conn = SecureTransport.open(origin + PATH_MIC_START, security).apply {
            requestMethod = "POST"
            connectTimeout = 4000
            readTimeout = timeoutMs.coerceIn(1000, 15_000)
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        SecureTransport.setTokenHeader(conn, token)
        try {
            val body = buildString {
                append("{\"streamId\":\"${jsonEsc(streamId)}\"")
                if (!answerRequestId.isNullOrEmpty()) append(",\"answerRequestId\":\"${jsonEsc(answerRequestId)}\"")
                append("}")
            }
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            SecureTransport.throwOnRedirect(conn)
            val code = conn.responseCode
            val text = readBody(conn, code)
            if (code == 200) return MicStartResult(streamId, ready = true, message = null)
            if (code == 404) throw MicStartMissing("mic preflight route absent (legacy bridge)")
            if (code == 503) {
                val parsed = runCatching { StrictJson.parse(if (text.isBlank()) "{}" else text) }.getOrNull()
                val msg = parsed?.let { runCatching { StrictJson.str(it, "message") }.getOrNull() }
                    .orEmpty().ifEmpty { "voice backend warming — wait, then tap record again" }
                return MicStartResult(streamId, ready = false, message = msg)
            }
            val parsed = runCatching { StrictJson.parse(if (text.isBlank()) "{}" else text) }.getOrNull()
            val err = parsed?.let { runCatching { StrictJson.str(it, "error") }.getOrNull() }
                .orEmpty().ifEmpty { "mic preflight HTTP $code" }
            throw IOException("mic preflight HTTP $code")
        } finally {
            conn.disconnect()
        }
    }

    /** Legacy-bridge probe: true when the preflight route exists (any non-404). */
    fun hasMicPreflight(
        base: String,
        token: String,
        security: SecureTransport.EndpointSecurity,
    ): Boolean {
        return try {
            micStart(base, token, security, "probe-${System.currentTimeMillis()}")
            true
        } catch (e: MicStartMissing) {
            false
        } catch (_: Exception) {
            true // reachable route with another outcome still counts as present
        }
    }

    class MicStartMissing(message: String) : IOException(message)

    /**
     * Untrusted LAN scan: UDP `DSHW1DISCOVER <nonce>` → collect
     * `DSHW1BRIDGE <nonce> <port>` replies as candidate `https://host:port`
     * strings. Candidates confer NO authority — no secret is sent before the
     * [fetchPairInfo] bind + explicit user confirm. Bounds: 512 B packets,
     * nonce `[\w-]{1,64}`, ports 1–65535, ≤8 replies, ≤3 s deadline.
     */
    fun scanCandidates(timeoutMs: Int = 3000): List<String> {
        return try {
            LanDiscovery.scan(timeoutMs).map { "https://$it" }
        } catch (_: Exception) { emptyList() }
    }

    private fun pairError(code: Int, text: String): IOException {
        val parsed = runCatching { StrictJson.parse(if (text.isBlank()) "{}" else text) }.getOrNull()
        val err = parsed?.let { runCatching { StrictJson.str(it, "error") }.getOrNull() }
            .orEmpty().ifEmpty { "HTTP $code" }
        val safe = err.takeIf { it in setOf("approval-expired", "approval-denied", "approval-replay", "approval-required", "trust-mismatch", "bad-request") } ?: "pairing failed"
        return IOException("$safe (HTTP $code)")
    }

    private fun jsonEsc(s: String): String = buildString {
        for (c in s) {
            when (c) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (c.code < 0x20) append("\\u%04x".format(c.code)) else append(c)
            }
        }
    }

    private fun throwOnRedirect(conn: HttpURLConnection) {
        val code = conn.responseCode
        if (code in 300..399) {
            conn.disconnect()
            throw IOException("pairing redirect refused (HTTP $code)")
        }
    }

    private fun readBody(conn: HttpURLConnection, code: Int): String {
        val stream = try {
            if (code >= 400) conn.errorStream else conn.inputStream
        } catch (_: Exception) {
            null
        } ?: return ""
        return readBoundedUtf8(stream)
    }

    /** Bound bytes BEFORE decode, reject invalid UTF-8, never echo a private body. */
    internal fun readBoundedUtf8(stream: java.io.InputStream): String = stream.use {
        val out = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(1024)
        while (true) {
            val n = it.read(chunk, 0, minOf(chunk.size, StrictJson.MAX_BODY_BYTES + 1 - out.size()))
            if (n < 0) break
            out.write(chunk, 0, n)
            if (out.size() > StrictJson.MAX_BODY_BYTES) throw IOException("JSON body exceeds 16KiB bound")
        }
        try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(out.toByteArray())).toString()
        } catch (_: java.nio.charset.CharacterCodingException) {
            throw IOException("JSON body is not valid UTF-8")
        }
    }
}
