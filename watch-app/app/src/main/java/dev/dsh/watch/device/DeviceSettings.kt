package dev.dsh.watch.device

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

/**
 * Device-scoped preferences and profile resolution.
 *
 * Storage reuses the existing `dsh_remote` SharedPreferences file (same
 * package id, no migration); only new keys are introduced, so bridge settings
 * owned by the ViewModel are never reshaped. The bridge base/token keys stay
 * exactly as `core.ViewModel` defines them — this object only reads
 * the base to decide whether endpoint onboarding should be shown.
 *
 * The profile override is deliberately a plain string id: Settings writes it
 * through [DeviceSettings] without touching ViewModel signatures.
 */
object DeviceSettings {
    const val PREFS_NAME = "dsh_remote"
    const val KEY_PROFILE_OVERRIDE = "device_profile_override"
    const val KEY_HOME_ALIAS_ENABLED = "home_alias_enabled"

    /** Documentation placeholder shipped as DEFAULT_BASE (RFC 5737). */
    const val PLACEHOLDER_HOST = "192.0.2.1"

    fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun loadOverride(prefs: SharedPreferences): String? =
        prefs.getString(KEY_PROFILE_OVERRIDE, null)?.takeIf { it.isNotBlank() }

    fun saveOverride(prefs: SharedPreferences, profileId: String?) {
        prefs.edit() {
            if (profileId.isNullOrBlank()) remove(KEY_PROFILE_OVERRIDE)
            else putString(KEY_PROFILE_OVERRIDE, profileId)
        }
    }

    fun isHomeAliasEnabled(prefs: SharedPreferences): Boolean =
        prefs.getBoolean(KEY_HOME_ALIAS_ENABLED, true)

    fun setHomeAliasEnabled(prefs: SharedPreferences, enabled: Boolean) {
        prefs.edit() { putBoolean(KEY_HOME_ALIAS_ENABLED, enabled) }
    }

    fun resolve(prefs: SharedPreferences, manufacturer: String?, model: String?): DeviceProfile =
        resolveProfile(loadOverride(prefs), manufacturer, model)

    /**
     * True when no real bridge endpoint is configured yet: blank base or the
     * checked-in documentation placeholder. Callers show endpoint onboarding
     * (open Settings, enter the bridge address) instead of a misleading
     * reconnect/retry affordance.
     */
    fun isPlaceholderEndpoint(base: String?): Boolean {
        if (base.isNullOrBlank()) return true
        val host = base.trim().substringAfter("://").substringBefore(":").substringBefore("/")
        return host.equals(PLACEHOLDER_HOST, ignoreCase = true) ||
            host.equals("localhost", ignoreCase = true) && base.contains(PLACEHOLDER_HOST)
    }
}
