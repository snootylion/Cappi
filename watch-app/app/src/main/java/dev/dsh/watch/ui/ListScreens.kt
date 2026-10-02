package dev.dsh.watch.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text
import dev.dsh.watch.core.Approval
import dev.dsh.watch.core.JobItem
import dev.dsh.watch.core.QueueLine
import dev.dsh.watch.core.TodoItem
import dev.dsh.watch.core.UiState

private fun todoGlyph(status: String): String = when (status) {
    "done", "completed" -> "●"
    "in_progress" -> "◐"
    else -> "○"
}

private fun statusColor(state: String): Color = when (state.lowercase()) {
    "done", "completed", "ok", "up", "running" -> DshColors.success
    "failed", "error", "down" -> DshColors.danger
    "in_progress", "active" -> DshColors.warning
    else -> DshColors.textSecondary
}

/** Full-width neutral pill (shared by the list screens). */
@Composable
private fun FullPill(label: String, onClick: () -> Unit) {
    DshPill(
        label = label,
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp),
    )
}

// ---------------------------------------------------------------- Todos

@Composable
fun TodosScreen(todos: List<TodoItem>, onRefresh: () -> Unit) {
    val listState = rememberScalingLazyListState()
    ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxWidth()) {
        item { FullPill(label = "Refresh", onClick = onRefresh) }
        if (todos.isEmpty()) {
            item { DshEmpty("No todos") }
        }
        items(todos.size) { i ->
            val t = todos[i]
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = todoGlyph(t.status),
                    style = DshType.title.copy(color = statusColor(t.status)),
                    maxLines = 1,
                )
                Text(
                    text = t.text,
                    style = DshType.body,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

// ---------------------------------------------------------------- Jobs / Agents

@Composable
fun JobsScreen(title: String, jobs: List<JobItem>, onRefresh: () -> Unit) {
    val listState = rememberScalingLazyListState()
    ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxWidth()) {
        item { FullPill(label = "Refresh", onClick = onRefresh) }
        if (jobs.isEmpty()) {
            item { DshEmpty("No $title") }
        }
        items(jobs.size) { i ->
            val j = jobs[i]
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = j.label.ifEmpty { j.id },
                    style = DshType.body,
                    textAlign = TextAlign.Center,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = j.state,
                    style = DshType.secondary.copy(color = statusColor(j.state)),
                    maxLines = 1,
                )
            }
        }
    }
}

// ---------------------------------------------------------------- Status

@Composable
fun StatusScreen(
    state: UiState,
    onRefresh: () -> Unit,
    onMuteToggle: () -> Unit,
    onStopVoice: () -> Unit,
    onTestTts: () -> Unit,
    onPing: () -> Unit,
    pingResult: String?,
    onOpenPermissions: () -> Unit,
) {
    val listState = rememberScalingLazyListState()
    ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxWidth()) {
        item {
            Text(
                text = "base: ${state.base}",
                style = DshType.secondary,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
            )
        }
        item {
            StatusRow(
                "sse",
                if (state.connected) "up" else "down",
                if (state.connected) DshColors.success else DshColors.danger,
            )
        }
        item {
            StatusRow(
                "session",
                (if (state.sessionRunning) "running" else "idle") +
                    if (state.sessionId.isNotEmpty()) " · …" + state.sessionId.takeLast(8) else "",
                statusColor(if (state.sessionRunning) "running" else "idle"),
            )
        }
        item {
            // Safety-relevant current preset → opens the Permissions screen.
            DshPill(
                label = "Preset · ${permissionLabel(state.permissions?.currentValue)}",
                onClick = onOpenPermissions,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
            )
        }
        item {
            StatusRow(
                "voice",
                "${state.serverVoicePhase}${if (state.macMuted) " · muted" else ""} · ${if (state.voiceActive) "active" else "off"}",
                if (state.macMuted) DshColors.warning else DshColors.textPrimary,
            )
        }
        item {
            StatusRow("queue", "${state.queue.size}", DshColors.accent)
        }
        if (state.helperState.isNotEmpty()) {
            item { StatusRow("helper", state.helperState, DshColors.textPrimary) }
        }
        pingResult?.let { r ->
            item {
                Text(
                    text = r,
                    style = DshType.label.copy(
                        color = if (r.startsWith("OK")) DshColors.success else DshColors.danger,
                    ),
                    textAlign = TextAlign.Center,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        item { FullPill(label = "Refresh", onClick = onRefresh) }
        item { FullPill(label = "Test TTS", onClick = onTestTts) }
        item {
            if (state.macMuted) {
                DshPillTinted(
                    label = "Mute · on",
                    onClick = onMuteToggle,
                    tint = DshColors.warning,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp),
                )
            } else {
                DshPill(
                    label = "Mute · off",
                    onClick = onMuteToggle,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp),
                )
            }
        }
        item {
            DshPillTinted(
                label = "Stop voice",
                onClick = onStopVoice,
                tint = DshColors.danger,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
            )
        }
        item { FullPill(label = "Ping", onClick = onPing) }
    }
}

@Composable
private fun StatusRow(label: String, value: String, valueColor: Color) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = label, style = DshType.label.copy(color = DshColors.textSecondary), maxLines = 1)
        Text(
            text = value,
            style = DshType.label.copy(color = valueColor),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.End,
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

// ---------------------------------------------------------------- Queue (shared row rendering)

@Composable
fun QueueRowText(q: QueueLine) {
    Text(
        text = q.text,
        style = DshType.body,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth(),
    )
}
