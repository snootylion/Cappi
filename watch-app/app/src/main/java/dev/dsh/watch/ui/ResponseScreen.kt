package dev.dsh.watch.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Text
import dev.dsh.watch.core.UiState

/** Read the current turn as it streams, or its completed response, without truncation. */
@Composable
fun ResponseScreen(state: UiState) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 30.dp, vertical = 36.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Interim vs final is always labeled: `assistantDone` flips true only on
        // the turn's authoritative final (turn/end or reconnect snapshot).
        val title = when {
            state.assistantDone -> "Final response"
            state.assistantText.isNotBlank() -> "Response (interim)"
            else -> "Response"
        }
        Text(title, style = DshType.title)
        if (state.error != null) Text(state.error, style = DshType.secondary.copy(color = DshColors.danger))
        if (state.assistantText.isBlank()) {
            DshEmpty(if (state.sessionRunning) "Waiting for response…" else "No response yet")
        } else {
            Text(state.assistantText, style = DshType.body, modifier = Modifier.fillMaxWidth())
            when {
                state.assistantDone -> Unit // labeled "Final response" above
                state.sessionRunning -> Text("Working…", style = DshType.caption.copy(color = DshColors.accent))
                else -> Text("Interim — final not received yet", style = DshType.caption)
            }
        }
        if (state.partialText.isNotBlank()) {
            DshSectionLabel("You said")
            Text(state.partialText, style = DshType.secondary, modifier = Modifier.fillMaxWidth())
        }
    }
}
