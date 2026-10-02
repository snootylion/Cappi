package dev.dsh.watch.cappi

import org.junit.Assert.*
import org.junit.Test

class CappiManifestTest {

    private fun realManifestText(): String =
        javaClass.classLoader!!.getResourceAsStream("cappi/cappi-manifest.json")!!
            .bufferedReader().readText()

    @Test fun realPackParsesWithContractIntact() {
        val m = parseCappiManifest(realManifestText())
        assertTrue(m.actions.size >= 19)
        assertTrue(m.clips.size >= 21)
        assertEquals(m.actions.size, m.actions.map { it.id }.distinct().size)
        m.actions.flatMap { it.clips }.forEach { assertTrue(m.clips.containsKey(it)) }
        val work = m.action("work")!!
        assertEquals(ClipMode.ENTER_LOOP_EXIT, work.mode)
        assertEquals(listOf("laptop_enter.gif", "laptop_work.gif", "laptop_exit.gif"), work.clips)
        assertFalse(m.action("static_hold")!!.modelSelectable)
        val question = m.action("question")!!
        assertEquals(ClipMode.ONCE, question.mode)
        assertEquals(listOf("question.gif"), question.clips)
        assertFalse(question.modelSelectable)
        m.clips.values.forEach { assertTrue(it.durationS > 0) }
    }

    @Test fun wrongSizePackRejected() {
        val bad = realManifestText().replace("\"width\": 98", "\"width\": 100")
        try {
            parseCappiManifest(bad)
            fail("expected rejection")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("98x98"))
        }
    }

    @Test fun unknownModeRejected() {
        val bad = realManifestText().replace("\"mode\": \"hold\"", "\"mode\": \"nap\"")
        try {
            parseCappiManifest(bad)
            fail("expected rejection")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("unknown mode"))
        }
    }

    @Test fun missingClipRefRejected() {
        // Break only the action's clip reference, not the clips-table key.
        val bad = realManifestText().replace(
            "\"clips\": [\n        \"idle1_a.gif\"",
            "\"clips\": [\n        \"nope.gif\"",
        )
        assertTrue(bad.contains("nope.gif"))
        try {
            parseCappiManifest(bad)
            fail("expected rejection")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("missing clip"))
        }
    }

    @Test fun garbageRejected() {
        try {
            parseCappiManifest("{not json")
            fail("expected rejection")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }
}
