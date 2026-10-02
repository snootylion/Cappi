package dev.dsh.watch.audio

import org.junit.Assert.*
import org.junit.Test

class TtsDrainTest {
    @Test fun transportDoneDoesNotDiscardBufferedTail() {
        assertTrue(hasBufferedSpeech(true, 24000, 12000))
        assertTrue(hasBufferedSpeech(true, 24000, 23999))
        assertFalse(hasBufferedSpeech(true, 24000, 24000))
    }
    @Test fun disabledAndReleasedOutputAreQuiet() {
        assertFalse(hasBufferedSpeech(false, 24000, 0))
        assertFalse(hasBufferedSpeech(true, 0, 0))
    }
    @Test fun nextSpeechExtendsOutputWithoutPrematureDone() {
        assertTrue(hasBufferedSpeech(true, 48000, 24000))
        assertFalse(hasBufferedSpeech(true, 48000, 48000))
    }
}
