package dev.dsh.watch.util

import org.junit.Assert.*
import org.junit.Test

class AmbientDisplayTest {

    @Test fun interactiveIsAlwaysFullAlpha() {
        assertEquals(1f, AmbientDisplay.windowAlpha(true, false, false))
        assertEquals(1f, AmbientDisplay.windowAlpha(true, false, true))
        assertEquals(1f, AmbientDisplay.windowAlpha(true, true, true))
    }

    @Test fun companionAmbientFaceStaysVisible() {
        assertEquals(1f, AmbientDisplay.windowAlpha(false, true, false))
        assertEquals(1f, AmbientDisplay.windowAlpha(false, true, true))
    }

    @Test fun dimAndHiddenStates() {
        assertEquals(0.15f, AmbientDisplay.windowAlpha(false, false, false))
        assertEquals(0f, AmbientDisplay.windowAlpha(false, false, true))
    }

    @Test fun ambientObserverOnlyOnWatchFeature() {
        // Regression: attaching AmbientLifecycleObserver without the Wear
        // shared library (phones, generic emulators) throws in ON_CREATE
        // dispatch and crashes launch. Non-watch devices must skip it and
        // stay interactive-only (full alpha already guaranteed above).
        assertTrue(AmbientDisplay.isAmbientSupported(true))
        assertFalse(AmbientDisplay.isAmbientSupported(false))
    }

    @Test fun burnInDriftCyclesOnlyWhenRequired() {
        assertEquals(0f, AmbientDisplay.burnInOffsetDp(3, false))
        assertEquals(-2f, AmbientDisplay.burnInOffsetDp(0, true))
        assertEquals(0f, AmbientDisplay.burnInOffsetDp(1, true))
        assertEquals(2f, AmbientDisplay.burnInOffsetDp(2, true))
        assertEquals(0f, AmbientDisplay.burnInOffsetDp(3, true))
        assertEquals(-2f, AmbientDisplay.burnInOffsetDp(4, true))
    }
}
