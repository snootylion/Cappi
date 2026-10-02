package dev.dsh.watch.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text
import dev.dsh.watch.core.UiState

/**
 * Projects: {cmd:"projects"} → rows (title primary, path secondary, session count) with a
 * per-row "New session here", a top "New session (default project)" and
 * "New session in path…" (routes to Type for a custom absolute cwd).
 */
@Composable
fun ProjectsScreen(
    state: UiState,
    onRefresh: () -> Unit,
    onNewDefault: () -> Unit,
    onNewInProject: (workspaceId: String?, path: String) -> Unit,
    onNewInPath: () -> Unit,
) {
    val listState = rememberScalingLazyListState()
    LaunchedEffect(Unit) { onRefresh() }

    ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxWidth()) {
        item {
            DshPill(
                label = "New session (default)",
                onClick = onNewDefault,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
            )
        }
        item {
            DshPill(
                label = "New session in path…",
                onClick = onNewInPath,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
            )
        }
        if (state.projects.isEmpty()) {
            item { DshEmpty("Loading…") }
        }
        items(state.projects.size) { i ->
            val p = state.projects[i]
            val title = p.title.ifEmpty { p.path.substringAfterLast('/') }
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = title,
                        style = DshType.body,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        text = "${p.sessions}",
                        style = DshType.secondary.copy(color = DshColors.success),
                        maxLines = 1,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
                if (p.path.isNotEmpty()) {
                    Text(
                        text = p.path,
                        style = DshType.caption,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                DshPill(
                    label = "New session here",
                    onClick = { onNewInProject(p.workspaceId, p.path) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp),
                )
            }
        }
    }
}
