package dev.dsh.watch

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import dev.dsh.watch.net.PairingTransport
import dev.dsh.watch.net.SecureTransport
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.security.KeyStore
import java.security.cert.X509Certificate
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import kotlin.concurrent.thread

/** Real Activity/UI + real pinned HTTPS on emulator only. No physical mic or host service. */
@RunWith(AndroidJUnit4::class)
class PairingRuntimeTest {
    @Test fun freshWizardConfirmApprovalHomeSsePingAndMic503() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        val prefs = context.getSharedPreferences("dsh_remote", Context.MODE_PRIVATE)
        assertTrue(prefs.edit().clear().commit())
        val fixture = HostFixture()
        var restarted: HostFixture? = null
        fixture.start()
        val syntheticInputs = CopyOnWriteArrayList<SyntheticInput>()
        dev.dsh.watch.service.VoiceInputFactory.syntheticFactory = {
            SyntheticInput().also { syntheticInputs.add(it) }
        }
        try {
            val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            context.startActivity(intent)
            assertTrue(device.wait(Until.hasObject(By.text("Pair with Mac")), 15000))
            assertEquals(PackageManager.PERMISSION_DENIED, context.checkSelfPermission(Manifest.permission.RECORD_AUDIO))
            assertFalse(device.hasObject(By.textContains("record audio")))

            // Use the real bounded UDP scan, not manual token/port setup or hooks.
            if (!device.wait(Until.hasObject(By.textContains(":${fixture.port}")), 6000)) {
                throw AssertionError("emulator UDP did not deliver local fixture candidate")
            }
            clickScrollable(device, By.textContains(":${fixture.port}"))
            assertTrue(device.wait(Until.hasObject(By.text("SDW isolated Mac")), 10000))
            assertTrue(device.hasObject(By.text(fixture.short)))
            assertEquals(0, fixture.enrolls)
            assertFalse(prefs.contains("token"))
            saveScreen(device, context, "compare")
            clickScrollable(device, By.text("Confirm — this is my Mac"))
            waitFor { fixture.enrolls == 1 }
            assertTrue(fixture.confirmHeaders)
            assertTrue(device.wait(Until.hasObject(By.textContains("Waiting for Mac approval")), 10000))
            assertFalse(prefs.contains("token"))
            fixture.approved = true // fixture Mac-side approval, never a user secret
            waitFor(15000) { prefs.contains("token") }
            assertTrue(SecureTransport.pinMatches(prefs.getString("cert_pin_sha256", "").orEmpty(), fixture.pin))
            assertTrue(prefs.getString("token", "") == fixture.token)
            assertFalse(prefs.getBoolean("allow_insecure_lan", true))
            assertTrue(prefs.getString("base", "")?.endsWith(":${fixture.port}") == true)
            waitFor { (context.applicationContext as App).bridgeViewModel().state.value.connected }
            val vm = (context.applicationContext as App).bridgeViewModel()
            assertFalse(vm.state.value.micOpen)
            waitFor { !vm.state.value.queueReorderSupported }
            instrumentation.runOnMainSync { vm.queueMove("fixture", 0) }
            Thread.sleep(300)
            assertFalse(fixture.commands.contains("queue-move"))
            waitFor { fixture.commands.contains("start") }
            waitFor { fixture.commands.contains("character-select") }
            var ping = ""
            instrumentation.runOnMainSync { vm.ping { ping = it } }
            waitFor { ping.startsWith("OK") }
            assertTrue(fixture.authedHealth > 0)
            waitFor { vm.state.value.toast == null }
            saveScreen(device, context, "home")
            // Permission is still absent until an explicit home record tap.
            clickScrollable(device, By.desc("Turn microphone on"))
            assertTrue(device.wait(Until.hasObject(By.textContains("record audio")), 10000))
            val allow = device.wait(Until.findObject(By.res("com.android.permissioncontroller:id/permission_allow_foreground_only_button")), 5000)
                ?: device.findObject(By.textContains("While using"))
                ?: device.findObject(By.textContains("Allow"))
            assertNotNull("explicit record permission action available", allow)
            allow!!.click()
            waitFor { fixture.preflights > 0 }
            waitFor { vm.state.value.micState == "error" }
            assertFalse(vm.state.value.micOpen)
            assertEquals(0, fixture.pcmUploads)
            assertEquals(0L, vm.state.value.micTxBytes)
            assertTrue(device.wait(Until.hasObject(By.text("Error")), 10000))
            saveScreen(device, context, "mic503")
            assertTrue(syntheticInputs.isEmpty()) // 503 never constructs ANY input source.
            waitFor { !dev.dsh.watch.service.VoiceService.isActive() }
            waitFor { fixture.cancelledStreams.contains(vm.state.value.watchStreamId) }

            // Real UI record-off -> real foreground worker -> chunked EOF -> receipt.
            // Input is DEBUG-only synthetic; no AudioRecord/host mic. Fixture ACK is
            // conditional on this exact stream's received bytes + EOF, not SDK proof.
            fixture.voiceReady = true
            instrumentation.runOnMainSync { vm.dismissError() } // explicit acknowledgement of prior 503
            val cancelsBeforeFinish = fixture.cancelRequests
            clickScrollable(device, By.desc("Turn microphone on"))
            waitFor { vm.state.value.micState == "capturing" && fixture.pcmUploads == 1 }
            val normalStream = vm.state.value.watchStreamId
            clickScrollable(device, By.desc("Turn microphone off"))
            waitFor { fixture.micEofs == 1 && vm.state.value.micState == "closed" }
            waitFor { !dev.dsh.watch.service.VoiceService.isActive() }
            assertEquals(normalStream, vm.state.value.watchStreamId)
            assertEquals(1, fixture.normalAcks)
            assertEquals(cancelsBeforeFinish, fixture.cancelRequests)
            assertFalse(vm.state.value.sessionRunning)
            saveScreen(device, context, "mic-eof-ack")

            fixture.uploadStatus = 413
            instrumentation.runOnMainSync { vm.startMicUplink() }
            waitFor { vm.state.value.micState == "capturing" && fixture.pcmUploads == 2 }
            dev.dsh.watch.service.VoiceService.finishRecording(normalStream) // stale A cannot finish B
            Thread.sleep(200)
            assertEquals("capturing", vm.state.value.micState)
            assertEquals(1, fixture.micEofs)
            instrumentation.runOnMainSync { vm.stopMicUplink() }
            waitFor { fixture.micEofs == 2 && vm.state.value.micState == "error" }
            assertTrue(vm.state.value.micMessage.orEmpty().contains("too large"))
            fixture.sendEvent(JSONObject().put("t", "mic").put("streamId", vm.state.value.watchStreamId).put("state", "ready").toString())
            Thread.sleep(250)
            assertEquals("error", vm.state.value.micState)
            assertFalse(vm.state.value.micOpen) // late SSE ready cannot undo HTTP error
            waitFor { !dev.dsh.watch.service.VoiceService.isActive() }
            assertEquals(1, fixture.normalAcks)
            assertFalse(vm.state.value.sessionRunning)
            saveScreen(device, context, "mic-eof-error")

            fixture.uploadStatus = 200
            fixture.noSpeech = true
            instrumentation.runOnMainSync { vm.startMicUplink() }
            waitFor { vm.state.value.micState == "capturing" && fixture.pcmUploads == 3 }
            instrumentation.runOnMainSync { vm.stopMicUplink() }
            waitFor { fixture.micEofs == 3 && vm.state.value.micState == "error" }
            assertTrue(vm.state.value.micMessage.orEmpty().contains("No speech"))
            waitFor { !dev.dsh.watch.service.VoiceService.isActive() }
            assertFalse(vm.state.value.sessionRunning)
            fixture.noSpeech = false

            // Explicit security abort disconnects: no EOF/admission, scoped cancel only.
            instrumentation.runOnMainSync { vm.startMicUplink() }
            waitFor { vm.state.value.micState == "capturing" && fixture.pcmUploads == 4 }
            val abortStream = vm.state.value.watchStreamId
            instrumentation.runOnMainSync { vm.abortMicUplink() }
            waitFor { !dev.dsh.watch.service.VoiceService.isActive() && fixture.cancelledStreams.contains(abortStream) }
            Thread.sleep(300)
            assertEquals(3, fixture.micEofs)
            assertEquals(1, fixture.normalAcks)
            assertEquals("idle", vm.state.value.micState)

            // Record-off while warming cancels a scoped lease and NEVER creates input.
            fixture.preflightDelayMs = 1000
            val inputCount = syntheticInputs.size
            instrumentation.runOnMainSync { vm.startMicUplink() }
            val warmStream = vm.state.value.watchStreamId
            waitFor { fixture.lastPreflight == warmStream }
            instrumentation.runOnMainSync { vm.toggleMic() } // same UI toggle cancels while warming
            waitFor { !dev.dsh.watch.service.VoiceService.isActive() && fixture.cancelledStreams.contains(warmStream) }
            assertEquals(inputCount, syntheticInputs.size)
            assertEquals("cancelled", vm.state.value.micState)
            fixture.preflightDelayMs = 0

            // Same actual ViewModel question intent + user End: EOF inserts draft only.
            fixture.sendEvent("{\"t\":\"pending\",\"items\":[{\"id\":\"fixture-ask\",\"kind\":\"ask\",\"title\":\"Fixture question\"}]}")
            waitFor { vm.state.value.pending.any { it.id == "fixture-ask" } }
            instrumentation.runOnMainSync { vm.setPendingTarget("fixture-ask"); vm.startDictation("fixture-ask") }
            waitFor { vm.state.value.micState == "capturing" && fixture.pcmUploads == 5 }
            val draftStream = vm.state.value.watchStreamId
            instrumentation.runOnMainSync { vm.stopDictation() }
            waitFor { fixture.draftsAccepted == 1 && vm.state.value.micState == "closed" && !vm.state.value.dictationSettling }
            waitFor { !dev.dsh.watch.service.VoiceService.isActive() }
            assertEquals(draftStream, vm.state.value.watchStreamId)
            assertEquals("synthetic answer", vm.state.value.dictationFinal)
            assertEquals(1, fixture.normalAcks) // draft NEVER claims SDK admission.
            assertFalse(fixture.commands.contains("approve"))
            assertFalse(vm.state.value.sessionRunning)
            assertTrue(vm.state.value.pending.any { it.id == "fixture-ask" })
            instrumentation.runOnMainSync { vm.stopDictation(clear = true) }

            fixture.sseErrorBeforeAck = true
            instrumentation.runOnMainSync { vm.startMicUplink() }
            waitFor { vm.state.value.micState == "capturing" && fixture.pcmUploads == 6 }
            instrumentation.runOnMainSync { vm.stopMicUplink() }
            waitFor { fixture.normalAcks == 2 && !dev.dsh.watch.service.VoiceService.isActive() }
            assertEquals("error", vm.state.value.micState) // HTTP success cannot overwrite earlier same-stream SSE error
            assertFalse(vm.state.value.micOpen)
            fixture.sseErrorBeforeAck = false

            // Fresh stream can record after latched error; settings rebind hard-aborts
            // its OLD captured endpoint/token BEFORE prefs/SSE transport mutation.
            instrumentation.runOnMainSync { vm.startMicUplink() }
            waitFor { vm.state.value.micState == "capturing" && fixture.pcmUploads == 7 }
            val reboundStream = vm.state.value.watchStreamId
            val preflightsBeforeRebind = fixture.preflights
            val oldConnection = vm.state.value
            instrumentation.runOnMainSync {
                vm.applySettings(oldConnection.base + "/", oldConnection.token, SecureTransport.displayPin(oldConnection.certPinSha256), false)
                assertTrue(syntheticInputs.last().stopped)
                assertFalse(vm.state.value.micOpen)
            }
            waitFor { fixture.cancelledStreams.contains(reboundStream) && !dev.dsh.watch.service.VoiceService.isActive() && vm.state.value.connected }
            assertEquals(5, fixture.micEofs)
            assertEquals(2, fixture.normalAcks)
            assertEquals(preflightsBeforeRebind, fixture.preflights) // reconnect NEVER opens a new input lease
            // No stored credential overwrite on duplicate/rotated/late approvals.
            val stored = prefs.getString("token", "")
            val base = "https://127.0.0.1:${fixture.port}"
            fixture.duplicateInfo = true
            try { PairingTransport.fetchPairInfo(base); fail("duplicate keys accepted") } catch (_: java.io.IOException) { }
            fixture.duplicateInfo = false
            val record = dev.dsh.watch.core.PairingCenter.ImmutableRecord(base, fixture.pin)
            val approved = PairingTransport.PollResult.Approved("fixture", fixture.token, base, fixture.pin)
            assertNull(dev.dsh.watch.core.PairingCenter.approvedPersistIfFresh(record, fixture.pin, approved, 1, 2))
            val healthBeforeWrongPin = fixture.authedHealth
            val wrong = SecureTransport.EndpointSecurity(certPinSha256 = java.util.Base64.getEncoder().encodeToString(ByteArray(32)))
            try { dev.dsh.watch.net.BridgeClient.health(base, fixture.token, wrong); fail("rotated pin accepted") } catch (_: Exception) { }
            assertTrue(prefs.getString("token", "") == stored)
            assertEquals(healthBeforeWrongPin, fixture.authedHealth)
            // HTTPS ephemeral-port restart: retain actual cert + stable device token;
            // real VM supervisor must rediscover on UDP without manual settings.
            fixture.close()
            val replacement = HostFixture(fixture.token)
            restarted = replacement
            replacement.start()
            waitFor(20000) { vm.state.value.base.endsWith(":${replacement.port}") && vm.state.value.connected }
            assertTrue(prefs.getString("token", "") == stored)
            assertTrue(SecureTransport.pinMatches(prefs.getString("cert_pin_sha256", "").orEmpty(), replacement.pin))
            assertEquals(0, replacement.enrolls)
            assertTrue(replacement.authedHealth > 0)
            saveScreen(device, context, "rediscovered")
        } catch (failure: Throwable) {
            saveScreen(device, context, "failure")
            throw failure
        } finally {
            instrumentation.runOnMainSync { (context.applicationContext as App).bridgeViewModel().disconnect() }
            fixture.close()
            restarted?.close()
            dev.dsh.watch.service.VoiceInputFactory.syntheticFactory = null
        }
    }

    private fun clickScrollable(device: UiDevice, selector: androidx.test.uiautomator.BySelector) {
        repeat(10) {
            val obj = device.findObject(selector)
            val bounds = obj?.visibleBounds
            if (bounds != null && bounds.height() > 12 && bounds.centerY() in device.displayHeight / 5..device.displayHeight * 3 / 4) {
                obj.click(); return
            }
            // Do not tap a partly exposed pill at the clipped circular edge.
            device.swipe(device.displayWidth / 2, device.displayHeight * 3 / 4, device.displayWidth / 2, device.displayHeight / 3, 20)
            Thread.sleep(200)
        }
        throw AssertionError("required UI action not visible")
    }
    private fun waitFor(timeout: Long = 10000, ready: () -> Boolean) {
        val until = System.currentTimeMillis() + timeout
        while (!ready() && System.currentTimeMillis() < until) Thread.sleep(100)
        assertTrue("bounded runtime condition", ready())
    }
    private fun saveScreen(device: UiDevice, context: Context, name: String) {
        device.waitForIdle(1000)
        Thread.sleep(250)
        device.takeScreenshot(java.io.File(context.getExternalFilesDir(null), "sdw-$name.png"))
    }

    private class SyntheticInput : dev.dsh.watch.service.VoiceInput {
        @Volatile var stopped = false
            private set
        override fun start() { }
        override fun read(buffer: ByteArray): Int {
            Thread.sleep(20)
            if (stopped) return -3 // intentional stop's negative read must still EOF/drain
            buffer.fill(0)
            return buffer.size
        }
        override fun stop() { stopped = true }
        override fun release() { stopped = true }
    }

    private class HostFixture(val token: String = PairingTransport.newSecret()) {
        private val ssl: SSLServerSocket
        val port: Int get() = ssl.localPort
        val pin: String
        val short: String
        private val full: String
        private val requestId = PairingTransport.newSecret()
        private var enrollmentSecret = ""
        @Volatile var approved = false
        @Volatile var duplicateInfo = false
        @Volatile var enrolls = 0
        @Volatile var confirmHeaders = false
        @Volatile var authedHealth = 0
        @Volatile var preflights = 0
        @Volatile var pcmUploads = 0
        @Volatile var voiceReady = false
        @Volatile var uploadStatus = 200
        @Volatile var noSpeech = false
        @Volatile var sseErrorBeforeAck = false
        @Volatile var preflightDelayMs = 0L
        @Volatile var lastPreflight = ""
        @Volatile var micEofs = 0
        @Volatile var normalAcks = 0
        @Volatile var draftsAccepted = 0
        @Volatile var cancelRequests = 0
        val cancelledStreams = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
        private val readyStreams = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
        private val streams = java.util.concurrent.ConcurrentHashMap<java.net.Socket, java.io.OutputStream>()
        @Volatile private var pendingQuestionAlive = false
        fun sendEvent(event: String) {
            val json = JSONObject(event)
            if (json.optString("t") == "pending") pendingQuestionAlive = json.optJSONArray("items")?.optJSONObject(0)?.optString("id") == "fixture-ask"
            for (out in streams.values) runCatching { synchronized(out) { out.write("data: $event\n\n".toByteArray()); out.flush() } }
        }
        val commands = CopyOnWriteArrayList<String>()
        private val sockets = CopyOnWriteArrayList<java.net.Socket>()
        private val udp = DatagramSocket(8797)
        init {
            val testContext = InstrumentationRegistry.getInstrumentation().context
            val ks = KeyStore.getInstance("PKCS12")
            testContext.assets.open("sdw-fixture.p12").use { ks.load(it, "fixture-only".toCharArray()) }
            val cert = ks.getCertificate(ks.aliases().nextElement()) as X509Certificate
            pin = PairingTransport.handshakePin(cert)
            full = PairingTransport.fullFingerprint(cert)
            short = PairingTransport.shortFingerprint(full)
            val km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
            km.init(ks, "fixture-only".toCharArray())
            val ctx = SSLContext.getInstance("TLS"); ctx.init(km.keyManagers, null, null)
            ssl = ctx.serverSocketFactory.createServerSocket(0) as SSLServerSocket
        }
        fun start() {
            thread(isDaemon = true) {
                while (!udp.isClosed) try {
                    val pkt = DatagramPacket(ByteArray(513), 513); udp.receive(pkt)
                    val raw = String(pkt.data, 0, pkt.length)
                    if (raw.matches(Regex("DSHW1DISCOVER [A-Za-z0-9_-]{1,64}"))) {
                        val out = "DSHW1BRIDGE ${raw.substringAfter(' ')} $port".toByteArray()
                        udp.send(DatagramPacket(out, out.size, pkt.address, pkt.port))
                    }
                } catch (_: Exception) { }
            }
            thread(isDaemon = true) {
                while (!ssl.isClosed) try {
                    val socket = ssl.accept(); sockets.add(socket)
                    thread(isDaemon = true) { serve(socket) }
                } catch (_: Exception) { }
            }
        }
        private fun serve(socket: java.net.Socket) {
            try {
                val input = socket.getInputStream().buffered()
                fun line(): String? {
                    val out = java.io.ByteArrayOutputStream()
                    while (out.size() < 8192) {
                        val b = input.read()
                        if (b < 0) return if (out.size() == 0) null else throw java.io.EOFException()
                        if (b == 10) return out.toString("UTF-8").removeSuffix("\r")
                        out.write(b)
                    }
                    throw java.io.IOException("fixture header bound")
                }
                val first = line() ?: return
                val path = first.split(' ')[1]
                val headers = mutableMapOf<String, String>()
                while (true) {
                    val header = line() ?: return
                    if (header.isEmpty()) break
                    headers[header.substringBefore(':').lowercase()] = header.substringAfter(':').trim()
                }
                if (path.startsWith("/watch/") && headers["x-bridge-token"] != token) { respond(socket, 401, "{}"); return }
                if (path.startsWith("/watch/mic?")) {
                    pcmUploads++
                    val query = java.net.URI(path).rawQuery.split('&').associate {
                        java.net.URLDecoder.decode(it.substringBefore('='), "UTF-8") to java.net.URLDecoder.decode(it.substringAfter('='), "UTF-8")
                    }
                    val sid = query["streamId"].orEmpty()
                    if (headers["transfer-encoding"] != "chunked" || !readyStreams.contains(sid)) { respond(socket, 400, "{}"); return }
                    var bytes = 0
                    val chunk = ByteArray(8192)
                    while (true) {
                        val size = line()?.substringBefore(';')?.toIntOrNull(16) ?: throw java.io.EOFException()
                        if (size < 0 || size > 65536 || bytes + size > 1024 * 1024) throw java.io.IOException("fixture PCM bound")
                        if (size == 0) { check(line() == ""); micEofs++; break }
                        var left = size
                        while (left > 0) {
                            val n = input.read(chunk, 0, minOf(chunk.size, left))
                            if (n < 0) throw java.io.EOFException()
                            left -= n; bytes += n
                        }
                        check(line() == "")
                    }
                    readyStreams.remove(sid)
                    val draft = query["answerRequestId"]
                    val receipt = JSONObject().put("streamId", sid).put("state", "closed").put("txBytes", bytes).put("ackFinals", 0).put("delivered", false)
                    when {
                        uploadStatus != 200 -> { respond(socket, uploadStatus, "{\"error\":\"mic-too-large\"}"); return }
                        cancelledStreams.contains(sid) -> receipt.put("state", "error").put("code", "mic-delivery-failed")
                        bytes == 0 || noSpeech -> receipt.put("code", "no-speech")
                        draft == "fixture-ask" && pendingQuestionAlive -> {
                            // Exact live fixture question + actual bytes/EOF inserts a draft.
                            draftsAccepted++
                            sendEvent("{\"t\":\"dictation-final\",\"requestId\":\"fixture-ask\",\"text\":\"synthetic answer\"}")
                            sendEvent("{\"t\":\"dictation-closed\",\"requestId\":\"fixture-ask\"}")
                            receipt.put("drafted", true)
                        }
                        draft != null -> receipt.put("state", "error").put("code", "mic-delivery-failed")
                        else -> { normalAcks++; receipt.put("ackFinals", 1).put("delivered", true) }
                    }
                    if (sseErrorBeforeAck) {
                        sendEvent(JSONObject().put("t", "mic").put("streamId", sid).put("state", "error").put("code", "mic-delivery-failed").toString())
                        Thread.sleep(300) // ensure SSE error reaches real reducer BEFORE HTTP success
                    }
                    respond(socket, 200, receipt.toString()); return
                }
                val count = headers["content-length"]?.toIntOrNull() ?: 0
                check(count in 0..16384)
                val bytes = ByteArray(count); var n = 0
                while (n < count) { val read = input.read(bytes, n, count - n); if (read < 0) throw java.io.EOFException(); n += read }
                val body = if (count > 0) JSONObject(String(bytes, Charsets.UTF_8)) else JSONObject()
                when (path) {
                    "/pair/info" -> {
                        val dto = JSONObject().put("pairProtocol", "turnkey/1").put("serverDisplayName", "SDW isolated Mac").put("nonce", "fixture")
                            .put("certSha256Pin", pin).put("fingerprint", JSONObject().put("full", full).put("short", short)).toString()
                        respond(socket, 200, if (duplicateInfo) dto.dropLast(1) + ",\"nonce\":\"duplicate\"}" else dto)
                    }
                    "/pair/enroll" -> {
                        confirmHeaders = headers["x-fingerprint-confirmed"] == "true" && headers["x-cert-pin"] == pin
                        if (!confirmHeaders || headers["content-type"] != "application/json") { respond(socket, 403, "{}"); return }
                        enrollmentSecret = body.getString("enrollmentSecret"); enrolls++
                        respond(socket, 201, JSONObject().put("requestId", requestId).put("expiresAtMs", System.currentTimeMillis() + 30000).toString())
                    }
                    "/pair/poll" -> {
                        if (body.optString("enrollmentSecret") != enrollmentSecret || body.optString("requestId") != requestId) { respond(socket, 401, "{}"); return }
                        if (!approved) respond(socket, 202, JSONObject().put("status", "pending").put("requestId", requestId).put("expiresAtMs", System.currentTimeMillis() + 30000).toString())
                        else respond(socket, 200, JSONObject().put("status", "approved").put("deviceId", "fixture-watch").put("token", token).put("certSha256Pin", pin).toString())
                    }
                    "/watch/health" -> { authedHealth++; respond(socket, 200, "{\"status\":\"up\",\"ok\":true}") }
                    "/watch/mic/start" -> {
                        preflights++
                        val sid = body.optString("streamId")
                        lastPreflight = sid
                        if (!voiceReady) { respond(socket, 503, "{\"error\":\"mic-not-ready\",\"message\":\"Fixture voice warming\",\"retryable\":true}"); return }
                        if (cancelledStreams.contains(sid)) { respond(socket, 409, "{}"); return }
                        readyStreams.add(sid)
                        if (preflightDelayMs > 0) Thread.sleep(preflightDelayMs)
                        if (cancelledStreams.contains(sid)) respond(socket, 409, "{}")
                        else respond(socket, 200, JSONObject().put("streamId", sid).put("state", "ready").put("ready", true).toString())
                    }
                    "/watch/stream" -> {
                        val out = socket.getOutputStream()
                        streams[socket] = out
                        out.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n".toByteArray())
                        out.write("data: {\"t\":\"hello\",\"protocolVersion\":1,\"voiceActive\":false}\n\ndata: {\"t\":\"snapshot\",\"voice\":{\"active\":false,\"phase\":\"idle\"},\"session\":{\"running\":false},\"queue\":[],\"pending\":[],\"features\":{\"queueReorder\":false,\"openMac\":false,\"micCancel\":true}}\n\n".toByteArray()); out.flush()
                        while (!ssl.isClosed) { Thread.sleep(1000); synchronized(out) { out.write(": keepalive\n\n".toByteArray()); out.flush() } }
                    }
                    "/watch/command" -> {
                        val cmd = body.optString("cmd"); commands.add(cmd)
                        when (cmd) {
                            "start" -> { assertTrue(body.optBoolean("sessionOwnedByApp")); respond(socket, 200, "{\"ok\":true,\"active\":true}") }
                            "stop" -> respond(socket, 200, "{\"ok\":true,\"active\":false}")
                            "character-select" -> respond(socket, 200, "{\"ok\":true,\"characterId\":\"cappi\"}")
                            "sessions" -> respond(socket, 200, "{\"ok\":true,\"sessions\":[],\"active\":null}")
                            "mic-cancel" -> {
                                val sid = body.optString("streamId")
                                if (!sid.matches(Regex("[A-Za-z0-9_-]{1,64}"))) { respond(socket, 400, "{}"); return }
                                cancelRequests++
                                cancelledStreams.add(sid)
                                respond(socket, 200, JSONObject().put("ok", true).put("streamId", sid).put("cancelled", readyStreams.remove(sid)).toString())
                            }
                            else -> respond(socket, 400, "{\"error\":\"unknown-command\"}")
                        }
                    }
                    else -> { if (path.startsWith("/watch/mic?")) pcmUploads++; respond(socket, 404, "{}") }
                }
            } catch (_: Exception) { /* TLS mismatch closes before an HTTP request */ }
            finally { streams.remove(socket); sockets.remove(socket); runCatching { socket.close() } }
        }
        private fun respond(socket: java.net.Socket, code: Int, body: String) {
            val bytes = body.toByteArray()
            socket.getOutputStream().apply {
                write("HTTP/1.1 $code Fixture\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                write(bytes); flush()
            }
        }
        fun close() { udp.close(); ssl.close(); sockets.forEach { runCatching { it.close() } } }
    }
}
