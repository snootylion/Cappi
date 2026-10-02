package dev.dsh.watch.cappi

/**
 * Character selection + capability publication (pure JVM).
 *
 * This is the single source of character capabilities for the watch UI, the
 * bridge (`POST /watch/cappi` legacy adapter), and plugins: [toBridgeJson]
 * publishes one JSON registry both can consume without duplicating pack
 * knowledge. The legacy `/watch/cappi` action-id contract is preserved as an
 * adapter ([legacyActionIds]); the semantic role contract is preferred for
 * new integrations (see `docs/characters.md`).
 *
 * Selection never throws: null/blank/unknown ids resolve to [default].
 */
class CharacterRegistry(packs: List<CharacterPack>) {
    private val byId: Map<String, CharacterPack>
    private val defaultPack: CharacterPack

    init {
        require(packs.isNotEmpty()) { "character registry needs at least one pack" }
        require(packs.size == packs.map { it.packId }.distinct().size) { "duplicate pack ids" }
        byId = packs.associateBy { it.packId }
        defaultPack = packs.first()
    }

    fun availableIds(): List<String> = byId.keys.sorted()

    fun default(): CharacterPack = defaultPack

    fun select(id: String?): CharacterPack {
        if (id.isNullOrBlank()) return defaultPack
        return byId[id] ?: defaultPack
    }

    fun modelSelectableActions(id: String?): List<String> = select(id).modelSelectableActions()

    /**
     * Legacy adapter: action ids the old `/watch/cappi` contract may request
     * for this character (model-selectable actions only; state-owned cues such
     * as question/work_talk are never exposed here).
     */
    fun legacyActionIds(id: String?): List<String> = modelSelectableActions(id)

    /** Published registry JSON for bridge/plugin consumers. Hand-built to stay dependency-free. */
    fun toBridgeJson(): String {
        val sb = StringBuilder()
        sb.append("{\"schema_version\":2,\"default\":")
        appendJsonString(sb, defaultPack.packId)
        sb.append(",\"legacy_cappi_route\":\"/watch/cappi\",\"watch_stream_route\":\"/watch/stream\",")
        sb.append("\"characters\":[")
        byId.values.sortedBy { it.packId }.forEachIndexed { i, p ->
            if (i > 0) sb.append(',')
            sb.append("{\"id\":")
            appendJsonString(sb, p.packId)
            sb.append(",\"version\":")
            appendJsonString(sb, p.version)
            sb.append(",\"author\":")
            appendJsonString(sb, p.author)
            sb.append(",\"license\":")
            appendJsonString(sb, p.license)
            sb.append(",\"dimensions\":{\"width\":").append(p.width).append(",\"height\":").append(p.height).append('}')
            sb.append(",\"background\":")
            appendJsonString(sb, p.background)
            sb.append(",\"fallback_role\":")
            appendJsonString(sb, p.fallbackRole.key)
            sb.append(",\"roles\":{")
            p.roles.entries.sortedBy { it.key.key }.forEachIndexed { j, (role, ids) ->
                if (j > 0) sb.append(',')
                appendJsonString(sb, role.key)
                sb.append(':')
                appendJsonStringList(sb, ids)
            }
            sb.append("},\"model_selectable\":")
            appendJsonStringList(sb, p.modelSelectableActions())
            sb.append(",\"asset_dir\":")
            appendJsonString(sb, CharacterAssets.assetDir(p.packId))
            sb.append('}')
        }
        sb.append("]}")
        return sb.toString()
    }

    private fun appendJsonString(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) when (c) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
        }
        sb.append('"')
    }

    private fun appendJsonStringList(sb: StringBuilder, items: List<String>) {
        sb.append('[')
        items.forEachIndexed { i, s ->
            if (i > 0) sb.append(',')
            appendJsonString(sb, s)
        }
        sb.append(']')
    }
}
