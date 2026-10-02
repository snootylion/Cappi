package dev.dsh.watch.cappi

import dev.dsh.watch.core.Phase
import dev.dsh.watch.core.Approval

/**
 * Data-driven character scheduler. Same boundary-driven semantics as the
 * legacy [CappiScheduler] — one transition clip at a time, every clip
 * finishes before re-evaluation, speech never cuts poses, only disconnect
 * interrupts, question holds are authoritative — but every action set resolves
 * through [CharacterPack] roles instead of hardcoded action ids.
 *
 * Compatibility: [fromLegacy] migrates a schema-v1 manifest to the canonical
 * legacy role pack, and [parityWith] lets tests prove the facade preserves
 * legacy scheduling over scripted snapshot sequences.
 */
class CharacterScheduler(val pack: CharacterPack) {
    private val actions = pack.actions.associateBy { it.id }

    /** Strict declared-role lookup (no fallback): optional roles resolve null. */
    private fun roleAction(role: CharacterRole, mode: ClipMode, clipCount: Int): CappiAction? {
        val id = pack.roles[role]?.firstOrNull() ?: return null
        val a = actions[id] ?: return null
        require(a.mode == mode) { "pack ${pack.packId} role ${role.key} action $id must be $mode" }
        require(a.clips.size == clipCount) { "pack ${pack.packId} role ${role.key} action $id must have $clipCount clips" }
        return a
    }

    private val work = requireNotNull(roleAction(CharacterRole.WORK, ClipMode.ENTER_LOOP_EXIT, 3)) {
        "pack ${pack.packId} must declare a work enter/loop/exit action"
    }
    // Packs without work_talk fall back to the standing-speech path, exactly
    // like old packs that lacked the action.
    private val workTalk = roleAction(CharacterRole.WORK_TALK, ClipMode.ENTER_LOOP_EXIT, 3)
    private val staticHold = requireNotNull(roleAction(CharacterRole.NEUTRAL_HOLD, ClipMode.HOLD, 1)) {
        "pack ${pack.packId} must declare a neutral_hold action"
    }
    private val question = roleAction(CharacterRole.QUESTION, ClipMode.ONCE, 1)?.also { a ->
        require(!a.modelSelectable) { "question cue must be state-owned" }
    }

    val neutralClip: String get() = staticHold.clips[0]
    private var presentedQuestions: Set<Approval>? = null

    /** UI also requires actual clip completion before preserving this hold over sleep. */
    fun isQuestionHolding(snap: CappiSnapshot): Boolean = snap.connected && snap.questionAttention &&
        presentedQuestions?.containsAll(snap.questionIdentity) == true

    fun canRetainQuestionOnResume(snap: CappiSnapshot, active: Boolean, completed: Boolean,
                                 hasDrawable: Boolean): Boolean =
        active && completed && hasDrawable && isQuestionHolding(snap)

    /** Talk chain: role TALK expanded to clips, rotating start offset per program. */
    private val talkChain: List<String> = pack.clipsFor(CharacterRole.TALK)
        .also { require(it.isNotEmpty()) { "pack ${pack.packId} role talk resolves to no clips" } }
    private val listenPool: List<String> = pack.clipsFor(CharacterRole.LISTEN)
        .also { require(it.isNotEmpty()) { "pack ${pack.packId} role listen resolves to no clips" } }
    private val idlePool: List<String> = pack.clipsFor(CharacterRole.IDLE)
        .also { require(it.size >= 3) { "pack ${pack.packId} role idle needs at least 3 clips" } }
    private val celebratePool: List<String> = pack.clipsFor(CharacterRole.CELEBRATE)
        .also { require(it.isNotEmpty()) { "pack ${pack.packId} role celebrate resolves to no clips" } }

    private enum class WorkPose { NONE, WORK, TALK }
    private var pose = WorkPose.NONE
    private var idleCursor = 0
    private var talkCursor = 0
    private var listenCursor = 0
    private var celebrateCursor = 0

    fun reset() {
        pose = WorkPose.NONE
        presentedQuestions = null
        idleCursor = 0
        talkCursor = 0
        listenCursor = 0
        celebrateCursor = 0
    }

    @Suppress("UNUSED_PARAMETER")
    fun shouldInterrupt(file: String, before: CappiSnapshot, after: CappiSnapshot): Boolean =
        !after.connected

