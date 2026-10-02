package dev.dsh.watch.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text
import dev.dsh.watch.core.QueueLine

/**
 * Queue: tap a row → inline actions [Send now] [Remove]; Clear all in header.
 * Crown scrolls the list (built-in rotary).
 */
@Composable
fun QueueScreen(
    queue: List<QueueLine>,
    onSteer: (id: String) -> Unit,
    onRemove: (id: String) -> Unit,
    onClear: () -> Unit,
) {
    val listState = rememberScalingLazyListState()
    var expandedId by remember { mutableStateOf<String?>(null) }

    if (queue.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            DshEmpty("Queue empty")
        }
        return
    }

    ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxWidth()) {
        item {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(text = "Queue", style = DshType.title, maxLines = 1)
                Text(
                    text = "${queue.size}",
                    style = DshType.label.copy(color = DshColors.accent),
                    maxLines = 1,
                )
            }
        }
        item {
            DshPillTinted(
                label = "Clear all",
                onClick = onClear,
                tint = DshColors.danger,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
            )
        }
        items(queue.size) { i ->
            val q = queue[i]
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                QueueRowText(q)
                Text(
                    text = q.state,
                    style = DshType.secondary,
                    maxLines = 1,
                    textAlign = TextAlign.Center,
                )
                if (expandedId == q.id) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        DshPillTinted(
                            label = "Send now",
                            onClick = {
                                expandedId = null
                                onSteer(q.id)
                            },
                            tint = DshColors.accent,
                            modifier = Modifier.weight(1f),
                        )
                        DshPillTinted(
                            label = "Remove",
                            onClick = {
                                expandedId = null
                                onRemove(q.id)
                            },
                            tint = DshColors.danger,
                            modifier = Modifier.weight(1f),
                        )
                    }
                } else {
                    Text(
                        text = "tap for actions",
                        style = DshType.caption,
                        maxLines = 1,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .clickable { expandedId = q.id }
                            .padding(top = 2.dp),
                    )
                }
            }
        }
    }
}
