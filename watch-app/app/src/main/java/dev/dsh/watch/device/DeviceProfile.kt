package dev.dsh.watch.device

/**
 * Stable physical button identifiers for wrist hardware keys.
 *
 * These ids describe the physical switch (position on the case when worn on
 * the left wrist, crown side up) and MUST NOT be derived from worn-orientation
 * labels: the user confirms how the watch is actually worn, and the same
 * physical key keeps its id regardless of which wrist/orientation is chosen.
 * Human-readable labels live on [DeviceProfile.orientationLabels] and may
 * differ per device; routing logic matches only on these ids.
 */
enum class PhysicalButtonId {
    /** Canonical HOME key (lower key on Galaxy Watch4, left-wrist). */
    LOWER_HOME,

    /** Canonical Back key (upper key on Galaxy Watch4, left-wrist). */
    UPPER_BACK,
}

/** Worn-orientation labels confirmed by/with the user; display only. */
data class OrientationLabels(val upper: String, val lower: String)

/**
 * Capability profile for one watch family. Routing decisions (Back handling,
 * shortcut detection, vendor intents) branch on these flags — never on
 * `Build.MODEL` strings scattered through UI code. See [resolveProfile].
 */
interface DeviceProfile {
    /** Stable id persisted in the profile override preference. */
    val id: String
    val displayName: String

    /**
     * Double-press of [PhysicalButtonId.LOWER_HOME] (or the vendor shortcut
     * intent) toggles companion/character mode. True on every current profile;
     * the flag exists so a future minimal profile can opt out without editing
     * the press gate.
     */
    val doubleShortcutTogglesCompanion: Boolean

    /**
     * Physical Back at the app root toggles the microphone. True only on
     * profiles whose hardware/UX was validated for it (Galaxy Watch4).
     * Generic Wear OS keeps system Back behavior at the root so the app never
     * steals Back for the microphone by default.
     */
    val rootBackTogglesMic: Boolean

    /**
     * Samsung-specific packages/intents (SysUi activity component, shortcut
     * classification) may be used. False on generic: no Samsung package is
     * ever named and the Samsung Home menu entry is hidden.
     */
    val allowSamsungIntents: Boolean

    /** The reversible HOME-alias capture flow is offered in Settings. */
    val offersHomeCapture: Boolean

    /** Stable role description for a physical key; never a vendor key name. */
    fun buttonRole(button: PhysicalButtonId): String

    /** Display labels for the worn orientation; may be user-confirmed. */
    fun orientationLabels(): OrientationLabels
}

/** Validated on Galaxy Watch4 (40/44mm, Wear OS / One UI Watch). */
object GalaxyWatch4Profile : DeviceProfile {
    override val id = "galaxy-watch4"
    override val displayName = "Galaxy Watch4"
    override val doubleShortcutTogglesCompanion = true
    override val rootBackTogglesMic = true
    override val allowSamsungIntents = true
    override val offersHomeCapture = true

    override fun buttonRole(button: PhysicalButtonId): String = when (button) {
        PhysicalButtonId.LOWER_HOME ->
            "Home: single press sends the oldest queued message, double press toggles companion mode"
        PhysicalButtonId.UPPER_BACK ->
            "Back: in-app navigation off the Home screen, microphone toggle on the Home screen"
    }

    override fun orientationLabels() = OrientationLabels(
        upper = "Upper · Back / mic (at Home)",
        lower = "Lower · Home",
    )
}

/**
 * Safe default for any unrecognized Wear OS device: touch-first, no vendor
 * packages, system Back behavior preserved at the app root.
 */
object GenericWearOsProfile : DeviceProfile {
    override val id = "generic-wearos"
    override val displayName = "Generic Wear OS"
    override val doubleShortcutTogglesCompanion = true
    override val rootBackTogglesMic = false
    override val allowSamsungIntents = false
    override val offersHomeCapture = true

    override fun buttonRole(button: PhysicalButtonId): String = when (button) {
        PhysicalButtonId.LOWER_HOME ->
            "Home: single press sends the oldest queued message, double press toggles companion mode"
        PhysicalButtonId.UPPER_BACK ->
            "Back: system navigation everywhere (touch controls handle microphone)"
    }

    override fun orientationLabels() = OrientationLabels(
        upper = "Upper · Back",
        lower = "Lower · Home",
    )
}

/** All profiles known to [resolveProfile]; new hardware adds an entry here. */
val ALL_PROFILES: List<DeviceProfile> = listOf(GalaxyWatch4Profile, GenericWearOsProfile)

/**
 * Chooses the active profile. An explicit user override always wins; otherwise
 * matching is deliberately cautious — only known Samsung Galaxy Watch4
 * model/manufacturer pairs select [GalaxyWatch4Profile], everything else
 * (including null/blank hardware strings, emulators, and unknown models)
 * falls back to [GenericWearOsProfile]. An unknown override id is ignored
 * (hardware detection decides), so a stale preference can never widen access
 * beyond what cautious detection already allows.
 */
fun resolveProfile(overrideId: String?, manufacturer: String?, model: String?): DeviceProfile {
    if (!overrideId.isNullOrBlank()) {
        ALL_PROFILES.firstOrNull { it.id == overrideId }?.let { return it }
    }
    val mfr = manufacturer?.trim().orEmpty()
    val mdl = model?.trim().orEmpty()
    val isSamsung = mfr.equals("samsung", ignoreCase = true)
    val isWatch4 = mdl.startsWith("SM-R86", ignoreCase = true) ||
        mdl.startsWith("SM-R87", ignoreCase = true) ||
        mdl.contains("Watch4", ignoreCase = true)
    return if (isSamsung && isWatch4) GalaxyWatch4Profile else GenericWearOsProfile
}
