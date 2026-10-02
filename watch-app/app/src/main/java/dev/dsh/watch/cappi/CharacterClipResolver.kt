package dev.dsh.watch.cappi

/**
 * Pure clip-target resolution for character packs (no Android imports, so
 * unit tests exercise the same decisions the UI enforces).
 *
 * Compiled drawable resources (res/drawable vector XML) are preferred for
 * `.xml` vectors via `getIdentifier`. Imported vector assets that have no
 * compiled resource must NOT be fed to the GIF decoder: they resolve to
 * [ClipResolution.AssetVector] so the UI inflates them with an XML parser
 * ([android.graphics.drawable.VectorDrawable.createFromXml]) or falls back
 * to neutral with a useful reason. Anything unsafe or absent resolves to
 * [ClipResolution.Missing] with a human-readable reason instead of a
 * decoder crash or silent spin.
 */
sealed interface ClipResolution {
    data class CompiledVector(val resId: Int, val holdMs: Long) : ClipResolution
    data class AssetVector(val assetPath: String, val holdMs: Long) : ClipResolution
    data class Gif(val assetPath: String) : ClipResolution
    data class Missing(val reason: String) : ClipResolution
}

object CharacterClipResolver {

    fun holdMs(pack: CharacterPack, file: String): Long =
        ((pack.clips[file]?.durationS ?: 3.0) * 1000).toLong().coerceIn(500, 10_000)

    /**
     * Resolve one scheduler clip file.
     *
     * @param resIdOf maps a drawable name (file without `.xml`) to a compiled
     *   resource id, or 0 when absent (i.e. `Resources.getIdentifier`).
     * @param assetHas true when the asset path exists in the pack's asset dir.
     * @param assetBase e.g. `characters/dot-default`.
     */
    fun resolve(
        pack: CharacterPack,
        file: String,
        resIdOf: (String) -> Int,
        assetHas: (String) -> Boolean,
        assetBase: String,
    ): ClipResolution {
        if (!isSafeAssetName(file)) {
            return ClipResolution.Missing("unsafe clip name '$file' (bare filename required)")
        }
        if (!pack.clips.containsKey(file)) {
            return ClipResolution.Missing("clip '$file' not in pack '${pack.packId}' clips table")
        }
        if (file.endsWith(".xml")) {
            val resId = runCatching { resIdOf(file.removeSuffix(".xml")) }.getOrDefault(0)
            if (resId != 0) return ClipResolution.CompiledVector(resId, holdMs(pack, file))
            val assetPath = "$assetBase/$file"
            if (assetHas(assetPath)) return ClipResolution.AssetVector(assetPath, holdMs(pack, file))
            return ClipResolution.Missing(
                "vector '$file' has no compiled drawable and no asset at '$assetPath'",
            )
        }
        val assetPath = "$assetBase/$file"
        if (assetHas(assetPath)) return ClipResolution.Gif(assetPath)
        return ClipResolution.Missing("asset missing at '$assetPath'")
    }

    /** Neutral-clip fallback through the same rules (null when even neutral is unresolvable). */
    fun neutralFallback(
        pack: CharacterPack,
        sched: CharacterScheduler,
        resIdOf: (String) -> Int,
        assetHas: (String) -> Boolean,
        assetBase: String,
    ): ClipResolution? {
        return when (val r = resolve(pack, sched.neutralClip, resIdOf, assetHas, assetBase)) {
            is ClipResolution.Missing -> null
            else -> r
        }
    }
}
