package dev.dsh.watch.core

import dev.dsh.watch.cappi.parseCharacterPack
import org.junit.Assert.*
import org.junit.Test

/**
 * JVM tests for character selection: id hygiene, per-pack alias translation
 * (legacy bridge ids and cross-pack semantic ids resolve through roles instead
 * of being ignored), and state-owned roles never resolving from model cues.
 * Packs load from the committed test resources (byte-equal mirrors).
 */
class CharacterSelectionTest {

    private fun loadPack(resource: String) = parseCharacterPack(
        javaClass.classLoader!!.getResourceAsStream("characters/$resource")!!
            .bufferedReader().use { it.readText() },
    )

    @Test fun sanitizeDefaultsToCappiOriginal() {
        assertEquals("cappi-original", CharacterSelection.sanitizeId(null))
        assertEquals("cappi-original", CharacterSelection.sanitizeId(""))
        assertEquals("cappi-original", CharacterSelection.sanitizeId("  "))
        assertEquals("cappi-original", CharacterSelection.sanitizeId("../evil"))
        assertEquals("cappi-original", CharacterSelection.sanitizeId("HAS SPACE"))
        assertEquals("ember-min", CharacterSelection.sanitizeId("ember-min"))
        assertEquals("dot-default", CharacterSelection.sanitizeId("dot-default"))
        // Pre-clearance saves migrate forward; unset stays on the registry default.
        assertEquals("cappi-original", CharacterSelection.sanitizeId("cappi-legacy-local"))
        assertEquals("cappi-original", CharacterSelection.DEFAULT_ID)
        assertEquals("dot-default", CharacterSelection.FALLBACK_ID)
    }

    @Test fun dotDefaultExactAndLegacyAliases() {
        val pack = loadPack("dot-default-pack.json")
        assertEquals("celebrate", CharacterSelection.resolveModelAction(pack, "celebrate"))
        // Legacy bridge allowlist ids translate through roles, not ignored.
        assertEquals("celebrate", CharacterSelection.resolveModelAction(pack, "dance"))
        assertEquals("celebrate", CharacterSelection.resolveModelAction(pack, "shadow"))
        assertEquals("talk_a", CharacterSelection.resolveModelAction(pack, "talk2"))
        assertEquals("talk_a", CharacterSelection.resolveModelAction(pack, "talk_gesture"))
        assertEquals("listen", CharacterSelection.resolveModelAction(pack, "breath"))
        assertEquals("work_set", CharacterSelection.resolveModelAction(pack, "work"))
        assertEquals("idle_a", CharacterSelection.resolveModelAction(pack, "idle1_a"))
    }

    @Test fun stateOwnedRolesNeverResolve() {
        val pack = loadPack("dot-default-pack.json")
        assertNull(CharacterSelection.resolveModelAction(pack, "question"))
        assertNull(CharacterSelection.resolveModelAction(pack, "work_talk"))
        assertNull(CharacterSelection.resolveModelAction(pack, null))
        assertNull(CharacterSelection.resolveModelAction(pack, ""))
        assertNull(CharacterSelection.resolveModelAction(pack, "clear"))
        assertNull(CharacterSelection.resolveModelAction(pack, "no-such-action"))
    }

    @Test fun cappiOriginalExactAndStateOwned() {
        val pack = loadPack("cappi-original-pack.json")
        assertEquals("cappi-original", pack.packId)
        // Original ids resolve exactly on the default pack.
        assertEquals("dance", CharacterSelection.resolveModelAction(pack, "dance"))
        assertEquals("shadow", CharacterSelection.resolveModelAction(pack, "shadow"))
        assertEquals("breath", CharacterSelection.resolveModelAction(pack, "breath"))
        assertEquals("work", CharacterSelection.resolveModelAction(pack, "work"))
        assertEquals("talk2", CharacterSelection.resolveModelAction(pack, "talk2"))
        // Cross-pack semantic ids animate through roles instead of being ignored.
        assertEquals("talk2", CharacterSelection.resolveModelAction(pack, "talk_a"))
        assertEquals("dance", CharacterSelection.resolveModelAction(pack, "celebrate"))
        // State-owned roles never resolve from a model cue.
        assertNull(CharacterSelection.resolveModelAction(pack, "question"))
        assertNull(CharacterSelection.resolveModelAction(pack, "work_talk"))
        assertNull(CharacterSelection.resolveModelAction(pack, "static_hold"))
    }

    @Test fun emberMinCrossPackAndSparseFallback() {
        val pack = loadPack("ember-min-pack.json")
        // dot-default semantic ids animate on ember-min through the talk role.
        assertEquals("talk", CharacterSelection.resolveModelAction(pack, "talk_a"))
        assertEquals("talk", CharacterSelection.resolveModelAction(pack, "talk2"))
        assertEquals("listen", CharacterSelection.resolveModelAction(pack, "breath2"))
        // ember-min has no celebrate role: falls back to idle motion, never null-spin.
        val fellBack = CharacterSelection.resolveModelAction(pack, "dance")
        assertNotNull(fellBack)
        assertTrue(pack.roles[dev.dsh.watch.cappi.CharacterRole.IDLE]!!.contains(fellBack))
        assertNull(CharacterSelection.resolveModelAction(pack, "question"))
    }
}
