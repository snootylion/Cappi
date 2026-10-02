package dev.dsh.watch.core

import org.junit.Assert.*
import org.junit.Test

/** JVM tests for the question/voice collaborator guards. */
class CollaboratorsTest {

    private fun state() = UiState(
        base = "https://bridge.example",
        token = "tok",
        connected = true,
        sessionId = "s1",
        pending = listOf(
            Approval("q1", "ask", "Pick one?", null, listOf(ApprovalOption("a", "A")), false),
        ),
        pendingRequestId = "q1",
        pendingQuestionTitle = "Pick one?",
    )

    @Test fun dictationBlockers() {
        assertNull(QuestionCenter.dictationBlocker(state(), "q1", micOpen = false))
        assertNotNull(QuestionCenter.dictationBlocker(state(), "q1", micOpen = true))
        assertNotNull(QuestionCenter.dictationBlocker(state().copy(connected = false), "q1", false))
        assertNotNull(QuestionCenter.dictationBlocker(state().copy(offlineClock = true), "q1", false))
        assertNotNull(QuestionCenter.dictationBlocker(state(), "other", false))
    }

    @Test fun approveBlocking() {
        assertFalse(QuestionCenter.approveBlocked(state(), "q1", null))
        assertFalse(QuestionCenter.approveBlocked(state(), "q1", "free"))
        assertTrue(QuestionCenter.approveBlocked(state(), "missing", null))
        val advanced = state().copy(pendingQuestionTitle = "Next?")
        assertTrue(QuestionCenter.approveBlocked(advanced, "q1", "free"))
        assertFalse(QuestionCenter.approveBlocked(advanced, "q1", null))
    }

    @Test fun voiceMicBlocker() {
        assertNull(VoiceCenter.micBlocker(state()))
        assertNotNull(VoiceCenter.micBlocker(state().copy(connected = false)))
    }

    @Test fun modelScopeComparesPin() {
        val scope = ModelScope("https://b", "t", "s", certPinSha256 = "pin-a")
        assertTrue(scope.matches(state().copy(base = "https://b", token = "t", sessionId = "s", certPinSha256 = "pin-a")))
        assertFalse(scope.matches(state().copy(base = "https://b", token = "t", sessionId = "s", certPinSha256 = "pin-b")))
        assertFalse(scope.matches(state().copy(base = "https://b", token = "t", sessionId = "s")))
        assertTrue(scope.toString().contains("credentials=redacted"))
        assertFalse(scope.toString().contains("pin-a"))
    }

    @Test fun connectionTrustError() {
        val missing = state().copy(certPinSha256 = "")
        assertNotNull(ConnectionCenter.trustError(missing))
        assertNull(ConnectionCenter.trustError(state().copy(certPinSha256 = "pin")))
        assertNull(ConnectionCenter.trustError(state().copy(base = "")))
    }
}
