package dev.dsh.watch.device

import org.junit.Assert.*
import org.junit.Test

/**
 * Covers [WatchDevice.classify] only: it is pure (intent string/flag
 * matching — Android constants are compile-time inlined). Intent builders
 * need a device/emulator and are verified via assemble + manual review.
 */
class WatchDeviceTest {
    private val gw4 = WatchDevice(GalaxyWatch4Profile)
    private val generic = WatchDevice(GenericWearOsProfile)

    private val shortcutFlags = 0x10200000 // NEW_TASK | RESET_TASK_IF_NEEDED

    @Test fun samsungShortcutTogglesOnlyWhenAllowed() {
        val onGw4 = gw4.classify(
            "android.intent.action.MAIN", emptySet(), "dev.dsh.watch.MainActivity", shortcutFlags,
        )
        assertEquals(WatchDevice.HomeIntent.ShortcutToggle, onGw4)

        // Same raw intent on generic degrades to an ordinary HOME press:
        // no companion toggle via the vendor path, no Samsung packages.
        val onGeneric = generic.classify(
            "android.intent.action.MAIN", emptySet(), "dev.dsh.watch.MainActivity", shortcutFlags,
        )
        assertEquals(WatchDevice.HomeIntent.HomePress, onGeneric)
    }

    @Test fun ordinaryHomePressOnBothProfiles() {
        val cats = setOf("android.intent.category.HOME")
        assertEquals(WatchDevice.HomeIntent.HomePress, gw4.classify("android.intent.action.MAIN", cats, null, 0))
        assertEquals(WatchDevice.HomeIntent.HomePress, generic.classify("android.intent.action.MAIN", cats, null, 0))
    }

    @Test fun gridLaunchIsNeverAKeyPress() {
        val cats = setOf("android.intent.category.LAUNCHER")
        assertEquals(
            WatchDevice.HomeIntent.Other,
            gw4.classify("android.intent.action.MAIN", cats, "dev.dsh.watch.MainActivity", 0),
        )
        assertEquals(
            WatchDevice.HomeIntent.Other,
            generic.classify("android.intent.action.MAIN", cats, "dev.dsh.watch.MainActivity", 0),
        )
    }

    @Test fun shortcutLookalikeWithoutFlagsIsNotAShortcut() {
        // Missing the NEW_TASK|RESET_TASK_IF_NEEDED flag pair: ordinary press.
        val r = gw4.classify("android.intent.action.MAIN", emptySet(), "dev.dsh.watch.MainActivity", 0)
        assertEquals(WatchDevice.HomeIntent.HomePress, r)
    }

    @Test fun wrongComponentIsNotAShortcut() {
        val r = gw4.classify(
            "android.intent.action.MAIN", emptySet(), "dev.dsh.watch.RemoteHomeActivity", shortcutFlags,
        )
        assertEquals(WatchDevice.HomeIntent.HomePress, r)
    }
}
