package dev.dsh.watch.cappi

/**
 * Semantic character roles. The scheduler is driven by these roles — never by
 * hardcoded action ids — so alternate packs work without scheduler edits.
 *
 * - IDLE: neutral looping motion (also the ultimate fallback).
 * - LISTEN: low-energy loops while audio input is live (mic state never
 *   overrides the schedule; this role only styles HEARING/LISTENING).
 * - TALK: audible-output motion, played in rotation while SPEAKING.
 * - WORK / WORK_TALK: foreground-task pose lifecycle (enter/loop/exit).
 *   WORK_TALK is state-owned: only audible speech in a running session
 *   selects it, never a model request.
 * - CELEBRATE: explicit model emotes.
 * - QUESTION: authoritative pending-question cue. State-owned: the model may
 *   never request it; only unreviewed-question state selects it.
 * - NEUTRAL_HOLD: static reference interstitial (holds, repairs, menu entry).
 */
enum class CharacterRole(val key: String) {
    IDLE("idle"),
    LISTEN("listen"),
    TALK("talk"),
    WORK("work"),
    WORK_TALK("work_talk"),
    CELEBRATE("celebrate"),
    QUESTION("question"),
    NEUTRAL_HOLD("neutral_hold"),
    ;

    companion object {
        fun fromKey(key: String): CharacterRole? = values().firstOrNull { it.key == key }
    }
}

/**
 * Versioned, data-driven character pack (schema v2).
 *
 * Dimensions live in the pack (any W/H in range), so packs are not bound to
 * the legacy 98x98 contract. [roles] maps each declared role to action ids in
 * preference order; undeclared non-core roles resolve through [fallbackRole]
 * and ultimately IDLE. [transitions] is an optional explicit graph override:
 * keys and values must reference declared action ids; the scheduler validates
 * but otherwise preserves ordinary boundary-driven completion semantics.
 */
data class CharacterPack(
    val packId: String,
    val version: String,
    val author: String,
    val attribution: String?,
    val license: String,
    val width: Int,
    val height: Int,
    val background: String,
    val actions: List<CappiAction>,
    val clips: Map<String, ClipInfo>,
    val roles: Map<CharacterRole, List<String>>,
    val fallbackRole: CharacterRole,
    val transitions: Map<String, String>,
) {
    fun action(id: String): CappiAction? = actions.firstOrNull { it.id == id }

    /** Ordered clip files for a role, following the fallback chain. */
    fun clipsFor(role: CharacterRole): List<String> {
        val chain = listOf(role, fallbackRole, CharacterRole.IDLE).distinct()
        for (r in chain) {
            val ids = roles[r] ?: continue
            val files = ids.mapNotNull { action(it) }.flatMap { it.clips }
            if (files.isNotEmpty()) return files
        }
        return emptyList()
    }

    /** First action id of a role (or its fallback), or null. */
    fun firstActionId(role: CharacterRole): String? {
        val chain = listOf(role, fallbackRole, CharacterRole.IDLE).distinct()
        for (r in chain) {
            val id = roles[r]?.firstOrNull()
            if (id != null && action(id) != null) return id
        }
        return null
    }

    fun modelSelectableActions(): List<String> = actions.filter { it.modelSelectable }.map { it.id }
}

/** Bare asset filenames only: no directories, no traversal, no absolutes. */
private val SAFE_ASSET_NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*\\.(gif|xml|png|webp)$")
private val SAFE_ACTION_ID = Regex("^[A-Za-z0-9][A-Za-z0-9_-]*$")
private val SAFE_PACK_ID = Regex("^[a-z0-9][a-z0-9._-]*$")

fun isSafeAssetName(name: String): Boolean {
    if (name.isEmpty() || name.length > 128) return false
    if (name.contains("..") || name.contains('/') || name.contains('\\')) return false
    return SAFE_ASSET_NAME.matches(name)
}

/**
 * Parse + validate a schema-v2 character pack. Throws IllegalArgumentException
 * on any malformed, unsafe, or ownership-violating input. Pure JVM.
 */
