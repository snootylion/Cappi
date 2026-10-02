package dev.dsh.watch.core

import org.junit.Assert.*
import org.junit.Test

class StateWakePolicyTest {
    private val q = Approval("q", "ask", "Question", null, emptyList(), false)
    private val idle = StateWakeSnapshot(true, "thread", emptySet(), false, false, false)
    private fun policy() = StateWakePolicy().also { assertNull(it.observe(idle, true, 0)) }

    @Test fun initialSnapshotNeverWakes() {
        assertNull(StateWakePolicy().observe(idle.copy(questions = setOf(q), speaking = true), true, 0))
    }
    @Test fun newQuestionWakesOnce() {
        val p = policy(); val v = idle.copy(questions = setOf(q))
        assertEquals(StateWakeReason.QUESTION, p.observe(v, true, 1))
        assertNull(p.observe(v, true, 10_000))
    }
    @Test fun changedQuestionWithSameIdAndCountIsNew() {
        val p = StateWakePolicy()
        p.observe(idle.copy(questions = setOf(q)), true, 0)
        assertEquals(StateWakeReason.QUESTION, p.observe(idle.copy(questions = setOf(q.copy(title = "Changed"))), true, 1))
    }
    @Test fun questionReorderIsNotAnEvent() {
        val p = StateWakePolicy(); val other = q.copy(id = "q2")
        p.observe(idle.copy(questions = linkedSetOf(q, other)), true, 0)
        assertNull(p.observe(idle.copy(questions = linkedSetOf(other, q)), true, 5_000))
    }
    @Test fun questionClearedWakesOnce() {
        val p = StateWakePolicy(); p.observe(idle.copy(questions = setOf(q)), true, 0)
        assertEquals(StateWakeReason.QUESTION_CLEARED, p.observe(idle, true, 1))
        assertNull(p.observe(idle, true, 5_000))
    }
    @Test fun speechStartsImmediatelyAndEndsOnlyAfterQuietGrace() {
        val p = policy(); val speech = idle.copy(speaking = true)
        assertEquals(StateWakeReason.SPEAKING, p.observe(speech, true, 100))
        assertNull(p.observe(idle, true, 4_000))
        assertNull(p.observe(idle, true, 5_499))
        assertEquals(StateWakeReason.SPEECH_ENDED, p.observe(idle, true, 5_500))
        assertNull(p.observe(idle, true, 9_000))
    }
    @Test fun audioChunkGapsDoNotStartNewEpisodes() {
        val p = policy(); val speech = idle.copy(speaking = true)
        p.observe(speech, true, 100)
        assertNull(p.observe(idle, true, 5_000))
        assertNull(p.observe(speech, true, 5_500))
        assertNull(p.observe(idle, true, 6_000))
        assertNull(p.observe(speech, true, 7_000))
    }
    @Test fun nextRealSpeechEpisodeWakesAgain() {
        val p = policy(); val speech = idle.copy(speaking = true)
        p.observe(speech, true, 100); p.observe(idle, true, 4_000); p.observe(idle, true, 5_500)
        assertEquals(StateWakeReason.SPEAKING, p.observe(speech, true, 9_000))
    }
    @Test fun workingStartAndCompletionAreEdges() {
        val p = policy(); val work = idle.copy(working = true)
        assertEquals(StateWakeReason.WORKING, p.observe(work, true, 1))
        assertNull(p.observe(work, true, 5_000))
        assertEquals(StateWakeReason.WORK_ENDED, p.observe(idle, true, 9_000))
    }
    @Test fun errorEntryIsAnEdge() {
        val p = policy(); val error = idle.copy(error = true)
        assertEquals(StateWakeReason.ERROR, p.observe(error, true, 1))
        assertNull(p.observe(error, true, 5_000))
    }
    @Test fun ineligibleEdgesAreConsumedNotReplayed() {
        val p = policy(); val work = idle.copy(working = true)
        assertNull(p.observe(work, false, 1))
        assertNull(p.observe(work, true, 5_000))
    }
    @Test fun cooldownDoesNotQueueOldEvents() {
        val p = policy(); val work = idle.copy(working = true)
        p.observe(work, true, 1)
        val error = work.copy(error = true)
        assertNull(p.observe(error, true, 100))
        assertNull(p.observe(error, true, 5_000))
    }
    @Test fun disconnectAndReconnectRebaseline() {
        val p = policy()
        assertNull(p.observe(idle.copy(connected = false, speaking = true), true, 1))
        assertNull(p.observe(idle.copy(questions = setOf(q)), true, 5_000))
    }
    @Test fun differentThreadRebaselines() {
        assertNull(policy().observe(idle.copy(sessionId = "other", questions = setOf(q)), true, 1))
    }
    @Test fun unchangedSnapshotsDoNotWake() {
        val p = policy()
        repeat(100) { assertNull(p.observe(idle, true, it * 10_000L)) }
    }
    @Test fun diagnosticsDistinguishBaselineUnchangedAndDeniedEdge() {
        val p = policy()
        assertEquals(StateWakeDecision.BASELINE, p.decision)
        p.observe(idle, true, 1)
        assertEquals(StateWakeDecision.UNCHANGED, p.decision)
        assertNull(p.reason)
        p.observe(idle.copy(questions = setOf(q)), false, 2)
        assertEquals(StateWakeDecision.INELIGIBLE, p.decision)
        assertEquals(StateWakeReason.QUESTION, p.reason)
        assertEquals(1L, p.eventRevision)
        p.observe(idle.copy(questions = setOf(q)), false, 3)
        assertEquals(StateWakeDecision.UNCHANGED, p.decision)
        assertEquals(1L, p.eventRevision)
    }
    @Test fun diagnosticsDistinguishWakeFromCooldown() {
        val p = policy()
        p.observe(idle.copy(working = true), true, 1)
        assertEquals(StateWakeDecision.WAKE, p.decision)
        p.observe(idle.copy(working = true, error = true), true, 2)
        assertEquals(StateWakeDecision.COOLDOWN, p.decision)
        assertEquals(StateWakeReason.ERROR, p.reason)
    }
    @Test fun diagnosticRecordCannotContainIdentifiersOrText() {
        assertTrue(StateWakeDiagnostics::class.java.declaredFields.filterNot { it.isSynthetic }
            .all { it.type.isPrimitive || it.type.isEnum })
    }
    @Test fun diagnosticsLogOnlyChangedSafeProjection() {
        val changes = StateWakeDiagnosticChanges()
        val d = StateWakeDiagnostics(true, true, true, true, true, true, true, true,
            true, true, true, false, false, 0, false, true, false, StateWakeDecision.UNCHANGED, null, 0L)
        assertTrue(changes.changed(d))
        repeat(100) { assertFalse(changes.changed(d.copy())) }
        assertTrue(changes.changed(d.copy(sdkAmbient = false)))
        assertTrue(changes.changed(d.copy(pendingCount = 1)))
    }
    @Test fun wakePreferenceDefaultsOnAndIsIndependentOfKeepAwake() {
        val state = UiState(base = "", token = "", keepScreenAwake = false)
        assertTrue(state.wakeOnActivity)
        assertFalse(state.keepScreenAwake)
    }
}

