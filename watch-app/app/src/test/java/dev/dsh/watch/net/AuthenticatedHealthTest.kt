package dev.dsh.watch.net

import org.junit.Assert.*
import org.junit.Test
import java.security.KeyStore
import java.security.cert.X509Certificate
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import kotlin.concurrent.thread

class AuthenticatedHealthTest {
    @Test fun storedActualPinThenDeviceAuthAndNoTokenSentToWrongPeer() {
        val ks = KeyStore.getInstance("PKCS12")
        java.io.File("build/generated/sdwTestAssets/sdw-fixture.p12").inputStream().use { ks.load(it, "fixture-only".toCharArray()) }
        val cert = ks.getCertificate(ks.aliases().nextElement()) as X509Certificate
        val km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        km.init(ks, "fixture-only".toCharArray())
        val ctx = SSLContext.getInstance("TLS"); ctx.init(km.keyManagers, null, null)
        val server = ctx.serverSocketFactory.createServerSocket(0, 8, java.net.InetAddress.getByName("127.0.0.1")) as SSLServerSocket
        val received = java.util.concurrent.atomic.AtomicInteger()
        val token = "isolated-fixture-token"
        val worker = thread(isDaemon = true) {
            repeat(3) {
                try {
                    server.accept().use { s ->
                        val reader = s.getInputStream().bufferedReader()
                        val request = reader.readLine() ?: return@use
                        assertEquals("GET /watch/health HTTP/1.1", request)
                        var header = ""
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isEmpty()) break
                            if (line.startsWith("X-Bridge-Token:", true)) header = line.substringAfter(':').trim()
                        }
                        received.incrementAndGet()
                        val code = if (header == token) 200 else 401
                        s.getOutputStream().write("HTTP/1.1 $code Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                    }
                } catch (_: Exception) { }
            }
        }
        try {
            val base = "https://127.0.0.1:${server.localPort}"
            val security = SecureTransport.EndpointSecurity(certPinSha256 = SecureTransport.sha256Pin(cert))
            assertTrue(BridgeClient.authenticatedHealthVerified(base, token, security, 2000))
            assertFalse(BridgeClient.authenticatedHealthVerified(base, "revoked-fixture-token", security, 2000))
            val wrong = security.copy(certPinSha256 = java.util.Base64.getEncoder().encodeToString(ByteArray(32)))
            assertFalse(BridgeClient.authenticatedHealthVerified(base, token, wrong, 1000))
            assertEquals(2, received.get()) // wrong peer sees no HTTP request/header
        } finally { server.close(); worker.join(2000) }
    }
}
