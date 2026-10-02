package dev.dsh.watch.util

/**
 * Pure ambient/display-state math extracted from the activity lifecycle.
 *
 * Display contract: the window is fully opaque while interactive, or while the
 * companion root is showing in ambient (avatar face stays visible); otherwise
 * it dims to 15% so burn-in protection and low-bit ambient modes stay legible
 * without waking the screen. In low-bit ambient the window goes fully
 * transparent. Burn-in offsets cycle ±2dp only when the hardware requires
 * burn-in protection.
 *
 * Android-free so the policy is unit-testable; the activity feeds it lifecycle
 * state and applies the results to the window/decor view.
 */
object AmbientDisplay {
    const val DIM_ALPHA = 0.15f
    const val FULL_ALPHA = 1f
    const val HIDDEN_ALPHA = 0f

    /**
     * @param interactive activity started, not ambient, screen interactive.
     * @param companionAmbientFace avatar root visible while ambient (Cappi
     *   face); keeps full alpha so the face is not dimmed into invisibility.
     * @param lowBitAmbient device reports low-bit ambient: hide the window.
     */
    fun windowAlpha(
        interactive: Boolean,
        companionAmbientFace: Boolean,
        lowBitAmbient: Boolean,
    ): Float = when {
        interactive || companionAmbientFace -> FULL_ALPHA
        lowBitAmbient -> HIDDEN_ALPHA
        else -> DIM_ALPHA
    }

    /**
     * Whether the activity may attach the Wear ambient observer. The observer
     * requires the `android.hardware.type.watch` shared library; on phones and
     * generic emulators it is absent and attaching throws during ON_CREATE
     * dispatch, crashing launch. Non-watch devices stay interactive-only:
     * [windowAlpha] already returns full opacity when interactive, so skipping
     * the observer is a safe degrade, not a behavior change on watches.
     */
    fun isAmbientSupported(hasWatchFeature: Boolean): Boolean = hasWatchFeature

    /** Burn-in pixel drift sequence; 0 when protection is not required. */
    fun burnInOffsetDp(tick: Int, burnInProtectionRequired: Boolean): Float {        if (!burnInProtectionRequired) return 0f
        return floatArrayOf(-2f, 0f, 2f, 0f)[tick.mod(4)]
    }
}
