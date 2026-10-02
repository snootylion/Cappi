package dev.dsh.watch.cappi

import dev.dsh.watch.core.Approval
import dev.dsh.watch.core.ApprovalOption
import dev.dsh.watch.core.Phase
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Data-driven scheduling: parity with the legacy scheduler over scripted
 * snapshot sequences (compatibility facade), safe role fallbacks for sparse
 * packs, authoritative question/speech ownership, and unskippable
 * enter/loop/exit transitions. Synthetic fixtures only.
 */
class CharacterSchedulerTest {

    private val card = Approval("q1", "ask", "Choose?", null, listOf(ApprovalOption("a", "A")), false)

    private fun snap(
        phase: Phase = Phase.IDLE,
        connected: Boolean = true,
        sessionRunning: Boolean = false,
        pending: Set<Approval> = emptySet(),
        celebrate: Boolean = false,
        modelAction: String? = null,
    ) = CappiSnapshot(
        connected = connected,
        phase = phase,
        sessionRunning = sessionRunning,
        micOpen = false,
        pendingCount = pending.size,
        celebrate = celebrate,
        modelAction = modelAction,
        questionAttention = pending.isNotEmpty(),
        questionIdentity = pending,
    )

    private lateinit var legacyManifest: CappiManifest
    private lateinit var legacy: CappiScheduler
    private lateinit var migrated: CharacterScheduler

    @Before fun setUp() {
        val text = javaClass.classLoader!!.getResourceAsStream("cappi/cappi-manifest.json")!!
            .bufferedReader().readText()
        legacyManifest = parseCappiManifest(text)
        legacy = CappiScheduler(legacyManifest)
        migrated = CharacterScheduler.fromLegacy(legacyManifest)
    }

    /** Scripted sequence exercising every scheduler branch in order. */
    private fun script(): List<CappiSnapshot> = listOf(
        snap(),
        snap(sessionRunning = true),
        snap(sessionRunning = true),
        snap(),
        snap(phase = Phase.SPEAKING),
        snap(phase = Phase.SPEAKING),
        snap(celebrate = true),
        snap(phase = Phase.HEARING),
        snap(phase = Phase.ERROR),
        snap(modelAction = "dance"),
        snap(modelAction = "work"),
        snap(),
        snap(modelAction = "fly"),
        snap(modelAction = "static_hold"),
        snap(modelAction = "work_talk"),
        snap(pending = setOf(card)),
        snap(pending = setOf(card)),
        snap(),
        snap(sessionRunning = true),
        snap(pending = setOf(card)),
        snap(pending = setOf(card)),
        snap(phase = Phase.SPEAKING, sessionRunning = true),
        snap(phase = Phase.SPEAKING, sessionRunning = true),
        snap(phase = Phase.SPEAKING, pending = setOf(card), celebrate = true, modelAction = "dance"),
        snap(connected = false),
        snap(),
    )

    @Test fun legacyParityOverScriptedSequence() {
        assertEquals(legacy.neutralClip, migrated.neutralClip)
        for ((i, s) in script().withIndex()) {
            assertEquals("program step $i", legacy.program(s), migrated.program(s))
            assertEquals("interrupt step $i",
                legacy.shouldInterrupt("x", s, s), migrated.shouldInterrupt("x", s, s))
            assertEquals("holding step $i",
                legacy.isQuestionHolding(s), migrated.isQuestionHolding(s))
        }
    }

    @Test fun legacyParityForWakeAndResume() {
        val states = listOf(
            snap(sessionRunning = true),
            snap(phase = Phase.SPEAKING, sessionRunning = true),
            snap(pending = setOf(card)),
            snap(celebrate = true),
            snap(modelAction = "dance"),
            snap(),
        )
        for ((i, s) in states.withIndex()) {
            legacy.reset(); migrated.reset()
            assertEquals("wake step $i", legacy.wakeProgram(s), migrated.wakeProgram(s))
            assertEquals("retain step $i",
                legacy.canRetainQuestionOnResume(s, true, true, true),
                migrated.canRetainQuestionOnResume(s, true, true, true))
        }
    }

    @Test fun defaultCappiInheritsExactLegacySchedule() {
        // The clean-checkout default (cappi-original) must schedule exactly
        // like the legacy scheduler users tested: same neutral clip, same
        // programs, interrupts and holds over the full scripted sequence.
        val canonical = parseCharacterPack(
            javaClass.classLoader!!.getResourceAsStream("characters/cappi-original-pack.json")!!
                .bufferedReader().readText())
        assertEquals("cappi-original", canonical.packId)
        assertEquals("Apache-2.0", canonical.license)
        val sched = CharacterScheduler(canonical)
        assertEquals(legacy.neutralClip, sched.neutralClip)
        for ((i, s) in script().withIndex()) {
            sched.reset(); legacy.reset()
            // Fresh-state parity per step (cursors aligned): the default pack
            // plays the same first program the legacy scheduler played.
            assertEquals("default program step $i", legacy.program(s), sched.program(s))
        }
        // Long-run parity without per-step resets: identical trajectories.
        legacy.reset(); sched.reset()
        for ((i, s) in script().withIndex()) {
            assertEquals("default trajectory step $i", legacy.program(s), sched.program(s))
            assertEquals("default interrupt step $i",
                legacy.shouldInterrupt("x", s, s), sched.shouldInterrupt("x", s, s))
            assertEquals("default holding step $i",
                legacy.isQuestionHolding(s), sched.isQuestionHolding(s))
        }
    }

