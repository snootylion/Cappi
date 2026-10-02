package dev.dsh.watch.core

import dev.dsh.watch.cappi.CharacterPack
import dev.dsh.watch.cappi.CharacterRole
import org.json.JSONObject

/**
 * Character-selection source of truth (question collaborator owns the local
 * choice; the bridge only advertises capabilities).
 *
 * - The local selection is user-owned and persisted (`character_id`). The
 *   bridge never changes it silently: an incoming `t:'character'` event is
 *   observed (mismatch surfaced), never applied.
 * - The watch advertises its choice to the bridge with
 *   `POST /watch/command {cmd:'character-select', characterId,
 *   registryVersion}` and re-advertises on every hello/reconnect. The server
 *   answers `{ok:true, characterId}`.
 * - Model `cappiAction` ids are translated per active pack ([resolveModelAction]):
 *   exact pack ids win; legacy/semantic aliases map through roles so an old
 *   model cue (e.g. `dance`) still animates on a new pack instead of being
 *   ignored. State-owned roles (`question`, `work_talk`) never resolve from a
 *   model request.
 */
object CharacterSelection {

    const val PREF_KEY = "character_id"
    const val DEFAULT_ID = "cappi-original"
    /** Pre-clearance local id: saved selections migrate to the canonical pack. */
    const val LEGACY_LOCAL_ID = "cappi-legacy-local"
    /** Corrupt/missing Cappi fallback: the license-safe hand-authored pack. */
    const val FALLBACK_ID = "dot-default"
    const val REGISTRY_VERSION = 2

    /** Legacy + cross-pack semantic aliases → role. Pack-exact ids always win first. */
    private val aliasToRole: Map<String, CharacterRole> = buildMap {
        // Legacy bridge allowlist (bridge/cappi.mjs) → roles.
        for (id in listOf("idle1_a", "idle1_b", "idle1_c", "idle1_d", "idle2_a", "idle2_b", "idle2_c", "idle2_d", "idle2_e")) {
            put(id, CharacterRole.IDLE)
        }
        put("breath", CharacterRole.LISTEN)
        put("breath2", CharacterRole.LISTEN)
        put("relaxed", CharacterRole.LISTEN)
        put("talk2", CharacterRole.TALK)
        put("talk3", CharacterRole.TALK)
        put("talk_gesture", CharacterRole.TALK)
        put("work", CharacterRole.WORK)
        put("work_talk", CharacterRole.WORK_TALK)
        put("dance", CharacterRole.CELEBRATE)
        put("shadow", CharacterRole.CELEBRATE)
        put("question", CharacterRole.QUESTION)
        put("static_hold", CharacterRole.NEUTRAL_HOLD)
        // Cross-pack semantic aliases: dot-default <-> ember-min.
        put("idle_a", CharacterRole.IDLE)
        put("idle_b", CharacterRole.IDLE)
        put("idle_c", CharacterRole.IDLE)
        put("listen", CharacterRole.LISTEN)
        put("talk", CharacterRole.TALK)
        put("talk_a", CharacterRole.TALK)
        put("talk_b", CharacterRole.TALK)
        put("work_set", CharacterRole.WORK)
        put("celebrate", CharacterRole.CELEBRATE)
    }

    fun sanitizeId(id: String?): String {
        var t = id?.trim().orEmpty()
        if (t == LEGACY_LOCAL_ID) t = DEFAULT_ID // pre-clearance saves migrate forward
        if (t.isEmpty()) return DEFAULT_ID
        if (!t.matches(Regex("^[a-z0-9][a-z0-9._-]*$"))) return DEFAULT_ID
        return t
    }

    /**
     * Translate a model-requested action id to this pack's playable action id,
     * or null when it must be ignored (unknown, state-owned, or non-selectable).
     */
    fun resolveModelAction(pack: CharacterPack, requested: String?): String? {
        if (requested.isNullOrEmpty() || requested == "clear") return null
        val byId = pack.actions.associateBy { it.id }
        // Exact pack id wins when the pack marks it model-selectable.
        val exact = byId[requested]
        if (exact != null) {
            return if (exact.modelSelectable) exact.id else null
        }
        // Alias → role → this pack's first model-selectable action for the role.
        val role = aliasToRole[requested] ?: return null
        if (role == CharacterRole.QUESTION || role == CharacterRole.WORK_TALK) return null
        val candidates = pack.roles[role].orEmpty()
        for (id in candidates) {
            val a = byId[id] ?: continue
            if (a.modelSelectable) return a.id
        }
        // Role fallback chain (pack-declared fallback, then idle) for sparse packs.
        for (fallback in listOf(pack.fallbackRole, CharacterRole.IDLE).distinct()) {
            if (fallback == role) continue
            for (id in pack.roles[fallback].orEmpty()) {
                val a = byId[id] ?: continue
                if (a.modelSelectable) return a.id
            }
        }
        return null
    }

    /** Command body advertising the local choice. */
    fun selectCommand(characterId: String): JSONObject = JSONObject()
        .put("cmd", "character-select")
        .put("characterId", sanitizeId(characterId))
        .put("registryVersion", REGISTRY_VERSION)
}
