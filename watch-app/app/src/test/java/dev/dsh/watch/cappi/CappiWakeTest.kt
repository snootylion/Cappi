package dev.dsh.watch.cappi

import dev.dsh.watch.core.Approval
import dev.dsh.watch.core.Phase
import org.junit.Assert.*
import org.junit.Test

class CappiWakeTest {
    private val card = Approval("q", "ask", "Choose?", null, emptyList(), false)
    private fun manifest() = parseCappiManifest(javaClass.classLoader!!
        .getResourceAsStream("cappi/cappi-manifest.json")!!.bufferedReader().use { it.readText() })
    private fun snap(working: Boolean = false, speaking: Boolean = false, question: Boolean = false) =
        CappiSnapshot(true, if (speaking) Phase.SPEAKING else Phase.IDLE, working, false,
            if (question) 1 else 0, questionAttention = question,
            questionIdentity = if (question) setOf(card) else emptySet())

    @Test fun workWakeJumpsDirectlyToLoopThenOrdinaryExitIsStillRequired() {
        val s = CappiScheduler(manifest())
        assertEquals(listOf("laptop_work.gif"), s.wakeProgram(snap(working = true)).clips)
        assertEquals(listOf("laptop_exit.gif"), s.program(snap()).clips)
        assertFalse(s.program(snap()).clips.contains("laptop_exit.gif"))
    }

    @Test fun progressSpeechWakeSkipsEnterLookUpAndStaticThenReturnsCorrectly() {
        val s = CappiScheduler(manifest())
        val talking = snap(working = true, speaking = true)
        assertEquals(listOf("laptop_talk_loop.gif"), s.wakeProgram(talking).clips)
        assertEquals(listOf("laptop_talk_loop.gif"), s.program(talking).clips)
        assertEquals(listOf("laptop_talk_exit.gif"), s.program(snap(working = true)).clips)
        assertEquals(listOf("laptop_work.gif"), s.program(snap(working = true)).clips)
    }

    @Test fun finalSpeechWakeDiscardsOldLaptopPoseAndTalksStandingImmediately() {
        val s = CappiScheduler(manifest())
        s.program(snap(working = true))
        s.program(snap(working = true, speaking = true))
        assertEquals("talk2.gif", s.wakeProgram(snap(speaking = true)).clips.first())
        assertEquals(listOf("laptop_enter.gif"), s.program(snap(working = true)).clips)
    }

    @Test fun finalSpeechAfterProgressWakeStillRunsBothOrdinaryExits() {
        val s = CappiScheduler(manifest())
        s.wakeProgram(snap(working = true, speaking = true))
        val final = snap(speaking = true)
        assertEquals(listOf("laptop_talk_exit.gif"), s.program(final).clips)
        assertEquals(listOf("laptop_exit.gif"), s.program(final).clips)
        assertEquals("talk2.gif", s.program(final).clips.first())
    }

    @Test fun newQuestionWakeOverridesAllStateAndSkipsOldProps() {
        val s = CappiScheduler(manifest())
        s.program(snap(working = true))
        s.program(snap(working = true, speaking = true))
        val q = snap(working = true, speaking = true, question = true).copy(celebrate = true, modelAction = "dance")
        val cue = s.wakeProgram(q)
        assertEquals(listOf("question.gif"), cue.clips)
        assertTrue(cue.questionCue)
        assertTrue(s.program(q).clips.isEmpty())
    }

    @Test fun questionArrivingAfterWorkWakeStillNeedsOrdinaryLaptopExit() {
        val s = CappiScheduler(manifest())
        s.wakeProgram(snap(working = true))
        val q = snap(working = true, question = true)
        assertFalse(s.shouldInterrupt("laptop_work.gif", snap(working = true), q))
        assertEquals(listOf("laptop_exit.gif"), s.program(q).clips)
        assertEquals(listOf("question.gif"), s.program(q).clips)
    }

    @Test fun completedUnchangedQuestionRetainsFinalFrameOnWakeWithoutReplay() {
        val s = CappiScheduler(manifest())
        val q = snap(question = true)
        s.wakeProgram(q)
        val changedOrdinaryState = q.copy(phase = Phase.SPEAKING, sessionRunning = true)
        val keep = s.canRetainQuestionOnResume(changedOrdinaryState, true, true, true)
        assertTrue(keep)
        val held = s.wakeProgram(changedOrdinaryState, retainCompletedQuestion = keep)
        assertTrue(held.questionCue)
        assertTrue(held.clips.isEmpty())
    }

