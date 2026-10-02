package dev.dsh.watch.net

import org.junit.Assert.*
import org.junit.Test

/** JVM tests for the Settings validation shared by UI and ViewModel. */
class ConnectionSettingsTest {

    private fun pin(): String = "sha256/" + java.util.Base64.getEncoder()
        .encodeToString(ByteArray(32) { it.toByte() })

    @Test fun blankBaseUnpairedAllowed() {
        assertNull(ConnectionSettings.validate("", "", "", false))
    }

    @Test fun blankBaseWithLeftoversRejected() {
        assertNotNull(ConnectionSettings.validate("", "tok", "", false))
        assertNotNull(ConnectionSettings.validate("", "", pin(), false))
    }

    @Test fun httpsRequiresPinAndToken() {
        assertNotNull(ConnectionSettings.validate("https://192.168.1.20:8787", "", pin(), false))
        val missing = ConnectionSettings.validate("https://192.168.1.20:8787", "tok", "", false)
        assertNotNull(missing)
        assertTrue(missing!!.contains("sha256"))
        assertNull(ConnectionSettings.validate("https://192.168.1.20:8787", "tok", pin(), false))
    }

    @Test fun httpsRejectsBadPin() {
        val err = ConnectionSettings.validate("https://192.168.1.20:8787", "tok", "sha256/aGk=", false)
        assertNotNull(err)
        assertTrue(err!!.contains("32 bytes"))
        assertNotNull(ConnectionSettings.validate("https://192.168.1.20:8787", "tok", "not-base64!!!", false))
    }

    @Test fun httpRequiresExplicitToggle() {
        assertNotNull(ConnectionSettings.validate("http://192.168.1.20:8787", "tok", "", false))
        assertNull(ConnectionSettings.validate("http://192.168.1.20:8787", "tok", "", true))
    }

    @Test fun nonHttpSchemeRejected() {
        assertNotNull(ConnectionSettings.validate("ftp://host/x", "tok", "", true))
        assertNotNull(ConnectionSettings.validate("192.168.1.20:8787", "tok", pin(), false))
    }

    @Test fun validatedNormalizesPinToCanonical() {
        val v = ConnectionSettings.validated("https://h:8787", " tok ", pin(), false)
        assertEquals("tok", v.token)
        assertFalse(v.pin.startsWith("sha256/"))
        assertEquals(32, java.util.Base64.getDecoder().decode(v.pin).size)
    }

    @Test fun validatedThrowsOnInvalid() {
        try {
            ConnectionSettings.validated("https://h:8787", "tok", "", false)
            fail("must throw")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test fun unpairedDetection() {
        assertTrue(ConnectionSettings.isUnpairedBase(""))
        assertTrue(ConnectionSettings.isUnpairedBase(null))
        assertTrue(ConnectionSettings.isUnpairedBase("http://192.0.2.1:8787"))
        assertFalse(ConnectionSettings.isUnpairedBase("https://192.168.1.20:8787"))
    }

    @Test fun baseRejectsUserinfoQueryFragmentAndPath() {
        val p = pin()
        assertNotNull(ConnectionSettings.validate("https://user:pass@192.168.1.20:8787", "tok", p, false))
        assertNotNull(ConnectionSettings.validate("https://user@192.168.1.20:8787", "tok", p, false))
        assertNotNull(ConnectionSettings.validate("https://192.168.1.20:8787?x=1", "tok", p, false))
        assertNotNull(ConnectionSettings.validate("https://192.168.1.20:8787#frag", "tok", p, false))
        assertNotNull(ConnectionSettings.validate("https://192.168.1.20:8787/evil", "tok", p, false))
        assertNotNull(ConnectionSettings.validate("https://192.168.1.20:8787/watch/health", "tok", p, false))
        try {
            ConnectionSettings.validated("https://user:pass@h:8787", "tok", p, false)
            fail("userinfo base must be rejected before any I/O")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test fun baseCanonicalizesTrailingSlash() {
        val p = pin()
        assertNull(ConnectionSettings.validate("https://h:8787/", "tok", p, false))
        val v = ConnectionSettings.validated("https://h:8787/", "tok", p, false)
        assertEquals("https://h:8787", v.base)
        assertEquals("https://h:8787", ConnectionSettings.canonicalBase("https://h:8787///"))
        assertEquals("", ConnectionSettings.canonicalBase("   "))
    }
}
