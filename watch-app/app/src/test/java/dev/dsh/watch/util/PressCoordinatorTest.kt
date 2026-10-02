package dev.dsh.watch.util

import org.junit.Assert.*
import org.junit.Test

class PressCoordinatorTest {
    private var now = 1_000_000L
    private fun coordinator() = PressCoordinator(clock = { now })

    @Test fun singlePressSteersAfterWindow() {
        val c = coordinator()
        assertTrue(c.press("s1", "q1", true).isEmpty())
        assertNotNull(c.flushDueAtMs)
        now += 600
        assertEquals(listOf(PressCoordinator.Outcome.SteerQueue("q1")), c.flush("s1", "q1", true))
        assertNull(c.flushDueAtMs)
    }

    @Test fun doublePressTogglesAndConsumesBoth() {
        val c = coordinator()
        assertTrue(c.press("s1", "q1", true).isEmpty())
        now += 200
        assertEquals(listOf(PressCoordinator.Outcome.ToggleCompanion), c.press("s1", "q1", true))
        // Consumed: nothing left to flush.
        now += 600
        assertTrue(c.flush("s1", "q1", true).isEmpty())
    }

    @Test fun trailingThirdPressIsSwallowedByCooldown() {
        val c = coordinator()
        c.press("s1", "q1", true)
        now += 200
        c.press("s1", "q1", true) // DOUBLE, cooldown until now+600
        now += 100
        assertTrue(c.press("s1", "q1", true).isEmpty())
        now += 600
        assertTrue(c.flush("s1", "q1", true).isEmpty())
    }

    @Test fun staleSessionNeverSends() {
        val c = coordinator()
        c.press("s1", "q1", true)
        now += 600
        // Session rotated mid-gesture: the captured target no longer matches.
        assertTrue(c.flush("s2", "q1", true).isEmpty())
        // Oldest queue item changed: also dropped.
        val c2 = coordinator()
        c2.press("s1", "q1", true)
        now += 600
        assertTrue(c2.flush("s1", "q2", true).isEmpty())
    }

    @Test fun disconnectedPressNeverSends() {
        val c = coordinator()
        c.press("s1", "q1", false)
        now += 600
        assertTrue(c.flush("s1", "q1", false).isEmpty())
    }

    @Test fun postSendSuppressionWindow() {
        val c = coordinator()
        c.press("s1", "q1", true)
        now += 600 // send at T0; suppression runs to T0+700 (boundary inclusive, as before).
        assertEquals(1, c.flush("s1", "q1", true).size)
        // A gesture whose SINGLE falls due strictly inside the suppression
        // window sends nothing (press at T0+50 → due at T0+650 < T0+700).
        now += 50
        c.press("s1", "q1", true)
        now += 600
        assertTrue(c.flush("s1", "q1", true).isEmpty())
        // After the window, sending works again.
        now += 700
        c.press("s1", "q1", true)
        now += 600
        assertEquals(listOf(PressCoordinator.Outcome.SteerQueue("q1")), c.flush("s1", "q1", true))
    }

    @Test fun cancelClearsPendingGesture() {
        val c = coordinator()
        c.press("s1", "q1", true)
        assertTrue(c.hasPending)
        c.cancel()
        assertFalse(c.hasPending)
        now += 600
        assertTrue(c.flush("s1", "q1", true).isEmpty())
    }

    @Test fun nothingQueuedSendsNothing() {
        val c = coordinator()
        c.press("s1", null, true)
        now += 600
        assertTrue(c.flush("s1", null, true).isEmpty())
    }
}
