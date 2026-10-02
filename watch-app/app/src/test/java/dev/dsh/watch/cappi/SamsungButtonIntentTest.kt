package dev.dsh.watch.cappi

import org.junit.Assert.*
import org.junit.Test

class SamsungButtonIntentTest {
    private val main = "android.intent.action.MAIN"
    private val activity = "dev.dsh.watch.MainActivity"
    @Test fun recordedSamsungDoubleLaunchIsOneShortcut() {
        assertTrue(isSamsungCappiShortcut(main, null, activity, 270532608))
    }
    @Test fun ordinaryHomeIsNotShortcut() {
        assertFalse(isSamsungCappiShortcut(main, setOf("android.intent.category.HOME"),
            "dev.dsh.watch.RemoteHomeActivity", 268435712))
    }
    @Test fun launcherNeverToggles() {
        assertFalse(isSamsungCappiShortcut(main, setOf("android.intent.category.LAUNCHER"), activity, 270532608))
    }
    @Test fun adbLaunchAndPlainMainAreNotShortcut() {
        assertFalse(isSamsungCappiShortcut(null, null, activity, 268435456))
        assertFalse(isSamsungCappiShortcut(main, null, activity, 268435456))
    }
    @Test fun wrongComponentNeverToggles() {
        assertFalse(isSamsungCappiShortcut(main, null, "dev.dsh.watch.RemoteHomeActivity", 270532608))
    }
}
