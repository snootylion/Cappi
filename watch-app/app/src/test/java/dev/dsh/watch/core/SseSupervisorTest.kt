package dev.dsh.watch.core

import org.junit.Assert.*
import org.junit.Test

/** JVM tests for the extracted SSE-supervisor policy (same numbers the ViewModel enforces). */
class SseSupervisorTest {

    @Test fun backoffProgressesToCap() {
        assertEquals(1000L, SseSupervisor.INITIAL_BACKOFF_MS)
        assertEquals(2000L, SseSupervisor.nextBackoff(1000L))
        assertEquals(4000L, SseSupervisor.nextBackoff(2000L))
        assertEquals(5000L, SseSupervisor.nextBackoff(4000L))
        assertEquals(5000L, SseSupervisor.nextBackoff(5000L))
        assertEquals(5000L, SseSupervisor.MAX_BACKOFF_MS)
    }

    @Test fun deadlineArithmetic() {
        assertEquals(5 * 60_000L, SseSupervisor.CONNECTION_DEADLINE_MS)
        assertEquals(5 * 60_000L, SseSupervisor.deadlineRemaining(1000L, 1000L))
        assertEquals(0L, SseSupervisor.deadlineRemaining(1000L + 5 * 60_000L + 1, 1000L))
        assertEquals(60_000L, SseSupervisor.deadlineRemaining(1000L + 4 * 60_000L, 1000L))
        // Clock skew (now before start) never goes negative.
        assertEquals(5 * 60_000L, SseSupervisor.deadlineRemaining(500L, 1000L))
    }

    @Test fun discoveryAdoption() {
        assertFalse(SseSupervisor.shouldAdoptDiscovery(null, "https://a:8787"))
        assertFalse(SseSupervisor.shouldAdoptDiscovery("https://a:8787", "https://a:8787"))
        assertTrue(SseSupervisor.shouldAdoptDiscovery("https://b:8787", "https://a:8787"))
    }
}