@Suppress("UNCHECKED_CAST")
fun parseCharacterPack(json: String): CharacterPack {
    val root = MiniJson.parse(json) as? Map<String, Any?>
        ?: throw IllegalArgumentException("character pack root must be an object")
    val schemaVersion = (root["schema_version"] as? Double)?.toInt()
        ?: throw IllegalArgumentException("character pack lacks numeric schema_version")
    require(schemaVersion == 2) { "unsupported character pack schema_version $schemaVersion (want 2)" }

    val packId = root["pack"] as? String ?: throw IllegalArgumentException("character pack lacks id (pack)")
    require(SAFE_PACK_ID.matches(packId)) { "character pack id '$packId' is not a safe id" }
    val version = root["version"] as? String ?: throw IllegalArgumentException("pack $packId lacks version")
    require(version.isNotBlank() && version.length <= 64) { "pack $packId has bad version" }
    val author = root["author"] as? String ?: throw IllegalArgumentException("pack $packId lacks author")
    require(author.isNotBlank()) { "pack $packId has blank author" }
    val license = root["license"] as? String ?: throw IllegalArgumentException("pack $packId lacks license")
    require(license.isNotBlank()) { "pack $packId has blank license" }
    val attribution = root["attribution"] as? String

    val dims = root["dimensions"] as? Map<String, Any?>
        ?: throw IllegalArgumentException("pack $packId lacks dimensions")
    val width = (dims["width"] as? Double)?.toInt()
        ?: throw IllegalArgumentException("pack $packId lacks numeric dimensions.width")
    val height = (dims["height"] as? Double)?.toInt()
        ?: throw IllegalArgumentException("pack $packId lacks numeric dimensions.height")
    require(width in 16..1024 && height in 16..1024) {
        "pack $packId dimensions ${width}x$height outside 16..1024"
    }
    val background = (root["background"] as? String) ?: "#000000"

    val clipsRaw = root["clips"] as? Map<String, Any?>
        ?: throw IllegalArgumentException("pack $packId lacks clips")
    require(clipsRaw.isNotEmpty()) { "pack $packId has no clips" }
    val clips = clipsRaw.map { (name, v) ->
        require(isSafeAssetName(name)) { "pack $packId clip name '$name' is unsafe (bare filename required)" }
        val o = v as? Map<String, Any?> ?: throw IllegalArgumentException("pack $packId bad clip $name")
        val w = (o["width"] as? Double)?.toInt()
        val h = (o["height"] as? Double)?.toInt()
        require(w == width && h == height) {
            "pack $packId clip $name is ${w}x$h, pack declares ${width}x$height"
        }
        name to ClipInfo(file = name, durationS = (o["duration_s"] as? Double) ?: 0.0)
    }.toMap()

    val actionsRaw = root["actions"] as? List<Any?>
        ?: throw IllegalArgumentException("pack $packId lacks actions")
    require(actionsRaw.isNotEmpty()) { "pack $packId has no actions" }
    val actions = actionsRaw.map { a ->
        val o = a as? Map<String, Any?> ?: throw IllegalArgumentException("pack $packId bad action")
        val id = o["id"] as? String ?: throw IllegalArgumentException("pack $packId action lacks id")
        require(SAFE_ACTION_ID.matches(id)) { "pack $packId action id '$id' is unsafe" }
        val mode = when (o["mode"] as? String) {
            "once" -> ClipMode.ONCE
            "neutral_loop" -> ClipMode.NEUTRAL_LOOP
            "enter_loop_exit" -> ClipMode.ENTER_LOOP_EXIT
            "hold" -> ClipMode.HOLD
            else -> throw IllegalArgumentException("pack $packId action $id has unknown mode")
        }
        val files = (o["clips"] as? List<Any?>)
            ?.map { it as? String ?: throw IllegalArgumentException("pack $packId bad clip ref in $id") }
            ?: throw IllegalArgumentException("pack $packId action $id lacks clips")
        require(files.isNotEmpty()) { "pack $packId action $id has no clips" }
        files.forEach {
            require(isSafeAssetName(it)) { "pack $packId action $id clip ref '$it' is unsafe" }
            require(clips.containsKey(it)) { "pack $packId action $id references missing clip $it" }
        }
        if (mode == ClipMode.ENTER_LOOP_EXIT) require(files.size == 3) {
            "pack $packId action $id must be [enter, loop, exit]"
        }
        CappiAction(
            id = id,
            mode = mode,
            clips = files,
            modelSelectable = (o["model_selectable"] as? Boolean) ?: false,
        )
    }
    require(actions.size == actions.map { it.id }.distinct().size) {
        "pack $packId has duplicate action ids"
    }
    val byId = actions.associateBy { it.id }

    val rolesRaw = root["roles"] as? Map<String, Any?>
        ?: throw IllegalArgumentException("pack $packId lacks roles")
    val roles = LinkedHashMap<CharacterRole, List<String>>()
    for ((key, v) in rolesRaw) {
        val role = CharacterRole.fromKey(key)
            ?: throw IllegalArgumentException("pack $packId has unknown role '$key'")
        val ids = (v as? List<Any?>)
            ?.map { it as? String ?: throw IllegalArgumentException("pack $packId bad action ref in role $key") }
            ?: throw IllegalArgumentException("pack $packId role $key must list action ids")
        require(ids.isNotEmpty()) { "pack $packId role $key has no actions" }
        ids.forEach { require(byId.containsKey(it)) { "pack $packId role $key references unknown action $it" } }
        require(!roles.containsKey(role)) { "pack $packId duplicates role $key" }
        roles[role] = ids.toList()
    }
    require(roles.containsKey(CharacterRole.IDLE)) { "pack $packId must declare role 'idle'" }
    // Required contracts (the scheduler cannot fallback these): idle needs
    // >=3 clips, work must be enter/loop/exit [enter, loop, exit], and
    // neutral_hold must be a single-clip hold. All other roles are optional
    // and resolve through fallback_role, ultimately idle.
    require(roles.containsKey(CharacterRole.WORK)) { "pack $packId must declare role 'work' (enter/loop/exit)" }
    require(roles.containsKey(CharacterRole.NEUTRAL_HOLD)) { "pack $packId must declare role 'neutral_hold' (hold)" }
    run {
        val workId = roles[CharacterRole.WORK]!!.firstOrNull()
            ?: throw IllegalArgumentException("pack $packId role work has no actions")
        val workAction = byId[workId]
            ?: throw IllegalArgumentException("pack $packId role work references unknown action $workId")
        require(workAction.mode == ClipMode.ENTER_LOOP_EXIT && workAction.clips.size == 3) {
            "pack $packId role work action $workId must be enter/loop/exit [enter, loop, exit]"
        }
        val holdId = roles[CharacterRole.NEUTRAL_HOLD]!!.firstOrNull()
            ?: throw IllegalArgumentException("pack $packId role neutral_hold has no actions")
        val holdAction = byId[holdId]
            ?: throw IllegalArgumentException("pack $packId role neutral_hold references unknown action $holdId")
        require(holdAction.mode == ClipMode.HOLD && holdAction.clips.size == 1) {
            "pack $packId role neutral_hold action $holdId must be a single-clip hold"
        }
        val idleClips = roles[CharacterRole.IDLE]!!.mapNotNull { byId[it] }.flatMap { it.clips }
        require(idleClips.size >= 3) {
            "pack $packId role idle needs at least 3 clips (got ${idleClips.size})"
        }
    }
    val fallbackKey = root["fallback_role"] as? String
        ?: throw IllegalArgumentException("pack $packId lacks fallback_role")
    val fallbackRole = CharacterRole.fromKey(fallbackKey)
        ?: throw IllegalArgumentException("pack $packId has unknown fallback_role '$fallbackKey'")
    require(roles.containsKey(fallbackRole)) { "pack $packId fallback_role '$fallbackKey' is not a declared role" }

    // Ownership invariants: state-owned roles may never be model-requestable.
    // A pack that lets the model cue questions or fake work-talk speech is rejected.
    for (role in listOf(CharacterRole.QUESTION, CharacterRole.WORK_TALK)) {
        roles[role]?.forEach { id ->
            require(byId[id]?.modelSelectable != true) {
                "pack $packId role '${role.key}' action $id must be state-owned (model_selectable=false)"
            }
        }
    }

    val transitionsRaw = (root["transitions"] as? Map<String, Any?>) ?: emptyMap()
    val transitions = LinkedHashMap<String, String>()
    for ((from, toAny) in transitionsRaw) {
        val to = toAny as? String ?: throw IllegalArgumentException("pack $packId bad transition target for $from")
        require(byId.containsKey(from)) { "pack $packId transition from unknown action $from" }
        require(byId.containsKey(to)) { "pack $packId transition to unknown action $to" }
        transitions[from] = to
    }

    return CharacterPack(
        packId = packId,
        version = version,
        author = author,
        attribution = attribution,
        license = license,
        width = width,
        height = height,
        background = background,
        actions = actions,
        clips = clips,
        roles = roles,
        fallbackRole = fallbackRole,
        transitions = transitions,
    )
}

