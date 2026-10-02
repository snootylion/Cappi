package dev.dsh.watch.net

import org.junit.Assert.*
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket
import kotlin.concurrent.thread

/**
 * W-owned pairing-transport guards (JVM, ephemeral loopback ports only).
 * Covers: secret entropy shape, handshake-derived fingerprints, base hygiene
 * (https-only, no userinfo/query/fragment), redirect refusal, legacy mic
 * preflight 404 → explicit [PairingTransport.MicStartMissing] (no silent
 * downgrade), and non-200 enroll/poll surfacing.
 */
class PairingTransportTest {

    private fun randomPin(): String =
        java.util.Base64.getEncoder().encodeToString(ByteArray(32).also {
            java.security.SecureRandom().nextBytes(it)
        })

    @Test fun secretsAreHighEntropyBase64Url() {
        repeat(50) {
            val s = PairingTransport.newSecret()
            assertTrue(PairingTransport.isSecretShape(s))
            assertFalse(s.contains("+") || s.contains("/") || s.contains("="))
        }
        assertFalse(PairingTransport.isSecretShape("short"))
        assertFalse(PairingTransport.isSecretShape("has space in it 1234567890!"))
    }

    @Test fun fingerprintFormatsFromRealCert() {
        val tmp = java.nio.file.Files.createTempDirectory("w-pair").toFile()
        try {
            val ksFile = java.io.File(tmp, "ks.jks")
            val proc = ProcessBuilder(
                "keytool", "-genkeypair", "-alias", "bridge", "-keyalg", "RSA", "-keysize", "2048",
                "-validity", "1", "-keystore", ksFile.absolutePath, "-storepass", "changeit",
                "-keypass", "changeit", "-dname", "CN=127.0.0.1", "-ext", "SAN=IP:127.0.0.1",
            ).redirectErrorStream(true).start()
            val out = proc.inputStream.bufferedReader().readText()
            assertEquals("keytool failed: $out", 0, proc.waitFor())
            val ks = java.security.KeyStore.getInstance("JKS")
            ksFile.inputStream().use { ks.load(it, "changeit".toCharArray()) }
            val cert = ks.getCertificate("bridge") as java.security.cert.X509Certificate
            val pin = PairingTransport.handshakePin(cert)
            assertTrue(pin.startsWith("sha256/"))
            assertTrue(SecureTransport.pinMatches(pin, SecureTransport.normalizePin(pin)))
            val full = PairingTransport.fullFingerprint(cert)
            assertTrue(full.matches(Regex("^([0-9a-f]{2}:){31}[0-9a-f]{2}$")))
            val short = PairingTransport.shortFingerprint(full)
            assertTrue(short.matches(Regex("^[0-9a-f]{4}(-[0-9a-f]{4}){5}$")))
            // Short is the leading 96 bits of the full fingerprint.
            assertEquals(full.replace(":", "").substring(0, 24),
                short.replace("-", ""))
        } finally {
            runCatching { tmp.deleteRecursively() }
        }
    }

