package dev.dsh.watch.cappi

import org.junit.Assert.*
import org.junit.Test

class LowerPressTargetTest {
    @Test fun sendsOnlyCapturedOldestInOriginalSession() {
        val target = LowerPressTarget("session-a", "queue-1")
        assertEquals("queue-1", target.sendId("session-a", "queue-1", true))
        assertNull(target.sendId("session-b", "queue-1", true))
        assertNull(target.sendId("session-a", "queue-2", true))
        assertNull(target.sendId("session-a", "queue-1", false))
        assertNull(target.sendId("session-a", null, true))
    }
    @Test fun emptyQueueCannotSendLaterArrival() {
        assertNull(LowerPressTarget("session-a", null).sendId("session-a", "new", true))
    }
}