/**
 * Legacy migration: schema-v1 Cappi manifest (hardcoded action ids, fixed
 * 98x98 contract) -> schema-v2 role pack. The role assignments below are the
 * exact sets the legacy [CappiScheduler] hardcodes, so scheduling behavior is
 * preserved bit-for-bit through the facade. The rights holder confirmed
 * ownership and approved Apache-2.0 release, so the migrated canonical pack
 * (`cappi-original`, byte-identical to `characters/cappi-original/pack.json`)
 * is license-safe and the clean-checkout default. A previously saved
 * `cappi-legacy-local` selection migrates to `cappi-original`
 * (see [dev.dsh.watch.core.CharacterSelection]).
 */
fun migrateLegacyManifest(manifest: CappiManifest): CharacterPack {
    fun requireLegacy(id: String): String {
        require(manifest.action(id) != null) { "legacy manifest lacks action $id" }
        return id
    }
    val idleIds = manifest.actions.filter { it.mode == ClipMode.NEUTRAL_LOOP }.sortedBy { it.id }.map { it.id }
    require(idleIds.size >= 3) { "legacy manifest needs at least 3 neutral loops" }
    val roles = linkedMapOf(
        CharacterRole.IDLE to idleIds,
        CharacterRole.LISTEN to listOf("breath", "breath2", "relaxed").map(::requireLegacy),
        CharacterRole.TALK to listOf("talk2", "talk3", "talk_gesture").map(::requireLegacy),
        CharacterRole.WORK to listOf(requireLegacy("work")),
        CharacterRole.CELEBRATE to listOf("dance", "shadow").map(::requireLegacy),
        CharacterRole.QUESTION to listOf(requireLegacy("question")),
        CharacterRole.NEUTRAL_HOLD to listOf(requireLegacy("static_hold")),
    )
    if (manifest.action("work_talk") != null) roles[CharacterRole.WORK_TALK] = listOf("work_talk")
    val firstClip = manifest.clips.values.firstOrNull()
    return CharacterPack(
        packId = "cappi-original",
        version = "1.0.0",
        author = "wear-dsh release contributors",
        attribution = "Original Cappi character art; rights holder confirmed ownership and approved Apache-2.0 release. Third-party SDKs and model weights retain their own terms.",
        license = "Apache-2.0",
        width = 98,
        height = 98,
        background = "#000000",
        actions = manifest.actions,
        clips = manifest.clips,
        roles = roles,
        fallbackRole = CharacterRole.IDLE,
        transitions = emptyMap(),
    ).also { require(firstClip != null) { "legacy manifest has no clips" } }
}