    @Test fun interruptedOrChangedQuestionWakePlaysCompleteCueDirectly() {
        val s = CappiScheduler(manifest())
        val q = snap(question = true)
        s.wakeProgram(q)
        val keep = s.canRetainQuestionOnResume(q, true, false, true)
        assertFalse(keep)
        assertEquals(listOf("question.gif"), s.wakeProgram(q, keep).clips)
        val newCard = q.copy(questionIdentity = setOf(card.copy(title = "Next?")))
        // The scheduler also refuses an incorrectly requested stale-frame retention.
        assertEquals(listOf("question.gif"), s.wakeProgram(newCard, retainCompletedQuestion = true).clips)
    }

    @Test fun reviewedQuestionDoesNotReplayAndWakeUsesCurrentWorkingState() {
        val s = CappiScheduler(manifest())
        s.wakeProgram(snap(question = true))
        val reviewed = snap(working = true).copy(pendingCount = 1, questionAttention = false)
        assertEquals(listOf("laptop_work.gif"), s.wakeProgram(reviewed).clips)
        assertFalse(s.program(reviewed).questionCue)
    }

    @Test fun oldPackWakeSpeechFallsBackToStandingAndQuestionToStatic() {
        val old = manifest().let { it.copy(actions = it.actions.filterNot { a -> a.id in setOf("work_talk", "question") }) }
        val s = CappiScheduler(old)
        assertEquals("talk2.gif", s.wakeProgram(snap(working = true, speaking = true)).clips.first())
        assertEquals(listOf("cappi_static.gif"), s.wakeProgram(snap(question = true)).clips)
        assertTrue(s.program(snap(question = true)).clips.isEmpty())
    }

    @Test fun wakeHonorsExplicitModelEmotesAndThinkingWithoutSessionFlag() {
        val s = CappiScheduler(manifest())
        assertEquals(listOf("laptop_work.gif"), s.wakeProgram(snap().copy(phase = Phase.THINKING)).clips)
        assertEquals(listOf("laptop_work.gif"), s.wakeProgram(snap().copy(modelAction = "work")).clips)
        assertEquals(listOf("dance.gif"), s.wakeProgram(snap(working = true).copy(modelAction = "dance")).clips)
        assertTrue(s.wakeProgram(snap().copy(connected = false)).clips.isEmpty())
    }

    @Test fun freshAvatarBaselinesExistingEpochSoMenuReturnIsNotAFalseWake() {
        val tracker = CappiDisplayResume(initialActive = true, initialEpoch = 42)
        assertFalse(tracker.consumeWake())
        repeat(5) { tracker.observe(true, 42); assertFalse(tracker.consumeWake()) }
    }

    @Test fun inactiveDisplayRetainsWakeIntentWithoutStartingPlayback() {
        val tracker = CappiDisplayResume(initialActive = false, initialEpoch = 8)
        assertFalse(tracker.consumeWake())
        tracker.observe(false, 9)
        assertFalse(tracker.consumeWake())
        tracker.observe(false, 10)
        assertFalse(tracker.consumeWake())
        tracker.observe(true, 10)
        assertTrue(tracker.consumeWake())
        assertFalse(tracker.consumeWake())
    }

    @Test fun inactiveToActiveEdgeSnapsEvenWithoutCounterIncrement() {
        val tracker = CappiDisplayResume(true, 3)
        tracker.observe(false, 3)
        assertFalse(tracker.consumeWake())
        tracker.observe(true, 3)
        assertTrue(tracker.consumeWake())
    }

    @Test fun menuReturnStaysNeutralEvenIfDisplayWokeWhileMenuWasOpen() {
        val tracker = CappiDisplayResume(true, 3)
        tracker.markMenuOpened()
        tracker.observe(false, 3)
        tracker.observe(true, 4)
        assertTrue(tracker.isMenuReturnPending)
        assertFalse(tracker.consumeWake())
        assertFalse(tracker.isMenuReturnPending)
        tracker.observe(false, 4)
        tracker.observe(true, 5)
        assertTrue(tracker.consumeWake()) // Only the menu return is exempted.
    }

    @Test fun wakeEpochPersistsUntilLifecycleActuallyStartsPlayback() {
        val tracker = CappiDisplayResume(true, 3)
        tracker.observe(true, 4)
        repeat(5) { tracker.observe(true, 4) } // lifecycle may still be STOPPED
        assertTrue(tracker.consumeWake())
        assertFalse(tracker.consumeWake())
        tracker.observe(true, 5)
        assertTrue(tracker.consumeWake())
    }
}
