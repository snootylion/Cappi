package dev.dsh.watch.core

import dev.dsh.watch.net.PairingTransport
import dev.dsh.watch.net.SecureTransport

/**
 * Turnkey pairing state machine (W-owned, pure JVM).
 *
 * Authoritative states (schema `pairingState`): unpaired | cert-offered |
 * trust-pending | enrollment-pending | enrolled | failed-closed.
 *
 * Rules enforced here (transport-agnostic so unit tests need no sockets):
 * - Discovery yields candidates only — no secret before trust.
 * - Fingerprint Confirm precedes secret generation AND enroll (ordering).
 * - The confirmed `{ baseUrl, certSha256Pin }` record is IMMUTABLE: later
 *   display edits cannot retarget the pinned origin; rotation is fail-closed.
 * - Atomic persist ONLY on approved responses whose pin matches the confirmed
 *   record AND the live handshake pin; otherwise discard.
 * - Poll backoff is finite and bounded by the server TTL (max 120 s).
 */
object PairingCenter {

    enum class PairingState {
        UNPAIRED, CERT_OFFERED, TRUST_PENDING, ENROLLMENT_PENDING, ENROLLED, FAILED_CLOSED,
    }

    fun schemaName(state: PairingState): String = when (state) {
        PairingState.UNPAIRED -> "unpaired"
        PairingState.CERT_OFFERED -> "cert-offered"
        PairingState.TRUST_PENDING -> "trust-pending"
        PairingState.ENROLLMENT_PENDING -> "enrollment-pending"
        PairingState.ENROLLED -> "enrolled"
        PairingState.FAILED_CLOSED -> "failed-closed"
    }

    data class ImmutableRecord(val baseUrl: String, val certSha256Pin: String)

    data class ApprovedPersist(
        val baseUrl: String,
        val certSha256Pin: String,
        val deviceId: String,
        val token: String,
    )

    private val REQUEST_RE = Regex("^[A-Za-z0-9_-]{22,128}$")

    fun isRequestIdShape(s: String): Boolean = REQUEST_RE.matches(s)

    fun validateAlias(alias: String): String? {
        val t = alias.trim()
        if (t.isEmpty()) return "Name this watch (e.g. Watch4)"
        if (t.length > 64) return "Name must be ≤ 64 characters"
        return null
    }

    /**
     * Immutable capture on explicit Watch Confirm. Throws when the fingerprint
     * was not compared (both full + short required from the handshake cert).
     */
    fun confirmRecord(
        baseUrl: String,
        pin: String,
        fullFingerprint: String,
        shortFingerprint: String,
        userConfirmed: Boolean,
    ): ImmutableRecord {
        if (!userConfirmed) throw IllegalArgumentException("compare the fingerprint, then Confirm")
        val b = baseUrl.trim().trimEnd('/')
        if (b.isEmpty()) throw IllegalArgumentException("bridge address is empty")
        if (!b.startsWith("https://", ignoreCase = true)) {
            throw IllegalArgumentException("pairing requires https:// (no insecure auto-downgrade)")
        }
        val normalized = try {
            SecureTransport.normalizePin(pin)
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("certificate pin: ${e.message}")
        }
        if (normalized.isEmpty()) throw IllegalArgumentException("certificate pin is required")
        if (fullFingerprint.isBlank() || shortFingerprint.isBlank()) {
            throw IllegalArgumentException("fingerprint missing — rescan before confirming")
        }
        return ImmutableRecord(b, "sha256/$normalized".replace("sha256/sha256/", "sha256/"))
    }

    /**
     * Enroll ordering gate: secret generation + POST /pair/enroll are allowed
     * ONLY after [confirmRecord]. Returns the fresh single-use secret.
     */
    fun newEnrollmentSecret(confirmed: ImmutableRecord?): String {
        if (confirmed == null) throw IllegalStateException("confirm the fingerprint before enrolling")
        return PairingTransport.newSecret()
    }

    /** Finite poll delays bounded by TTL: 1s, 2s, then 5s steps until expiresAtMs. */
    fun pollDelays(
        nowMs: Long,
        expiresAtMs: Long,
        maxSteps: Int = 40,
    ): List<Long> {
        val out = ArrayList<Long>()
        var t = nowMs
        var step = 1000L
        repeat(maxSteps) {
            if (t >= expiresAtMs) return out
            val wait = minOf(step, expiresAtMs - t)
            if (wait <= 0) return out
            out.add(wait)
            t += wait
            step = when {
                step < 2000L -> 2000L
                else -> 5000L
            }
        }
        return out
    }

    /**
     * Atomic persist gate for `pollApproved`. Returns the persist row ONLY when
     * the approved pin matches BOTH the confirmed record AND the live
     * handshake pin; otherwise null (caller discards, shows rotation error).
     *
     * IMPORTANT: pass the per-round `fetchPairInfo` LIVE pin as
     * [handshakePin] — never `approved.certSha256Pin` itself (that would be a
     * vacuous self-compare). Use [approvedPersistIfFresh] when the server TTL
     * is known so a late approved arriving after expiry never persists.
     */
    fun approvedPersist(
        record: ImmutableRecord?,
        handshakePin: String,
        approved: PairingTransport.PollResult.Approved,
    ): ApprovedPersist? {
        if (record == null) return null
        if (!SecureTransport.pinMatches(approved.certSha256Pin, record.certSha256Pin)) return null
        if (!SecureTransport.pinMatches(handshakePin, record.certSha256Pin)) return null
        val base = (approved.baseUrl ?: record.baseUrl).trim().trimEnd('/')
        if (!base.equals(record.baseUrl, ignoreCase = false)) return null
        if (approved.deviceId.isBlank() || approved.deviceId.length > 64) return null
        if (approved.token.length < 22 || approved.token.length > 256) return null
        return ApprovedPersist(base, record.certSha256Pin, approved.deviceId, approved.token)
    }

    /**
     * TTL-guarded variant: a late `approved` arriving at/after [expiresAtMs]
     * returns null even when pins match (expired approvals must not persist).
     * The persisted row still uses the immutable confirmed base + pin only.
     */
    fun approvedPersistIfFresh(
        record: ImmutableRecord?,
        handshakePin: String,
        approved: PairingTransport.PollResult.Approved,
        expiresAtMs: Long,
        nowMs: Long = System.currentTimeMillis(),
    ): ApprovedPersist? {
        if (nowMs >= expiresAtMs) return null
        return approvedPersist(record, handshakePin, approved)
    }

    /** Cert rotation is fail-closed: stored pin != handshake pin → re-pair. */
    fun rotationDetected(storedPin: String, handshakePin: String): Boolean {
        if (storedPin.isBlank() || handshakePin.isBlank()) return false
        return !SecureTransport.pinMatches(storedPin, handshakePin)
    }

    /** Attempt-counter lockout text (client-side courtesy; server enforces). */
    fun attemptsText(failures: Int): String? = when {
        failures < 3 -> null
        failures < 5 -> "Several failed attempts — check the address, then retry"
        else -> "Too many attempts — wait a minute, then start pairing again"
    }

    fun pollTerminalMessage(error: String): String = when (error) {
        "approval-expired" -> "Approval expired — start pairing again"
        "approval-denied" -> "Mac denied this device — pairing stopped"
        "approval-replay" -> "Request already used — start pairing again"
        else -> error
    }
}
