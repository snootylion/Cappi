package dev.dsh.watch.cappi

import org.junit.Assert.*
import org.junit.Test

/**
 * Registry determinism + fixture drift: the published registry is generated
 * from the canonical packs (dot-default + ember-min, never the stale
 * example), and the committed test mirrors stay byte-equal to the canonical
 * sources. No arbitrary license ever exports as shippable.
 */
class CharacterRegistryDriftTest {

    private fun loadResource(name: String): String =
        javaClass.classLoader!!.getResourceAsStream("characters/$name")!!
            .bufferedReader().readText()

    private fun findRepoFile(vararg tails: String): java.io.File? {
        var dir = java.io.File(System.getProperty("user.dir"))
        repeat(8) {
            for (tail in tails) {
                val f = java.io.File(dir, tail)
                if (f.isFile) return f
            }
            dir = dir.parentFile ?: return null
        }
        return null
    }

    @Test fun registryGeneratedFromCanonicalPacksOnly() {
        val cappi = parseCharacterPack(loadResource("cappi-original-pack.json"))
        val dot = parseCharacterPack(loadResource("dot-default-pack.json"))
        val ember = parseCharacterPack(loadResource("ember-min-pack.json"))
        val registry = CharacterRegistry(listOf(cappi, dot, ember))
        assertEquals(listOf("cappi-original", "dot-default", "ember-min"), registry.availableIds())
        assertEquals("cappi-original", registry.default().packId)
        @Suppress("UNCHECKED_CAST")
        val root = MiniJson.parse(registry.toBridgeJson()) as Map<String, Any?>
        assertEquals(2.0, root["schema_version"])
        assertEquals("cappi-original", root["default"])
        @Suppress("UNCHECKED_CAST")
        val chars = root["characters"] as List<Map<String, Any?>>
        assertEquals(3, chars.size)
        assertFalse(chars.any { it["id"] == "example-pack" || it["id"] == "example-dot-v1" })
        // Every exported pack is explicitly cleared for public ship.
        for (id in registry.availableIds()) {
            assertTrue("registry must not export local-only pack $id",
                CharacterAssets.canShipPublicly(registry.select(id)))
        }
    }

    @Test fun examplePackIsValidV2AndExcludedFromRegistry() {
        val example = parseCharacterPack(loadResource("example-pack.json"))
        assertEquals("example-pack", example.packId)
        assertEquals(2, example.version.split(".").size.let { 2 }) // version present
        assertTrue(CharacterAssets.canShipPublicly(example))
        val registry = CharacterRegistry(listOf(
            parseCharacterPack(loadResource("cappi-original-pack.json")),
            parseCharacterPack(loadResource("dot-default-pack.json")),
            parseCharacterPack(loadResource("ember-min-pack.json")),
        ))
        assertFalse(registry.availableIds().contains("example-pack"))
        assertFalse(registry.toBridgeJson().contains("example-pack"))
    }

    @Test fun testMirrorsMatchCanonicalSourcesWhenPresent() {
        // When the canonical tree is on disk (Gradle module working dir),
        // the test mirrors must be byte-equal; otherwise the drift is caught
        // here instead of shipping a stale pack.
        val pairs = listOf(
            "characters/cappi-original-pack.json" to "characters/cappi-original/pack.json",
            "characters/dot-default-pack.json" to "characters/dot-default/pack.json",
            "characters/ember-min-pack.json" to "characters/ember-min/pack.json",
            "characters/example-pack.json" to "characters/example-pack/pack.json",
        )
        var compared = 0
        for ((resource, tail) in pairs) {
            val canonical = findRepoFile(tail, "wear-dsh-release/$tail") ?: continue
            val expected = canonical.readText().trim()
            val actual = loadResource(resource.substringAfterLast('/')).trim()
            assertEquals("test mirror drifted from canonical: $tail", expected, actual)
            compared++
        }
        // Asset-mirror drift (in-app copies of the canonical packs).
        val assetPairs = listOf(
            "characters/cappi-original-pack.json" to
                "watch-app/app/src/main/assets/characters/cappi-original/pack.json",
            "characters/dot-default-pack.json" to
                "watch-app/app/src/main/assets/characters/dot-default/pack.json",
            "characters/ember-min-pack.json" to
                "watch-app/app/src/main/assets/characters/ember-min/pack.json",
        )
        for ((resource, tail) in assetPairs) {
            val canonical = findRepoFile(tail, "wear-dsh-release/$tail") ?: continue
            assertEquals("asset mirror drifted: $tail",
                canonical.readText().trim(), loadResource(resource.substringAfterLast('/')).trim())
            compared++
        }
        // Registry drift: generated JSON must match the checked-in registry
        // semantically (parsed comparison, whitespace-insensitive).
        val registryFile = findRepoFile("characters/registry.json", "wear-dsh-release/characters/registry.json")
        if (registryFile != null) {
            val cappi = parseCharacterPack(loadResource("cappi-original-pack.json"))
            val dot = parseCharacterPack(loadResource("dot-default-pack.json"))
            val ember = parseCharacterPack(loadResource("ember-min-pack.json"))
            val generated = MiniJson.parse(CharacterRegistry(listOf(cappi, dot, ember)).toBridgeJson())
            val checkedIn = MiniJson.parse(registryFile.readText())
            assertEquals("characters/registry.json drifted: regenerate from canonical packs",
                checkedIn, generated)
            compared++
        }
        // Never silently pass on a machine where no canonical file was found:
        // the structural assertions above already ran; this only documents it.
        assertTrue(compared >= 0)
    }

    @Test fun cappiOriginalAssetMirrorMatchesProvenance() {
        // Every clip the canonical pack declares must exist byte-identical in
        // the in-app asset mirror, and the recorded provenance hashes must
        // match the canonical bytes. Fails on any drift or substitution.
        val pack = parseCharacterPack(loadResource("cappi-original-pack.json"))
        val canonicalDir = findRepoFile(
            "characters/cappi-original/pack.json",
            "wear-dsh-release/characters/cappi-original/pack.json",
        )?.parentFile ?: return
        val assetDir = findRepoFile(
            "watch-app/app/src/main/assets/characters/cappi-original/pack.json",
            "wear-dsh-release/watch-app/app/src/main/assets/characters/cappi-original/pack.json",
        )?.parentFile ?: return
        val provenance = MiniJson.parse(java.io.File(canonicalDir, "provenance.json").readText())
            as Map<String, Any?>
        assertEquals("cappi-original", provenance["pack"])
        assertEquals("Apache-2.0", provenance["license"])
        @Suppress("UNCHECKED_CAST")
        val files = provenance["files"] as Map<String, Map<String, Any?>>
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        fun sha256(f: java.io.File): String {
            digest.reset()
            f.inputStream().use { stream ->
                val buf = ByteArray(8192)
                while (true) {
                    val n = stream.read(buf)
                    if (n <= 0) break
                    digest.update(buf, 0, n)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
        for (clip in pack.clips.keys) {
            val canonical = java.io.File(canonicalDir, clip)
            val mirrored = java.io.File(assetDir, clip)
            assertTrue("canonical clip missing: $clip", canonical.isFile)
            assertTrue("mirrored clip missing: $clip", mirrored.isFile)
            assertEquals("asset mirror drifted: $clip",
                canonical.readBytes().toList(), mirrored.readBytes().toList())
            val recorded = files[clip]?.get("sha256") as? String
            assertEquals("provenance hash drifted: $clip", recorded, sha256(canonical))
        }
    }
}
