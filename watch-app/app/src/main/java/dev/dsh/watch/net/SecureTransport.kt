package dev.dsh.watch.net

import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Trusted connection factory for the bridge. Every watch request — commands,
 * SSE, state, images and the [VoiceService][dev.dsh.watch.service.VoiceService]
 * mic uplink — opens through here so the same guarantees hold everywhere:
 *
 * - The bridge certificate's SHA-256 pin is verified BEFORE any token, audio
 *   or data is sent. The pin is the stable bridge identity: it survives
 *   DHCP/IP changes while a bare IP address does not.
 * - The token travels only in the `X-Bridge-Token` header, never in the URL.
 * - Redirects are never followed (a 3xx is surfaced as an error instead), so
 *   the token cannot leak into a redirect target.
 * - Cleartext `http://` is refused unless [EndpointSecurity.allowInsecureLan]
 *   is explicitly set — a visible legacy opt-in, never a silent downgrade.
 * - `https://` without a pinned certificate is refused (fail-closed). There is
 *   no silent fallback to system PKI: a pinned bridge uses a private local CA,
 *   so system trust would authenticate the wrong parties. Pairing is an
 *   explicit human step (see [normalizePin]).
 *
 * First pairing is a human step: the bridge prints its `sha256/<base64>` pin
 * at startup (from `bridge/setup-cert.sh --fingerprint`) and the user enters
 * it in Settings alongside the base URL and token. The display format and the
 * accepted input are the same string: an optional `sha256/` prefix followed by
 * base64 of exactly 32 bytes.
 */
object SecureTransport {

    const val TOKEN_HEADER = "X-Bridge-Token"

    /** Prefix printed by `setup-cert.sh` and accepted on input. */
    const val PIN_PREFIX = "sha256/"

    /**
     * Endpoint security for one bridge. [certPinSha256] is the canonical
     * base64 SHA-256 of the bridge certificate (DER), stored WITHOUT the
     * `sha256/` prefix; blank means unpaired. [allowInsecureLan] permits
     * cleartext LAN legacy mode only — explicit opt-in, not default.
     */
    data class EndpointSecurity(
        val certPinSha256: String = "",
        val allowInsecureLan: Boolean = false,
    ) {
        fun isPaired(): Boolean = certPinSha256.isNotBlank() || allowInsecureLan
    }

    /**
     * Normalize user-entered pin text to canonical storage form (base64 of 32
     * bytes, no prefix). Accepts the exact string the bridge prints
     * (`sha256/<base64>`) as well as bare base64. Blank input returns blank
     * (unpaired). Throws [IllegalArgumentException] on any non-blank input
     * that does not decode to exactly 32 bytes.
     */
    fun normalizePin(input: String): String {
        val t = input.trim()
        if (t.isEmpty()) return ""
        val b64 = if (t.startsWith(PIN_PREFIX, ignoreCase = true)) {
            t.substring(PIN_PREFIX.length).trim()
        } else {
            t
        }
        if (b64.isEmpty()) throw IllegalArgumentException("certificate pin is empty")
        val bytes = try {
            java.util.Base64.getDecoder().decode(b64)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("certificate pin is not valid base64")
        }
        if (bytes.size != 32) {
            throw IllegalArgumentException(
                "certificate pin must decode to 32 bytes (SHA-256), got ${bytes.size}",
            )
        }
        return java.util.Base64.getEncoder().encodeToString(bytes)
    }

    /** Display form of a stored pin: `sha256/<base64>`, or "" when unpaired. */
    fun displayPin(canonical: String): String {
        val t = canonical.trim()
        if (t.isEmpty()) return ""
        return PIN_PREFIX + t
    }

    /** Null when [normalizePin] would accept the input, else a display-ready reason. */
    fun pinError(input: String): String? {
        if (input.trim().isEmpty()) return null
        return try {
            normalizePin(input)
            null
        } catch (e: IllegalArgumentException) {
            e.message
        }
    }

