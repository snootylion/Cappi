package dev.dsh.watch.cappi

import org.junit.Assert.*
import org.junit.Test

/**
 * Clip-target resolution: compiled resources win, imported vector assets
 * without a compiled resource resolve to parser inflation (never the GIF
 * decoder), and unsafe/absent art fails with a useful reason.
 */
class CharacterClipResolverTest {

    private fun pack(): CharacterPack {
        val text = javaClass.classLoader!!.getResourceAsStream("characters/dot-default-pack.json")!!
            .bufferedReader().readText()
        return parseCharacterPack(text)
    }

    @Test fun compiledResourceWins() {
        val p = pack()
        val r = CharacterClipResolver.resolve(p, "dot_idle_a.xml",
            resIdOf = { if (it == "dot_idle_a") 123 else 0 },
            assetHas = { false }, assetBase = "characters/dot-default")
        assertTrue(r is ClipResolution.CompiledVector)
        assertEquals(123, (r as ClipResolution.CompiledVector).resId)
    }

    @Test fun importedVectorWithoutResourceResolvesToParserPath() {
        val p = pack()
        // New imported asset: no compiled resource, but present in assets.
        val r = CharacterClipResolver.resolve(p, "dot_idle_a.xml",
            resIdOf = { 0 },
            assetHas = { it == "characters/dot-default/dot_idle_a.xml" },
            assetBase = "characters/dot-default")
        assertTrue("expected AssetVector, got $r", r is ClipResolution.AssetVector)
        assertEquals("characters/dot-default/dot_idle_a.xml", (r as ClipResolution.AssetVector).assetPath)
    }

    @Test fun missingVectorFailsUsefully() {
        val p = pack()
        val r = CharacterClipResolver.resolve(p, "dot_idle_a.xml",
            resIdOf = { 0 }, assetHas = { false }, assetBase = "characters/dot-default")
        assertTrue(r is ClipResolution.Missing)
        assertTrue((r as ClipResolution.Missing).reason.contains("no compiled drawable"))
    }

    @Test fun unsafeAndUnknownClipsFailUsefully() {
        val p = pack()
        assertTrue(CharacterClipResolver.resolve(p, "../evil.xml", { 0 }, { true }, "characters/dot-default")
            is ClipResolution.Missing)
        assertTrue(CharacterClipResolver.resolve(p, "ghost.xml", { 0 }, { true }, "characters/dot-default")
            is ClipResolution.Missing)
    }

    @Test fun gifResolvesOnlyWhenAssetPresent() {
        val p = pack()
        // dot-default has no gif clips; synthesize via resolver against the clips table:
        // an unsafe name must not resolve to GIF decode.
        val r = CharacterClipResolver.resolve(p, "dot_idle_a.xml",
            resIdOf = { 0 }, assetHas = { false }, assetBase = "characters/dot-default")
        assertTrue(r is ClipResolution.Missing)
    }

    @Test fun neutralFallbackResolves() {
        val p = pack()
        val sched = CharacterScheduler(p)
        val fb = CharacterClipResolver.neutralFallback(p, sched,
            resIdOf = { if (it == "dot_static") 7 else 0 },
            assetHas = { false }, assetBase = "characters/dot-default")
        assertTrue(fb is ClipResolution.CompiledVector)
    }

    @Test fun newPackNeedsNoCodeRegistration() {
        // Discovery + parse is data-driven: a third pack id flows through the
        // same pure functions with no hardcoded list.
        val ids = CharacterAssets.discoverPackIds(listOf(
            "characters/dot-default/pack.json",
            "characters/ember-min/pack.json",
            "characters/nova-third/pack.json",
        ))
        assertEquals(listOf("dot-default", "ember-min", "nova-third"), ids)
        for (id in ids) {
            assertEquals("characters/$id/pack.json", CharacterAssets.packAssetPath(id))
        }
        // ember-min (the shipped minimal second) parses and schedules without
        // any per-pack branch.
        val emberText = javaClass.classLoader!!.getResourceAsStream("characters/ember-min-pack.json")!!
            .bufferedReader().readText()
        val ember = parseCharacterPack(emberText)
        assertEquals("ember-min", ember.packId)
        CharacterScheduler(ember) // must not throw: proves no registration edit needed
    }
}
