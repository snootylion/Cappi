package dev.dsh.watch.ui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.text.format.DateFormat
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Text
import java.util.Date
import kotlinx.coroutines.delay

/** The offline HOME face. Tap anywhere to reach the Reconnect menu action. */
@Composable
fun OfflineClockScreen(onMenu: () -> Unit) {
    val context = LocalContext.current
    var now by remember { mutableStateOf(Date()) }
    DisposableEffect(context) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) { now = Date() }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_TIME_CHANGED)
            addAction(Intent.ACTION_TIMEZONE_CHANGED)
            addAction(Intent.ACTION_DATE_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            context.registerReceiver(receiver, filter)
        }
        onDispose { context.unregisterReceiver(receiver) }
    }
    LaunchedEffect(Unit) {
        while (true) {
            now = Date()
            delay((60_000L - System.currentTimeMillis() % 60_000L).coerceAtLeast(1_000L))
        }
    }
    val time = DateFormat.getTimeFormat(context).format(now)
    val date = DateFormat.format("EEE, d MMM", now).toString()
    Box(
        Modifier.fillMaxSize().semantics { contentDescription = "$time, $date. Tap to open reconnect menu" }
            .clickable(role = Role.Button, onClick = onMenu),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(time, style = DshType.display.copy(fontSize = 38.sp, fontWeight = FontWeight.Light,
                letterSpacing = (-1.1).sp, color = DshColors.textPrimary), textAlign = TextAlign.Center, maxLines = 1)
            Text(date, style = DshType.secondary.copy(fontSize = 12.sp, color = DshColors.textSecondary),
                textAlign = TextAlign.Center, maxLines = 1)
        }
    }
}
