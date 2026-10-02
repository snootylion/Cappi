package dev.dsh.watch.net

import org.junit.Assert.*
import org.junit.Test

class ImageSafetyTest {
    @Test fun decoderHeaderBoundsRejectTinyCompressedBombsAndInvalidDimensions() {
        for ((w, h) in listOf(0 to 1, -1 to 1, 1 to 0, 8193 to 1, 1 to 8193, 8000 to 8000, Int.MAX_VALUE to Int.MAX_VALUE)) {
            assertNull(ImageSafety.sampleForBounds(w, h, 480))
        }
        assertEquals(1, ImageSafety.sampleForBounds(120, 80, 480))
        assertEquals(8, ImageSafety.sampleForBounds(3840, 2160, 480))
        assertEquals(16, ImageSafety.sampleForBounds(8192, 1, 768))
    }
    @Test fun advertisedOversizedHttpBodyRejectedBeforeRead() {
        val server = java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))
        val worker = kotlin.concurrent.thread {
            server.accept().use { socket ->
                val reader = socket.getInputStream().bufferedReader()
                while (reader.readLine()?.isNotEmpty() == true) { }
                socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: ${ImageSafety.MAX_BYTES + 1}\r\nConnection: close\r\n\r\n".toByteArray())
            }
        }
        try {
            BridgeClient.fetchImage("http://127.0.0.1:${server.localPort}", "fixture", "image", SecureTransport.EndpointSecurity(allowInsecureLan = true))
            fail("oversized HTTP header accepted")
        } catch (e: java.io.IOException) { assertTrue(e.message!!.contains("6 MiB")) }
        finally { server.close(); worker.join(2000) }
    }
    @Test fun rawBodyBoundedBeforeDecodeWithoutPrivateBodyInException() {
        assertArrayEquals(byteArrayOf(1, 2), ImageSafety.readBounded(byteArrayOf(1, 2).inputStream()))
        val bytes = ByteArray(ImageSafety.MAX_BYTES + 1)
        try { ImageSafety.readBounded(bytes.inputStream()); fail("oversized body accepted") }
        catch (e: java.io.IOException) { assertEquals("Image unavailable: exceeds 6 MiB limit", e.message) }
    }
}
