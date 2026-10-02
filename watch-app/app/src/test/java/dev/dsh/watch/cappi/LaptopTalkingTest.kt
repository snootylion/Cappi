package dev.dsh.watch.cappi

import dev.dsh.watch.core.Phase
import org.junit.Assert.*
import org.junit.Test

class LaptopTalkingTest {
    private fun manifest(): CappiManifest = parseCappiManifest(
        javaClass.classLoader!!.getResourceAsStream("cappi/cappi-manifest.json")!!
            .bufferedReader().use { it.readText() })
    private fun state(working: Boolean = true, speaking: Boolean = false, connected: Boolean = true) =
        CappiSnapshot(connected, if (speaking) Phase.SPEAKING else Phase.IDLE, working, false, 0)
    private fun next(s: CappiScheduler, snapshot: CappiSnapshot) = s.program(snapshot).clips

    @Test fun progressSpeechPreservesLaptopAndReturnsToWorkWithoutReentering() {
        val s = CappiScheduler(manifest())
        assertEquals(listOf("laptop_enter.gif"), next(s, state()))
        assertEquals(listOf("laptop_work.gif"), next(s, state()))
        assertEquals(listOf("laptop_talk_enter.gif"), next(s, state(speaking = true)))
        repeat(3) { assertEquals(listOf("laptop_talk_loop.gif"), next(s, state(speaking = true))) }
        assertEquals(listOf("laptop_talk_exit.gif"), next(s, state()))
        assertEquals(listOf("laptop_work.gif"), next(s, state()))
        assertEquals(listOf("laptop_exit.gif"), next(s, state(working = false)))
    }

    @Test fun finalResponseReturnsFromLookUpThenPutsLaptopAwayBeforeStandingTalk() {
        val s = CappiScheduler(manifest())
        next(s, state())
        next(s, state(speaking = true))
        next(s, state(speaking = true))
        val finalSpeech = state(working = false, speaking = true)
        assertEquals(listOf("laptop_talk_exit.gif"), next(s, finalSpeech))
        assertEquals(listOf("laptop_exit.gif"), next(s, finalSpeech))
        assertEquals(listOf("talk2.gif", "talk3.gif", "talk_gesture.gif"), next(s, finalSpeech))
        assertEquals(listOf("laptop_enter.gif"), next(s, state()))
    }

    @Test fun workAndAudioFinishTogetherStillPlayBothExits() {
        val s = CappiScheduler(manifest())
        next(s, state())
        next(s, state(speaking = true))
        val idle = state(working = false)
        assertEquals(listOf("laptop_talk_exit.gif"), next(s, idle))
        assertEquals(listOf("laptop_exit.gif"), next(s, idle))
        assertEquals("cappi_static.gif", next(s, idle).last())
    }

    @Test fun audioAlreadyRunningOnEntryGetsLaptopThenLooksUp() {
        val s = CappiScheduler(manifest())
        val progress = state(speaking = true)
        assertEquals(listOf("laptop_enter.gif"), next(s, progress))
        assertEquals(listOf("laptop_talk_enter.gif"), next(s, progress))
        assertEquals(listOf("laptop_talk_loop.gif"), next(s, progress))
    }

    @Test fun shortSpeechFinishesEnterThenReturnsWithoutExtraTalkingLoop() {
        val s = CappiScheduler(manifest())
        next(s, state())
        assertEquals(listOf("laptop_talk_enter.gif"), next(s, state(speaking = true)))
        assertEquals(listOf("laptop_talk_exit.gif"), next(s, state()))
        assertEquals(listOf("laptop_work.gif"), next(s, state()))
    }

    @Test fun speechResumingDuringReturnReentersTalkingOnlyAfterReturnCompletes() {
        val s = CappiScheduler(manifest())
        next(s, state())
        next(s, state(speaking = true))
        assertEquals(listOf("laptop_talk_exit.gif"), next(s, state()))
        assertEquals(listOf("laptop_talk_enter.gif"), next(s, state(speaking = true)))
    }

    @Test fun fallbackOldPackReturnsToStandingTalkRatherThanMissingFile() {
        val m = manifest().let { it.copy(actions = it.actions.filterNot { a -> a.id == "work_talk" }) }
        val s = CappiScheduler(m)
        next(s, state())
        assertEquals(listOf("laptop_exit.gif"), next(s, state(speaking = true)))
        assertEquals("talk2.gif", next(s, state(speaking = true)).first())
    }

    @Test fun disconnectResetsPropsWithoutPlayingExits() {
        val s = CappiScheduler(manifest())
        next(s, state())
        next(s, state(speaking = true))
        assertTrue(next(s, state(connected = false)).isEmpty())
        assertEquals(listOf("laptop_enter.gif"), next(s, state()))
    }

    @Test fun playbackAlwaysFinishesCurrentGifForSpeechStartsStopsAndWorkChanges() {
        val s = CappiScheduler(manifest())
        val work = state()
        val progress = state(speaking = true)
        assertFalse(s.shouldInterrupt("laptop_work.gif", work, progress))
        assertFalse(s.shouldInterrupt("cappi_static.gif", state(working = false), progress))
        assertFalse(s.shouldInterrupt("talk2.gif", state(false, true), state(false)))
        // snapshotFlow initially emits unchanged state: this must not spin/cancel.
        assertFalse(s.shouldInterrupt("talk2.gif", state(false, true), state(false, true)))
        assertFalse(s.shouldInterrupt("laptop_talk_loop.gif", progress, progress))
        for (file in listOf("laptop_enter.gif", "laptop_exit.gif", "laptop_talk_enter.gif",
            "laptop_talk_loop.gif", "laptop_talk_exit.gif")) {
            assertFalse(file, s.shouldInterrupt(file, work, progress))
            assertFalse(file, s.shouldInterrupt(file, progress, work))
            assertFalse(file, s.shouldInterrupt(file, progress, state(false, true)))
            assertFalse(file, s.shouldInterrupt(file, work, state(false, true)))
            assertTrue(file, s.shouldInterrupt(file, progress, state(connected = false)))
        }
    }

    @Test fun everyAssetCompletesDespiteAnyConnectedSpeechOrWorkEdge() {
        val m = manifest()
        val s = CappiScheduler(m)
        val states = listOf(state(), state(false), state(true, true), state(false, true))
        for (file in m.clips.keys) for (before in states) for (after in states) {
            assertFalse(file, s.shouldInterrupt(file, before, after))
        }
    }

    @Test fun speechThatEndsDuringPutAwayDoesNotReplayStaleTalking() {
        val s = CappiScheduler(manifest())
        next(s, state())
        assertEquals(listOf("laptop_exit.gif"), next(s, state(false, true)))
        val idle = next(s, state(false, false))
        assertFalse(idle.any { it.startsWith("talk") })
        assertEquals("cappi_static.gif", idle.last())
    }

    @Test fun standaloneSpeechNeverOpensLaptopAndWorkTalkIsNotModelSelectable() {
        val m = manifest()
        assertFalse(m.action("work_talk")!!.modelSelectable)
        val s = CappiScheduler(m)
        assertEquals("talk2.gif", next(s, state(false, true)).first())
    }
}