class AmbientWakeOwnershipTest {
    private fun owned() = AmbientWakeOwnership().also { it.focused(); it.enterAmbient() }
    @Test fun ambientWithoutForegroundOwnershipCannotWake() {
        val gate = AmbientWakeOwnership(); gate.enterAmbient()
        assertFalse(gate.permits(true, true, true))
    }
    @Test fun ambientVisibleOwnerMayWake() { assertTrue(owned().permits(true, true, true)) }
    @Test fun ambientCanRemainEligibleAcrossPauseAndVisibleStop() {
        val gate = owned(); gate.pause(true); gate.stop(true, true)
        assertTrue(gate.permits(true, true, true))
    }
    @Test fun invisibleStopRevokesOwnership() {
        val gate = owned(); gate.stop(true, false)
        assertFalse(gate.permits(true, true, true))
    }
    @Test fun userLeaveCannotBeRearmedByLateAmbientCallback() {
        val gate = owned(); gate.leave(); gate.enterAmbient()
        assertFalse(gate.permits(true, true, true))
    }
    @Test fun normalPauseRevokesAmbientLease() {
        val gate = owned(); gate.pause(false)
        assertFalse(gate.permits(true, true, true))
    }
    @Test fun lateFocusRecoveredOnExitAllowsNextAmbientLease() {
        val gate = AmbientWakeOwnership()
        gate.enterAmbient() // Initial resume had no focus, then focus arrived during ambient.
        assertFalse(gate.permits(true, true, true))
        gate.focused() // onExitAmbient explicitly verifies current focused, visible window.
        assertFalse(gate.permits(false, true, true))
        gate.enterAmbient()
        assertTrue(gate.permits(true, true, true))
    }
    @Test fun freshFocusAtAmbientEntryRecoversMissingResumeFocusCallback() {
        val gate = AmbientWakeOwnership()
        gate.focused() // onEnterAmbient freshly checks actual focus before changing mode.
        gate.enterAmbient()
        assertTrue(gate.permits(true, true, true))
        gate.leave()
        gate.enterAmbient() // Hidden/unfocused late callback cannot perform that recovery.
        assertFalse(gate.permits(true, true, true))
    }
    @Test fun anotherActivityOwnerOrInvisibleWindowCannotWake() {
        val gate = owned()
        assertFalse(gate.permits(true, true, false))
        assertFalse(gate.permits(true, false, true))
        assertFalse(gate.permits(false, true, true))
    }
}
