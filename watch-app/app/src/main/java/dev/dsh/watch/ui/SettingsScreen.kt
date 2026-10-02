package dev.dsh.watch.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Text
import dev.dsh.watch.device.ALL_PROFILES
import dev.dsh.watch.net.ConnectionSettings

/**
 * Snapshot of the device-owned settings section. Read from the shared
 * `dsh_remote` preferences by the caller (Activity) and written back through
 * the callbacks — the bridge connection fields stay ViewModel-owned and
 * are saved through [onSaveSecure].
 */
data class DeviceSettingsState(
    /** Explicit override id, or null for automatic detection. */
    val overrideId: String?,
    /** Resolved profile display name (override or hardware detection). */
    val effectiveName: String,
    val homeCaptureEnabled: Boolean,
    val offersHomeCapture: Boolean,
)

/**
 * Settings: bridge connection (base + token + certificate pin + insecure-LAN
 * opt-in + character) plus display toggles plus the Watch device section.
 *
 * The Display section owns the touch-accessible avatar/remote mode switch
 * ([avatarMode]/[onAvatarModeToggle]): it flips the same companion UI that
 * the hardware double-press toggles, so generic Wear OS devices with no
 * Samsung buttons switch modes entirely by touch. A null
 * [onAvatarModeToggle] hides the pill (backwards-compatible callers).
 *
 * - The token is masked by default and never logged; editing reveals a
 *   password field that saves on change when the combination validates.
 * - The certificate pin uses the exact bridge display format (`sha256/...`,
 *   also accepted as bare base64); it is validated to 32 bytes before save.
 * - Invalid combinations are shown inline and never saved: stored prefs keep
 *   the last valid values (migration-safe).
 */
