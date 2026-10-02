package dev.dsh.watch.cappi

import org.junit.Assert.*
import org.junit.Test

class LowerPressGateTest {
    @Test fun defaultAcceptsObservedDeviceIntereventGaps() {
        for (gap in listOf(465L, 469L, 516L, 599L)) {
            val gate = LowerPressGate()
            assertTrue(gate.press(1000).isEmpty())
            assertEquals(listOf(PressAction.DOUBLE), gate.press(1000 + gap))
            assertTrue(gate.flush(2000).isEmpty())
        }
    }

    @Test fun defaultSingleWaits600Milliseconds() {
        val gate = LowerPressGate()
        gate.press(1000)
        assertEquals(1600L, gate.deadlineMs)
        assertTrue(gate.flush(1599).isEmpty())
        assertEquals(listOf(PressAction.SINGLE), gate.flush(1600))
    }

    @Test fun observedHomeStreamProducesDoubleWithoutLeakingItsSingle() {
        val gate = LowerPressGate()
        val actions = mutableListOf<PressAction>()
        for (t in listOf(9229L, 9921L, 10437L, 10906L, 11371L)) {
            actions += gate.flush(t)
            actions += gate.press(t)
        }
        // First isolated press times out; 9921+10437 form a double; 10906
        // is swallowed by cooldown. 11371 begins a new independent gesture.
        assertEquals(listOf(PressAction.SINGLE, PressAction.DOUBLE), actions)
        assertEquals(listOf(PressAction.SINGLE), gate.flush(11971))
    }

    @Test fun defaultExactBoundaryIsNotADoubleAndRealBackgroundCancels() {
        val gate = LowerPressGate()
        gate.press(1000)
        assertEquals(listOf(PressAction.SINGLE), gate.press(1600))
        gate.cancel() // onStop/window-focus loss, not transient onPause
        assertTrue(gate.flush(2200).isEmpty())
        assertTrue(gate.press(2300).isEmpty())
    }

    @Test fun singleWaitsForTheFullWindow() {
        val gate = LowerPressGate(windowMs = 320)
        assertTrue(gate.press(1000).isEmpty())
        assertEquals(1320L, gate.deadlineMs)
        assertTrue(gate.flush(1319).isEmpty())
        assertEquals(listOf(PressAction.SINGLE), gate.flush(1320))
        assertNull(gate.deadlineMs)
        assertTrue(gate.flush(1400).isEmpty())
    }

    @Test fun doublePressNeverEmitsSingle() {
        val gate = LowerPressGate(windowMs = 320)
        gate.press(1000)
        assertEquals(listOf(PressAction.DOUBLE), gate.press(1200))
        assertNull(gate.deadlineMs)
        assertTrue(gate.flush(1400).isEmpty())
    }

    @Test fun cancelPreventsLateSingle() {
        val gate = LowerPressGate(windowMs = 320)
        gate.press(1000)
        gate.cancel()
        assertNull(gate.deadlineMs)
        assertTrue(gate.flush(2000).isEmpty())
    }

    @Test fun tripleDoesNotSendAfterToggle() {
        val gate = LowerPressGate(windowMs = 320)
        gate.press(1000)
        gate.press(1100)
        assertTrue(gate.press(1200).isEmpty())
        assertTrue(gate.flush(2000).isEmpty())
    }

    @Test fun boundaryIsTwoSinglesNotDouble() {
        val gate = LowerPressGate(windowMs = 320)
        gate.press(1000)
        assertEquals(listOf(PressAction.SINGLE), gate.press(1320))
        assertEquals(listOf(PressAction.SINGLE), gate.flush(1640))
    }

    @Test fun freshGestureAfterCooldownWorks() {
        val gate = LowerPressGate(windowMs = 320)
        gate.press(1000)
        gate.press(1100)
        assertTrue(gate.press(1419).isEmpty())
        assertTrue(gate.press(1420).isEmpty())
        assertEquals(listOf(PressAction.SINGLE), gate.flush(1740))
    }

    @Test fun cancelAlsoResetsCooldown() {
        val gate = LowerPressGate(windowMs = 320)
        gate.press(1000)
        gate.press(1100)
        gate.cancel()
        gate.press(1200)
        assertEquals(listOf(PressAction.SINGLE), gate.flush(1520))
    }

    @Test fun customWindowHasMatchingBoundary() {
        val gate = LowerPressGate(windowMs = 400)
        gate.press(1000)
        assertTrue(gate.flush(1399).isEmpty())
        assertEquals(listOf(PressAction.SINGLE), gate.flush(1400))
    }

    @Test(expected = IllegalArgumentException::class)
    fun nonPositiveWindowRejected() {
        LowerPressGate(windowMs = 0)
    }
}
