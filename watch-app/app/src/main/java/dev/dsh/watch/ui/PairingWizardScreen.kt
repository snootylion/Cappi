package dev.dsh.watch.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Text
import dev.dsh.watch.core.BridgeViewModel
import dev.dsh.watch.core.PairingCenter
import dev.dsh.watch.net.PairingTransport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Turnkey pairing wizard (W-owned). Default screen while unpaired — the raw
 * base/token/pin fields live ONLY under Advanced (legacy manual entry).
 *
 * Flow: Scan (untrusted candidates, liveness only) → Compare (handshake
 * fingerprint vs Mac DSH Settings, full + 96-bit short) → Watch Confirm
 * (BEFORE secret generation/enroll) → Wait (Mac approval, bounded TTL
 * backoff) → Done. Nothing persists until an approved poll whose pin matches
 * the confirmed record AND the live handshake pin.
 */
@Composable
fun PairingWizardScreen(
    vm: BridgeViewModel,
    deviceAliasDefault: String,
    onPaired: () -> Unit,
    onOpenAdvanced: () -> Unit,
) {
    var stage by remember { mutableStateOf("scan") }
    var candidates by remember { mutableStateOf<List<String>>(emptyList()) }
    var scanning by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<PairingTransport.PairInfoResult?>(null) }
    var infoError by remember { mutableStateOf<String?>(null) }
    var alias by remember { mutableStateOf(deviceAliasDefault) }
    var record by remember { mutableStateOf<PairingCenter.ImmutableRecord?>(null) }
    var requestId by remember { mutableStateOf<String?>(null) }
    var expiresAtMs by remember { mutableStateOf(0L) }
    var pollError by remember { mutableStateOf<String?>(null) }
    var failures by remember { mutableStateOf(0) }
    var showFull by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun scan() {
        scanning = true
        infoError = null
        scope.launch(Dispatchers.IO) {
            val found = PairingTransport.scanCandidates(3000)
            withContext(Dispatchers.Main) {
                candidates = found
                scanning = false
                if (found.isEmpty()) {
                    infoError = "No bridge found on this Wi-Fi — check the Mac is on the same network, or enter the address under Advanced"
                }
            }
        }
    }

    LaunchedEffect(Unit) { scan() }

    fun fetchCandidate(base: String) {
        selected = base
        info = null
        infoError = null
        scope.launch(Dispatchers.IO) {
            try {
                val got = PairingTransport.fetchPairInfo(base)
                withContext(Dispatchers.Main) {
                    info = got
                    stage = "compare"
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    failures++
                    infoError = if ((e.message ?: "").contains("trust-mismatch", ignoreCase = true)) {
                        "Trust mismatch — this device is NOT your Mac. Nothing saved."
                    } else if ((e.message ?: "").contains("404", ignoreCase = true)) {
                        "Install LiveVoice and Cappi in DSH Settings on the Mac first, then scan again"
                    } else {
                        "Could not verify $base — ${e.message ?: "unreachable"}"
                    }
                }
            }
        }
    }

    fun confirmAndEnroll() {
        val current = info ?: return
        val aliasErr = PairingCenter.validateAlias(alias)
        if (aliasErr != null) {
            infoError = aliasErr
            return
        }
        val rec = try {
            PairingCenter.confirmRecord(
                selected ?: return, current.handshakePin,
                current.fullFingerprint, current.shortFingerprint,
                userConfirmed = true,
            )
        } catch (e: IllegalArgumentException) {
            infoError = e.message
            return
        }
        record = rec
        pollError = null
        scope.launch(Dispatchers.IO) {
            try {
                val secret = PairingCenter.newEnrollmentSecret(rec)
                val enrolled = PairingTransport.enroll(rec.baseUrl, rec.certSha256Pin, alias.trim(), secret)
                // Keep the single-use secret in memory only for the poll loop.
                withContext(Dispatchers.Main) {
                    requestId = enrolled.requestId
                    expiresAtMs = enrolled.expiresAtMs
                    stage = "wait"
                }
                pollLoop(vm, rec, enrolled.requestId, secret, enrolled.expiresAtMs,
                    onApproved = { approved, livePin ->
                        // Thread the per-round LIVE handshake pin (never the
                        // approved pin itself) + TTL guard: a late/rotated
                        // approved never persists. Persist row reuses the
                        // immutable confirmed base + pin only.
                        val row = PairingCenter.approvedPersistIfFresh(
                            rec, livePin, approved, enrolled.expiresAtMs,
                            System.currentTimeMillis(),
                        )
                        if (row == null) {
                            pollError = "Certificate changed during approval — nothing saved. Start pairing again."
                            stage = "compare"
                        } else {
                            vm.persistPairing(row)
                            stage = "done"
                            onPaired()
                        }
                    },
                    onTerminal = { msg ->
                        pollError = msg
                        if (msg.contains("expired", ignoreCase = true) ||
                            msg.contains("denied", ignoreCase = true) ||
                            msg.contains("replay", ignoreCase = true)
                        ) {
                            stage = "compare"
                        }
                    })
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    failures++
                    pollError = e.message ?: "enroll failed"
                    stage = "compare"
                }
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 26.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = "Pair with Mac", style = DshType.title, maxLines = 1)
        when (stage) {
            "scan" -> {
                Text("Finds your Mac on this Wi-Fi. Nothing is sent until you confirm its fingerprint.",
                    style = DshType.caption, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(vertical = 6.dp))
                if (scanning) {
                    Text("Scanning…", style = DshType.body, modifier = Modifier.padding(top = 8.dp))
                } else {
                    DshPill(label = "Scan again", onClick = { scan() },
                        modifier = Modifier.padding(top = 8.dp))
                }
                for (c in candidates) {
                    DshPill(label = if (c == selected) "✓ $c" else c,
                        onClick = { fetchCandidate(c) },
                        modifier = Modifier.padding(top = 8.dp))
                }
                infoError?.let {
                    Text(it, style = DshType.label.copy(color = DshColors.danger),
                        textAlign = TextAlign.Center, maxLines = 4,
                        overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                }
                PairingCenter.attemptsText(failures)?.let {
                    Text(it, style = DshType.caption, textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 6.dp))
                }
                DshPill(label = "Advanced", onClick = onOpenAdvanced,
                    modifier = Modifier.padding(top = 10.dp))
                Text("Manual address + legacy fields live under Advanced only.",
                    style = DshType.caption, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(vertical = 6.dp))
            }
            "compare" -> {
                val current = info
                if (current == null) {
                    Text("Verifying…", style = DshType.body, modifier = Modifier.padding(top = 8.dp))
                } else {
                    Text("On the Mac, open DSH Settings and compare the same fingerprint. Confirm ONLY on match.",
                        style = DshType.caption, textAlign = TextAlign.Center,
                        modifier = Modifier.padding(vertical = 6.dp))
                    Text(current.serverDisplayName, style = DshType.secondary,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(current.shortFingerprint, style = DshType.title, maxLines = 2,
                        textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
                    DshPill(label = if (showFull) "Hide full" else "Show full",
                        onClick = { showFull = !showFull },
                        modifier = Modifier.padding(top = 8.dp))
                    if (showFull) {
                        Text(current.fullFingerprint, style = DshType.caption,
                            textAlign = TextAlign.Center, maxLines = 5,
                            modifier = Modifier.padding(top = 6.dp))
                    }
                    SettingNameField(label = "name", value = alias, onChange = { alias = it })
                    DshPill(label = "Confirm — this is my Mac",
                        onClick = { confirmAndEnroll() },
                        modifier = Modifier.padding(top = 10.dp))
                    DshPill(label = "Back", onClick = { stage = "scan"; record = null },
                        modifier = Modifier.padding(top = 8.dp))
                    (infoError ?: pollError)?.let {
                        Text(it, style = DshType.label.copy(color = DshColors.danger),
                            textAlign = TextAlign.Center, maxLines = 4,
                            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                    }
                }
            }
            "wait" -> {
                Text("Waiting for Mac approval — approve this device in DSH Settings on the Mac.",
                    style = DshType.caption, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(vertical = 6.dp))
                Text("Request ends automatically if not approved in time.",
                    style = DshType.caption, textAlign = TextAlign.Center)
                pollError?.let {
                    Text(it, style = DshType.label.copy(color = DshColors.danger),
                        textAlign = TextAlign.Center, maxLines = 3,
                        modifier = Modifier.padding(top = 6.dp))
                }
                DshPill(label = "Cancel", onClick = { stage = "compare"; requestId = null },
                    modifier = Modifier.padding(top = 10.dp))
            }
            "done" -> {
                Text("Paired — this watch is connected to your Mac.",
                    style = DshType.body, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(vertical = 8.dp))
            }
        }
    }
}

private suspend fun pollLoop(
    vm: BridgeViewModel,
    record: PairingCenter.ImmutableRecord,
    requestId: String,
    secret: String,
    expiresAtMs: Long,
    onApproved: (PairingTransport.PollResult.Approved, String) -> Unit,
    onTerminal: (String) -> Unit,
) {
    // Finite bounded backoff until the server TTL; the requestId is one-use
    // (replay → 401) and expiry → 410. No secret ever leaves the body.
    for (wait in PairingCenter.pollDelays(System.currentTimeMillis(), expiresAtMs)) {
        delay(wait)
        try {
            // Re-verify the live handshake pin each round: rotation aborts.
            // This LIVE pin (not the approved body pin) is threaded into the
            // persist gate so the check is never a vacuous self-compare.
            val live = try {
                PairingTransport.fetchPairInfo(record.baseUrl).handshakePin
            } catch (e: Exception) {
                onTerminal.callWith("Mac unreachable — pairing stopped. Nothing saved.")
                return
            }
            if (PairingCenter.rotationDetected(record.certSha256Pin, live)) {
                onTerminal.callWith("Certificate changed — pairing stopped. Nothing saved.")
                return
            }
            when (val r = PairingTransport.poll(record.baseUrl, record.certSha256Pin, requestId, secret)) {
                is PairingTransport.PollResult.Approved -> {
                    // TTL guard: a late approved arriving at/after expiry is
                    // discarded, never persisted.
                    if (System.currentTimeMillis() >= expiresAtMs) {
                        onTerminal.callWith("Approval expired — start pairing again")
                        return
                    }
                    // Re-assert: approved pin must equal the confirmed record
                    // AND the live handshake pin (fail-closed on rotation).
                    val row = PairingCenter.approvedPersistIfFresh(
                        record, live, r, expiresAtMs, System.currentTimeMillis(),
                    )
                    if (row == null) {
                        onTerminal.callWith("Certificate changed during approval — nothing saved.")
                        return
                    }
                    withContext(Dispatchers.Main) { onApproved(r, live) }
                    return
                }
                is PairingTransport.PollResult.Pending -> Unit // keep waiting
                is PairingTransport.PollResult.Rejected -> {
                    withContext(Dispatchers.Main) {
                        onTerminal(PairingCenter.pollTerminalMessage(r.error))
                    }
                    return
                }
            }
        } catch (e: Exception) {
            val msg = e.message.orEmpty()
            withContext(Dispatchers.Main) {
                when {
                    msg.contains("approval-expired", ignoreCase = true) ->
                        onTerminal("Approval expired — start pairing again")
                    msg.contains("approval-denied", ignoreCase = true) ->
                        onTerminal("Mac denied this device — pairing stopped")
                    msg.contains("approval-replay", ignoreCase = true) ->
                        onTerminal("Request already used — start pairing again")
                    else -> onTerminal("Waiting… ($msg)")
                }
            }
            if (msg.contains("approval-", ignoreCase = true)) return
        }
    }
    withContext(Dispatchers.Main) { onTerminal("Approval expired — start pairing again") }
}

private suspend fun ((String) -> Unit).callWith(msg: String) {
    withContext(Dispatchers.Main) { this@callWith(msg) }
}

/** Single-line device-alias field for the wizard (no secrets shown). */
@Composable
private fun SettingNameField(label: String, value: String, onChange: (String) -> Unit) {
    DshCard(
        onClick = {},
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp),
    ) {
        androidx.compose.foundation.layout.Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text = label, style = DshType.secondary, maxLines = 1)
            androidx.compose.foundation.text.BasicTextField(
                value = value,
                onValueChange = onChange,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 10.dp),
                textStyle = DshType.body,
                singleLine = true,
            )
        }
    }
}
