package dev.dsh.watch.device

import org.junit.Assert.*
import org.junit.Test

class DeviceProfileTest {

    @Test fun explicitOverrideAlwaysWins() {
        assertSame(GenericWearOsProfile, resolveProfile("generic-wearos", "samsung", "SM-R860"))
        assertSame(GalaxyWatch4Profile, resolveProfile("galaxy-watch4", "bogus", "bogus"))
    }

    @Test fun unknownOverrideFallsBackToCautiousDetection() {
        // A stale/typo override id is ignored: hardware detection decides, and
        // detection itself is cautious (only known Watch4 pairs match).
        assertSame(GalaxyWatch4Profile, resolveProfile("nope", "samsung", "SM-R870"))
        assertSame(GenericWearOsProfile, resolveProfile("nope", "samsung", "SM-R930"))
        assertSame(GenericWearOsProfile, resolveProfile("nope", null, null))
    }

    @Test fun watch4MatchesOnlyKnownSamsungPairs() {
        assertSame(GalaxyWatch4Profile, resolveProfile(null, "samsung", "SM-R860"))
        assertSame(GalaxyWatch4Profile, resolveProfile(null, "Samsung", "SM-R875F"))
        assertSame(GalaxyWatch4Profile, resolveProfile(null, "samsung", "Galaxy Watch4"))
        assertSame(GenericWearOsProfile, resolveProfile(null, "samsung", "SM-R930")) // Watch5
        assertSame(GenericWearOsProfile, resolveProfile(null, "google", "Pixel Watch"))
        assertSame(GenericWearOsProfile, resolveProfile(null, null, null))
        assertSame(GenericWearOsProfile, resolveProfile(null, "", ""))
        assertSame(GenericWearOsProfile, resolveProfile(null, "samsung", null))
    }

    @Test fun genericNeverStealsBackOrVendor() {
        assertFalse(GenericWearOsProfile.rootBackTogglesMic)
        assertFalse(GenericWearOsProfile.allowSamsungIntents)
        assertTrue(GalaxyWatch4Profile.rootBackTogglesMic)
        assertTrue(GalaxyWatch4Profile.allowSamsungIntents)
    }

    @Test fun profileIdsAreStableAndUnique() {
        assertEquals(listOf("galaxy-watch4", "generic-wearos"), ALL_PROFILES.map { it.id })
        assertEquals(ALL_PROFILES.size, ALL_PROFILES.map { it.id }.distinct().size)
    }

    @Test fun buttonIdsAreStableAndLabelsAreDisplayOnly() {
        // Routing matches on enum identity; labels may change freely.
        assertEquals(2, PhysicalButtonId.values().size)
        assertTrue(GalaxyWatch4Profile.buttonRole(PhysicalButtonId.LOWER_HOME).isNotBlank())
        assertTrue(GenericWearOsProfile.buttonRole(PhysicalButtonId.UPPER_BACK).isNotBlank())
        val gw4 = GalaxyWatch4Profile.orientationLabels()
        val generic = GenericWearOsProfile.orientationLabels()
        assertTrue(gw4.upper.isNotBlank() && gw4.lower.isNotBlank())
        assertTrue(generic.upper.isNotBlank() && generic.lower.isNotBlank())
    }

    @Test fun homeCaptureOfferedOnBothProfiles() {
        assertTrue(GalaxyWatch4Profile.offersHomeCapture)
        assertTrue(GenericWearOsProfile.offersHomeCapture)
    }
}
