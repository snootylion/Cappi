package dev.dsh.watch.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text
import dev.dsh.watch.core.SessionRow
import dev.dsh.watch.core.UiState

/**
 * Sessions/threads: {cmd:"sessions"} (command-only, no SSE event) → rows with title/short id,
 * workspace-or-cwd secondary line, running dot, active-pin highlight. Tap pins the session;
 * Auto-follow clears the pin. Subagent rows are filtered out.
 */
@Composable
fun SessionsScreen(
    state: UiState,
    onRefresh: () -> Unit,
    onSelect: (String) -> Unit,
    onAuto: () -> Unit,
    onNew: () -> Unit,
) {
    val listState = rememberScalingLazyListState()
    LaunchedEffect(Unit) { onRefresh() } // pull on entry (fetchState refresh + sessions)

    val visible = state.sessions.filter { !it.subagent }
        .sortedByDescending { it.sessionId == state.sessionId }
    ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxWidth()) {
        item { Text("Switch thread", style = DshType.title) }
        item { DshPill("+ New thread", onClick = onNew,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp)) }
        item {
            DshPill(
                label = "Auto-follow",
                onClick = onAuto,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
            )
        }
        item {
            DshPill(
                label = "Refresh",
                onClick = onRefresh,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
            )
        }
        if (visible.isEmpty()) {
            item { DshEmpty(if (state.sessions.isEmpty()) "Loading…" else "No sessions") }
        }
        items(visible.size) { i ->
            val row = visible[i]
            SessionRowView(
                row = row,
                active = row.sessionId == state.sessionId,
                secondary = sessionSecondary(row, state),
                onClick = { onSelect(row.sessionId) },
            )
        }
    }
}

/** Secondary line: workspace title (via state.workspaces membership) else cwd basename. */
private fun sessionSecondary(row: SessionRow, state: UiState): String {
    val wsTitle = row.workspaceId?.let { id ->
        state.workspaces.firstOrNull { it.workspaceId == id }?.title?.takeIf { t -> t.isNotEmpty() }
    }
    return wsTitle ?: row.cwd?.substringAfterLast('/') ?: ""
}

@Composable
private fun SessionRowView(
    row: SessionRow,
    active: Boolean,
    secondary: String,
    onClick: () -> Unit,
) {
    DshCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
        background = if (active) DshColors.surfaceHigh else DshColors.surface,
        onClick = onClick,
    ) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        DshDot(
            color = if (row.running) DshColors.success else DshColors.textTertiary,
            size = 7,
        )
        Column(modifier = Modifier.weight(1f)) {
            if (active) Text("Current thread", style = DshType.caption.copy(color = DshColors.accent))
            Text(
                text = row.title?.takeIf { it.isNotBlank() } ?: ("Thread · " + row.sessionId.takeLast(6)),
                style = DshType.body.copy(color = if (active) DshColors.accent else DshColors.textPrimary),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (secondary.isNotEmpty()) {
                Text(
                    text = secondary,
                    style = DshType.secondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (active) {
            Text("✓", style = DshType.label.copy(color = DshColors.accent))
        }
    }
    }
}
