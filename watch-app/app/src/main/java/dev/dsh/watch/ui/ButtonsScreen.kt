package dev.dsh.watch.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Text
import dev.dsh.watch.device.DeviceProfile
import dev.dsh.watch.device.GalaxyWatch4Profile
import dev.dsh.watch.device.PhysicalButtonId

/**
 * What the hardware buttons do while DSH Remote is open.
 *
 * Text is profile-driven: validated profiles describe their confirmed
 * Back/mic behavior, while the generic profile documents system Back plus the
 * touch alternatives that exist on every profile. The default preserves the
 * historical Galaxy Watch4 copy.
 */
@Composable
fun ButtonsScreen(profile: DeviceProfile = GalaxyWatch4Profile) {
    val labels = profile.orientationLabels()
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 26.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Text("Hardware buttons", style = DshType.title, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth())
        Text("Lower · send oldest queued", style = DshType.body.copy(color = DshColors.accent),
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        Text("Nothing queued? It takes you Home — from another app too.",
            style = DshType.secondary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        if (profile.doubleShortcutTogglesCompanion) {
            Text("Double-press lower · companion mode", style = DshType.body.copy(color = DshColors.accent),
                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            Text("Hardware shortcut only. Touch path (every watch, no Samsung buttons required): Menu → Avatar mode, or Settings → Display → Avatar mode. Touch-hold the avatar face to reopen Menu and switch back.",
                style = DshType.secondary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        }
        if (profile.rootBackTogglesMic) {
            Text("Upper · mic on/off", style = DshType.body.copy(color = DshColors.accent),
                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            Text("On the Home screen. From other screens it works as normal Back. Hold either button for its stock behavior.",
                style = DshType.secondary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        } else {
            Text("Upper · Back (system behavior)", style = DshType.body.copy(color = DshColors.accent),
                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            Text("Back is never remapped on this device. Use the on-screen mic, stop, and menu controls — available on every watch.",
                style = DshType.secondary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        }
        Text("Worn as: ${labels.upper} / ${labels.lower}",
            style = DshType.secondary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        Text(profile.buttonRole(PhysicalButtonId.LOWER_HOME),
            style = DshType.secondary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
    }
}
