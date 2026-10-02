package dev.dsh.watch.cappi

/**
 * Asset resolution, provenance gate, and local-import hook (pure JVM core;
 * Android file access stays in AvatarScreen).
 *
 * Provenance: every pack carries a license string. [Provenance] classifies it
 * so the UI ships only cleared packs and the legacy Cappi binaries stay local:
 *
 * - LICENSE_SAFE: an explicitly cleared original pack (allowlisted below).
 *   May ship in public artifacts and be the clean-checkout default. An
 *   arbitrary license string is NEVER treated as safe.
 * - LOCAL_PARITY_ONLY: rights unresolved, unknown, or local-only. Loads only
 *   from an explicit local import; never ships, never auto-selected, never
 *   exported.
 */
object CharacterAssets {
    const val CHARACTERS_ROOT = "characters"
    const val LEGACY_CAPPI_DIR = "cappi"
    const val LEGACY_MANIFEST = "cappi/cappi-manifest.json"

    /** In-asset pack descriptor path for a character id (traversal-safe). */
    fun packAssetPath(packId: String): String? {
        if (!isSafePackId(packId)) return null
        return "$CHARACTERS_ROOT/$packId/pack.json"
    }

    /** Asset path for one clip file of a pack; null when either part is unsafe. */
    fun clipAssetPath(packId: String, file: String): String? {
        if (!isSafePackId(packId) || !isSafeAssetName(file)) return null
        return "$CHARACTERS_ROOT/$packId/$file"
    }

    fun assetDir(packId: String): String = "$CHARACTERS_ROOT/$packId"

    fun isSafePackId(packId: String): Boolean =
        packId.isNotEmpty() && packId.length <= 64 && packId.matches(Regex("^[a-z0-9][a-z0-9._-]*$"))

    sealed interface Provenance {
        data object LicenseSafe : Provenance
        data class LocalParityOnly(val reason: String) : Provenance
    }

    /**
     * Explicitly cleared public-safe licenses for original release packs.
     * Anything else — UNRESOLVED markers, unknown strings, empty, or local
     * parity notes — is local-only. Never extend by pattern-matching an
     * arbitrary license string: only these two recognized cleared original
     * licenses (CC0-1.0 for the hand-authored vectors, Apache-2.0 for the
     * owner-approved original Cappi pack) are safe.
     */
    private val PUBLIC_SAFE_LICENSES = setOf("CC0-1.0", "Apache-2.0")

    fun provenanceOf(pack: CharacterPack): Provenance {
        val lic = pack.license.trim()
        if (lic.startsWith("UNRESOLVED") || lic.contains("unresolved", ignoreCase = true)) {
            return Provenance.LocalParityOnly("pack ${pack.packId} license unresolved: $lic")
        }
        if (lic in PUBLIC_SAFE_LICENSES) return Provenance.LicenseSafe
        return Provenance.LocalParityOnly("pack ${pack.packId} license not cleared for public ship: $lic")
    }

    fun canShipPublicly(pack: CharacterPack): Boolean = provenanceOf(pack) is Provenance.LicenseSafe

    /**
     * Generic acquisition/import hook. Validates a candidate pack descriptor
     * against the asset names a source directory actually provides and reports
     * what is missing — without copying, downloading, or inventing rights.
     * Callers (e.g. `characters/import-local.sh`) perform the copy after the
     * operator confirms provenance.
     */
    data class ImportReport(
        val packId: String,
        val valid: Boolean,
        val missingAssets: List<String>,
        val error: String?,
    )

    fun inspectImport(packJson: String, availableAssetNames: Set<String>): ImportReport {
        val pack = try {
            parseCharacterPack(packJson)
        } catch (e: IllegalArgumentException) {
            return ImportReport("?", false, emptyList(), e.message)
        }
        val missing = pack.clips.keys.filter { !availableAssetNames.contains(it) }.sorted()
        return ImportReport(pack.packId, missing.isEmpty(), missing, null)
    }

    /**
     * Lists pack ids present in an asset listing (e.g. AssetManager.list root
     * entries of the form "characters/<id>/pack.json"). Pure function so the
     * selection UI and integration tests share one implementation.
     */
    fun discoverPackIds(assetPaths: List<String>): List<String> {
        return assetPaths.mapNotNull { p ->
            val parts = p.split('/')
            if (parts.size == 3 && parts[0] == CHARACTERS_ROOT && parts[2] == "pack.json" &&
                isSafePackId(parts[1])) parts[1] else null
        }.distinct().sorted()
    }
}

/**
 * A pack bound to its scheduler and asset location. [assetBase] is the
 * in-asset directory holding the pack's clips (`characters/<id>` for role
 * packs, `cappi` for the legacy local-parity import).
 */
data class BoundCharacter(
    val pack: CharacterPack,
    val sched: CharacterScheduler,
    val assetBase: String,
)
