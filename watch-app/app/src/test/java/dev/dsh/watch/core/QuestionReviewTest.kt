package dev.dsh.watch.core

import org.junit.Assert.*
import org.junit.Test

class QuestionReviewTest {
    private val card = Approval("request", "ask", "Choose?", "Details",
        listOf(ApprovalOption("yes", "Yes")), false)
    private fun state() = UiState(base = "https://bridge.example", token = "test", sessionId = "session",
        connected = true, pending = listOf(card))

    @Test fun menuEntryAcknowledgesButDoesNotAnswerDismissOrMutateCards() {
        val original = state()
        assertEquals(setOf(card), original.unreviewedQuestions)
        val reviewed = original.acknowledgePendingQuestions()
        assertTrue(reviewed.unreviewedQuestions.isEmpty())
        assertEquals(original.pending, reviewed.pending)
        assertEquals(original.sessionRunning, reviewed.sessionRunning)
    }

    @Test fun acknowledgementSurvivesAvatarNavigationCopiesAndSameCardRefresh() {
        val reviewed = state().acknowledgePendingQuestions()
        val returned = reviewed.copy(avatarMode = true, micOpen = true, speakingOutput = true)
            .withVisiblePending(listOf(card.copy()))
        assertTrue(returned.unreviewedQuestions.isEmpty())
        assertEquals(listOf(card), returned.pending) // yellow badge can still exist
    }

    @Test fun changedFullIdentityEvenSameIdIsNewAttention() {
        val reviewed = state().acknowledgePendingQuestions()
        val variants = listOf(card.copy(title = "Next?"), card.copy(detail = "New details"),
            card.copy(options = listOf(ApprovalOption("no", "No"))),
            card.copy(multi = true), card.copy(kind = "approval"))
        for (changed in variants) {
            val updated = reviewed.withVisiblePending(listOf(changed))
            assertEquals(setOf(changed), updated.unreviewedQuestions)
            assertTrue(updated.reviewedPending.isEmpty())
        }
    }

    @Test fun questionsArrivingAfterMenuEntryStayUnreviewed() {
        val entered = state().acknowledgePendingQuestions()
        val next = card.copy(id = "new-request")
        val updated = entered.withVisiblePending(listOf(card, next))
        assertEquals(setOf(next), updated.unreviewedQuestions)
        assertEquals(setOf(card), updated.reviewedPending)
    }

    @Test fun reviewedCollectionIsPrunedWhenRemoteCardsDisappear() {
        var st = state()
        repeat(1000) { i ->
            val next = card.copy(id = "q$i")
            st = st.withVisiblePending(listOf(next)).acknowledgePendingQuestions()
            assertEquals(1, st.reviewedPending.size)
        }
        st = st.withVisiblePending(emptyList())
        assertTrue(st.reviewedPending.isEmpty())
        assertTrue(st.unreviewedQuestions.isEmpty())
        assertEquals(setOf(card), st.withVisiblePending(listOf(card)).unreviewedQuestions)
    }

    @Test fun sameConnectionReconnectRetainsReviewButSessionAndEndpointChangesReset() {
        val reviewed = state().acknowledgePendingQuestions()
        val reconnect = reviewed.copy(connected = false).copy(connected = true)
            .withQuestionConnection(reviewed.base, reviewed.token)
            .withVisiblePending(listOf(card))
        assertTrue(reconnect.unreviewedQuestions.isEmpty())
        assertEquals(setOf(card), reviewed.withVisiblePending(listOf(card), "other-session").unreviewedQuestions)
        for (changed in listOf(reviewed.withQuestionConnection("https://other.example", "test"),
            reviewed.withQuestionConnection(reviewed.base, "different"))) {
            assertTrue(changed.pending.isEmpty())
            assertTrue(changed.reviewedPending.isEmpty())
            assertEquals(setOf(card), changed.withVisiblePending(listOf(card)).unreviewedQuestions)
        }
    }

    @Test fun persistedDismissalFilteringStillWinsOverCueAcknowledgement() {
        val st = state().acknowledgePendingQuestions()
        val store = PendingDismissals()
        val saved = store.dismiss(st.base, st.token, card)
        val visible = PendingDismissals(saved).visible(st.base, st.token, listOf(card))
        val updated = st.withVisiblePending(visible)
        assertTrue(updated.pending.isEmpty())
        assertTrue(updated.reviewedPending.isEmpty())
        assertTrue(updated.unreviewedQuestions.isEmpty())
    }
}
