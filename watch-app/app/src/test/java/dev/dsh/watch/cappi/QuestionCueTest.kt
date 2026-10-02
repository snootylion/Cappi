package dev.dsh.watch.cappi

import dev.dsh.watch.core.*
import org.junit.Assert.*
import org.junit.Test

class QuestionCueTest {
    private val card = Approval("q1", "ask", "Choose?", null, listOf(ApprovalOption("a", "A")), false)
    private fun manifest() = parseCappiManifest(javaClass.classLoader!!
        .getResourceAsStream("cappi/cappi-manifest.json")!!.bufferedReader().use { it.readText() })
    private fun snap(working: Boolean = false, speaking: Boolean = false, cards: Set<Approval> = emptySet()) =
        CappiSnapshot(true, if (speaking) Phase.SPEAKING else Phase.IDLE, working, false,
            cards.size, questionAttention = cards.isNotEmpty(), questionIdentity = cards)
    private fun next(s: CappiScheduler, state: CappiSnapshot) = s.program(state).clips

    @Test fun questionWinsOverSpeechModelAndCelebration() {
        val s = CappiScheduler(manifest())
        val question = snap(speaking = true, cards = setOf(card)).copy(celebrate = true, modelAction = "dance")
        assertEquals(listOf("question.gif"), next(s, question))
        assertTrue(s.program(question).questionCue)
        assertTrue(next(s, question).isEmpty())
    }

    @Test fun workingLaptopMustBePutAwayBeforeQuestion() {
        val s = CappiScheduler(manifest())
        next(s, snap(working = true))
        assertEquals(listOf("laptop_work.gif"), next(s, snap(working = true)))
        val question = snap(working = true, speaking = true, cards = setOf(card))
        assertFalse(s.shouldInterrupt("laptop_work.gif", snap(working = true), question))
        assertEquals(listOf("laptop_exit.gif"), next(s, question))
        assertEquals(listOf("question.gif"), next(s, question))
    }

    @Test fun talkingLaptopReturnsThenPutsAwayThenQuestions() {
        val s = CappiScheduler(manifest())
        next(s, snap(working = true))
        next(s, snap(working = true, speaking = true))
        val question = snap(working = true, speaking = true, cards = setOf(card))
        assertEquals(listOf("laptop_talk_exit.gif"), next(s, question))
        assertEquals(listOf("laptop_exit.gif"), next(s, question))
        assertEquals(listOf("question.gif"), next(s, question))
    }

    @Test fun ordinaryStateChangesNeverReplayOrReplaceHeldQuestion() {
        val s = CappiScheduler(manifest())
        val question = snap(cards = setOf(card))
        next(s, question)
        for (changed in listOf(question, question.copy(phase = Phase.SPEAKING),
            question.copy(sessionRunning = true), question.copy(micOpen = true),
            question.copy(modelAction = "shadow", celebrate = true), question.copy(pendingCount = 20))) {
            val held = s.program(changed)
            assertTrue(held.clips.isEmpty())
            assertTrue(held.questionCue)
            assertFalse(held.repeatLast)
        }
    }

    @Test fun remoteDisappearanceReturnsToNeutralOnceThenNormalWithoutReverse() {
        val s = CappiScheduler(manifest())
        next(s, snap(cards = setOf(card)))
        val clear = snap(working = true)
        assertEquals(listOf("cappi_static.gif"), next(s, clear))
        assertEquals(listOf("laptop_enter.gif"), next(s, clear))
        assertEquals(listOf("laptop_work.gif"), next(s, clear))
    }

    @Test fun reviewedUnansweredCardDoesNotBlockNormalSpeechOrWork() {
        val s = CappiScheduler(manifest())
        next(s, snap(cards = setOf(card)))
        val reviewed = snap(speaking = true).copy(pendingCount = 1, questionAttention = false)
        assertEquals(listOf("cappi_static.gif"), next(s, reviewed))
        assertEquals("talk2.gif", next(s, reviewed).first())
        assertEquals(listOf("laptop_enter.gif"), next(s, reviewed.copy(phase = Phase.IDLE, sessionRunning = true)))
    }

    @Test fun newOrChangedCardAfterHoldNeedsNeutralThenFreshCue() {
        for (fresh in listOf(card.copy(id = "q2"), card.copy(title = "Next?"),
            card.copy(options = listOf(ApprovalOption("b", "B"))))) {
            val s = CappiScheduler(manifest())
            next(s, snap(cards = setOf(card)))
            val changed = snap(cards = setOf(fresh))
            assertEquals(listOf("cappi_static.gif"), next(s, changed))
            assertEquals(listOf("question.gif"), next(s, changed))
            assertTrue(next(s, changed).isEmpty())
        }
    }

    @Test fun removingOneCardDoesNotReplayButReappearanceIsFresh() {
        val s = CappiScheduler(manifest())
        val second = card.copy(id = "q2")
        val both = snap(cards = setOf(card, second))
        next(s, both)
        assertTrue(next(s, snap(cards = setOf(card))).isEmpty())
        assertEquals(listOf("cappi_static.gif"), next(s, both))
        assertEquals(listOf("question.gif"), next(s, both))
    }

    @Test fun oldPackUsesOneStaticThenIndefiniteRetainedHold() {
        val old = manifest().let { it.copy(actions = it.actions.filterNot { a -> a.id == "question" },
            clips = it.clips - "question.gif") }
        val s = CappiScheduler(old)
        val q = snap(cards = setOf(card))
        val first = s.program(q)
        assertEquals(listOf("cappi_static.gif"), first.clips)
        assertTrue(first.questionCue)
        repeat(10) { assertTrue(next(s, q).isEmpty()) }
    }

    @Test fun completedUnchangedHoldSurvivesLifecycleButPartialOrAcknowledgedDoesNot() {
        val s = CappiScheduler(manifest())
        val q = snap(cards = setOf(card))
        next(s, q)
        assertTrue(s.canRetainQuestionOnResume(q, true, true, true))
        assertFalse(s.canRetainQuestionOnResume(q, true, false, true))
        assertFalse(s.canRetainQuestionOnResume(q, true, true, false))
        assertFalse(s.canRetainQuestionOnResume(q, false, true, true))
        assertFalse(s.canRetainQuestionOnResume(q.copy(questionAttention = false), true, true, true))
        assertFalse(s.canRetainQuestionOnResume(q.copy(connected = false), true, true, true))
        assertFalse(s.canRetainQuestionOnResume(q.copy(questionIdentity = setOf(card.copy(title = "New"))), true, true, true))
        // A retained final drawable needs no new playback program on resume.
        assertTrue(next(s, q).isEmpty())
        s.reset() // Interrupted clip uses explicit UI neutral first, then fresh complete cue.
        assertFalse(s.isQuestionHolding(q))
        assertEquals(listOf("question.gif"), next(s, q))
    }

    @Test fun offlineCanInterruptButQuestionAndSpeechEdgesCannot() {
        val s = CappiScheduler(manifest())
        val q = snap(cards = setOf(card))
        for (file in manifest().clips.keys) {
            assertFalse(file, s.shouldInterrupt(file, snap(), q))
            assertFalse(file, s.shouldInterrupt(file, q, snap()))
            assertTrue(file, s.shouldInterrupt(file, q, q.copy(connected = false)))
        }
        next(s, q)
        assertTrue(next(s, q.copy(connected = false)).isEmpty())
        assertEquals(listOf("question.gif"), next(s, q))
    }
}
