package dev.dsh.watch.core

import org.junit.Assert.*
import org.junit.Test

/**
 * W-owned pairing state-machine guards (pure JVM, no sockets, no secrets).
 * Covers: confirm-before-secret ordering, immutable record, approved persist
 * matching, cert-rotation fail-closed (no auto-TOFU), finite poll backoff,
 * replay/expiry terminal messages.
 */
class PairingCenterTest {

    private fun record() = PairingCenter.ImmutableRecord(
        baseUrl = "https://192.168.1.20:8443",
        certSha256Pin = "sha256/" + java.util.Base64.getEncoder().encodeToString(ByteArray(32) { 7 }),
    )

    private fun approved(pin: String) = dev.dsh.watch.net.PairingTransport.PollResult.Approved(
        deviceId = "device-1",
        token = "t".repeat(32),
        baseUrl = "https://192.168.1.20:8443",
        certSha256Pin = pin,
    )

    @Test fun schemaNamesMatchContract() {
        assertEquals("unpaired", PairingCenter.schemaName(PairingCenter.PairingState.UNPAIRED))
        assertEquals("cert-offered", PairingCenter.schemaName(PairingCenter.PairingState.CERT_OFFERED))
        assertEquals("trust-pending", PairingCenter.schemaName(PairingCenter.PairingState.TRUST_PENDING))
        assertEquals("enrollment-pending", PairingCenter.schemaName(PairingCenter.PairingState.ENROLLMENT_PENDING))
        assertEquals("enrolled", PairingCenter.schemaName(PairingCenter.PairingState.ENROLLED))
        assertEquals("failed-closed", PairingCenter.schemaName(PairingCenter.PairingState.FAILED_CLOSED))
    }

    @Test fun secretBeforeConfirmIsRefused() {
        try {
            PairingCenter.newEnrollmentSecret(null)
            fail("secret before confirm must throw")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("confirm", ignoreCase = true))
        }
    }

    @Test fun confirmRequiresHttpsPinAndFingerprints() {
        val pin = record().certSha256Pin
        // http is refused: no insecure auto-downgrade for turnkey pair.
        try {
            PairingCenter.confirmRecord("http://192.168.1.20:8443", pin, "aa:bb", "aabb", true)
            fail("http must be refused")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("https", ignoreCase = true))
        }
        // No confirm without explicit user confirmation.
        try {
            PairingCenter.confirmRecord("https://192.168.1.20:8443", pin, "full", "short", false)
            fail("unconfirmed must throw")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("Confirm", ignoreCase = true))
        }
        // Missing fingerprint display.
        try {
            PairingCenter.confirmRecord("https://192.168.1.20:8443", pin, "", "", true)
            fail("missing fingerprint must throw")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("fingerprint", ignoreCase = true))
        }
        val rec = PairingCenter.confirmRecord(
            "https://192.168.1.20:8443/", pin, "full-fp", "short-fp", true)
        assertEquals("https://192.168.1.20:8443", rec.baseUrl)
        val secret = PairingCenter.newEnrollmentSecret(rec)
        assertTrue(dev.dsh.watch.net.PairingTransport.isSecretShape(secret))
    }

    @Test fun aliasValidation() {
        assertNotNull(PairingCenter.validateAlias(""))
        assertNotNull(PairingCenter.validateAlias("x".repeat(65)))
        assertNull(PairingCenter.validateAlias("Watch4"))
    }

    @Test fun approvedPersistRequiresPinMatch() {
        val rec = record()
        val ok = PairingCenter.approvedPersist(rec, rec.certSha256Pin, approved(rec.certSha256Pin))
        assertNotNull(ok)
        assertEquals(rec.baseUrl, ok!!.baseUrl)
        // Rotated pin in the approved body → discard (no auto-TOFU).
        val other = "sha256/" + java.util.Base64.getEncoder().encodeToString(ByteArray(32) { 9 })
        assertNull(PairingCenter.approvedPersist(rec, rec.certSha256Pin, approved(other)))
        // Live handshake differs from the confirmed record → discard.
        assertNull(PairingCenter.approvedPersist(rec, other, approved(rec.certSha256Pin)))
        // Retargeted base echo → discard (immutable record).
        val moved = approved(rec.certSha256Pin).copy(baseUrl = "https://192.168.1.99:8443")
        assertNull(PairingCenter.approvedPersist(rec, rec.certSha256Pin, moved))
        // No record → no persist.
        assertNull(PairingCenter.approvedPersist(null, rec.certSha256Pin, approved(rec.certSha256Pin)))
    }

    @Test fun rotationIsFailClosed() {
        val pin = record().certSha256Pin
        assertFalse(PairingCenter.rotationDetected(pin, pin))
        val other = "sha256/" + java.util.Base64.getEncoder().encodeToString(ByteArray(32) { 3 })
        assertTrue(PairingCenter.rotationDetected(pin, other))
        assertFalse(PairingCenter.rotationDetected("", other))
    }

    @Test fun pollBackoffIsFiniteAndBoundedByTtl() {
        val now = 1_000_000L
        val delays = PairingCenter.pollDelays(now, now + 120_000)
        assertTrue(delays.isNotEmpty())
        assertTrue(delays.size <= 40)
        assertEquals(120_000L, delays.sum())
        assertEquals(listOf(1000L, 2000L, 5000L), delays.take(3))
        assertTrue(PairingCenter.pollDelays(now, now).isEmpty())
    }

    @Test fun terminalMessagesAreActionable() {
        assertTrue(PairingCenter.pollTerminalMessage("approval-expired").contains("expired", ignoreCase = true))
        assertTrue(PairingCenter.pollTerminalMessage("approval-denied").contains("denied", ignoreCase = true))
        assertTrue(PairingCenter.pollTerminalMessage("approval-replay").contains("used", ignoreCase = true))
    }

    @Test fun expiredApprovedNeverPersistsEvenWithPinMatch() {
        val rec = record()
        val ok = PairingCenter.approvedPersistIfFresh(
            rec, rec.certSha256Pin, approved(rec.certSha256Pin),
            expiresAtMs = 2000L, nowMs = 1000L)
        assertNotNull(ok)
        // Same pins, but late (now >= expiry) → discard.
        assertNull(PairingCenter.approvedPersistIfFresh(
            rec, rec.certSha256Pin, approved(rec.certSha256Pin),
            expiresAtMs = 2000L, nowMs = 2000L))
        assertNull(PairingCenter.approvedPersistIfFresh(
            rec, rec.certSha256Pin, approved(rec.certSha256Pin),
            expiresAtMs = 1000L, nowMs = 9000L))
    }

    @Test fun requestIdShapeMatchesSchema() {
        assertTrue(PairingCenter.isRequestIdShape("a".repeat(22)))
        assertFalse(PairingCenter.isRequestIdShape("short"))
        assertFalse(PairingCenter.isRequestIdShape("has space in it 1234567890"))
    }
}
