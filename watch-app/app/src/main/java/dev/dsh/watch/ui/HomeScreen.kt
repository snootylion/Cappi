package dev.dsh.watch.ui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.text.format.DateFormat as AndroidDateFormat
import android.widget.Toast
import androidx.annotation.DrawableRes
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.Text
import dev.dsh.watch.R
import dev.dsh.watch.core.Phase
import dev.dsh.watch.core.UiState
import dev.dsh.watch.core.projectLabel
import dev.dsh.watch.core.homeDisplayPhase
import dev.dsh.watch.device.DeviceSettings
import java.util.Date
import kotlinx.coroutines.delay

/** A quiet hierarchy: thread/time, task status, voice controls, utility capsule. */
@Composable
fun HomeScreen(
    state: UiState,
    onMicToggle: () -> Unit,
    onStop: () -> Unit,
    onMenu: () -> Unit,
    onSessions: () -> Unit,
    onSteer: (String) -> Unit,
    onText: () -> Unit,
    onPending: () -> Unit,
    onVoiceOutputToggle: () -> Unit,
    onDismissError: () -> Unit,
    onPair: () -> Unit = {},
) {
    val context = LocalContext.current
    val phase = state.homeDisplayPhase()
    val label = when (phase) {
        Phase.THINKING -> "Working"
        Phase.SPEAKING -> "Speaking"
        Phase.ERROR -> "Error"
        Phase.CONNECTING -> "Connecting"
        else -> if (state.assistantDone) "Finished" else "Ready"
    }
    val color = when (phase) {
        Phase.ERROR -> DshColors.danger
        Phase.CONNECTING -> DshColors.textSecondary
        else -> DshColors.textPrimary
    }
    val alpha = if (phase == Phase.THINKING) {
        val transition = rememberInfiniteTransition(label = "working")
        val opacity by transition.animateFloat(
            initialValue = 0.78f, targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(1600, easing = EaseInOut), RepeatMode.Reverse),
            label = "workingOpacity",
        )
        opacity
    } else 1f
    val current = state.sessions.firstOrNull { it.sessionId == state.sessionId }
    val fullTitle = current?.title?.takeIf { it.isNotBlank() }
        ?: state.projectLabel() ?: "Current thread"
    val title = remember(fullTitle) { fullTitle.trim().split(Regex("\\s+")).take(2).joinToString(" ") }
    val clock = rememberLocalTime()
    val queued = state.queue.firstOrNull()
    // A blank base (or the checked-in documentation placeholder) is unpaired:
    // while disconnected on it, onboard instead of retrying.
    val showEndpointOnboarding = !state.connected && DeviceSettings.isPlaceholderEndpoint(state.base)

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val diameter = minOf(maxWidth, maxHeight)
        // Fractions anchor the composition, not fixed device pixels. On the GW4:
        // header y=32, status y=63, voice row y=103, utility capsule y=155.
        // Every circular control fits within the 99dp radius (including the
        // expanded 140x44 capsule: hypot(48,56)+22 = 95.8dp).
        Row(
            modifier = Modifier.align(Alignment.Center)
                .offset(y = diameter * -0.34f)
                .width(diameter * 0.64f).height(44.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                modifier = Modifier.weight(1f).fillMaxHeight()
                    .semantics(mergeDescendants = true) {
                        contentDescription = "Switch thread: $fullTitle"
                        stateDescription = if (state.connected) "Connected" else "Disconnected"
                    }
                    .clickable(role = Role.Button, onClick = onSessions),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                DshDot(if (state.connected) DshColors.connected else DshColors.disconnected, size = 4)
                Text(title, style = DshType.secondary.copy(color = DshColors.textSecondary, fontWeight = FontWeight.Medium),
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 5.dp))
            }
            Text(clock, style = DshType.secondary.copy(color = DshColors.textSecondary, fontFeatureSettings = "tnum"),
                maxLines = 1, modifier = Modifier.padding(start = 7.dp))
        }

        Row(
            modifier = Modifier.align(Alignment.Center).offset(y = diameter * -0.18f)
                // Centre the task label above the primary microphone control.
                .width(diameter * 0.55f).height(24.dp)
                .semantics { if (state.error != null) contentDescription = "$label. ${state.error}. Tap to dismiss error" }
                .clickable(enabled = state.error != null) {
                    Toast.makeText(context, state.error, Toast.LENGTH_LONG).show()
                    onDismissError()
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = DshType.body.copy(fontSize = 15.sp, lineHeight = 20.sp,
                fontWeight = FontWeight.Medium, letterSpacing = 0.sp,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center, color = color.copy(alpha = alpha)),
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (state.error != null && state.pending.isEmpty()) Text("!", style = DshType.title.copy(color = DshColors.danger), modifier = Modifier.padding(start = 4.dp))
        }

        if (state.pending.isNotEmpty()) {
            val count = state.pending.size
            Box(
                modifier = Modifier.align(Alignment.Center)
                    .offset(x = diameter * 0.34f, y = diameter * -0.18f)
                    .size(44.dp)
                    .semantics { contentDescription = "$count pending question${if (count == 1) "" else "s"}. Open choices" }
                    .clickable(role = Role.Button, onClick = onPending),
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.size(36.dp).clip(CircleShape).background(DshColors.surfaceHigh),
                    contentAlignment = Alignment.Center) {
                    Text(if (count == 1) "?" else if (count > 9) "9+" else "$count",
                        style = DshType.title.copy(color = DshColors.warning), maxLines = 1)
                }
            }
        }

        // The microphone is the primary action. Secondary controls share the
        // same stroke weight and neutral surface; no coloured background discs.
        // Touch controls are present on every profile: hardware behavior may
        // vary, but mic/stop/menu/steer never depend on it.
        if (showEndpointOnboarding) {
            Text("No bridge yet — pair with your Mac",
                style = DshType.secondary.copy(color = DshColors.warning),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.align(Alignment.Center).offset(y = diameter * -0.085f)
                    .width(diameter * 0.62f)
                    .clickable(role = Role.Button, onClick = onPair))
        }
        HomeControl(
            icon = if (state.voiceOutputEnabled) R.drawable.ic_speaker else R.drawable.ic_speaker_off,
            label = if (state.voiceOutputEnabled) "Mute voice output" else "Enable voice output",
            onClick = onVoiceOutputToggle,
            tint = if (state.voiceOutputEnabled) DshColors.textPrimary else DshColors.textTertiary,
            modifier = Modifier.align(Alignment.Center).offset(x = diameter * -0.28f, y = diameter * 0.02f),
        )
        HomeControl(
            icon = R.drawable.ic_mic,
            label = if (state.micOpen) "Turn microphone off" else "Turn microphone on",
            onClick = onMicToggle,
            tint = if (state.micOpen) DshColors.success else DshColors.danger,
            fill = DshColors.surfaceHigh,
            size = 54.dp, iconSize = 25.dp,
            modifier = Modifier.align(Alignment.Center).offset(y = diameter * 0.02f),
        )
        HomeControl(
            icon = R.drawable.ic_response, label = "Read response", onClick = onText,
            modifier = Modifier.align(Alignment.Center).offset(x = diameter * 0.28f, y = diameter * 0.02f),
        )

        Row(
            modifier = Modifier.align(Alignment.Center).offset(y = diameter * 0.283f)
                .width(if (queued != null) 140.dp else 100.dp).height(44.dp)
                .clip(RoundedCornerShape(50)).background(DshColors.surface),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            HomeControl(R.drawable.ic_stop, "Stop", onStop, fill = Color.Transparent, iconSize = 19.dp)
            if (queued != null) HomeControl(R.drawable.ic_steer, "Steer oldest queued message (${state.queue.size} queued)",
                { onSteer(queued.id) }, tint = DshColors.accent, fill = Color.Transparent)
            HomeControl(R.drawable.ic_more, "Open menu", onMenu, fill = Color.Transparent)
        }
    }
}

