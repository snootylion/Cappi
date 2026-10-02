package dev.dsh.watch.core

import android.content.SharedPreferences
import androidx.core.content.edit
import dev.dsh.watch.net.ConnectionSettings
import dev.dsh.watch.net.SecureTransport

/**
 * Connection collaborator: validation, persistence and endpoint snapshots for
 * the bridge transport. The [BridgeViewModel] retains the SSE lifecycle (one
 * supervisor, one generation counter); this object owns the rules so Settings
 * and tests share one implementation.
 */
object ConnectionCenter {

    fun validate(base: String, token: String, pin: String, insecure: Boolean): String? =
        ConnectionSettings.validate(base, token, pin, insecure)

    fun snapshot(state: UiState): SecureTransport.EndpointSecurity = state.endpointSecurity()

    /** Persist a validated connection. Throws [IllegalArgumentException] when invalid. */
    fun persist(
        prefs: SharedPreferences,
        base: String,
        token: String,
        pinInput: String,
        allowInsecureLan: Boolean,
    ): ConnectionSettings.Validated {
        val v = ConnectionSettings.validated(base, token, pinInput, allowInsecureLan)
        prefs.edit {
            putString(BridgeViewModel.KEY_BASE, v.base)
            putString(BridgeViewModel.KEY_TOKEN, v.token)
            putString(BridgeViewModel.KEY_CERT_PIN, v.pin)
            putBoolean(BridgeViewModel.KEY_ALLOW_INSECURE, v.allowInsecureLan)
        }
        return v
    }

    /** Trust misconfiguration worth surfacing instead of an endless retry. */
    fun trustError(state: UiState): String? {
        val b = state.base.trim()
        if (b.isEmpty() || ConnectionSettings.isUnpairedBase(b)) return null
        if (b.startsWith("https://", ignoreCase = true) && state.certPinSha256.isBlank()) {
            return "Bridge certificate not pinned — open Settings and enter the sha256/ pin"
        }
        return null
    }
}
