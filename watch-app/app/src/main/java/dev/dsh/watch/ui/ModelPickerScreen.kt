package dev.dsh.watch.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text
import dev.dsh.watch.core.ModelScope
import dev.dsh.watch.core.UiState
import dev.dsh.watch.core.modelScope

/** The target is captured once, never rebound when the followed thread changes. */
@Composable
fun ModelPickerScreen(
    state: UiState,
    onOpen: (ModelScope) -> Unit,
    onClose: (ModelScope) -> Unit,
    onRefresh: (ModelScope) -> Unit,
    onSet: (ModelScope, String) -> Unit,
    onSetReasoning: (ModelScope, String, String) -> Unit,
) {
    val scope = remember { state.modelScope() }
    LaunchedEffect(scope) { onOpen(scope) }
    DisposableEffect(scope) { onDispose { onClose(scope) } }
    val picker = state.modelPicker?.takeIf { it.scope == scope }
    val stale = !scope.matches(state) || picker?.invalidated == true || scope.sessionId.isBlank()
    val offline = !state.connected || state.offlineClock
    val catalog = picker?.catalog?.takeUnless { stale }
    val selected = catalog?.options?.firstOrNull { it.value == catalog.currentValue }
    val currentName = selected?.name ?: catalog?.current?.model ?: "Unknown"
    val currentProvider = selected?.providerName ?: selected?.provider ?: catalog?.current?.provider
    val busy = picker?.busy == true
    val refreshable = picker != null && !stale && !offline && !busy
    val currentModelId = catalog?.currentValue
    val reasoning = catalog?.reasoning?.takeIf { it.modelId == currentModelId }
    val effortName = reasoning?.options?.firstOrNull { it.value == reasoning.currentValue }?.name
        ?: catalog?.current?.reasoningEffort ?: "Unknown"
    // Model identity is a reset key: never keep an old model's choices expanded.
    var reasoningExpanded by remember(currentModelId) { mutableStateOf(false) }
    val canExpandReasoning = refreshable && picker?.error == null && currentModelId != null &&
        reasoning?.adjustable == true && reasoning.options.size > 1

    ScalingLazyColumn(state = rememberScalingLazyListState(), modifier = Modifier.fillMaxWidth()) {
        item {
            Column(horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp)) {
                Text(if (catalog != null && picker?.error != null) "Last confirmed model" else "Current model",
                    style = DshType.caption)
                Text(currentName, style = DshType.title, textAlign = TextAlign.Center,
                    maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (currentProvider != null) Text(currentProvider, style = DshType.caption,
                    maxLines = 2, textAlign = TextAlign.Center, overflow = TextOverflow.Ellipsis)
                Text("This thread · ${scope.sessionId.take(8)}", style = DshType.caption,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(catalog?.scopeHint ?: "Also used for new or unconfigured threads",
                    style = DshType.caption, textAlign = TextAlign.Center)
                if (state.sessionRunning && !stale) Text("Applies to next request",
                    style = DshType.caption.copy(color = DshColors.warning), textAlign = TextAlign.Center)
            }
        }
        val message = when {
            stale -> "Thread or connection changed. Reopen Switch model."
            offline -> "Offline — reconnect to load models"
            picker?.applyingReasoning != null -> "Applying reasoning…"
            picker?.applying != null -> "Applying model…"
            picker?.loading == true -> "Loading models…"
            picker?.error != null -> picker.error
            catalog?.options?.isEmpty() == true -> "No models available"
            catalog == null -> "Model details unavailable"
            else -> null
        }
        if (message != null) item {
            Text(message, style = DshType.caption.copy(color = if (picker?.error != null || stale)
                DshColors.warning else DshColors.textSecondary), textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp))
        }
        if (catalog != null) {
            item {
                DshCard(modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
                    onClick = if (canExpandReasoning) ({ reasoningExpanded = !reasoningExpanded }) else null) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)) {
                        Text("Reasoning effort", style = DshType.caption)
                        Text(effortName + if (canExpandReasoning) (if (reasoningExpanded) " ▴" else " ▾") else "",
                            style = DshType.body, textAlign = TextAlign.Center,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (reasoning == null || !reasoning.adjustable || reasoning.options.size <= 1) {
                            Text(reasoning?.unavailableReason ?: when {
                                reasoning == null -> "Reasoning details unavailable"
                                reasoning.options.size == 1 -> "Fixed for this model"
                                else -> "Not configurable for this model"
                            }, style = DshType.caption, textAlign = TextAlign.Center)
                        }
                    }
                }
            }
            if (reasoningExpanded && reasoning?.adjustable == true && reasoning.options.size > 1) {
                items(reasoning.options.size) { index ->
                    val option = reasoning.options[index]
                    val current = option.value == reasoning.currentValue
                    val enabled = currentModelId != null && picker?.canSetReasoning(state, currentModelId, option.value) == true
                    DshCard(modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
                        background = if (current) DshColors.surfaceHigh else DshColors.surface,
                        onClick = if (enabled && currentModelId != null) ({
                            onSetReasoning(scope, currentModelId, option.value)
                            reasoningExpanded = false
                        }) else null) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)) {
                            Text(option.name + if (current) " ✓" else "", style = DshType.body.copy(color = when {
                                current -> DshColors.success
                                enabled -> DshColors.textPrimary
                                else -> DshColors.textSecondary
                            }), textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            option.description?.let { Text(it, style = DshType.caption,
                                textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                        }
                    }
                }
            }
        }
        item {
            DshCard(modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
                onClick = if (refreshable) ({ onRefresh(scope) }) else null) {
                Text("Refresh", style = DshType.label.copy(color = if (refreshable) DshColors.accent
                    else DshColors.textSecondary), modifier = Modifier.padding(12.dp))
            }
        }
        val options = catalog?.options.orEmpty()
        items(options.size) { index ->
            val option = options[index]
            val current = option.value == catalog?.currentValue
            val enabled = picker?.canSelect(state, option.value) == true
            DshCard(modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
                background = if (current) DshColors.surfaceHigh else DshColors.surface,
                onClick = if (enabled) ({ onSet(scope, option.value) }) else null) {
                Column(horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)) {
                    Text(option.name + if (current) " ✓" else "", style = DshType.body.copy(color = when {
                        current -> DshColors.success
                        enabled -> DshColors.textPrimary
                        else -> DshColors.textSecondary
                    }), maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                    val provider = option.providerName ?: option.provider
                    if (provider != null) Text(provider, style = DshType.caption,
                        maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                }
            }
        }
    }
}