/** Local Home component so the redesign cannot alter controls on other screens. */
@Composable
private fun HomeControl(
    @DrawableRes icon: Int,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = DshColors.textPrimary,
    fill: Color = DshColors.surface,
    size: Dp = 44.dp,
    iconSize: Dp = 21.dp,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.94f else 1f, tween(110), label = "buttonPress")
    Box(
        modifier = modifier.size(size).scale(scale).clip(CircleShape).background(fill)
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(painterResource(icon), contentDescription = label, tint = tint, modifier = Modifier.size(iconSize))
    }
}

@Composable
private fun rememberLocalTime(): String {
    val context = LocalContext.current
    var now by remember { mutableStateOf(Date()) }

    // Re-read the platform formatter on every update so Android's 12/24-hour
    // preference and timezone changes are honored without a lifecycle leak.
    DisposableEffect(context) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                now = Date()
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_TIME_CHANGED)
            addAction(Intent.ACTION_TIMEZONE_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            context.registerReceiver(receiver, filter)
        }
        onDispose { context.unregisterReceiver(receiver) }
    }
    LaunchedEffect(Unit) {
        while (true) {
            now = Date()
            val untilNextMinute = 60_000L - (System.currentTimeMillis() % 60_000L)
            delay(untilNextMinute.coerceAtLeast(1_000L))
        }
    }
    return AndroidDateFormat.getTimeFormat(context).format(now)
}
