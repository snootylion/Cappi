package dev.dsh.watch.core

/**
 * Question collaborator: pending-question review, dismissal and dictation
 * guards. Pending/speech state stays authoritative in [UiState]; this object
 * holds the transition rules so the ViewModel stays a thin lifecycle owner.
 */
object QuestionCenter {

    /** Local dismissal only: never sends an answer, approval, denial, or cancel. */
    fun canDismiss(state: UiState, item: Approval): Boolean = item in state.pending

    fun dictationTarget(state: UiState, requestId: String): Approval? =
        state.pending.firstOrNull { it.id == requestId && it.kind == "ask" && it.title == state.pendingQuestionTitle }

    /** Display-ready reason when dictation cannot start, or null when it can. */
    fun dictationBlocker(state: UiState, requestId: String, micOpen: Boolean): String? {
        if (micOpen) return "Turn off the main mic before dictating an answer"
        if (!state.connected || state.offlineClock) return "Reconnect to dictate"
        if (dictationTarget(state, requestId) == null) return "Question changed; reopen it"
        return null
    }

    fun approveBlocked(state: UiState, requestId: String, freeText: String?): Boolean {
        val item = state.pending.firstOrNull { it.id == requestId } ?: return true
        if (freeText != null &&
            (state.pendingRequestId != requestId || state.pendingQuestionTitle != item.title)
        ) return true
        return false
    }
}
