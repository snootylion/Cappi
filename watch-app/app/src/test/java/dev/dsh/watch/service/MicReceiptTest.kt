package dev.dsh.watch.service

import dev.dsh.watch.net.PairingTransport
import org.junit.Assert.*
import org.junit.Test

class MicReceiptTest {
    private fun receipt(fields: String) = "{\"streamId\":\"current\",\"state\":\"closed\",$fields}"
    private fun evaluate(body: String, draft: Boolean = false, legacy: Boolean = false) =
        MicReceipt.evaluate(200, body, "current", draft, legacy)

    @Test fun managedAcknowledgementRequiresActualDeliveryAndAck() {
        assertTrue(evaluate(receipt("\"delivered\":true,\"ackFinals\":1")).accepted)
        assertTrue(evaluate(receipt("\"delivered\":true,\"ackFinals\":1")).sdkAcknowledged)
        assertFalse(evaluate(receipt("\"delivered\":true,\"ackFinals\":0")).accepted)
        assertFalse(evaluate(receipt("\"delivered\":false,\"ackFinals\":1")).accepted)
        assertFalse(evaluate("{\"ok\":true}").accepted) // Never generic managed fake success.
    }
    @Test fun noSpeechAndExplicitFailureRemainFriendlyErrorWithoutPrivateText() {
        val noSpeech = evaluate(receipt("\"delivered\":false,\"ackFinals\":0"))
        assertEquals("error", noSpeech.state)
        assertTrue(noSpeech.message!!.contains("No speech"))
        for (code in listOf("no-speech", "prompt-delivery-failed", "mic-delivery-failed", "private-body-value")) {
            val result = evaluate(receipt("\"delivered\":false,\"ackFinals\":0,\"code\":\"$code\",\"message\":\"private transcript and token\""))
            assertFalse(result.accepted)
            assertFalse(result.message!!.contains("private"))
        }
        assertFalse(evaluate(receipt("\"delivered\":true,\"ackFinals\":1").replace("closed", "error")).accepted)
    }
    @Test fun draftedIsOnlyCapturedQuestionIntentAndNeverSdkAcknowledgement() {
        val draft = receipt("\"drafted\":true,\"delivered\":false,\"ackFinals\":0")
        assertTrue(evaluate(draft, draft = true).accepted)
        assertTrue(evaluate(draft, draft = true).drafted)
        assertFalse(evaluate(draft, draft = true).sdkAcknowledged)
        assertFalse(evaluate(draft).accepted)
        assertFalse(evaluate(receipt("\"drafted\":false,\"delivered\":false,\"ackFinals\":0"), draft = true).accepted)
        assertFalse(evaluate(receipt("\"delivered\":true,\"ackFinals\":1"), draft = true).accepted)
    }
    @Test fun wrongStreamMalformedDuplicateAndTypedFieldsRejected() {
        for (body in listOf(
            receipt("\"delivered\":true,\"ackFinals\":1").replace("current", "other"),
            "{", "{} trailing", "[]", "{\"ok\":true,\"ok\":true}",
            receipt("\"delivered\":\"true\",\"ackFinals\":1"),
            receipt("\"delivered\":true,\"ackFinals\":1.5"),
            receipt("\"delivered\":true,\"ackFinals\":-1")
        )) assertFalse(evaluate(body).accepted)
    }
    @Test fun legacyWithoutAdmissionFieldsExplicitlyCompatible() {
        assertTrue(evaluate("{\"ok\":true}", legacy = true).accepted)
        assertFalse(evaluate("{\"ok\":false}", legacy = true).accepted)
        assertFalse(evaluate("{\"error\":\"failure\"}", legacy = true).accepted)
        assertFalse(evaluate("{\"streamId\":\"other\",\"ok\":true}", legacy = true).accepted)
    }
    @Test fun sameStreamErrorCannotBeOverwrittenByHttpCloseOrSseReady() {
        for (late in listOf("closed", "ready", "capturing", "warming", "finishing")) assertFalse(MicReceipt.allowsProgress("error", late))
        assertTrue(MicReceipt.allowsProgress("error", "error"))
        assertTrue(MicReceipt.allowsProgress("warming", "ready")) // new explicit UUID initializes fresh stream
    }
    @Test fun recordOffAndCancelledTerminalCannotReopenFromDelayedCapturing() {
        assertFalse(MicReceipt.allowsProgress("finishing", "ready"))
        assertFalse(MicReceipt.allowsProgress("finishing", "capturing"))
        assertFalse(MicReceipt.allowsProgress("closed", "ready"))
        assertTrue(MicReceipt.allowsProgress("closed", "error")) // late HTTP failure still truthful
        assertFalse(MicReceipt.allowsProgress("cancelled", "error"))
        assertFalse(MicReceipt.allowsProgress("cancelled", "ready"))
    }
    @Test fun postUploadHttpFailuresAreNotEofSuccessAndCancelledCaptureQuiet() {
        for (status in listOf(401, 413, 500)) {
            val result = MicReceipt.evaluate(status, "private body", "current", false)
            assertEquals("error", result.state)
            assertFalse(result.message!!.contains("private"))
        }
        assertTrue(MicReceipt.shouldPublishFailure(true, true, "closed"))
        assertFalse(MicReceipt.shouldPublishFailure(false, true, "capturing"))
        assertFalse(MicReceipt.shouldPublishFailure(true, false, "capturing"))
        assertFalse(MicReceipt.shouldPublishFailure(true, true, "error"))
    }
    @Test fun boundedRawUtf8BeforeReceiptJson() {
        for (bytes in listOf(ByteArray(16385), byteArrayOf(0xc3.toByte(), 0x28))) {
            try { PairingTransport.readBoundedUtf8(bytes.inputStream()); fail("private/oversized input accepted") }
            catch (e: java.io.IOException) { assertFalse(e.message.orEmpty().contains("private")) }
        }
    }
    @Test fun actualHttpPostFailureAfterEofUsesSharedResponsePolicy() {
        val server = java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))
        val worker = kotlin.concurrent.thread {
            server.accept().use { socket ->
                val reader = socket.getInputStream().bufferedReader()
                while (reader.readLine()?.isNotEmpty() == true) { }
                reader.read() // Exact one-byte synthetic body; no AudioRecord or user audio.
                socket.getOutputStream().write("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
            }
        }
        val conn = java.net.URL("http://127.0.0.1:${server.localPort}/watch/mic").openConnection() as java.net.HttpURLConnection
        try {
            conn.requestMethod = "POST"; conn.doOutput = true; conn.readTimeout = 2000
            conn.setFixedLengthStreamingMode(1)
            conn.outputStream.use { it.write(0) }
            assertEquals("error", MicReceipt.read(conn, "current", false, false).state)
        } finally { conn.disconnect(); server.close(); worker.join(2000) }
    }
}