    @Test fun pairingBasesAreHttpsOnlyAndHygienic() {
        val pin = "sha256/${randomPin()}"
        for (bad in listOf(
            "",
            "http://127.0.0.1:9",
            "https://user:pass@127.0.0.1:9",
            "https://127.0.0.1:9/pair/info?token=secret",
            "https://127.0.0.1:9/pair/info#frag",
        )) {
            try {
                PairingTransport.fetchPairInfo(bad, 1000)
                fail("must refuse before I/O: $bad")
            } catch (e: java.io.IOException) {
                // Expected: hygiene or unreachable — never a silent trust.
                assertTrue(e.message!!.isNotEmpty())
            }
        }
        // Enroll validates alias + secret shape before I/O.
        try {
            PairingTransport.enroll("https://127.0.0.1:9", pin, "", "bad secret!!")
            fail("bad alias/secret must be refused")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.isNotEmpty())
        }
    }

    @Test fun legacyBridgeMicPreflight404IsExplicit() {
        // Loopback host answering 404: the client must surface MicStartMissing
        // (explicit legacy fallback), never silently downgrade or proceed.
        val server = ServerSocket(0, 8, java.net.InetAddress.getByName("127.0.0.1"))
        val port = server.localPort
        val worker = thread(isDaemon = true) {
            repeat(2) {
                val sock = try { server.accept() } catch (_: Exception) { return@repeat }
                sock.use { s ->
                    val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.US_ASCII))
                    var contentLength = 0
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        if (line.startsWith("Content-Length:", ignoreCase = true)) {
                            contentLength = line.substringAfter(":").trim().toIntOrNull() ?: 0
                        }
                    }
                    var remaining = contentLength
                    while (remaining > 0) {
                        val skipped = reader.skip(remaining.toLong())
                        if (skipped <= 0) break
                        remaining -= skipped.toInt()
                    }
                    val body = "{\"ok\":false,\"error\":\"not-found\"}".toByteArray(Charsets.US_ASCII)
                    val out = s.getOutputStream()
                    out.write(("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n" +
                        "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n")
                        .toByteArray(Charsets.US_ASCII))
                    out.write(body)
                    out.flush()
                }
            }
        }
        try {
            val security = SecureTransport.EndpointSecurity(allowInsecureLan = true)
            try {
                PairingTransport.micStart("http://127.0.0.1:$port", "tok", security, "watch-1")
                fail("404 must surface as MicStartMissing")
            } catch (e: PairingTransport.MicStartMissing) {
                assertTrue(e.message!!.contains("legacy", ignoreCase = true))
            }
        } finally {
            runCatching { server.close() }
            worker.join(3000)
        }
    }

    @Test fun micPreflightRedirectIsRefused() {
        val server = ServerSocket(0, 8, java.net.InetAddress.getByName("127.0.0.1"))
        val port = server.localPort
        val worker = thread(isDaemon = true) {
            val sock = try { server.accept() } catch (_: Exception) { return@thread }
            sock.use { s ->
                val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.US_ASCII))
                var contentLength = 0
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                    if (line.startsWith("Content-Length:", ignoreCase = true)) {
                        contentLength = line.substringAfter(":").trim().toIntOrNull() ?: 0
                    }
                }
                var remaining = contentLength
                while (remaining > 0) {
                    val skipped = reader.skip(remaining.toLong())
                    if (skipped <= 0) break
                    remaining -= skipped.toInt()
                }
                val out = s.getOutputStream()
                out.write("HTTP/1.1 302 Found\r\nLocation: /watch/health\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .toByteArray(Charsets.US_ASCII))
                out.flush()
            }
        }
        try {
            val security = SecureTransport.EndpointSecurity(allowInsecureLan = true)
            try {
                PairingTransport.micStart("http://127.0.0.1:$port", "tok", security, "watch-1")
                fail("redirect must be refused")
            } catch (e: java.io.IOException) {
                assertTrue(e.message!!.contains("redirect", ignoreCase = true))
            }
        } finally {
            runCatching { server.close() }
            worker.join(3000)
        }
    }

    @Test fun tamperedApprovedPinIsRejectedByCenter() {
        val pin = "sha256/${randomPin()}"
        val other = "sha256/${randomPin()}"
        val rec = dev.dsh.watch.core.PairingCenter.ImmutableRecord("https://10.0.0.2:8443", pin)
        val forged = PairingTransport.PollResult.Approved("d1", "t".repeat(32), rec.baseUrl, other)
        assertNull(dev.dsh.watch.core.PairingCenter.approvedPersist(rec, pin, forged))
        assertTrue(dev.dsh.watch.core.PairingCenter.rotationDetected(pin, other))
    }

    @Test fun strictJsonRejectsDuplicatesUnknownNestedTrailingAndWrongTypes() {
        // Duplicate keys.
        try {
            StrictJson.parse("{\"a\":\"1\",\"a\":\"2\"}")
            fail("duplicate keys must be rejected")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("duplicate", ignoreCase = true))
        }
        // Unknown field gate (caller allowlist).
        val m = StrictJson.parse("{\"requestId\":\"${"a".repeat(22)}\",\"expiresAtMs\":5}")
        try {
            StrictJson.rejectUnknown(m, setOf("requestId"), "enroll")
            fail("unknown field must be rejected")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("unknown", ignoreCase = true))
        }
        // Nested spoof: arrays rejected; deep nesting rejected.
        for (bad in listOf(
            "{\"fingerprint\":[1,2]}",
            "{\"a\":{\"b\":{\"c\":\"d\"}}}",
            "{\"a\":\"1\"} trailing",
            "{\"a\":123",
            "not json",
            "{\"a\":\"unterminated}",
        )) {
            try {
                StrictJson.parse(bad)
                fail("must reject: $bad")
            } catch (e: java.io.IOException) {
                assertTrue(e.message!!.isNotEmpty())
            }
        }
        // Wrong types rejected on typed access.
        val nums = StrictJson.parse("{\"requestId\":123,\"expiresAtMs\":\"nope\"}")
        try {
            StrictJson.str(nums, "requestId")
            fail("number-for-string must be rejected")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("string"))
        }
        try {
            StrictJson.long(nums, "expiresAtMs")
            fail("string-for-number must be rejected")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("number"))
        }
        // Bounded: oversized body refused.
        try {
            StrictJson.parse("{\"a\":\"" + "x".repeat(StrictJson.MAX_BODY_BYTES) + "\"}")
            fail("oversized body must be refused")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("exceeds", ignoreCase = true))
        }
        // Happy path: nested fingerprint parses with exact keys.
        val ok = StrictJson.parse(
            "{\"pairProtocol\":\"turnkey/1\",\"certSha256Pin\":\"sha256/${randomPin()}\"," +
                "\"serverDisplayName\":\"Mac\",\"nonce\":\"${"b".repeat(22)}\"," +
                "\"fingerprint\":{\"full\":\"${"aa:".repeat(31)}aa\",\"short\":\"aaaa-bbbb-cccc-dddd-eeee-ffff\"}}",
        )
        StrictJson.rejectUnknown(
            ok, setOf("pairProtocol", "certSha256Pin", "serverDisplayName", "nonce", "fingerprint"), "pair info")
        val fp = StrictJson.nested(ok, "fingerprint", setOf("full", "short"))!!
        assertNotNull(StrictJson.str(fp, "full"))
    }

    @Test fun enrollSendsConfirmHeadersMockHRequiresThem() {
        // Mock H enroll gate over pinned TLS: 403 unless BOTH
        // X-Fingerprint-Confirmed:true AND X-Cert-Pin:<pin> are present.
        // Proves the W client sends the ACTUAL host-required headers.
        val tmp = java.nio.file.Files.createTempDirectory("w-enroll").toFile()
        try {
            val ksFile = java.io.File(tmp, "ks.jks")
            val proc = ProcessBuilder(
                "keytool", "-genkeypair", "-alias", "bridge", "-keyalg", "RSA", "-keysize", "2048",
                "-validity", "1", "-keystore", ksFile.absolutePath, "-storepass", "changeit",
                "-keypass", "changeit", "-dname", "CN=127.0.0.1", "-ext", "SAN=IP:127.0.0.1",
            ).redirectErrorStream(true).start()
            val out = proc.inputStream.bufferedReader().readText()
            assertEquals("keytool failed: $out", 0, proc.waitFor())
            val ks = java.security.KeyStore.getInstance("JKS")
            ksFile.inputStream().use { ks.load(it, "changeit".toCharArray()) }
            val cert = ks.getCertificate("bridge") as java.security.cert.X509Certificate
            val pin = PairingTransport.handshakePin(cert)
            val kmf = javax.net.ssl.KeyManagerFactory.getInstance(
                javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm())
            kmf.init(ks, "changeit".toCharArray())
            val serverCtx = javax.net.ssl.SSLContext.getInstance("TLS")
            serverCtx.init(kmf.keyManagers, null, null)
            val serverSock = serverCtx.serverSocketFactory.createServerSocket(
                0, 8, java.net.InetAddress.getByName("127.0.0.1"),
            ) as javax.net.ssl.SSLServerSocket
            val seenConfirm = java.util.concurrent.atomic.AtomicReference<String?>()
            val seenPin = java.util.concurrent.atomic.AtomicReference<String?>()
            val seenBody = java.util.concurrent.atomic.AtomicReference<String?>()
            val worker = thread(isDaemon = true) {
                repeat(2) {
                    val sock = try {
                        serverSock.accept() as javax.net.ssl.SSLSocket
                    } catch (_: Exception) {
                        return@repeat
                    }
                    sock.use { s ->
                        try {
                            s.soTimeout = 5000
                            val reader = BufferedReader(
                                InputStreamReader(s.inputStream, Charsets.US_ASCII))
                            reader.readLine() // request line
                            var confirm: String? = null
                            var pinH: String? = null
                            var contentLength = 0
                            while (true) {
                                val line = reader.readLine() ?: break
                                if (line.isEmpty()) break
                                val name = line.substringBefore(":").trim()
                                when {
                                    name.equals(PairingTransport.HEADER_FINGERPRINT_CONFIRMED, ignoreCase = true) ->
                                        confirm = line.substringAfter(":").trim()
                                    name.equals(PairingTransport.HEADER_CERT_PIN, ignoreCase = true) ->
                                        pinH = line.substringAfter(":").trim()
                                    name.equals("Content-Length", ignoreCase = true) ->
                                        contentLength = line.substringAfter(":").trim().toIntOrNull() ?: 0
                                }
                            }
                            val bodyChars = CharArray(contentLength)
                            var read = 0
                            while (read < contentLength) {
                                val n = reader.read(bodyChars, read, contentLength - read)
                                if (n <= 0) break
                                read += n
                            }
                            seenConfirm.set(confirm)
                            seenPin.set(pinH)
                            seenBody.set(String(bodyChars, 0, read))
                            val okHeaders = confirm.equals("true", ignoreCase = true) &&
                                pinH != null && SecureTransport.pinMatches(pinH, pin)
                            val reqId = "r".repeat(32)
                            val payload = if (okHeaders) {
                                "{\"requestId\":\"$reqId\",\"expiresAtMs\":${System.currentTimeMillis() + 60_000}}"
                            } else {
                                "{\"ok\":false,\"error\":\"approval-required\",\"retryable\":false}"
                            }
                            val status = if (okHeaders) "201 Created" else "403 Forbidden"
                            val bytes = payload.toByteArray(Charsets.US_ASCII)
                            val output = s.outputStream
                            output.write(("HTTP/1.1 $status\r\nContent-Type: application/json\r\n" +
                                "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n")
                                .toByteArray(Charsets.US_ASCII))
                            output.write(bytes)
                            output.flush()
                        } catch (_: Exception) {
                        }
                    }
                }
            }
            try {
                val port = serverSock.localPort
                val base = "https://127.0.0.1:$port"
                // Real client: must succeed because it sends both headers.
                val res = PairingTransport.enroll(base, pin, "Watch4", PairingTransport.newSecret())
                assertTrue(PairingTransport.isSecretShape(res.requestId))
                assertEquals("true", seenConfirm.get()?.lowercase())
                assertTrue(SecureTransport.pinMatches(seenPin.get().orEmpty(), pin))
                // Secret traveled in the JSON body only — never the URL/headers.
                assertTrue(seenBody.get()!!.contains("enrollmentSecret"))
                assertFalse(seenBody.get()!!.contains("fingerprintConfirmed"))
                // Raw request WITHOUT headers: mock H must 403 (actual gate).
                val raw = java.net.URL("$base${PairingTransport.PATH_ENROLL}").openConnection()
                    as javax.net.ssl.HttpsURLConnection
                val trustAll = object : javax.net.ssl.X509TrustManager {
                    override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = emptyArray()
                    override fun checkClientTrusted(c: Array<java.security.cert.X509Certificate>, a: String) = Unit
                    override fun checkServerTrusted(c: Array<java.security.cert.X509Certificate>, a: String) = Unit
                }
                val ctx = javax.net.ssl.SSLContext.getInstance("TLS")
                ctx.init(null, arrayOf<javax.net.ssl.TrustManager>(trustAll), java.security.SecureRandom())
                raw.sslSocketFactory = ctx.socketFactory
                raw.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
                raw.requestMethod = "POST"
                raw.doOutput = true
                raw.setRequestProperty("Content-Type", "application/json")
                val secret = PairingTransport.newSecret()
                val bare = "{\"deviceAlias\":\"Watch4\",\"enrollmentSecret\":\"$secret\"}"
                raw.outputStream.use { it.write(bare.toByteArray(Charsets.UTF_8)) }
                assertEquals(403, raw.responseCode)
                raw.disconnect()
            } finally {
                runCatching { serverSock.close() }
                worker.join(5000)
            }
        } finally {
            runCatching { tmp.deleteRecursively() }
        }
    }

    @Test fun micPreflight503ReadyFalseMeansNoCapture() {
        // Mock host answering 503 mic-not-ready: client must surface
        // ready=false with guidance and must NOT throw-or-capture.
        val server = ServerSocket(0, 8, java.net.InetAddress.getByName("127.0.0.1"))
        val port = server.localPort
        val worker = thread(isDaemon = true) {
            val sock = try { server.accept() } catch (_: Exception) { return@thread }
            sock.use { s ->
                val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.US_ASCII))
                var contentLength = 0
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                    if (line.startsWith("Content-Length:", ignoreCase = true)) {
                        contentLength = line.substringAfter(":").trim().toIntOrNull() ?: 0
                    }
                }
                var remaining = contentLength
                while (remaining > 0) {
                    val skipped = reader.skip(remaining.toLong())
                    if (skipped <= 0) break
                    remaining -= skipped.toInt()
                }
                val body = "{\"ok\":false,\"error\":\"mic-not-ready\",\"retryable\":true,\"message\":\"warming\"}"
                    .toByteArray(Charsets.US_ASCII)
                val out = s.getOutputStream()
                out.write(("HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n" +
                    "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n")
                    .toByteArray(Charsets.US_ASCII))
                out.write(body)
                out.flush()
            }
        }
        try {
            val security = SecureTransport.EndpointSecurity(allowInsecureLan = true)
            val r = PairingTransport.micStart("http://127.0.0.1:$port", "tok", security, "watch-1")
            assertFalse(r.ready)
            assertTrue(r.message!!.isNotEmpty())
        } finally {
            runCatching { server.close() }
            worker.join(3000)
        }
    }

    @Test fun pollPendingApprovedReplayExpiryShapes() {
        // Approved pin echo mismatch + TTL guard live in PairingCenter; here
        // assert the shape validators: bad requestId/secret refused pre-I/O.
        try {
            PairingTransport.poll("https://127.0.0.1:9", "sha256/${randomPin()}", "short", PairingTransport.newSecret())
            fail("bad requestId must be refused")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("requestId", ignoreCase = true))
        }
        // Expired approved never persists (TTL guard).
        val pin = "sha256/${randomPin()}"
        val rec = dev.dsh.watch.core.PairingCenter.ImmutableRecord("https://10.0.0.2:8443", pin)
        val approved = PairingTransport.PollResult.Approved("d1", "t".repeat(32), rec.baseUrl, pin)
        assertNull(dev.dsh.watch.core.PairingCenter.approvedPersistIfFresh(
            rec, pin, approved, expiresAtMs = 1000L, nowMs = 2000L))
        assertNotNull(dev.dsh.watch.core.PairingCenter.approvedPersistIfFresh(
            rec, pin, approved, expiresAtMs = 5000L, nowMs = 1000L))
        // Vacuous self-compare is NOT sufficient: live pin differs → discard.
        val other = "sha256/${randomPin()}"
        assertNull(dev.dsh.watch.core.PairingCenter.approvedPersistIfFresh(
            rec, other, approved, expiresAtMs = 9000L, nowMs = 1000L))
    }
}
