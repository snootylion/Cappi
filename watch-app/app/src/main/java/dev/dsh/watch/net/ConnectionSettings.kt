package dev.dsh.watch.net

/**
 * Connection-settings validation shared by the Settings UI (inline errors)
 * and the ViewModel (validate-before-save). Pure JVM, no Android imports, so
 * unit tests exercise the same rules the watch enforces.
 *
 * Rules:
 * - Blank base = unpaired (allowed: the watch stays idle and shows setup).
 * - Non-blank base must be exactly scheme://host[:port] with no path (other
 *   than a single trailing slash, which is stripped to the canonical form),
 *   no query, no fragment, and no userinfo. https requires a valid pin
 *   unless the explicit insecure-LAN toggle is on AND the scheme is http.
 * - An https base with a blank pin is a trust error, not a silent retry.
 * - Token may be blank only while unpaired; a paired base needs a token.
 * - Canonical storage form has no trailing slash (e.g. https://host:8787).
 */
object ConnectionSettings {

    data class Validated(
        val base: String,
        val token: String,
        val pin: String,
        val allowInsecureLan: Boolean,
    )

    /** Null when the combination may be saved, else a display-ready reason. */
    fun validate(base: String, token: String, pinInput: String, allowInsecureLan: Boolean): String? {
        val b = base.trim()
        val t = token.trim()
        if (b.isEmpty()) {
            if (t.isNotEmpty() || pinInput.trim().isNotEmpty()) {
                return "Enter the bridge address, or clear token + pin to stay unpaired"
            }
            return null
        }
        val parsed = try {
            java.net.URI(b)
        } catch (_: Exception) {
            return "Base must start with https:// (or http:// with insecure-LAN on)"
        }
        val scheme = (parsed.scheme ?: "").lowercase()
        if (scheme != "http" && scheme != "https") {
            return "Base must start with https:// (or http:// with insecure-LAN on)"
        }
        if (!parsed.userInfo.isNullOrEmpty()) {
            return "Base must not contain userinfo (user:pass@)"
        }
        if (!parsed.rawQuery.isNullOrEmpty()) {
            return "Base must not contain a query string"
        }
        if (!parsed.rawFragment.isNullOrEmpty()) {
            return "Base must not contain a fragment"
        }
        val host = parsed.host
        if (host.isNullOrBlank()) return "Base needs a host (e.g. https://192.168.1.20:8787)"
        val path = parsed.rawPath.orEmpty()
        if (path.isNotEmpty() && path != "/") {
            return "Base must be scheme://host[:port] with no path"
        }
        val port = parsed.port
        if (port != -1 && (port < 1 || port > 65535)) {
            return "Base port must be 1-65535"
        }
        if (t.isEmpty()) return "Token is required once a bridge address is set"
        if (scheme == "http" && !allowInsecureLan) {
            return "http:// needs the explicit insecure-LAN toggle (or use https://)"
        }
        if (scheme == "https") {
            val err = SecureTransport.pinError(pinInput)
            if (err != null) return "Certificate pin: $err"
            if (pinInput.trim().isEmpty()) {
                return "https:// needs the sha256/ certificate pin from setup-cert.sh"
            }
        } else {
            val err = SecureTransport.pinError(pinInput)
            if (err != null) return "Certificate pin: $err"
        }
        return null
    }

    /** Normalize + trim for storage. Throws [IllegalArgumentException] when invalid. */
    fun validated(base: String, token: String, pinInput: String, allowInsecureLan: Boolean): Validated {
        val err = validate(base, token, pinInput, allowInsecureLan)
        if (err != null) throw IllegalArgumentException(err)
        return Validated(
            base = canonicalBase(base),
            token = token.trim(),
            pin = SecureTransport.normalizePin(pinInput),
            allowInsecureLan = allowInsecureLan,
        )
    }

    /**
     * Canonical storage form: trimmed, scheme lowercased, no trailing slash.
     * Only call on a base that [validate] accepts (blank stays blank).
     */
    fun canonicalBase(base: String): String {
        val b = base.trim()
        if (b.isEmpty()) return ""
        val parsed = java.net.URI(b)
        val scheme = (parsed.scheme ?: "").lowercase()
        val host = parsed.host ?: b.substringAfter("://").substringBefore("/").substringBefore("?").substringBefore("#")
        val port = parsed.port
        val authority = if (port != -1) "$host:$port" else host
        return "$scheme://$authority"
    }

    /** True when the stored base is a documentation placeholder or blank (unpaired). */
    fun isUnpairedBase(base: String?): Boolean {
        if (base.isNullOrBlank()) return true
        val host = base.trim().substringAfter("://").substringBefore(":").substringBefore("/")
        return host.equals("192.0.2.1", ignoreCase = true)
    }
}
