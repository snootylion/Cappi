package dev.dsh.watch.core

import org.junit.Assert.assertEquals
import org.junit.Test

class HomeStatusTest {
    private val working = UiState(base = "", token = "", connected = true,
        phase = Phase.THINKING, sessionRunning = true)

    @Test fun speechReturnsToWorkingEvenWhenTransportPhaseStaysSpeaking() {
        val speaking = working.copy(phase = Phase.SPEAKING, speakingOutput = true)
        assertEquals(Phase.SPEAKING, speaking.homeDisplayPhase())
        assertEquals(Phase.THINKING, speaking.copy(speakingOutput = false).homeDisplayPhase())
    }

    @Test fun eachProgressUtteranceCanSpeakAndReturnToWorking() {
        val staleTransport = working.copy(phase = Phase.SPEAKING)
        repeat(3) {
            assertEquals(Phase.SPEAKING, staleTransport.copy(speakingOutput = true).homeDisplayPhase())
            assertEquals(Phase.THINKING, staleTransport.homeDisplayPhase())
        }
    }

    @Test fun bufferedAudioTailRemainsSpeakingAfterTransportMovesOn() {
        assertEquals(Phase.SPEAKING, working.copy(phase = Phase.LISTENING,
            sessionRunning = false, speakingOutput = true).homeDisplayPhase())
    }

    @Test fun staleSpeechWithoutAudioOrWorkReturnsToIdle() {
        assertEquals(Phase.IDLE, working.copy(phase = Phase.SPEAKING,
            sessionRunning = false, assistantDone = true).homeDisplayPhase())
    }

    @Test fun disconnectedStillTakesPriorityOverAudio() {
        assertEquals(Phase.CONNECTING, working.copy(connected = false,
            speakingOutput = true).homeDisplayPhase())
    }

    @Test fun errorWithoutAudioOrWorkIsPreserved() {
        assertEquals(Phase.ERROR, working.copy(phase = Phase.ERROR,
            sessionRunning = false).homeDisplayPhase())
    }
}
