package dev.dsh.watch.core

import org.junit.Assert.*
import org.junit.Test

/**
 * set-permission carries the captured session for the bridge 409 binding
 * check. Assertions run against the pure JSON body builder (no Android
 * org.json stub in unit tests); the JSONObject wrapper delegates to it
 * without changing keys.
 */
class SessionCenterTest {

    @Test fun setPermissionIncludesCapturedSessionId() {
        val body = SessionCenter.setPermissionJson("workspace-write", "sess-123")
        assertTrue(body.contains("\"cmd\":\"set-permission\""))
        assertTrue(body.contains("\"preset\":\"workspace-write\""))
        assertTrue(body.contains("\"sessionId\":\"sess-123\""))
    }

    @Test fun setPermissionOmitsBlankSessionId() {
        val blank = SessionCenter.setPermissionJson("read-only", "")
        assertTrue(blank.contains("\"preset\":\"read-only\""))
        assertFalse("blank session must be omitted (bridge 400s missing)", blank.contains("sessionId"))
        val legacy = SessionCenter.setPermissionJson("read-only")
        assertFalse(legacy.contains("sessionId"))
    }
}
