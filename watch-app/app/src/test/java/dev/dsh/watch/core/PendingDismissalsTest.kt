package dev.dsh.watch.core

import org.junit.Assert.*
import org.junit.Test

class PendingDismissalsTest {
    private val base = "https://bridge.example"
    private val token = "test-only-connection-secret"
    private val question = Approval("request-1", "ask", "Which option?", "Question detail",
        listOf(ApprovalOption("a", "A"), ApprovalOption("b", "B")), false)
    private fun shown(store: PendingDismissals, items: List<Approval>) = store.visible(base, token, items)

    @Test fun removesOnlyTheChosenItemWithoutMutatingTheSourceList() {
        val store = PendingDismissals()
        val other = question.copy(id = "request-2")
        val original = listOf(question, other)
        store.dismiss(base, token, question)
        assertEquals(listOf(other), shown(store, original))
        assertEquals(2, original.size)
    }

    @Test fun repeatedSnapshotsDoNotResurrectDismissedQuestions() {
        val store = PendingDismissals()
        store.dismiss(base, token, question)
        repeat(5) { assertTrue(shown(store, listOf(question.copy())).isEmpty()) }
    }

    @Test fun dismissalSurvivesProcessRecreation() {
        val saved = PendingDismissals().dismiss(base, token, question)
        assertTrue(shown(PendingDismissals(saved), listOf(question)).isEmpty())
    }

    @Test fun newRequestWithIdenticalTextIsStillShown() {
        val store = PendingDismissals()
        store.dismiss(base, token, question)
        val fresh = question.copy(id = "new-request")
        assertEquals(listOf(fresh), shown(store, listOf(fresh)))
    }

    @Test fun changedWizardCardWithSameRequestIdIsStillShown() {
        val store = PendingDismissals()
        store.dismiss(base, token, question)
        val variants = listOf(question.copy(title = "Next question?"),
            question.copy(detail = "Changed context"), question.copy(multi = true),
            question.copy(options = listOf(ApprovalOption("c", "C"))),
            question.copy(options = listOf(ApprovalOption("a", "New meaning"))),
            question.copy(kind = "approval"))
        assertEquals(variants, shown(store, variants))
    }

    @Test fun dismissalIsScopedToBridgeAndCredential() {
        val store = PendingDismissals()
        store.dismiss(base, token, question)
        assertEquals(listOf(question), store.visible("https://other.example", token, listOf(question)))
        assertEquals(listOf(question), store.visible(base, "different", listOf(question)))
        assertTrue(store.visible("$base/", token, listOf(question)).isEmpty())
    }

    @Test fun approvalCanBeHiddenWithoutConvertingItToAnAnswer() {
        val store = PendingDismissals()
        val approval = question.copy(kind = "approval")
        store.dismiss(base, token, approval)
        assertTrue(shown(store, listOf(approval)).isEmpty())
        assertEquals("approval", approval.kind)
        assertEquals(question.options, approval.options)
    }

    @Test fun persistedDataContainsOnlyHashesNotQuestionTextOrCredentials() {
        val saved = PendingDismissals().dismiss(base, token, question)
        assertTrue(saved.matches(Regex("[0-9a-f]{64}")))
        assertFalse(saved.contains(question.title))
        assertFalse(saved.contains(token))
        assertFalse(saved.contains(base))
    }

    @Test fun storageIsBoundedAndKeepsMostRecentDismissals() {
        val store = PendingDismissals(limit = 2)
        val second = question.copy(id = "second")
        val third = question.copy(id = "third")
        store.dismiss(base, token, question)
        store.dismiss(base, token, second)
        val saved = store.dismiss(base, token, third)
        assertEquals(2, saved.lines().size)
        assertEquals(listOf(question), shown(PendingDismissals(saved, limit = 2), listOf(question, second, third)))
    }
}
