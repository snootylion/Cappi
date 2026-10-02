package dev.dsh.watch.device

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import android.widget.Toast
import android.annotation.SuppressLint
import dev.dsh.watch.cappi.isSamsungCappiShortcut

/**
 * All vendor-specific routing, isolated behind [DeviceProfile].
 *
 * Samsung paths (shortcut classification, SysUI component, launcher
 * targeting) are consulted ONLY when [DeviceProfile.allowSamsungIntents] is
 * true. Every entry point has a generic safe fallback that names no vendor
 * package, so the generic profile never touches Samsung components.
 *
 * `cappi.isSamsungCappiShortcut` is reused read-only (that file is owned by
 * the characters contributor): the raw signature match stays there, the
 * policy decision — whether this device may act on it — lives here.
 */
class WatchDevice(val profile: DeviceProfile) {

    /** Classification of an incoming MAIN/HOME intent for this profile. */
    sealed interface HomeIntent {
        /** Samsung double-press shortcut: toggle companion mode, never queue. */
        data object ShortcutToggle : HomeIntent

        /** Ordinary HOME press while this activity is the foreground target. */
        data object HomePress : HomeIntent

        /** Anything else (grid launch, unrelated intent): no key handling. */
        data object Other : HomeIntent
    }

    /**
     * Classifies a new/cold intent. The Samsung signature match is evaluated
     * only when the profile allows vendor intents; otherwise the same intent
     * degrades to [HomeIntent.Other] instead of toggling anything.
     */
    fun classify(
        action: String?,
        categories: Set<String>?,
        componentClass: String?,
        flags: Int,
    ): HomeIntent {
        if (profile.allowSamsungIntents &&
            isSamsungCappiShortcut(action, categories, componentClass, flags)
        ) {
            return HomeIntent.ShortcutToggle
        }
        val homePress = categories?.contains(Intent.CATEGORY_HOME) == true ||
            (action == Intent.ACTION_MAIN && categories?.contains(Intent.CATEGORY_LAUNCHER) != true)
        if (homePress) return HomeIntent.HomePress
        return HomeIntent.Other
    }

    /** Generic system settings intent; safe on every profile. */
    // WearRecents prefers no NEW_TASK, but these intents are started from a
    // device API that accepts any Context (including the application context
    // from a HOME-alias launch), where the flag is required. Preserved.
    @SuppressLint("WearRecents")
    fun systemSettingsIntent(): Intent =
        Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /**
     * Samsung SysUI home intent, or null when the profile forbids vendor
     * packages. Callers fall back to [systemSettingsIntent] on null.
     */
    @SuppressLint("WearRecents") // Same NEW_TASK justification as above.
    fun samsungHomeIntentOrNull(): Intent? {
        if (!profile.allowSamsungIntents) return null
        return Intent().setComponent(
            ComponentName(
                "com.samsung.android.wearable.sysui",
                "com.google.android.clockwork.sysui.mainui.activity.SysUiActivity",
            ),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    /**
     * Opens the requested system screen. Samsung target only when allowed;
     * otherwise the generic settings screen plus an explanatory toast — never
     * a vendor component, never a silent failure.
     */
    fun openSystemScreen(context: Context, samsungHome: Boolean): Boolean {
        val intent = if (samsungHome) {
            samsungHomeIntentOrNull() ?: run {
                runCatching {
                    context.startActivity(systemSettingsIntent())
                }.onFailure {
                    Toast.makeText(context, "Unable to open system screen", Toast.LENGTH_SHORT).show()
                }
                Toast.makeText(context, "Samsung Home is unavailable on this device", Toast.LENGTH_SHORT).show()
                return false
            }
        } else {
            systemSettingsIntent()
        }
        return runCatching {
            context.startActivity(intent)
            true
        }.onFailure {
            Toast.makeText(context, "Unable to open system screen", Toast.LENGTH_SHORT).show()
            false
        }.getOrDefault(false)
    }

    companion object {
        /** Manifest alias name for the reversible HOME candidate. */
        const val HOME_ALIAS_CLASS = "dev.dsh.watch.RemoteHomeActivity"

        /**
         * Applies the stored HOME-alias preference. Disabling is fully
         * reversible from the normal app-grid entry (Settings toggle writes
         * the same key). Never kills the app; the change takes effect for
         * subsequent HOME presses.
         */
        fun applyHomeAliasEnabled(context: Context, enabled: Boolean) {
            val state = if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
            runCatching {
                context.packageManager.setComponentEnabledSetting(
                    ComponentName(context, HOME_ALIAS_CLASS),
                    state,
                    PackageManager.DONT_KILL_APP,
                )
            }
        }
    }
}
