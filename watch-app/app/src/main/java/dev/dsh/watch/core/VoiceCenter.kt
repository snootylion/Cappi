package dev.dsh.watch.core

import android.content.SharedPreferences
import androidx.core.content.edit

/**
 * Voice collaborator: voice-output persistence and mic/dictation start guards.
 * Audio routing itself stays in [BridgeViewModel] + VoiceService; this object
 * owns the preconditions so they are unit-testable on plain JVM state.
 */
object VoiceCenter {

    private const val KEY_VOICE_OUTPUT = "voice_output_enabled"

    fun persistVoiceOutput(prefs: SharedPreferences, enabled: Boolean) {
        prefs.edit { putBoolean(KEY_VOICE_OUTPUT, enabled) }
    }

    fun readVoiceOutput(prefs: SharedPreferences): Boolean =
        prefs.getBoolean(KEY_VOICE_OUTPUT, true)

    /** Null when the mic may start, else a display-ready reason. */
    fun micBlocker(state: UiState): String? =
        if (!state.connected) "Reconnect to use the microphone" else null
}
