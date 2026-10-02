package dev.dsh.watch.cappi

import dev.dsh.watch.core.Phase
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class CappiSchedulerTest {

    private lateinit var manifest: CappiManifest
    private lateinit var sched: CappiScheduler

    private fun snap(
        phase: Phase = Phase.IDLE,
        connected: Boolean = true,
        sessionRunning: Boolean = false,
        micOpen: Boolean = false,
        pendingCount: Int = 0,
        celebrate: Boolean = false,
        modelAction: String? = null,
    ) = CappiSnapshot(
        connected = connected,
        phase = phase,
        sessionRunning = sessionRunning,
        micOpen = micOpen,
        pendingCount = pendingCount,
        celebrate = celebrate,
        modelAction = modelAction,
    )

    @Before fun setUp() {
        val text = javaClass.classLoader!!.getResourceAsStream("cappi/cappi-manifest.json")!!
            .bufferedReader().readText()
        manifest = parseCappiManifest(text)
        sched = CappiScheduler(manifest)
    }

    @Test fun offlineYieldsEmpty() {
        assertEquals(CappiProgram(emptyList(), false), sched.program(snap(connected = false)))
    }

    @Test fun idleCyclesOneMotionThenStatic() {
        val first = sched.program(snap())
        assertEquals(2, first.clips.size)
        assertEquals("cappi_static.gif", first.clips[1])
        assertFalse(first.repeatLast)
        val second = sched.program(snap())
        assertFalse(second.clips.take(2) == first.clips.take(2))
        assertEquals("cappi_static.gif", second.clips[1])
    }

    @Test fun workEntersLoopsThenExits() {
        val enter = sched.program(snap(sessionRunning = true))
        assertEquals(listOf("laptop_enter.gif"), enter.clips)
        assertFalse(enter.repeatLast)
        // Still running: pinned on the loop clip, enter not replayed.
        val loop = sched.program(snap(sessionRunning = true))
        assertEquals(listOf("laptop_work.gif"), loop.clips)
        assertTrue(loop.repeatLast)
        // Run ends: exit plays before the next program.
        val exit = sched.program(snap())
        assertEquals(listOf("laptop_exit.gif"), exit.clips)
        assertFalse(exit.repeatLast)
        // Afterwards: normal idle.
        val idle = sched.program(snap())
        assertEquals(2, idle.clips.size)
    }

    @Test fun offlineMidLoopSkipsExit() {
        sched.program(snap(sessionRunning = true))
        assertEquals(CappiProgram(emptyList(), false), sched.program(snap(connected = false)))
        // Loop hold cleared: reconnecting idle must not emit a stale exit.
        assertEquals(2, sched.program(snap()).clips.size)
    }

    @Test fun speakingChainsTalkInRotation() {
        val first = sched.program(snap(phase = Phase.SPEAKING))
        assertEquals(listOf("talk2.gif", "talk3.gif", "talk_gesture.gif"), first.clips)
        val second = sched.program(snap(phase = Phase.SPEAKING))
        assertEquals(listOf("talk3.gif", "talk_gesture.gif", "talk2.gif"), second.clips)
    }

    @Test fun micOpenAndListeningDoNotOverrideIdle() {
        val baseline = sched.program(snap())
        sched.reset()
        assertEquals(baseline, sched.program(snap(micOpen = true, phase = Phase.LISTENING)))
    }

    @Test fun finalSpeakingOverridesEmotesButStillPutsLaptopAway() {
        sched.program(snap(sessionRunning = true))
        val finalSpeech = snap(phase = Phase.SPEAKING,
            celebrate = true, modelAction = "dance")
        assertEquals(listOf("laptop_exit.gif"), sched.program(finalSpeech).clips)
        assertEquals("talk2.gif", sched.program(finalSpeech).clips.first())
        assertEquals(listOf("laptop_enter.gif"), sched.program(snap(sessionRunning = true)).clips)
    }

    @Test fun offlineWinsOverUrgentSpeech() {
        assertTrue(sched.program(snap(connected = false, phase = Phase.SPEAKING,
            pendingCount = 1, celebrate = true, modelAction = "dance")).clips.isEmpty())
    }

    @Test fun celebrateAlternatesEmotes() {
        assertEquals(listOf("dance.gif"), sched.program(snap(celebrate = true)).clips)
        assertEquals(listOf("shadow.gif"), sched.program(snap(celebrate = true)).clips)
    }

    @Test fun pendingPlaysQuestionOnceThenRetainsFinalFrame() {
        val p = sched.program(snap(pendingCount = 2))
        assertEquals(listOf("question.gif"), p.clips)
        assertFalse(p.repeatLast)
        assertTrue(p.questionCue)
        val held = sched.program(snap(pendingCount = 2))
        assertTrue(held.clips.isEmpty())
        assertTrue(held.questionCue)
    }

    @Test fun pendingExitsLoopFirst() {
        sched.program(snap(sessionRunning = true))
        assertEquals(listOf("laptop_exit.gif"), sched.program(snap(pendingCount = 1)).clips)
        assertEquals(listOf("question.gif"), sched.program(snap(pendingCount = 1)).clips)
    }

    @Test fun unknownModelActionIgnored() {
        val p = sched.program(snap(modelAction = "fly"))
        assertEquals(2, p.clips.size)
    }

    @Test fun nonSelectableModelActionIgnored() {
        val p = sched.program(snap(modelAction = "static_hold"))
        assertEquals(2, p.clips.size)
    }

    @Test fun modelOnceActionPlays() {
        val p = sched.program(snap(modelAction = "dance"))
        assertEquals(listOf("dance.gif"), p.clips)
    }

    @Test fun modelWorkRequestUsesLoopLifecycle() {
        val enter = sched.program(snap(modelAction = "work"))
        assertEquals(listOf("laptop_enter.gif"), enter.clips)
        // Model withdraws while session idle: exit, then idle.
        assertEquals(listOf("laptop_exit.gif"), sched.program(snap()).clips)
    }

    @Test fun errorAndMutedHoldStatic() {
        assertEquals(listOf("cappi_static.gif"), sched.program(snap(phase = Phase.ERROR)).clips)
        assertEquals(listOf("cappi_static.gif"), sched.program(snap(phase = Phase.MUTED)).clips)
    }
}