    /** Trust manager that accepts exactly the pinned certificate. */
    private fun pinningTrustManager(canonicalPin: String): X509TrustManager {
        val defaultFactory = javax.net.ssl.TrustManagerFactory.getInstance(
            javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm(),
        )
        defaultFactory.init(null as java.security.KeyStore?)
        val systemDefault = defaultFactory.trustManagers
            .filterIsInstance<X509TrustManager>().firstOrNull()
        return object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> =
                systemDefault?.acceptedIssuers ?: emptyArray()

            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
                systemDefault?.checkClientTrusted(chain, authType)
                    ?: throw java.security.cert.CertificateException("no system trust manager")
            }

            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (chain.isEmpty()) throw java.security.cert.CertificateException("empty chain")
                val presented = sha256Pin(chain[0])
                if (!pinMatches(presented, canonicalPin)) {
                    throw java.security.cert.CertificateException(
                        "bridge certificate pin mismatch (unpaired or rotated cert — re-enter the sha256/ pin from setup-cert.sh --fingerprint)",
                    )
                }
            }
        }
    }

    /** SHA-256 pin (base64, no prefix) of one certificate's DER encoding. */
    fun sha256Pin(cert: X509Certificate): String =
        MessageDigest.getInstance("SHA-256").digest(cert.encoded)
            .let { java.util.Base64.getEncoder().encodeToString(it) }

    /**
     * Constant-time pin comparison. Both sides may carry the optional
     * `sha256/` prefix; surrounding whitespace is ignored. Either side blank
     * never matches.
     */
    fun pinMatches(presented: String, expected: String): Boolean {
        val a: ByteArray
        val b: ByteArray
        try {
            a = decodePinBytes(presented) ?: return false
            b = decodePinBytes(expected) ?: return false
        } catch (_: IllegalArgumentException) {
            return false
        }
        if (a.size != b.size || a.size != 32) return false
        return MessageDigest.isEqual(a, b)
    }

    private fun decodePinBytes(s: String): ByteArray? {
        val t = s.trim()
        if (t.isEmpty()) return null
        val b64 = if (t.startsWith(PIN_PREFIX, ignoreCase = true)) {
            t.substring(PIN_PREFIX.length).trim()
        } else {
            t
        }
        if (b64.isEmpty()) return null
        return java.util.Base64.getDecoder().decode(b64)
    }

    /**
     * Validate a fully-built bridge URL before any I/O. Rejects userinfo,
     * fragments, and query strings on paths that must not carry them, so a
     * poisoned base or caller bug fails before a socket opens. Only these
     * watch paths may carry a query, with exactly these keys:
     * - /watch/image?ref=
     * - /watch/pair-probe?nonce=
     * - /watch/mic with optional ?answerRequestId= and/or ?streamId=
     *   (streamId is a non-secret correlator for the turnkey preflight;
     *   auth is always the header token + pinned TLS, never the query).
     * All other watch paths must carry no query. Turnkey pairing paths
     * (/pair/info, /pair/enroll, /pair/poll — exact match, no query, no
     * subpaths) are the ONLY non-/watch/ paths permitted, and only for the
     * pairing handshake (cert-only info, pinned enroll/poll with secrets in
     * the JSON body, never the URL). Paths outside /watch/ + the pair
     * allowlist are rejected (a base with an embedded path would land here).
     */
    private fun validateFullUrl(fullUrl: String): URL {
        val url = try {
            URL(fullUrl)
        } catch (e: Exception) {
            throw java.io.IOException("bridge URL is malformed: ${e.message}")
        }
        if (!url.userInfo.isNullOrEmpty()) {
            throw java.io.IOException("bridge URL must not contain userinfo")
        }
        if (url.ref != null) {
            throw java.io.IOException("bridge URL must not contain a fragment")
        }
        val path = url.path.orEmpty()
        // Turnkey pairing allowlist: exact paths only, never with a query.
        // GET /pair/info is cert-only over provisional TLS; POST
        // /pair/enroll|/pair/poll carry secrets in the JSON body over pinned
        // TLS (never ?token=/?secret= — refused here and 401 server-side).
        if (path == "/pair/info" || path == "/pair/enroll" || path == "/pair/poll") {
            if (!url.query.isNullOrEmpty()) {
                throw java.io.IOException("bridge URL path '$path' must not carry a query")
            }
            return url
        }
        if (!path.startsWith("/watch/")) {
            throw java.io.IOException("bridge URL path must be /watch/* or a /pair/* pairing path (got '$path')")
        }
        val query = url.query
        if (!query.isNullOrEmpty()) {
            val keys = query.split('&').map { it.substringBefore('=').trim() }
            val allowed: Set<String>? = when (path) {
                "/watch/image" -> setOf("ref")
                "/watch/pair-probe" -> setOf("nonce")
                "/watch/mic" -> setOf("answerRequestId", "streamId")
                else -> null
            }
            if (allowed == null) {
                throw java.io.IOException("bridge URL path '$path' must not carry a query")
            }
            for (k in keys) {
                if (k !in allowed) {
                    throw java.io.IOException("bridge URL path '$path' has unexpected query param '$k'")
                }
            }
        }
        return url
    }

    /**
     * Open a connection to [fullUrl] WITHOUT sending anything sensitive yet.
     * For `https://`, the pin in [security] is enforced during the TLS
     * handshake (before headers flush); an https URL with a blank pin is
     * refused fail-closed so an unpaired watch can never silently trust
     * system PKI for a private bridge. For `http://`, an explicit
     * [EndpointSecurity.allowInsecureLan] is required. Redirects are disabled.
     * The caller sets [TOKEN_HEADER] via [setTokenHeader] after opening.
     */
    fun open(fullUrl: String, security: EndpointSecurity): HttpURLConnection {
        val url = validateFullUrl(fullUrl)
        val scheme = url.protocol.lowercase()
        if (scheme != "http" && scheme != "https") {
            throw java.io.IOException("bridge URL must be http(s)://")
        }
        if (scheme == "http" && !security.allowInsecureLan) {
            throw java.io.IOException(
                "refusing cleartext bridge URL without explicit insecure-LAN opt-in",
            )
        }
        val conn = url.openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = false
        if (conn is HttpsURLConnection) {
            val canonical = try {
                normalizePin(security.certPinSha256)
            } catch (e: IllegalArgumentException) {
                throw java.io.IOException("stored certificate pin is invalid: ${e.message}")
            }
            if (canonical.isEmpty()) {
                conn.disconnect()
                throw java.io.IOException(
                    "refusing https bridge without a pinned certificate (enter the sha256/ pin in Settings)",
                )
            }
            val context = SSLContext.getInstance("TLS")
            context.init(null, arrayOf<TrustManager>(pinningTrustManager(canonical)), null)
            conn.sslSocketFactory = context.socketFactory
            // Hostname checks are subsumed by pinning: the pin authenticates the
            // exact bridge certificate (stable across DHCP changes), while a
            // LAN IP/DNS name is not a stable identity and cannot appear in a
            // long-lived local cert. Accept the hostname only in pinned mode.
            conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        }
        return conn
    }

    /** Attach the token header. The token is never placed in the URL. */
    fun setTokenHeader(conn: HttpURLConnection, token: String) {
        conn.setRequestProperty(TOKEN_HEADER, token)
    }

    /**
     * Fail when the response is a redirect (3xx). The bridge never redirects;
     * a 3xx means a captive portal or relay is in the path — never follow it
     * with the token attached.
     */
    fun throwOnRedirect(conn: HttpURLConnection) {
        val code = conn.responseCode
        if (code in 300..399) {
            conn.disconnect()
            throw java.io.IOException("bridge redirect refused (HTTP $code)")
        }
    }
}
