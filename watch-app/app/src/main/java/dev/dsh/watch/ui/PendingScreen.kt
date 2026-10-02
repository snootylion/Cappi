package dev.dsh.watch.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Text
import dev.dsh.watch.core.Approval

/** Only visible while harness approvals or questions exist. No automatic answer. */
@Composable
fun PendingScreen(
    pending: List<Approval>,
    onApprove: (requestId: String, choiceId: String, freeText: String?) -> Unit,
    onApproveChoices: (requestId: String, choices: List<String>) -> Unit,
    onTypeAnswer: (requestId: String) -> Unit,
    onDismiss: (Approval) -> Unit,
) {
    if (pending.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { DshEmpty("Nothing pending") }
        return
    }
    // A regular scroll column starts at the top of the question. A single tall
    // ScalingLazyColumn item centres its middle and clips the question heading.
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 30.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Pending · ${pending.size}", style = DshType.secondary,
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        pending.forEach { item ->
            var selected by remember(item.id, item.title) { mutableStateOf(emptySet<String>()) }
            var confirmDismiss by remember(item) { mutableStateOf(false) }
            Spacer(Modifier.height(4.dp))
            Text(item.title, style = DshType.body.copy(color = DshColors.textPrimary),
                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            if (!item.detail.isNullOrBlank()) {
                Text(item.detail!!, style = DshType.secondary, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth())
            }
            if (item.kind == "approval") {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                    DshPillTinted("Allow once", { onApprove(item.id, "allowed-once", null) }, DshColors.success,
                        modifier = Modifier.weight(1f))
                    DshPillTinted("Deny", { onApprove(item.id, "deny", null) }, DshColors.danger,
                        modifier = Modifier.weight(1f))
                }
            } else {
                item.options.filter { it.id != "_free" }.forEach { option ->
                    DshPill(
                        label = if (item.multi && option.id in selected) "✓ ${option.label}" else option.label,
                        onClick = {
                            if (item.multi) selected = if (option.id in selected) selected - option.id else selected + option.id
                            else onApprove(item.id, option.id, null)
                        },
                        tint = if (item.multi && option.id in selected) DshColors.success else DshColors.accent,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (item.multi) {
                    DshPillTinted(
                        label = "Confirm ${selected.size} selected",
                        onClick = { if (selected.isNotEmpty()) onApproveChoices(item.id, selected.toList()) },
                        tint = if (selected.isEmpty()) DshColors.textTertiary else DshColors.accent,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                DshPill("Dictate or type answer", { onTypeAnswer(item.id) }, modifier = Modifier.fillMaxWidth())
            }
            if (confirmDismiss) {
                Text("Hide on watch only. No answer or cancellation is sent.",
                    style = DshType.secondary, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                    DshPill("Keep", { confirmDismiss = false }, modifier = Modifier.weight(1f))
                    DshPill("Dismiss", { onDismiss(item) }, tint = DshColors.warning,
                        modifier = Modifier.weight(1f))
                }
            } else {
                DshPill("Dismiss from watch", { confirmDismiss = true },
                    tint = DshColors.textSecondary, modifier = Modifier.fillMaxWidth())
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}