    @Test fun sparsePackFallsBackToIdleForCelebrate() {
        val ember = parseCharacterPack(
            javaClass.classLoader!!.getResourceAsStream("characters/ember-min-pack.json")!!
                .bufferedReader().readText())
        val sched = CharacterScheduler(ember)
        // ember-min declares no celebrate role: emotes degrade to idle clips.
        val first = sched.program(snap(celebrate = true))
        assertEquals(listOf("ember_idle_a.xml"), first.clips)
        assertFalse(first.repeatLast)
        // ...but explicit model actions on declared roles still play.
        assertEquals(listOf("ember_talk.xml"), sched.program(snap(modelAction = "talk")).clips)
    }

    @Test fun packWithoutWorkTalkUsesStandingSpeech() {
        val dot = parseCharacterPack(
            javaClass.classLoader!!.getResourceAsStream("characters/dot-default-pack.json")!!
                .bufferedReader().readText())
        val sched = CharacterScheduler(dot)
        // Working while the final response speaks: exit first (no work_talk lift)...
        sched.program(snap(sessionRunning = true))
        assertEquals(listOf("dot_work_exit.xml"),
            sched.program(snap(phase = Phase.SPEAKING, sessionRunning = true)).clips)
        // ...then standing talk rotation.
        val talk = sched.program(snap(phase = Phase.SPEAKING, sessionRunning = true))
        assertEquals(listOf("dot_talk_a.xml", "dot_talk_b.xml"), talk.clips)
    }

    @Test fun questionAuthoritativeOverSpeechAndEmotes() {
        val dot = parseCharacterPack(
            javaClass.classLoader!!.getResourceAsStream("characters/dot-default-pack.json")!!
                .bufferedReader().readText())
        val sched = CharacterScheduler(dot)
        val cue = sched.program(
            snap(phase = Phase.SPEAKING, pending = setOf(card), celebrate = true, modelAction = "celebrate"))
        assertEquals(listOf("dot_question.xml"), cue.clips)
        assertTrue(cue.questionCue)
        // Held final frame: no replay, no speech cut-in.
        val held = sched.program(
            snap(phase = Phase.SPEAKING, pending = setOf(card), celebrate = true, modelAction = "celebrate"))
        assertTrue(held.clips.isEmpty())
        assertTrue(held.questionCue)
        // Acknowledgement returns to neutral explicitly.
        assertEquals(listOf("dot_static.xml"), sched.program(snap()).clips)
    }

    @Test fun modelCannotRequestStateOwnedActions() {
        // question/work_talk-equivalents are never model_selectable, so a model
        // request for them (or unknown ids) degrades to the idle schedule.
        val idle = migrated.program(snap())
        migrated.reset()
        assertEquals(idle, migrated.program(snap(modelAction = "question")))
        migrated.reset()
        assertEquals(idle, migrated.program(snap(modelAction = "work_talk")))
        migrated.reset()
        assertEquals(idle, migrated.program(snap(modelAction = "fly")))
    }

    @Test fun workTransitionsCompleteOneAtATime() {
        val dot = parseCharacterPack(
            javaClass.classLoader!!.getResourceAsStream("characters/dot-default-pack.json")!!
                .bufferedReader().readText())
        val sched = CharacterScheduler(dot)
        assertEquals(listOf("dot_work_enter.xml"), sched.program(snap(sessionRunning = true)).clips)
        val loop = sched.program(snap(sessionRunning = true))
        assertEquals(listOf("dot_work_loop.xml"), loop.clips)
        assertTrue(loop.repeatLast)
        assertEquals(listOf("dot_work_exit.xml"), sched.program(snap()).clips)
        // Offline mid-pose skips the exit; reconnecting starts neutral.
        sched.program(snap(sessionRunning = true))
        assertTrue(sched.program(snap(connected = false)).clips.isEmpty())
        assertEquals(2, sched.program(snap()).clips.size)
    }

    @Test fun alternateDimensionsDoNotAffectScheduling() {
        val ember = parseCharacterPack(
            javaClass.classLoader!!.getResourceAsStream("characters/ember-min-pack.json")!!
                .bufferedReader().readText())
        assertEquals(64, ember.width)
        val sched = CharacterScheduler(ember)
        val idle = sched.program(snap())
        assertEquals(2, idle.clips.size)
        assertEquals("ember_static.xml", idle.clips[1])
        assertEquals(listOf("ember_question.xml"), sched.program(snap(pending = setOf(card))).clips)
    }

    @Test fun malformedPackNeverBuildsScheduler() {
        try {
            CharacterScheduler(parseCharacterPack("{not json"))
            fail("expected rejection")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }
}
