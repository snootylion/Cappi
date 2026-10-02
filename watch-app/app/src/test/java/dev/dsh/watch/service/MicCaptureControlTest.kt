package dev.dsh.watch.service

import org.junit.Assert.*
import org.junit.Test

class MicCaptureControlTest {
    @Test fun recordOffPreservesTransportForEofAndReceipt() {
        val c = MicCaptureControl(); c.finishRecording()
        assertFalse(c.recording); assertTrue(c.transportActive); assertFalse(c.aborted)
        assertTrue(MicReceipt.shouldPublishFailure(c.transportActive, true, "closed"))
    }
    @Test fun legacyMicCancelAbsentDefaultsOff() {
        assertFalse(dev.dsh.watch.core.UiState(base = "", token = "").micCancelSupported)
    }
    @Test fun abortRequestSuppressesOutcomesBeforeInterruptingRecordLoop() {
        val c = MicCaptureControl(); c.beginAbort()
        assertTrue(c.recording) // do not emit terminating chunk before hard disconnect
        assertFalse(c.transportActive)
        assertFalse(MicReceipt.shouldPublishFailure(c.transportActive, true, "capturing"))
        c.abort(); assertFalse(c.recording)
    }
    @Test fun explicitAbortClosesBothAndSuppressesLateErrors() {
        val c = MicCaptureControl(); c.abort()
        assertFalse(c.recording); assertFalse(c.transportActive)
        assertFalse(MicReceipt.shouldPublishFailure(c.transportActive, true, "capturing"))
    }
    @Test fun finishAfterAbortCannotReviveTransportOrPrompt() {
        val c = MicCaptureControl(); c.abort(); c.finishRecording()
        assertTrue(c.aborted); assertFalse(c.recording); assertFalse(c.transportActive)
    }
    @Test fun gracefulRecordingOffStillAcceptsAdmissionOrShowsReceiptFailure() {
        val c = MicCaptureControl(); c.finishRecording()
        val ack = MicReceipt.evaluate(200, "{\"streamId\":\"s\",\"state\":\"closed\",\"delivered\":true,\"ackFinals\":1}", "s", false)
        assertTrue(c.transportActive && ack.sdkAcknowledged)
        val bad = MicReceipt.evaluate(413, "private", "s", false)
        assertEquals("error", bad.state)
        assertTrue(MicReceipt.shouldPublishFailure(c.transportActive, true, "closed"))
    }
}
