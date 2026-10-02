package dev.dsh.watch.net

import org.junit.Assert.*
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * JVM tests for the actual [SecureTransport] factory (not a model of it):
 * pin normalization/display, fail-closed trust, and a mock HTTP host on an
 * ephemeral port (raw loopback socket, no extra dependencies) proving
 * header-only auth, no token in URLs, and redirect refusal. No Android APIs,
 * no live hosts, no secrets.
 */

/**
 * JVM tests for the actual [SecureTransport] factory (not a model of it):
 * pin normalization/display, fail-closed trust, and a mock HTTP host on an
 * ephemeral port proving header-only auth, no token in URLs, and redirect
 * refusal. No Android APIs, no live hosts, no secrets.
 */
class SecureTransportTest {

    private fun randomPin(): String {
        val bytes = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
        return java.util.Base64.getEncoder().encodeToString(bytes)
    }

    @Test fun normalizeAcceptsBridgeDisplayFormat() {
        val canonical = randomPin()
        assertEquals(canonical, SecureTransport.normalizePin("sha256/$canonical"))
        assertEquals(canonical, SecureTransport.normalizePin(canonical))
        assertEquals(canonical, SecureTransport.normalizePin("  sha256/$canonical  "))
        assertEquals(canonical, SecureTransport.normalizePin("SHA256/$canonical"))
    }

    @Test fun normalizeBlankStaysUnpaired() {
        assertEquals("", SecureTransport.normalizePin(""))
        assertEquals("", SecureTransport.normalizePin("   "))
    }

    @Test fun normalizeRejectsNon32Bytes() {
        try {
            SecureTransport.normalizePin("sha256/aGk=")
            fail("short pin must be rejected")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("32 bytes"))
        }
        try {
            SecureTransport.normalizePin("not-base64!!!")
            fail("non-base64 pin must be rejected")
        } catch (_: IllegalArgumentException) {
        }
        try {
            SecureTransport.normalizePin("sha256/")
            fail("empty pin must be rejected")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test fun displayRoundTripsThroughNormalize() {
        val canonical = randomPin()
        val shown = SecureTransport.displayPin(canonical)
        assertTrue(shown.startsWith("sha256/"))
        assertEquals(canonical, SecureTransport.normalizePin(shown))
        assertEquals("", SecureTransport.displayPin(""))
    }

    @Test fun pinErrorNullWhenAcceptable() {
        assertNull(SecureTransport.pinError(""))
        assertNull(SecureTransport.pinError("sha256/" + randomPin()))
        assertNotNull(SecureTransport.pinError("sha256/short"))
    }

    @Test fun pinMatchesHandlesPrefixAndRejectsBlank() {
        val canonical = randomPin()
        assertTrue(SecureTransport.pinMatches(canonical, canonical))
        assertTrue(SecureTransport.pinMatches("sha256/$canonical", canonical))
        assertTrue(SecureTransport.pinMatches(canonical, "sha256/$canonical"))
        assertFalse(SecureTransport.pinMatches("", canonical))
        assertFalse(SecureTransport.pinMatches(canonical, ""))
        assertFalse(SecureTransport.pinMatches(canonical, randomPin()))
    }

    @Test fun httpRefusedWithoutExplicitOptIn() {
        try {
            SecureTransport.open("http://127.0.0.1:9/watch/health", SecureTransport.EndpointSecurity())
            fail("cleartext without opt-in must be refused")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("insecure-LAN"))
        }
    }

