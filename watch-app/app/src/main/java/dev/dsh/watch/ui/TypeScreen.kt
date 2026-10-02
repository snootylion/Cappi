package dev.dsh.watch.ui

import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Text

/** Dictation fills a local draft. Only the explicit Send answer button answers the harness. */
@Composable
fun TypeScreen(
    pendingRequestId: String?,
    pendingTitle: String?,
    onSubmit: (text: String) -> Unit,
    onApproveFree: (requestId: String, text: String, onSuccess: () -> Unit) -> Unit,
    onSent: () -> Unit,
    questionActive: Boolean = true,
    dictating: Boolean = false,
    dictationSettling: Boolean = false,
    dictationPartial: String = "",
    dictationFinal: String = "",
    dictationRevision: Int = 0,
    mainMicOn: Boolean = false,
    onStopMainMic: () -> Unit = {},
    onDictate: () -> Unit = {},
    onStopDictation: () -> Unit = {},
) {
    var text by remember(pendingRequestId) { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(pendingRequestId) {
        // The regular Type screen opens the keyboard. Answer mode leaves the
        // mic and Send controls visible; tapping the field still opens the IME.
        if (pendingRequestId == null) runCatching {
            focusRequester.requestFocus()
            keyboard?.show()
        }
    }
    LaunchedEffect(dictationRevision, pendingRequestId) {
        if (pendingRequestId != null && dictationRevision > 0 && dictationFinal.isNotBlank()) {
            text = listOf(text.trim(), dictationFinal.trim()).filter { it.isNotEmpty() }.joinToString(" ")
        }
    }

    fun send() {
        val answer = text.trim()
        if (answer.isEmpty() || dictating || dictationSettling || !questionActive) return
        if (pendingRequestId != null) onApproveFree(pendingRequestId, answer, onSent)
        else {
            onSubmit(answer)
            onSent()
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = pendingTitle?.takeIf { it.isNotEmpty() } ?: "Send",
            style = DshType.body,
            maxLines = 5,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth(),
        )
        if (!questionActive) {
            Text("Question changed or closed. Go back and reopen it.", style = DshType.secondary)
            return@Column
        }
        BasicTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp)
                .focusRequester(focusRequester).focusable(),
            textStyle = DshType.title,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { keyboard?.hide() }),
            decorationBox = { inner ->
                if (text.isEmpty()) Text("Your answer…", style = DshType.secondary)
                inner()
            },
        )
        if (pendingRequestId != null) {
            if (dictating || dictationSettling || dictationPartial.isNotBlank()) {
                Text(
                    if (dictationSettling) "Finishing dictation…" else dictationPartial.ifBlank { "Listening…" },
                    style = DshType.secondary.copy(color = DshColors.accent),
                    maxLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (mainMicOn) {
                Text("The main mic sends prompts. Turn it off before dictating an answer.", style = DshType.secondary)
                DshPill("Turn off main mic", onStopMainMic, modifier = Modifier.fillMaxWidth())
            } else {
                DshPill(
                    label = if (dictating) "Stop dictation" else "Dictate answer",
                    onClick = if (dictating) onStopDictation else onDictate,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        DshPillTinted(
            label = if (pendingRequestId != null) "Send answer" else "Send",
            onClick = { send() },
            tint = if (text.isNotBlank() && !dictating && !dictationSettling) DshColors.accent else DshColors.textTertiary,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
