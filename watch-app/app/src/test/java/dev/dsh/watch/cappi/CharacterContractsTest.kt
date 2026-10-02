package dev.dsh.watch.cappi

import org.junit.Assert.*
import org.junit.Test

/**
 * Required role contracts, provenance allowlist, and the valid v2
 * example-pack (the stale schema-v1 draft is gone). Synthetic packs only,
 * plus the committed v2 example.
 */
class CharacterContractsTest {

    private fun basePackJson(
        roles: String = "\"idle\": [\"idle_a\", \"idle_b\", \"idle_c\"], \"listen\": [\"listen\"], \"talk\": [\"talk\"], \"work\": [\"work_set\"], \"question\": [\"question\"], \"neutral_hold\": [\"static_hold\"]",
        fallback: String = "idle",
    ): String {
        val w = 64
        val sb = StringBuilder("{")
        sb.append("\"schema_version\": 2, \"pack\": \"synth\", \"version\": \"1.0.0\",")
        sb.append("\"author\": \"test\", \"license\": \"CC0-1.0\",")
        sb.append("\"dimensions\": {\"width\": $w, \"height\": $w}, \"background\": \"#000000\",")
        sb.append("\"actions\": [")
        sb.append("{\"id\": \"idle_a\", \"mode\": \"neutral_loop\", \"clips\": [\"idle_a.xml\"], \"model_selectable\": true},")
        sb.append("{\"id\": \"idle_b\", \"mode\": \"neutral_loop\", \"clips\": [\"idle_b.xml\"], \"model_selectable\": true},")
        sb.append("{\"id\": \"idle_c\", \"mode\": \"neutral_loop\", \"clips\": [\"idle_c.xml\"], \"model_selectable\": true},")
        sb.append("{\"id\": \"listen\", \"mode\": \"neutral_loop\", \"clips\": [\"listen.xml\"], \"model_selectable\": true},")
        sb.append("{\"id\": \"talk\", \"mode\": \"once\", \"clips\": [\"talk.xml\"], \"model_selectable\": true},")
        sb.append("{\"id\": \"work_set\", \"mode\": \"enter_loop_exit\", \"clips\": [\"enter.xml\", \"loop.xml\", \"exit.xml\"], \"model_selectable\": true},")
        sb.append("{\"id\": \"question\", \"mode\": \"once\", \"clips\": [\"question.xml\"], \"model_selectable\": false},")
        sb.append("{\"id\": \"static_hold\", \"mode\": \"hold\", \"clips\": [\"static.xml\"], \"model_selectable\": false}")
        sb.append("],")
        sb.append("\"clips\": {")
        for (f in listOf("idle_a.xml", "idle_b.xml", "idle_c.xml", "listen.xml", "talk.xml",
            "enter.xml", "loop.xml", "exit.xml", "question.xml", "static.xml")) {
            sb.append("\"$f\": {\"width\": $w, \"height\": $w, \"duration_s\": 1.0},")
        }
        sb.append("\"pad.xml\": {\"width\": $w, \"height\": $w}")
        sb.append("},")
        sb.append("\"roles\": {$roles},")
        sb.append("\"fallback_role\": \"$fallback\",")
        sb.append("\"notes\": \"synthetic\"}")
        return sb.toString()
    }

    private fun expectReject(json: String, fragment: String) {
        try {
            parseCharacterPack(json)
            fail("expected rejection containing: $fragment")
        } catch (e: IllegalArgumentException) {
            assertTrue("error '${e.message}' should mention '$fragment'",
                e.message!!.contains(fragment, ignoreCase = true))
        }
    }

    @Test fun requiredRolesWorkAndNeutralHold() {
        // Missing work / neutral_hold fail fast with an honest contract message.
        expectReject(basePackJson(roles = "\"idle\": [\"idle_a\", \"idle_b\", \"idle_c\"]"),
            "must declare role 'work'")
        expectReject(basePackJson(
            roles = "\"idle\": [\"idle_a\", \"idle_b\", \"idle_c\"], \"work\": [\"work_set\"]"),
            "must declare role 'neutral_hold'")
    }

    @Test fun idleNeedsAtLeastThreeClips() {
        expectReject(basePackJson(
            roles = "\"idle\": [\"idle_a\"], \"work\": [\"work_set\"], \"neutral_hold\": [\"static_hold\"]"),
            "at least 3 clips")
    }

    @Test fun optionalRolesTrulyFallback() {
        // Sparse pack with only the required contracts: celebrate/talk/listen
        // resolve through idle, work_talk/question stay state-owned or empty.
        val p = parseCharacterPack(basePackJson())
        assertEquals(listOf("idle_a.xml", "idle_b.xml", "idle_c.xml"),
            p.clipsFor(CharacterRole.CELEBRATE))
        assertEquals("idle_a", p.firstActionId(CharacterRole.WORK_TALK))
        CharacterScheduler(p) // required contracts satisfied: must construct
    }

    @Test fun provenanceAllowlistRejectsArbitraryStrings() {
        fun packWithLicense(license: String): CharacterPack {
            val json = basePackJson().replace("\"license\": \"CC0-1.0\"", "\"license\": \"$license\"")
            return parseCharacterPack(json)
        }
        assertTrue(CharacterAssets.canShipPublicly(packWithLicense("CC0-1.0")))
        // Apache-2.0 is cleared for the owner-approved original Cappi pack.
        assertTrue(CharacterAssets.canShipPublicly(packWithLicense("Apache-2.0")))
        for (lic in listOf("MIT", "proprietary", "CC-BY-4.0", "cleared", "")) {
            val json = basePackJson().replace("\"license\": \"CC0-1.0\"", "\"license\": \"$lic\"")
            if (lic.isEmpty()) {
                expectReject(json, "blank license")
            } else {
                assertFalse("arbitrary license must not ship: $lic",
                    CharacterAssets.canShipPublicly(packWithLicense(lic)))
                assertTrue(CharacterAssets.provenanceOf(packWithLicense(lic))
                    is CharacterAssets.Provenance.LocalParityOnly)
            }
        }
        assertFalse(CharacterAssets.canShipPublicly(
            packWithLicense("UNRESOLVED-local-parity-only: do not ship")))
    }

    @Test fun unresolvedUnknownLocalNeverAutoSelected() {
        // The automatic chain (requireLicenseSafe=true) admits only cleared
        // packs; unresolved/unknown licenses never auto-select.
        fun packWithLicense(license: String) = parseCharacterPack(
            basePackJson().replace("\"license\": \"CC0-1.0\"", "\"license\": \"$license\""))
        assertTrue(CharacterAssets.canShipPublicly(packWithLicense("CC0-1.0")))
        assertFalse(CharacterAssets.canShipPublicly(packWithLicense("UNRESOLVED-x")))
        assertFalse(CharacterAssets.canShipPublicly(packWithLicense("MIT")))
    }
}