    @Test fun httpsRefusedWithoutPinFailClosed() {
        // Fail-closed: no silent fallback to system PKI for a private bridge.
        try {
            SecureTransport.open("https://127.0.0.1:9/watch/health", SecureTransport.EndpointSecurity())
            fail("https without a pin must be refused")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("pinned certificate"))
        }
    }

    @Test fun httpsRefusedWithInvalidStoredPin() {
        try {
            SecureTransport.open(
                "https://127.0.0.1:9/watch/health",
                SecureTransport.EndpointSecurity(certPinSha256 = "bogus"),
            )
            fail("invalid stored pin must be refused")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("pin"))
        }
    }

    @Test fun nonHttpSchemeRefused() {
        try {
            SecureTransport.open("ftp://127.0.0.1:9/watch/health", SecureTransport.EndpointSecurity(allowInsecureLan = true))
            fail("non-http scheme must be refused")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("http(s)"))
        }
    }

    @Test fun blankPinStaysUnpairedAndMalformedSha256Rejected() {
        assertEquals("", SecureTransport.normalizePin(""))
        assertEquals("", SecureTransport.normalizePin("   "))
        assertNull(SecureTransport.pinError(""))
        assertNull(SecureTransport.pinError("   "))
        val bad = listOf("sha256/", "sha256/aGk=", "not-base64!!!", "sha256/" + "A".repeat(10))
        for (input in bad) {
            assertNotNull("pinError must explain '$input'", SecureTransport.pinError(input))
            try {
                SecureTransport.normalizePin(input)
                fail("malformed pin must be rejected: $input")
            } catch (_: IllegalArgumentException) {
            }
        }
        // 31 and 33 bytes (not 32) are rejected even when valid base64.
        for (n in listOf(31, 33)) {
            val b64 = java.util.Base64.getEncoder().encodeToString(ByteArray(n))
            try {
                SecureTransport.normalizePin("sha256/$b64")
                fail("$n-byte pin must be rejected")
            } catch (e: IllegalArgumentException) {
                assertTrue(e.message!!.contains("32 bytes"))
            }
        }
    }

    @Test fun endpointUserinfoFragmentAndQueryRejectedBeforeIo() {
        val security = SecureTransport.EndpointSecurity(allowInsecureLan = true)
        val evil = listOf(
            "http://user:pass@127.0.0.1:9/watch/health",
            "http://user@127.0.0.1:9/watch/health",
            "http://127.0.0.1:9/watch/health#frag",
            "http://127.0.0.1:9/watch/health?token=secret",
            "http://127.0.0.1:9/watch/command?ref=x",
            "http://127.0.0.1:9/watch/image?evil=1",
            "http://127.0.0.1:9/evil/path",
        )
        for (url in evil) {
            try {
                SecureTransport.open(url, security)
                fail("must refuse before I/O: $url")
            } catch (e: java.io.IOException) {
                assertTrue("wrong message for $url: ${e.message}",
                    e.message!!.contains("userinfo", ignoreCase = true) ||
                        e.message!!.contains("fragment", ignoreCase = true) ||
                        e.message!!.contains("query", ignoreCase = true) ||
                        e.message!!.contains("/watch/", ignoreCase = true))
            }
        }
        // Intended query paths pass validation (a refused-port connect
        // proves a socket was attempted, i.e. validation did not reject).
        for (url in listOf(
            "http://127.0.0.1:9/watch/image?ref=abc",
            "http://127.0.0.1:9/watch/pair-probe?nonce=abc",
            "http://127.0.0.1:9/watch/mic?answerRequestId=abc",
            "http://127.0.0.1:9/watch/mic",
        )) {
            val conn = SecureTransport.open(url, security)
            try {
                conn.connectTimeout = 1500
                conn.readTimeout = 1500
                try {
                    conn.connect()
                    fail("expected connect failure (validation must pass) for $url")
                } catch (e: java.io.IOException) {
                    assertFalse("validation must pass for $url, got: ${e.message}",
                        e.message!!.contains("userinfo") || e.message!!.contains("fragment") ||
                            e.message!!.contains("query") || e.message!!.contains("/watch/"))
                }
            } finally {
                conn.disconnect()
            }
        }
    }

    @Test fun wrongPinRejectedBeforeSensitiveBytesOverTls() {
        val tmp = java.nio.file.Files.createTempDirectory("q-tls").toFile()
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
            val goodPin = SecureTransport.sha256Pin(cert)
            val wrongPin = randomPin()
            assertFalse(SecureTransport.pinMatches(goodPin, wrongPin))

            val kmf = javax.net.ssl.KeyManagerFactory.getInstance(
                javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm())
            kmf.init(ks, "changeit".toCharArray())
            val serverCtx = javax.net.ssl.SSLContext.getInstance("TLS")
            serverCtx.init(kmf.keyManagers, null, null)
            // Raw TLS socket (java.base only): the test reads HTTP bytes
            // itself so no jdk.httpserver module is needed.
            val serverSock = serverCtx.serverSocketFactory.createServerSocket(
                0, 8, java.net.InetAddress.getByName("127.0.0.1"),
            ) as javax.net.ssl.SSLServerSocket
            val seenToken = AtomicReference<String?>()
            val hits = java.util.concurrent.atomic.AtomicInteger(0)
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
                            var token: String? = null
                            // Request line + headers until the blank line.
                            while (true) {
                                val line = reader.readLine() ?: break
                                if (line.isEmpty()) break
                                val name = line.substringBefore(":").trim()
                                if (name.equals(SecureTransport.TOKEN_HEADER, ignoreCase = true)) {
                                    token = line.substringAfter(":").trim()
                                }
                            }
                            if (token == null && s.inputStream.available() < 0) return@use
                            hits.incrementAndGet()
                            seenToken.set(token)
                            val body = "{}".toByteArray(Charsets.US_ASCII)
                            val out = s.outputStream
                            out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                                "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n")
                                .toByteArray(Charsets.US_ASCII))
                            out.write(body)
                            out.flush()
                        } catch (_: Exception) {
                            // Handshake failure (wrong pin): no request bytes,
                            // no hit, no token — exactly the guarantee.
                        }
                    }
                }
            }
            try {
                val port = serverSock.localPort
                // Wrong pin: TLS handshake fails — the server never sees a
                // request, so no token byte ever leaves the watch.
                try {
                    val conn = SecureTransport.open(
                        "https://127.0.0.1:$port/watch/health",
                        SecureTransport.EndpointSecurity(certPinSha256 = wrongPin),
                    )
                    SecureTransport.setTokenHeader(conn, "secret-token")
                    try {
                        conn.connect()
                        conn.inputStream.use { it.readBytes() }
                        fail("wrong pin must fail the handshake")
                    } finally {
                        conn.disconnect()
                    }
                    fail("wrong pin must fail the handshake")
                } catch (e: Exception) {
                    val msg = (e.message ?: "") + " " + e.javaClass.simpleName
                    assertTrue("expected pin/trust failure, got: $msg",
                        msg.contains("pin", ignoreCase = true) || msg.contains("trust", ignoreCase = true) ||
                            msg.contains("SSL", ignoreCase = true) || msg.contains("handshake", ignoreCase = true) ||
                            msg.contains("Certificate", ignoreCase = true))
                }
                // Give a refused handshake no chance to arrive late.
                Thread.sleep(300)
                assertEquals(0, hits.get())
                assertNull(seenToken.get())
                // Right pin: handshake passes and the request arrives.
                val ok = SecureTransport.open(
                    "https://127.0.0.1:$port/watch/health",
                    SecureTransport.EndpointSecurity(certPinSha256 = goodPin),
                )
                try {
                    SecureTransport.setTokenHeader(ok, "secret-token")
                    assertEquals(200, ok.responseCode)
                    ok.inputStream.use { it.readBytes() }
                } finally {
                    ok.disconnect()
                }
                assertEquals(1, hits.get())
                assertEquals("secret-token", seenToken.get())
            } finally {
                runCatching { serverSock.close() }
                worker.join(5000)
            }
        } finally {
            runCatching { tmp.deleteRecursively() }
        }
    }

    @Test fun bridgeClientRefusesRedirectWithoutFollowing() {
        val server = ServerSocket(0, 8, java.net.InetAddress.getByName("127.0.0.1"))
        val port = server.localPort
        val worker = thread(isDaemon = true) {
            repeat(4) {
                val sock = try {
                    server.accept()
                } catch (_: Exception) {
                    return@repeat
                }
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
                    // Consume the POST body (if any) before responding, so the
                    // client's write never races the 302.
                    var remaining = contentLength
                    while (remaining > 0) {
                        val skipped = reader.skip(remaining.toLong())
                        if (skipped <= 0) break
                        remaining -= skipped.toInt()
                    }
                    val out = s.getOutputStream()
                    out.write("HTTP/1.1 302 Found\r\nLocation: /watch/health\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
                    out.flush()
                }
            }
        }
        try {
            val security = SecureTransport.EndpointSecurity(allowInsecureLan = true)
            val base = "http://127.0.0.1:$port"
            try {
                BridgeClient.health(base, security)
                fail("health must refuse a redirect")
            } catch (e: java.io.IOException) {
                assertTrue(e.message!!.contains("redirect", ignoreCase = true))
            }
            try {
                // fetchState exercises the authenticated POST-free path with a
                // token header and no org.json body (unit tests run against
                // the Android stub, so no JSONObject is constructed here).
                BridgeClient.fetchState(base, "tok", security)
                fail("state must refuse a redirect")
            } catch (e: java.io.IOException) {
                assertTrue(e.message!!.contains("redirect", ignoreCase = true))
            }
        } finally {
            runCatching { server.close() }
            worker.join(3000)
        }
    }

    @Test fun pairPathsAllowlistedExactNoQuerySubpathRejected() {
        val pin = randomPin()
        val security = SecureTransport.EndpointSecurity(certPinSha256 = pin)
        // Exact pair paths pass validation (a refused-port connect proves a
        // socket was attempted, i.e. validation did not reject).
        for (url in listOf(
            "https://127.0.0.1:9/pair/info",
            "https://127.0.0.1:9/pair/enroll",
            "https://127.0.0.1:9/pair/poll",
        )) {
            val conn = SecureTransport.open(url, security)
            try {
                conn.connectTimeout = 800
                conn.readTimeout = 800
                try {
                    conn.connect()
                    fail("expected connect failure (validation must pass) for $url")
                } catch (e: java.io.IOException) {
                    assertFalse("validation must pass for $url, got: ${e.message}",
                        e.message!!.contains("must be /watch/", ignoreCase = true))
                }
            } finally {
                conn.disconnect()
            }
        }
        // Query / fragment / subpaths on pairing paths are refused pre-I/O:
        // secrets must never travel in URLs.
        for (url in listOf(
            "https://127.0.0.1:9/pair/enroll?token=secret",
            "https://127.0.0.1:9/pair/poll?secret=abc",
            "https://127.0.0.1:9/pair/info#frag",
            "https://127.0.0.1:9/pair/enroll/extra",
            "https://127.0.0.1:9/pair/other",
        )) {
            try {
                SecureTransport.open(url, security)
                fail("must refuse before I/O: $url")
            } catch (e: java.io.IOException) {
                assertTrue("wrong message for $url: ${e.message}",
                    e.message!!.contains("query", ignoreCase = true) ||
                        e.message!!.contains("fragment", ignoreCase = true) ||
                        e.message!!.contains("/pair/", ignoreCase = true) ||
                        e.message!!.contains("/watch/", ignoreCase = true))
            }
        }
    }

    @Test fun raceCancellationReturnsNullWithoutDialling() {
        // Immediate cancellation: actual behavior returns null fast, with no
        // socket work and no throw.
        val start = System.currentTimeMillis()
        val out = BridgeClient.discoverBase(
            "tok", 1500, SecureTransport.EndpointSecurity(),
            isCancelled = { true },
        )
        assertNull(out)
        assertTrue(System.currentTimeMillis() - start < 1500)
        // A closed loopback port never verifies (actual I/O, not source text).
        assertFalse(BridgeClient.pinVerified(
            "https://127.0.0.1:9", SecureTransport.EndpointSecurity(certPinSha256 = randomPin())))
    }

    @Test fun mockHostHeaderAuthNoTokenInUrlAndRedirectRefused() {
        // Minimal loopback HTTP host: records the request line + token header,
        // serves one 200 and one 302. Raw sockets keep the test dependency-free.
        val seenRequestLine = AtomicReference<String?>()
        val seenAuth = AtomicReference<String?>()
        val server = ServerSocket(0, 8, java.net.InetAddress.getByName("127.0.0.1"))
        val port = server.localPort
        val worker = thread(isDaemon = true) {
            repeat(2) {
                val sock = try {
                    server.accept()
                } catch (_: Exception) {
                    return@repeat
                }
                sock.use { s ->
                    val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.US_ASCII))
                    val requestLine = reader.readLine() ?: return@use
                    var auth: String? = null
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        val name = line.substringBefore(":").trim()
                        if (name.equals(SecureTransport.TOKEN_HEADER, ignoreCase = true)) {
                            auth = line.substringAfter(":").trim()
                        }
                    }
                    seenRequestLine.set(requestLine)
                    seenAuth.set(auth)
                    val out = s.getOutputStream()
                    if (requestLine.contains("/watch/redirect")) {
                        out.write("HTTP/1.1 302 Found\r\nLocation: /watch/health\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
                    } else {
                        val body = "{}".toByteArray()
                        out.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
                        out.write(body)
                    }
                    out.flush()
                }
            }
        }
        try {
            val security = SecureTransport.EndpointSecurity(allowInsecureLan = true)

            val conn = SecureTransport.open("http://127.0.0.1:$port/watch/image?ref=abc", security)
            conn.requestMethod = "GET"
            conn.connectTimeout = 3000
            conn.readTimeout = 3000
            SecureTransport.setTokenHeader(conn, "secret-token")
            try {
                SecureTransport.throwOnRedirect(conn)
                assertEquals(200, conn.responseCode)
                conn.inputStream.use { it.readBytes() }
            } finally {
                conn.disconnect()
            }
            assertEquals("secret-token", seenAuth.get())
            val requestLine = seenRequestLine.get()!!
            assertFalse("token must never appear in the request line", requestLine.contains("secret-token"))
            assertFalse("token must never appear as a query param", requestLine.contains("token="))

            val redir = SecureTransport.open("http://127.0.0.1:$port/watch/redirect", security)
            redir.requestMethod = "GET"
            redir.connectTimeout = 3000
            redir.readTimeout = 3000
            SecureTransport.setTokenHeader(redir, "secret-token")
            try {
                SecureTransport.throwOnRedirect(redir)
                fail("redirect must be refused, never followed with the token")
            } catch (e: java.io.IOException) {
                assertTrue(e.message!!.contains("redirect refused"))
            } finally {
                redir.disconnect()
            }
        } finally {
            runCatching { server.close() }
            worker.join(3000)
        }
    }
}
