package dev.dsh.watch.cappi

import org.junit.Assert.*
import org.junit.Test

/**
 * Validation of versioned (schema v2) role packs: dimensions are per-pack
 * (alternate sizes accepted), asset refs are traversal-safe bare filenames,
 * state-owned roles can never be model-requestable, and malformed packs fail
 * loudly. All fixtures are synthetic and license-safe (no binary dependency).
 */
class CharacterPackTest {

    private fun packJson(
        pack: String = "synth",
        version: String = "1.0.0",
        author: String = "test",
        license: String = "CC0-1.0",
        width: Int = 64,
        height: Int = 64,
        roles: String = "\"idle\": [\"idle_a\", \"idle_b\", \"idle_c\"], \"listen\": [\"listen\"], \"talk\": [\"talk\"], \"work\": [\"work_set\"], \"question\": [\"question\"], \"neutral_hold\": [\"static_hold\"]",
        fallback: String = "idle",
        extraAction: String = "",
        extraClip: String = "",
        omit: Set<String> = emptySet(),
    ): String {
        fun has(k: String) = !omit.contains(k)
        val sb = StringBuilder("{")
        sb.append("\"schema_version\": 2,")
        if (has("pack")) sb.append("\"pack\": \"$pack\",")
        if (has("version")) sb.append("\"version\": \"$version\",")
        if (has("author")) sb.append("\"author\": \"$author\",")
        if (has("license")) sb.append("\"license\": \"$license\",")
        if (has("dimensions")) sb.append("\"dimensions\": {\"width\": $width, \"height\": $height},")
        sb.append("\"background\": \"#000000\",")
        sb.append("\"actions\": [")
        sb.append("{\"id\": \"idle_a\", \"mode\": \"neutral_loop\", \"clips\": [\"idle_a.xml\"], \"model_selectable\": true},")
        sb.append("{\"id\": \"idle_b\", \"mode\": \"neutral_loop\", \"clips\": [\"idle_b.xml\"], \"model_selectable\": true},")
        sb.append("{\"id\": \"idle_c\", \"mode\": \"neutral_loop\", \"clips\": [\"idle_c.xml\"], \"model_selectable\": true},")
        sb.append("{\"id\": \"listen\", \"mode\": \"neutral_loop\", \"clips\": [\"listen.xml\"], \"model_selectable\": true},")
        sb.append("{\"id\": \"talk\", \"mode\": \"once\", \"clips\": [\"talk.xml\"], \"model_selectable\": true},")
        sb.append("{\"id\": \"work_set\", \"mode\": \"enter_loop_exit\", \"clips\": [\"enter.xml\", \"loop.xml\", \"exit.xml\"], \"model_selectable\": true},")
        sb.append("{\"id\": \"question\", \"mode\": \"once\", \"clips\": [\"question.xml\"], \"model_selectable\": false},")
        sb.append("{\"id\": \"static_hold\", \"mode\": \"hold\", \"clips\": [\"static.xml\"], \"model_selectable\": false}")
        sb.append(extraAction)
        sb.append("],")
        sb.append("\"clips\": {")
        for (f in listOf("idle_a.xml", "idle_b.xml", "idle_c.xml", "listen.xml", "talk.xml",
            "enter.xml", "loop.xml", "exit.xml", "question.xml", "static.xml")) {
            sb.append("\"$f\": {\"width\": $width, \"height\": $height, \"duration_s\": 1.0},")
        }
        sb.append(extraClip)
        sb.append("\"pad.xml\": {\"width\": $width, \"height\": $height}")
        sb.append("},")
        if (has("roles")) sb.append("\"roles\": {$roles},")
        if (has("fallback")) sb.append("\"fallback_role\": \"$fallback\",")
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

    @Test fun validSyntheticPackParsesWithAlternateDimensions() {
        val p = parseCharacterPack(packJson(width = 64, height = 48))
        assertEquals("synth", p.packId)
        assertEquals(64, p.width)
        assertEquals(48, p.height)
        assertEquals(CharacterRole.IDLE, p.fallbackRole)
        assertEquals(listOf("idle_a", "idle_b", "idle_c"), p.roles[CharacterRole.IDLE])
        assertTrue(p.modelSelectableActions().contains("talk"))
        assertFalse(p.modelSelectableActions().contains("question"))
    }

    @Test fun squareAndLargeDimensionsAccepted() {
        assertEquals(96, parseCharacterPack(packJson(width = 96, height = 96)).width)
        assertEquals(1024, parseCharacterPack(packJson(width = 1024, height = 16)).width)
    }

    @Test fun dimensionsOutOfRangeRejected() {
        expectReject(packJson(width = 8, height = 8), "16..1024")
    }

    @Test fun clipDimensionMismatchRejected() {
        val json = packJson(width = 64, height = 64)
            .replace("\"talk.xml\": {\"width\": 64, \"height\": 64",
                "\"talk.xml\": {\"width\": 32, \"height\": 64")
        expectReject(json, "64x64")
    }

    @Test fun missingClipRefRejected() {
        val json = packJson().replace("[\"talk.xml\"]", "[\"ghost.xml\"]")
        expectReject(json, "missing clip")
    }

    @Test fun pathTraversalRejected() {
        expectReject(packJson().replace("\"talk.xml\"", "\"../evil.xml\""), "unsafe")
        expectReject(packJson().replace("[\"talk.xml\"]", "[\"sub/talk.xml\"]"), "unsafe")
        expectReject(packJson().replace("[\"talk.xml\"]", "[\"/abs.xml\"]"), "unsafe")
        expectReject(packJson().replace("[\"talk.xml\"]", "[\"talk.exe\"]"), "unsafe")
        assertFalse(isSafeAssetName("../evil.gif"))
        assertFalse(isSafeAssetName("a/b.gif"))
        assertFalse(isSafeAssetName(""))
        assertTrue(isSafeAssetName("dot_idle_a.xml"))
    }

    @Test fun garbageAndWrongSchemaRejected() {
        expectReject("{not json", "expected string key")
        expectReject(packJson().replace("\"schema_version\": 2", "\"schema_version\": 1"), "schema_version")
        expectReject(packJson(omit = setOf("pack")), "lacks id")
        expectReject(packJson(omit = setOf("version")), "version")
        expectReject(packJson(omit = setOf("author")), "author")
        expectReject(packJson(omit = setOf("license")), "license")
        expectReject(packJson(omit = setOf("dimensions")), "dimensions")
        expectReject(packJson(omit = setOf("roles")), "roles")
        expectReject(packJson(omit = setOf("fallback")), "fallback_role")
    }

    @Test fun unknownRoleAndUnknownActionRejected() {
        expectReject(packJson(roles = "\"idle\": [\"idle_a\"], \"nap\": [\"idle_b\"]"), "unknown role")
        expectReject(packJson(roles = "\"idle\": [\"nope\"]"), "unknown action")
        expectReject(packJson(roles = "\"listen\": [\"idle_a\"]"), "must declare role 'idle'")
        expectReject(packJson(fallback = "celebrate"), "not a declared role")
    }

    @Test fun questionMustStayStateOwned() {
        val json = packJson().replace(
            "{\"id\": \"question\", \"mode\": \"once\", \"clips\": [\"question.xml\"], \"model_selectable\": false}",
            "{\"id\": \"question\", \"mode\": \"once\", \"clips\": [\"question.xml\"], \"model_selectable\": true}",
        )
        expectReject(json, "state-owned")
    }

    @Test fun unknownModeAndBadTransitionsRejected() {
        expectReject(packJson().replace("\"mode\": \"hold\"", "\"mode\": \"nap\""), "unknown mode")
        val badTrans = packJson().replace("\"notes\": \"synthetic\"}",
            "\"transitions\": {\"idle_a\": \"ghost\"}, \"notes\": \"synthetic\"}")
        expectReject(badTrans, "unknown action")
    }

    @Test fun duplicateActionIdsRejected() {
        val json = packJson(extraAction = ",{\"id\": \"talk\", \"mode\": \"once\", \"clips\": [\"talk.xml\"]}")
        expectReject(json, "duplicate")
    }

    @Test fun roleFallbackChainResolves() {
        // Sparse pack: no celebrate/work_talk roles at all.
        val p = parseCharacterPack(packJson())
        assertEquals(
            listOf("idle_a.xml", "idle_b.xml", "idle_c.xml"),
            p.clipsFor(CharacterRole.CELEBRATE),
        )
        assertEquals("idle_a", p.firstActionId(CharacterRole.WORK_TALK))
        assertEquals(listOf("talk.xml"), p.clipsFor(CharacterRole.TALK))
    }

    @Test fun legacyManifestMigratesToCanonicalRoles() {
        val text = javaClass.classLoader!!.getResourceAsStream("cappi/cappi-manifest.json")!!
            .bufferedReader().readText()
        val legacy = parseCappiManifest(text)
        val migrated = migrateLegacyManifest(legacy)
        assertEquals("cappi-original", migrated.packId)
        assertEquals("1.0.0", migrated.version)
        assertEquals(98, migrated.width)
        assertEquals("Apache-2.0", migrated.license)
        assertTrue(CharacterAssets.canShipPublicly(migrated))
        assertEquals(
            legacy.actions.filter { it.mode == ClipMode.NEUTRAL_LOOP }.map { it.id }.sorted(),
            migrated.roles[CharacterRole.IDLE],
        )
        assertEquals(listOf("talk2", "talk3", "talk_gesture"), migrated.roles[CharacterRole.TALK])
        assertEquals(listOf("breath", "breath2", "relaxed"), migrated.roles[CharacterRole.LISTEN])
        assertEquals(listOf("dance", "shadow"), migrated.roles[CharacterRole.CELEBRATE])
        assertEquals(listOf("work"), migrated.roles[CharacterRole.WORK])
        assertEquals(listOf("work_talk"), migrated.roles[CharacterRole.WORK_TALK])
        assertEquals(listOf("question"), migrated.roles[CharacterRole.QUESTION])
        assertEquals(listOf("static_hold"), migrated.roles[CharacterRole.NEUTRAL_HOLD])
        // State-owned cues never become model-requestable through migration.
        assertFalse(migrated.modelSelectableActions().contains("question"))
        assertFalse(migrated.modelSelectableActions().contains("work_talk"))
        assertFalse(migrated.modelSelectableActions().contains("static_hold"))
    }

    @Test fun migratedPackEqualsCanonicalCappiOriginal() {
        // The checked-in canonical pack must be exactly what the v1 manifest
        // migrates to: same actions, clips, roles, fallback and ownership.
        val legacy = parseCappiManifest(
            javaClass.classLoader!!.getResourceAsStream("cappi/cappi-manifest.json")!!
                .bufferedReader().readText())
        val migrated = migrateLegacyManifest(legacy)
        val canonical = parseCharacterPack(
            javaClass.classLoader!!.getResourceAsStream("characters/cappi-original-pack.json")!!
                .bufferedReader().readText())
        assertEquals(migrated.packId, canonical.packId)
        assertEquals(migrated.version, canonical.version)
        assertEquals(migrated.license, canonical.license)
        assertEquals(migrated.width, canonical.width)
        assertEquals(migrated.height, canonical.height)
        assertEquals(migrated.actions.map { it.id }, canonical.actions.map { it.id })
        assertEquals(migrated.actions.map { it.mode }, canonical.actions.map { it.mode })
        assertEquals(migrated.actions.map { it.clips }, canonical.actions.map { it.clips })
        assertEquals(
            migrated.actions.map { it.modelSelectable },
            canonical.actions.map { it.modelSelectable })
        assertEquals(migrated.clips.keys.sorted(), canonical.clips.keys.sorted())
        assertEquals(migrated.roles, canonical.roles)
        assertEquals(migrated.fallbackRole, canonical.fallbackRole)
    }

    @Test fun shippedExamplePacksValidate() {
        for (name in listOf("characters/cappi-original-pack.json", "characters/dot-default-pack.json", "characters/ember-min-pack.json")) {
            val stream = javaClass.classLoader!!.getResourceAsStream(name)
                ?: throw AssertionError("missing test resource $name")
            val pack = parseCharacterPack(stream.bufferedReader().readText())
            assertTrue(pack.width in 16..1024)
            assertEquals(CharacterRole.IDLE, pack.fallbackRole)
        }
        val dot = parseCharacterPack(
            javaClass.classLoader!!.getResourceAsStream("characters/dot-default-pack.json")!!
                .bufferedReader().readText())
        assertEquals("dot-default", dot.packId)
        assertEquals(96, dot.width)
        assertEquals("CC0-1.0", dot.license)
        val ember = parseCharacterPack(
            javaClass.classLoader!!.getResourceAsStream("characters/ember-min-pack.json")!!
                .bufferedReader().readText())
        assertEquals(64, ember.width)
        assertFalse(ember.roles.containsKey(CharacterRole.CELEBRATE))
    }
}