    fun wakeProgram(snap: CappiSnapshot, retainCompletedQuestion: Boolean = false): CappiProgram {
        if (retainCompletedQuestion && isQuestionHolding(snap)) return program(snap)
        reset()
        if (snap.connected && !snap.questionAttention) {
            if (snap.phase == Phase.SPEAKING) {
                if (snap.sessionRunning && workTalk != null) pose = WorkPose.TALK
            } else if (!snap.celebrate) {
                val model = snap.modelAction?.let { actions[it]?.takeIf { a -> a.modelSelectable } }
                val modelOverridesWork = model != null && model.id != work.id &&
                    model.id != workTalk?.id && model.mode != ClipMode.ENTER_LOOP_EXIT
                if (model?.id == work.id || (!modelOverridesWork &&
                        (snap.sessionRunning || snap.phase == Phase.THINKING))) pose = WorkPose.WORK
            }
        }
        return program(snap)
    }

    fun program(snap: CappiSnapshot): CappiProgram {
        if (!snap.connected) {
            pose = WorkPose.NONE
            presentedQuestions = null
            return CappiProgram(emptyList(), false)
        }
        if (presentedQuestions != null &&
            (!snap.questionAttention || !presentedQuestions!!.containsAll(snap.questionIdentity))) {
            presentedQuestions = null
            return one(neutralClip)
        }
        if (snap.questionAttention) {
            exitWork()?.let { return it }
            if (presentedQuestions == null) {
                presentedQuestions = snap.questionIdentity.toSet()
                return CappiProgram(listOf(question?.clips?.first() ?: neutralClip), false, questionCue = true)
            }
            presentedQuestions = snap.questionIdentity.toSet()
            return CappiProgram(emptyList(), false, questionCue = true)
        }
        if (snap.phase == Phase.SPEAKING) {
            if (snap.sessionRunning && workTalk != null) return workProgram(talking = true)
            return exitWork() ?: standingTalk()
        }
        if (snap.celebrate) return exitWork() ?: one(celebratePool[celebrateCursor++ % celebratePool.size])
        val model = snap.modelAction?.let { actions[it]?.takeIf { a -> a.modelSelectable } }
        if (model?.id == work.id) return workProgram(talking = false)
        // work_talk is state-owned: a model request cannot fake audible speech.
        if (model != null && model.id != workTalk?.id && model.mode != ClipMode.ENTER_LOOP_EXIT) {
            return exitWork() ?: CappiProgram(model.clips, model.mode == ClipMode.HOLD)
        }
        if (snap.sessionRunning || snap.phase == Phase.THINKING) return workProgram(talking = false)
        exitWork()?.let { return it }
        if (snap.phase == Phase.HEARING) return one(listenPool[listenCursor++ % listenPool.size])
        if (snap.phase == Phase.ERROR || snap.phase == Phase.MUTED) return one(staticHold.clips[0], true)
        val motion = idlePool[idleCursor++ % idlePool.size]
        return CappiProgram(listOf(motion, staticHold.clips[0]), false)
    }

    private fun workProgram(talking: Boolean): CappiProgram = when (pose) {
        WorkPose.NONE -> {
            pose = WorkPose.WORK
            one(work.clips[0])
        }
        WorkPose.WORK -> if (talking && workTalk != null) {
            pose = WorkPose.TALK
            one(workTalk.clips[0])
        } else one(work.clips[1], true)
        WorkPose.TALK -> if (talking && workTalk != null) one(workTalk.clips[1], true)
        else {
            pose = WorkPose.WORK
            one(requireNotNull(workTalk).clips[2])
        }
    }

    private fun exitWork(): CappiProgram? = when (pose) {
        WorkPose.TALK -> {
            pose = WorkPose.WORK
            one(requireNotNull(workTalk).clips[2])
        }
        WorkPose.WORK -> {
            pose = WorkPose.NONE
            one(work.clips[2])
        }
        WorkPose.NONE -> null
    }

    private fun standingTalk(): CappiProgram {
        val chain = talkChain.indices.map { talkChain[(talkCursor + it) % talkChain.size] }
        talkCursor = (talkCursor + 1) % talkChain.size
        return CappiProgram(chain, false)
    }

    private fun one(file: String, repeat: Boolean = false) = CappiProgram(listOf(file), repeat)

    companion object {
        /** Compatibility facade entry: legacy manifest behaves exactly as before. */
        fun fromLegacy(manifest: CappiManifest): CharacterScheduler =
            CharacterScheduler(migrateLegacyManifest(manifest))
    }
}
