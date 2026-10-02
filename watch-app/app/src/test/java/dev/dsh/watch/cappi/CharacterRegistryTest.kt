package dev.dsh.watch.cappi

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Selection API + published capability registry + asset/provenance gate.
 * The registry JSON is the single source for bridge/plugin consumers; the
 * legacy `/watch/cappi` action ids survive only as an adapter.
 */
class CharacterRegistryTest {

    private lateinit var cappi: CharacterPack
    private lateinit var dot: CharacterPack
    private lateinit var ember: CharacterPack
    private lateinit var registry: CharacterRegistry

    @Before fun setUp() {
        fun load(name: String): CharacterPack {
            val stream = javaClass.classLoader!!.getResourceAsStream(name)!!
            return parseCharacterPack(stream.bufferedReader().readText())
        }
        cappi = load("characters/cappi-original-pack.json")
        dot = load("characters/dot-default-pack.json")
        ember = load("characters/ember-min-pack.json")
        registry = CharacterRegistry(listOf(cappi, dot, ember))
    }

    @Test fun selectionDefaultsAndFallsBackSafely() {
        assertEquals("cappi-original", registry.default().packId)
        assertEquals("cappi-original", registry.select(null).packId)
        assertEquals("cappi-original", registry.select("").packId)
        assertEquals("cappi-original", registry.select("ghost-pack").packId)
        assertEquals("cappi-original", registry.select("cappi-legacy-local").packId)
        assertEquals("dot-default", registry.select("dot-default").packId)
        assertEquals("ember-min", registry.select("ember-min").packId)
        assertEquals(listOf("cappi-original", "dot-default", "ember-min"), registry.availableIds())
    }

    @Test fun emptyRegistryRejected() {
        try {
            CharacterRegistry(emptyList())
            fail("expected rejection")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }

    @Test fun modelSelectableExcludesStateOwnedCues() {
        val actions = registry.modelSelectableActions("dot-default")
        assertTrue(actions.containsAll(listOf("idle_a", "talk_a", "work_set", "celebrate")))
        assertFalse(actions.contains("question"))
        assertFalse(actions.contains("static_hold"))
        // Legacy adapter exposes exactly the model-selectable set.
        assertEquals(actions, registry.legacyActionIds("dot-default"))
        assertFalse(registry.legacyActionIds("ember-min").contains("question"))
    }

    @Test fun bridgeJsonPublishesSingleSource() {
        val json = registry.toBridgeJson()
        @Suppress("UNCHECKED_CAST")
        val root = MiniJson.parse(json) as Map<String, Any?>
        assertEquals(2.0, root["schema_version"])
        assertEquals("cappi-original", root["default"])
        assertEquals("/watch/cappi", root["legacy_cappi_route"])
        assertEquals("/watch/stream", root["watch_stream_route"])
        @Suppress("UNCHECKED_CAST")
        val chars = root["characters"] as List<Map<String, Any?>>
        assertEquals(3, chars.size)
        val cappiJson = chars.first { it["id"] == "cappi-original" }
        assertEquals("1.0.0", cappiJson["version"])
        assertEquals("Apache-2.0", cappiJson["license"])
        @Suppress("UNCHECKED_CAST")
        val dims = cappiJson["dimensions"] as Map<String, Any?>
        assertEquals(98.0, dims["width"])
        @Suppress("UNCHECKED_CAST")
        val roles = cappiJson["roles"] as Map<String, Any?>
        assertTrue((roles["talk"] as List<*>).containsAll(listOf("talk2", "talk3", "talk_gesture")))
        @Suppress("UNCHECKED_CAST")
        val selectable = cappiJson["model_selectable"] as List<String>
        assertFalse(selectable.contains("question"))
        assertFalse(selectable.contains("work_talk"))
        assertFalse(selectable.contains("static_hold"))
        assertEquals("characters/cappi-original", cappiJson["asset_dir"])
        val dotJson = chars.first { it["id"] == "dot-default" }
        assertEquals("CC0-1.0", dotJson["license"])
        assertEquals("characters/dot-default", dotJson["asset_dir"])
    }
}

class CharacterAssetsTest {

    @Test fun provenanceGateSeparatesShippableFromLocalOnly() {
        fun load(name: String): CharacterPack {
            val stream = javaClass.classLoader!!.getResourceAsStream(name)!!
            return parseCharacterPack(stream.bufferedReader().readText())
        }
        val cappi = load("characters/cappi-original-pack.json")
        assertTrue(CharacterAssets.canShipPublicly(cappi))
        assertTrue(CharacterAssets.provenanceOf(cappi) is CharacterAssets.Provenance.LicenseSafe)
        val dot = load("characters/dot-default-pack.json")
        assertTrue(CharacterAssets.canShipPublicly(dot))
        assertTrue(CharacterAssets.provenanceOf(dot) is CharacterAssets.Provenance.LicenseSafe)

        val legacyText = javaClass.classLoader!!.getResourceAsStream("cappi/cappi-manifest.json")!!
            .bufferedReader().readText()
        val migrated = migrateLegacyManifest(parseCappiManifest(legacyText))
        assertTrue(CharacterAssets.canShipPublicly(migrated))
        assertTrue(CharacterAssets.provenanceOf(migrated) is CharacterAssets.Provenance.LicenseSafe)
    }

    @Test fun assetPathsRejectTraversal() {
        assertEquals("characters/dot-default/dot_idle_a.xml",
            CharacterAssets.clipAssetPath("dot-default", "dot_idle_a.xml"))
        assertNull(CharacterAssets.clipAssetPath("dot-default", "../evil.xml"))
        assertNull(CharacterAssets.clipAssetPath("../evil", "dot_idle_a.xml"))
        assertNull(CharacterAssets.clipAssetPath("dot-default", "talk.exe"))
        assertNull(CharacterAssets.packAssetPath("../evil"))
        assertEquals("characters/dot-default/pack.json",
            CharacterAssets.packAssetPath("dot-default"))
    }

    @Test fun discoveryListsOnlyPackDescriptors() {
        val ids = CharacterAssets.discoverPackIds(listOf(
            "characters/cappi-original/pack.json",
            "characters/dot-default/pack.json",
            "characters/ember-min/pack.json",
            "characters/dot-default/dot_idle_a.xml",
            "cappi/cappi-manifest.json",
            "characters/../evil/pack.json",
        ))
        assertEquals(listOf("cappi-original", "dot-default", "ember-min"), ids)
    }

    @Test fun importHookReportsMissingAssetsWithoutCopying() {
        val stream = javaClass.classLoader!!.getResourceAsStream("characters/dot-default-pack.json")!!
        val json = stream.bufferedReader().readText()
        val pack = parseCharacterPack(json)
        val full = CharacterAssets.inspectImport(json, pack.clips.keys)
        assertTrue(full.valid)
        assertTrue(full.missingAssets.isEmpty())
        val partial = CharacterAssets.inspectImport(json, setOf("dot_idle_a.xml"))
        assertFalse(partial.valid)
        assertTrue(partial.missingAssets.contains("dot_static.xml"))
        val broken = CharacterAssets.inspectImport("{not json", emptySet())
        assertFalse(broken.valid)
        assertNotNull(broken.error)
    }
}
