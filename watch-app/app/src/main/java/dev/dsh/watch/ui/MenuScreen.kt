package dev.dsh.watch.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.Text
import dev.dsh.watch.R

/** Route → stroke icon (duplicate icons across entries are fine; labels disambiguate). */
private fun iconFor(route: String): Int? = when (route) {
    "todos" -> R.drawable.ic_todo
    "jobs" -> R.drawable.ic_pulse
    "agents" -> R.drawable.ic_play
    "pending" -> R.drawable.ic_shield
    "queue" -> R.drawable.ic_list
    "sessions" -> R.drawable.ic_threads
    "models" -> R.drawable.ic_sliders
    "projects" -> R.drawable.ic_folder
    "permissions" -> R.drawable.ic_sliders
    "buttons" -> R.drawable.ic_sliders
    "avatar-toggle" -> R.drawable.ic_image
    "connection" -> R.drawable.ic_pulse
    "wifi-settings" -> R.drawable.ic_sliders
    "status" -> R.drawable.ic_pulse
    "settings" -> R.drawable.ic_sliders
    "images" -> R.drawable.ic_image
    "type" -> R.drawable.ic_keyboard
    else -> null
}

@Composable
fun MenuScreen(entries: List<MenuEntry>, onNavigate: (String) -> Unit) {
    val listState = rememberScalingLazyListState()
    ScalingLazyColumn(
        state = listState,
        modifier = Modifier.fillMaxWidth(),
    ) {
        items(entries.size) { i ->
            val e = entries[i]
            val icon = iconFor(e.route)
            DshCard(
                onClick = { onNavigate(e.route) },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (icon != null) {
                        Icon(
                            painter = painterResource(icon),
                            contentDescription = null,
                            tint = DshColors.accent,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    Text(
                        text = e.label,
                        style = DshType.label,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (e.count > 0) {
                        Text(
                            text = "${e.count}",
                            style = DshType.caption,
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }
}
