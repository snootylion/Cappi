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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text
import dev.dsh.watch.core.UiState

/** Display label for a permission preset value (incl. derived "Custom"). */
fun permissionLabel(value: String?): String = when (value) {
    "read-only" -> "Read only"
    "workspace-write" -> "Workspace write"
    "danger-full-access" -> "Full access"
    null, "" -> "Unknown"
    else -> "Custom"
}

/** Preset colours from the shared token palette. */
fun permissionColor(value: String?): Color = when (value) {
    "read-only" -> DshColors.accent
    "workspace-write" -> DshColors.success
    "danger-full-access" -> DshColors.danger
    else -> DshColors.textSecondary
}

/**
 * Permission preset switcher: current preset big at top (derived "Custom" shown when
 * currentValue matches no option — display-only, not tappable), option rows below with
 * the harness's own descriptions. Tap → {cmd:"set-permission"}; the permissions SSE event
 * updates the UI (local apply covers the gap). Refreshes state on entry.
 */
@Composable
fun PermissionsScreen(
    state: UiState,
    onRefresh: () -> Unit,
    onSet: (String) -> Unit,
) {
    val listState = rememberScalingLazyListState()
    LaunchedEffect(Unit) { onRefresh() }

    val perms = state.permissions
    val current = perms?.currentValue
    val isCustom = perms != null && current != null && current.isNotEmpty() &&
        perms.options.none { it.value == current }

    ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxWidth()) {
        item {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = "Permission preset",
                    style = DshType.caption,
                    maxLines = 1,
                )
                Text(
                    text = permissionLabel(current),
                    style = DshType.display.copy(color = permissionColor(current)),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (isCustom) {
                    Text(
                        text = "custom · view only",
                        style = DshType.caption,
                        maxLines = 1,
                    )
                }
            }
        }
        when {
            perms == null -> item { DshEmpty("Waiting for permissions…") }
            perms.options.isEmpty() -> item { DshEmpty("No presets available") }
            else -> items(perms.options.size) { i ->
                val o = perms.options[i]
                val isCurrent = o.value == current
                val desc = o.description
                val onTap: (() -> Unit)? = if (isCurrent) null else { { onSet(o.value) } }
                DshCard(
                    onClick = onTap,
                    background = if (isCurrent) DshColors.surfaceHigh else DshColors.surface,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp),
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                text = o.name,
                                style = DshType.body.copy(
                                    color = if (isCurrent) permissionColor(o.value) else DshColors.textPrimary,
                                ),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (isCurrent) {
                                Text(
                                    text = "✓",
                                    style = DshType.label.copy(color = permissionColor(o.value)),
                                    maxLines = 1,
                                )
                            }
                        }
                        if (!desc.isNullOrEmpty()) {
                            Text(
                                text = desc,
                                style = DshType.caption,
                                textAlign = TextAlign.Center,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}