@Composable
fun SettingsScreen(
    base: String,
    token: String,
    certPin: String,
    allowInsecureLan: Boolean,
    characterId: String,
    availableCharacters: List<String>,
    keepScreenAwake: Boolean,
    onKeepScreenAwake: () -> Unit,
    wakeOnActivity: Boolean,
    onWakeOnActivity: () -> Unit,
    onSaveSecure: (base: String, token: String, certPinInput: String, allowInsecureLan: Boolean) -> Unit,
    onCharacterSelect: (String) -> Unit,
    onPing: () -> Unit,
    pingResult: String?,
    device: DeviceSettingsState? = null,
    onProfileOverride: ((String?) -> Unit)? = null,
    onHomeCapture: ((Boolean) -> Unit)? = null,
    onSave: ((base: String, token: String) -> Unit)? = null,
    avatarMode: Boolean = false,
    onAvatarModeToggle: (() -> Unit)? = null,
) {
    var baseText by remember(base) { mutableStateOf(base) }
    var tokenText by remember(token) { mutableStateOf(token) }
    var pinText by remember(certPin) { mutableStateOf(certPin) }
    var insecure by remember(allowInsecureLan) { mutableStateOf(allowInsecureLan) }
    var editing by remember { mutableStateOf<String?>(null) }
    // Legacy manual fields live ONLY under Advanced. The pairing wizard
    // (Menu → Pair with Mac) is the default; existing paired values migrate
    // untouched and keep working, but new setups never type URLs here.
    var showAdvanced by remember { mutableStateOf(false) }

    fun trySave(b: String = baseText, t: String = tokenText, p: String = pinText, i: Boolean = insecure) {
        if (ConnectionSettings.validate(b, t, p, i) == null) {
            onSaveSecure(b, t, p, i)
        }
    }

    val validationError = ConnectionSettings.validate(baseText, tokenText, pinText, insecure)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 26.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = "Settings", style = DshType.title, maxLines = 1)
        DshPill(
            label = if (keepScreenAwake) "Keep awake · On" else "Keep awake · Off",
            onClick = onKeepScreenAwake,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text("Keeps the screen on while DSH is open. Uses more battery.",
            style = DshType.caption, modifier = Modifier.padding(vertical = 6.dp))

        DshPill(
            label = if (wakeOnActivity) "Wake on activity · On" else "Wake on activity · Off",
            onClick = onWakeOnActivity,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text("Briefly wakes ambient Cappi for questions, speech, and work changes. Never opens over another app.",
            style = DshType.caption, modifier = Modifier.padding(vertical = 6.dp))

        Text(
            text = "Bridge",
            style = DshType.title,
            maxLines = 1,
            modifier = Modifier.padding(top = 14.dp),
        )
        Text("Paired ${if (base.isEmpty()) "— not paired yet (use Menu → Pair with Mac)" else "— managed by the pairing wizard"}",
            style = DshType.caption, modifier = Modifier.padding(vertical = 6.dp))
        DshPill(
            label = if (showAdvanced) "Advanced · Hide" else "Advanced · Show",
            onClick = { showAdvanced = !showAdvanced },
            modifier = Modifier.padding(top = 8.dp),
        )
        if (showAdvanced) {
        SettingField(
            label = "base",
            value = baseText,
            editing = editing == "base",
            onClick = { editing = "base" },
            onChange = { baseText = it; trySave(b = it) },
        )
        SettingField(
            label = "token",
            value = if (tokenText.isEmpty()) "(empty)" else "••••••••",
            editing = editing == "token",
            onClick = { editing = "token" },
            onChange = { tokenText = it; trySave(t = it) },
            mask = true,
        )
        SettingField(
            label = "pin",
            value = pinText.ifEmpty { "(empty)" },
            editing = editing == "pin",
            onClick = { editing = "pin" },
            onChange = { pinText = it; trySave(p = it) },
        )
        Text("Certificate pin from setup-cert.sh --fingerprint (sha256/...). Required for https://.",
            style = DshType.caption, modifier = Modifier.padding(vertical = 6.dp))

        DshPill(
            label = if (insecure) "Insecure LAN · On" else "Insecure LAN · Off",
            onClick = {
                insecure = !insecure
                trySave(i = insecure)
            },
            modifier = Modifier.padding(top = 8.dp),
        )
        Text("Legacy cleartext http:// only. Never needed for https://; default off.",
            style = DshType.caption, modifier = Modifier.padding(vertical = 6.dp))

        if (validationError != null) {
            Text(
                text = validationError,
                style = DshType.label.copy(color = DshColors.danger),
                textAlign = TextAlign.Center,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 6.dp),
            )
        } else {
            Text(
                text = "Connection valid — saves automatically",
                style = DshType.caption,
                maxLines = 2,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
        }

        DshPill(
            label = "Test",
            onClick = onPing,
            modifier = Modifier.padding(top = 10.dp),
        )

        pingResult?.let {
            Text(
                text = it,
                style = DshType.label.copy(
                    color = if (it.startsWith("OK")) DshColors.success else DshColors.danger,
                ),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 6.dp),
            )
        }

        Text(
            text = "Character",
            style = DshType.title,
            maxLines = 1,
            modifier = Modifier.padding(top = 14.dp),
        )
        val packs = availableCharacters.ifEmpty { listOf(characterId) }
        for (id in packs) {
            val selected = id == characterId
            DshPill(
                label = (if (selected) "✓ " else "") + id,
                onClick = { onCharacterSelect(id) },
                modifier = Modifier.padding(top = 8.dp),
            )
        }
        Text("Avatar pack for this watch. Stored on the watch; the bridge is notified, never obeyed.",
            style = DshType.caption, modifier = Modifier.padding(vertical = 6.dp))

        Text(
            text = "Display",
            style = DshType.title,
            maxLines = 1,
            modifier = Modifier.padding(top = 14.dp),
        )
        if (onAvatarModeToggle != null) {
            DshPill(
                label = if (avatarMode) "Avatar mode · On" else "Avatar mode · Off",
                onClick = onAvatarModeToggle,
                modifier = Modifier.padding(top = 8.dp),
            )
            Text("Character UI versus remote controls. Touch works on every watch, including generic Wear OS with no Samsung buttons; the hardware double-press remains as a shortcut for the same switch.",
                style = DshType.caption, modifier = Modifier.padding(vertical = 6.dp))
        } else {
            Text("Avatar mode is ${if (avatarMode) "on" else "off"} (character UI versus remote controls).",
                style = DshType.caption, modifier = Modifier.padding(vertical = 6.dp))
        }

        if (device != null && onProfileOverride != null) {
            Text(
                text = "Watch",
                style = DshType.title,
                maxLines = 1,
                modifier = Modifier.padding(top = 14.dp),
            )
            Text(
                text = "Detected: ${device.effectiveName}",
                style = DshType.caption,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(vertical = 6.dp),
            )
            DshPill(
                label = (if (device.overrideId == null) "✓ " else "") + "Auto-detect",
                onClick = { onProfileOverride(null) },
                modifier = Modifier.padding(top = 8.dp),
            )
            for (profile in ALL_PROFILES) {
                val selected = device.overrideId == profile.id
                DshPill(
                    label = (if (selected) "✓ " else "") + profile.displayName,
                    onClick = { onProfileOverride(profile.id) },
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            Text("Auto picks Galaxy Watch4 only on matching Samsung hardware; every other watch uses the generic profile (system Back, no vendor apps).",
                style = DshType.caption, modifier = Modifier.padding(vertical = 6.dp))
            if (device.offersHomeCapture && onHomeCapture != null) {
                DshPill(
                    label = if (device.homeCaptureEnabled) "Home replacement · On" else "Home replacement · Off",
                    onClick = { onHomeCapture(!device.homeCaptureEnabled) },
                    modifier = Modifier.padding(top = 8.dp),
                )
                Text("Optional: offer DSH as a HOME-screen choice. Turning it off restores the stock launcher; the app-grid entry always stays.",
                    style = DshType.caption, modifier = Modifier.padding(vertical = 6.dp))
            }
        }
    }
}

/**
 * Backwards-compatible overload: base + token only. The pin/insecure/character
 * state passes through untouched.
 */
@Composable
fun SettingsScreen(
    base: String,
    token: String,
    keepScreenAwake: Boolean,
    onKeepScreenAwake: () -> Unit,
    wakeOnActivity: Boolean,
    onWakeOnActivity: () -> Unit,
    onSave: (base: String, token: String) -> Unit,
    onPing: () -> Unit,
    pingResult: String?,
    device: DeviceSettingsState? = null,
    onProfileOverride: ((String?) -> Unit)? = null,
    onHomeCapture: ((Boolean) -> Unit)? = null,
) {
    SettingsScreen(
        base = base,
        token = token,
        certPin = "",
        allowInsecureLan = false,
        characterId = "cappi-original",
        availableCharacters = listOf("cappi-original"),
        keepScreenAwake = keepScreenAwake,
        onKeepScreenAwake = onKeepScreenAwake,
        wakeOnActivity = wakeOnActivity,
        onWakeOnActivity = onWakeOnActivity,
        onSaveSecure = { b, t, _, _ -> onSave(b, t) },
        onCharacterSelect = {},
        onPing = onPing,
        pingResult = pingResult,
        device = device,
        onProfileOverride = onProfileOverride,
        onHomeCapture = onHomeCapture,
        onSave = onSave,
        avatarMode = false,
        onAvatarModeToggle = null,
    )
}

@Composable
private fun SettingField(
    label: String,
    value: String,
    editing: Boolean,
    onClick: () -> Unit,
    onChange: (String) -> Unit,
    mask: Boolean = false,
) {
    DshCard(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp),
    ) {
        androidx.compose.foundation.layout.Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text = label, style = DshType.secondary, maxLines = 1)
            if (editing) {
                androidx.compose.foundation.text.BasicTextField(
                    value = if (mask && value == "••••••••") "" else value,
                    onValueChange = onChange,
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = 10.dp),
                    textStyle = DshType.body,
                    visualTransformation = if (mask) {
                        androidx.compose.ui.text.input.PasswordVisualTransformation()
                    } else {
                        androidx.compose.ui.text.input.VisualTransformation.None
                    },
                )
            } else {
                Text(
                    text = value,
                    style = DshType.body,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = 10.dp),
                )
            }
        }
    }
}
