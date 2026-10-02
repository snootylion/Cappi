package dev.dsh.watch.cappi

import org.junit.Assert.*
import org.junit.Test

class CappiActionStateTest {
    @Test fun setReplaceAndClear() {
        assertEquals("dance", reduceCappiAction(null, "dance"))
        assertEquals("work", reduceCappiAction("dance", "work"))
        assertNull(reduceCappiAction("work", null))
        assertNull(reduceCappiAction("work", ""))
        assertNull(reduceCappiAction("work", "clear"))
        assertNull(reduceCappiAction(null, null))
    }
}
