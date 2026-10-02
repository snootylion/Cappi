package dev.dsh.watch.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ServiceCompat
import dev.dsh.watch.App
import dev.dsh.watch.R
import dev.dsh.watch.net.SecureTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URLEncoder

/** Foreground microphone uplink. Service lifecycle is main-thread owned; each
 * worker owns its own recorder/socket, never a newer capture's resources. */
class VoiceService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val main = Handler(Looper.getMainLooper())
    private val ownership = VoiceStartOwnership()
    @Volatile private var captureSession: CaptureSession? = null
    private var destroyed = false
    private var wakeLock: PowerManager.WakeLock? = null

    private class CaptureSession(val generation: Long) {
        val control = MicCaptureControl()
        var streamId = ""
        @Volatile var preflightStarted = false
        var cancelBackend: (() -> Unit)? = null
        var record: VoiceInput? = null
        var connection: HttpURLConnection? = null

        @Synchronized fun attach(rec: VoiceInput): Boolean {
            if (!control.recording || control.aborted) return false
            record = rec
            return true
        }
        @Synchronized fun attach(conn: HttpURLConnection): Boolean {
            if (control.aborted) return false // recording-off still owns the drain socket
            connection = conn
            return true
        }
        @Synchronized fun finishRecording() {
            if (control.aborted) return
            control.finishRecording()
            runCatching { record?.stop() }
            if (record == null) cancel() // stopped while warming: no PCM body to EOF
        }
        @Synchronized fun cancel() {
            if (control.aborted) return
            control.beginAbort() // quiet any IO failure while disconnect interrupts the worker
            if (preflightStarted) cancelBackend?.invoke()
            // Hard-close BEFORE exposing record-off, so worker close() cannot send
            // a graceful terminating chunk during a force-abort race.
            runCatching { connection?.disconnect() }
            control.abort()
            runCatching { record?.stop() }
        }
        @Synchronized fun clear() { record = null; connection = null; cancelBackend = null }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        currentService = this
        // Fulfil startForegroundService promptly, before any intent validation,
        // capture work, or asynchronous stop/start interleaving.
        startCaptureNotification()
        Log.i(TAG, "service created and foreground promoted")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ownership.noteStart(startId)
        // Existing instances also receive new foreground-start obligations.
        startCaptureNotification()
        Log.i(TAG, "service command startId=$startId start=${intent?.action == ACTION_START}")
        when (intent?.action) {
            ACTION_START -> {
                val base = intent.getStringExtra(EXTRA_BASE)
                if (base.isNullOrBlank()) {
                    Log.w(TAG, "ignoring start without bridge base")
                    if (captureSession == null) stopIfLatest(startId)
                    return START_NOT_STICKY
                }
                if (captureSession != null) return START_NOT_STICKY
                val session = CaptureSession(ownership.begin())
                captureSession = session
                active = true
                acquireWakeLock()
                val token = intent.getStringExtra(EXTRA_TOKEN) ?: ""
                val answerRequestId = intent.getStringExtra(EXTRA_ANSWER_REQUEST_ID)
                val streamId = intent.getStringExtra(EXTRA_STREAM_ID)
                    .orEmpty().ifEmpty { "watch-${System.currentTimeMillis()}-${(0..999999).random()}" }
                val security = SecureTransport.EndpointSecurity(
                    certPinSha256 = intent.getStringExtra(EXTRA_CERT_PIN) ?: "",
                    allowInsecureLan = intent.getBooleanExtra(EXTRA_ALLOW_INSECURE, false),
                )
                session.streamId = streamId
                if (intent.getBooleanExtra(EXTRA_MIC_CANCEL, false)) {
                    session.cancelBackend = {
                        // Separate bounded best-effort request survives service scope disposal.
                        kotlin.concurrent.thread(isDaemon = true) {
                            runCatching { dev.dsh.watch.net.BridgeClient.command(base, token,
                                org.json.JSONObject().put("cmd", "mic-cancel").put("streamId", streamId), security) }
                        }
                    }
                }
                scope.launch { capture(session, base, token, streamId, answerRequestId, security) }
            }
            else -> {
                // Legacy STOP/null/unknown commands must satisfy foreground
                // promotion too; public stop() uses stopService, never starts FGS.
                cancelCapture()
                stopIfLatest(startId)
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        destroyed = true
        if (currentService === this) currentService = null
        cancelCapture()
        main.removeCallbacksAndMessages(null)
        scope.cancel()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        Log.i(TAG, "service destroyed")
        super.onDestroy()
    }

    private fun stopIfLatest(startId: Int) {
        // Android also checks commands queued but not yet delivered to this
        // instance. Never remove foreground before this startId-aware check.
        val stopped = stopSelfResult(startId)
        if (stopped) ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        Log.i(TAG, "finish startId=$startId stopped=$stopped")
    }

    private fun requestFinishRecording(session: CaptureSession) {
        if (destroyed || captureSession !== session || !ownership.isCurrent(session.generation) || session.control.aborted || !session.control.recording) return
        session.finishRecording()
        MicStatus.publish(MicStatus.Snapshot(session.generation, session.streamId,
            if (session.control.aborted) "cancelled" else "finishing"))
        // Worker remains owner: EOF -> receipt -> finishCapture -> stopSelf.
    }

    private fun cancelCapture() {
        ownership.cancel()
        val session = captureSession
        captureSession = null
        active = false
        session?.cancel()
        wakeLock?.runCatching { if (isHeld) release() }
        wakeLock = null
    }

    private fun finishCapture(session: CaptureSession) {
        // Worker completion is posted to main; stale completions do nothing.
        if (destroyed || captureSession !== session) return
        val startId = ownership.finish(session.generation) ?: return
        captureSession = null
        active = false
        wakeLock?.runCatching { if (isHeld) release() }
        wakeLock = null
        stopIfLatest(startId)
    }

    private fun startCaptureNotification() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(App.CHANNEL_ID, "DSH Remote", NotificationManager.IMPORTANCE_LOW)
        )
        val notification = Notification.Builder(this, App.CHANNEL_ID)
            .setContentTitle("Listening… — DSH Remote")
            .setSmallIcon(R.drawable.ic_mic)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else startForeground(NOTIFICATION_ID, notification)
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsh:mic").apply {
            setReferenceCounted(false)
            // Bounded so the OS always reclaims a leaked lock; normal captures
            // end (and release) long before this. See docs/devices.md §Lint.
            acquire(30 * 60_000L)
        }
    }

    private fun capture(
        session: CaptureSession,
        base: String,
        token: String,
        streamId: String,
        answerRequestId: String?,
        security: SecureTransport.EndpointSecurity,
    ) {
        var rec: VoiceInput? = null
        var connection: HttpURLConnection? = null
        var legacyFallback = false
        fun publish(
            state: String,
            txChunks: Long = 0,
            txBytes: Long = 0,
            zeroChunks: Long = 0,
            readErrors: Long = 0,
            rmsBucket: Int = 0,
            message: String? = null,
        ) {
            if (captureSession === session && !session.control.aborted) {
                MicStatus.publish(
                    MicStatus.Snapshot(session.generation, streamId, state,
                        txChunks, txBytes, zeroChunks, readErrors, rmsBucket,
                        message, legacyFallback),
                )
            }
        }
        try {
            if (!session.control.recording) return
            publish("warming")
            // Authenticate + ready preflight BEFORE any AudioRecord start: the
            // peer is verified (pinned TLS) and V reports ready before the mic
            // opens. SecureTransport.open() alone only installs the factory —
            // the handshake runs at connect/response time — so "opened" is not
            // trusted until this response arrives. Never capture before trust.
            synchronized(session) {
                if (!session.control.recording || session.control.aborted) return
                session.preflightStarted = true // atomic with cancel: late preflight gets a tombstone
            }
            try {
                val pre = dev.dsh.watch.net.PairingTransport.micStart(
                    base, token, security, streamId, answerRequestId)
                if (!pre.ready) {
                    publish("error", message = pre.message ?: "voice backend not ready")
                    return
                }
                publish("ready")
            } catch (e: dev.dsh.watch.net.PairingTransport.MicStartMissing) {
                // Legacy bridge without POST /watch/mic/start: explicit
                // compatible fallback (no insecure autodowngrade — the pinned
                // transport below still enforces pin/redirect rules).
                legacyFallback = true
                publish("ready", message = "legacy bridge: preflight unavailable")
            }
            if (!session.control.recording) return
            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
                publish("error", message = "Microphone permission needed — grant it, then tap record again")
                return
            }
            val recorder = VoiceInputFactory.create()
            rec = recorder
            if (!session.attach(recorder)) return
            // Pair start with cancellation's monitor: cancel cannot stop before
            // startRecording and then allow a late start to escape.
            synchronized(session) {
                if (!session.control.recording) return
                recorder.start()
            }
            publish("capturing")
            val query = buildString {
                append("?streamId=").append(URLEncoder.encode(streamId, "UTF-8"))
                if (answerRequestId != null) {
                    append("&answerRequestId=").append(URLEncoder.encode(answerRequestId, "UTF-8"))
                }
            }
            // Same trusted factory as every other bridge request: pinned cert
            // verified before any audio flows, token in the header (never the
            // URL), redirects refused. streamId/answerRequestId are routing
            // metadata, not secrets.
            val c = SecureTransport.open(base.trim().trimEnd('/') + "/watch/mic$query", security).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 5000
                readTimeout = 40_000 // bounded: server must consume/answer; SSE uses the same 40s watchdog
                setRequestProperty("Content-Type", "application/octet-stream")
                setChunkedStreamingMode(4096)
            }
            SecureTransport.setTokenHeader(c, token)
            // No redirect check here: responseCode would flush headers before
            // the body. TLS pinning already authenticated the peer pre-bytes
            // (the bridge never redirects); the status is checked post-upload.
            connection = c
            if (!session.attach(c)) return
            val startedAt = System.currentTimeMillis()
            var lastWriteAt = startedAt
            var txChunks = 0L
            var txBytes = 0L
            var zeroChunks = 0L
            var readErrors = 0L
            c.outputStream.use { out ->
                    val buf = ByteArray(4096)
                    while (session.control.recording) {
                        if (System.currentTimeMillis() - startedAt > MicStatus.ABSOLUTE_CAP_MS) break
                        if (System.currentTimeMillis() - lastWriteAt > MicStatus.WRITE_WATCHDOG_MS) {
                            throw IOException("mic uplink stalled (no write accepted)")
                        }
                        val n = try {
                            recorder.read(buf)
                        } catch (e: Exception) {
                            if (!session.control.recording) break // intentional stop may interrupt AudioRecord
                            readErrors++
                            publish("capturing", txChunks, txBytes, zeroChunks, readErrors,
                                message = null)
                            throw IOException("mic read failed: ${e.javaClass.simpleName}")
                        }
                        if (!session.control.recording) break // including negative read caused by user stop
                        when {
                            n > 0 -> {
                                out.write(buf, 0, n)
                                txChunks++
                                txBytes += n
                                lastWriteAt = System.currentTimeMillis()
                                // RMS bucket for the ambient meter (privacy: level only).
                                var sum = 0L
                                var i = 0
                                while (i + 1 < n) {
                                    val s = ((buf[i + 1].toInt() shl 8) or (buf[i].toInt() and 0xff))
                                    sum += (s * s).toLong()
                                    i += 2
                                }
                                val rms = kotlin.math.sqrt(sum.toDouble() / ((n / 2).coerceAtLeast(1)))
                                val bucket = ((rms / 32768.0) * 100).toInt().coerceIn(0, 99)
                                if (txChunks % 8L == 0L) {
                                    publish("capturing", txChunks, txBytes, zeroChunks, readErrors, bucket)
                                }
                            }
                            n == 0 -> {
                                zeroChunks++
                                if (zeroChunks % 32L == 0L) {
                                    publish("capturing", txChunks, txBytes, zeroChunks, readErrors)
                                }
                            }
                            else -> {
                                // Negative = AudioRecord error (not EOF): count
                                // it explicitly instead of a silent clean break.
                                readErrors++
                                publish("capturing", txChunks, txBytes, zeroChunks, readErrors)
                                throw IOException("mic read error ($n)")
                            }
                        }
                    }
                    out.flush()
                }
            // EOF is not success: validate real admission/draft receipt first.
            if (session.control.aborted || captureSession !== session) return
            SecureTransport.throwOnRedirect(c)
            val receipt = MicReceipt.read(c, streamId, answerRequestId != null, legacyFallback)
            if (!session.control.aborted && captureSession === session) {
                publish(receipt.state, txChunks, txBytes, zeroChunks, readErrors, message = receipt.message)
            }
        } catch (_: IOException) {
            Log.i(TAG, "capture transport ended") // Never log URL/token/exception text.
            val cur = MicStatus.flow.value
            if (MicReceipt.shouldPublishFailure(!session.control.aborted, captureSession === session, cur?.state)) {
                publish("error", message = "Microphone upload failed — tap record to retry")
            }
        } catch (error: Exception) {
            Log.w(TAG, "capture ended: ${error.javaClass.simpleName}")
            if (MicReceipt.shouldPublishFailure(!session.control.aborted, captureSession === session, MicStatus.flow.value?.state)) {
                publish("error", message = "Microphone could not start")
            }
        } finally {
            // Preflight allocated an input lease, but no upload ever opened.
            if (connection == null && session.preflightStarted) session.cancel()
            session.control.finishRecording()
            synchronized(session) {
                runCatching { rec?.stop() }
                runCatching { rec?.release() }
                runCatching { connection?.disconnect() }
                session.clear()
            }
            main.post { finishCapture(session) }
        }
    }

    companion object {
        private const val TAG = "DshMicService"
        private const val ACTION_START = "dev.dsh.watch.MIC_START"
        private const val EXTRA_BASE = "base"
        private const val EXTRA_TOKEN = "token"
        private const val EXTRA_CERT_PIN = "cert_pin"
        private const val EXTRA_ALLOW_INSECURE = "allow_insecure"
        private const val EXTRA_ANSWER_REQUEST_ID = "answerRequestId"
        private const val EXTRA_STREAM_ID = "stream_id"
        private const val EXTRA_MIC_CANCEL = "mic_cancel_supported"
        private const val NOTIFICATION_ID = 47
        @Volatile private var active = false
        @Volatile private var currentService: VoiceService? = null
        fun isActive(): Boolean = active

        /** Owned-instance callback: no stopService/disconnect or fresh FGS obligation. */
        fun finishRecording(expectedStreamId: String) {
            val service = currentService ?: return
            val session = service.captureSession ?: return
            if (session.streamId != expectedStreamId) return
            service.main.post { service.requestFinishRecording(session) }
        }

        fun start(
            context: Context,
            base: String,
            token: String,
            answerRequestId: String? = null,
            security: SecureTransport.EndpointSecurity = SecureTransport.EndpointSecurity(),
            streamId: String? = null,
            micCancelSupported: Boolean = false,
        ) {
            if (active) throw IllegalStateException("Microphone is still finishing")
            val intent = Intent(context, VoiceService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_BASE, base)
                .putExtra(EXTRA_TOKEN, token)
                .putExtra(EXTRA_CERT_PIN, security.certPinSha256)
                .putExtra(EXTRA_ALLOW_INSECURE, security.allowInsecureLan)
                .putExtra(EXTRA_MIC_CANCEL, micCancelSupported)
            if (streamId != null) intent.putExtra(EXTRA_STREAM_ID, streamId)
            if (answerRequestId != null) intent.putExtra(EXTRA_ANSWER_REQUEST_ID, answerRequestId)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            // Abort captured resources synchronously BEFORE endpoint/credential swap.
            // Lifecycle/foreground cleanup remains main owned; no new FGS obligation.
            currentService?.captureSession?.cancel()
            context.stopService(Intent(context, VoiceService::class.java))
        }
    }
}
