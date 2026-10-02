package dev.dsh.watch.cappi

import dev.dsh.watch.core.Phase
import dev.dsh.watch.core.Approval

/** Display state; SPEAKING means local audio output, not transport activity. */
data class CappiSnapshot(
    val connected: Boolean,
    val phase: Phase,
    val sessionRunning: Boolean,
    val micOpen: Boolean,
    val pendingCount: Int,
    val celebrate: Boolean = false,
    val modelAction: String? = null,
    val questionAttention: Boolean = pendingCount > 0,
    val questionIdentity: Set<Approval> = emptySet(),
)

/** Empty questionCue programs retain the final drawable; they must not redecode it. */
data class CappiProgram(val clips: List<String>, val repeatLast: Boolean, val questionCue: Boolean = false)

/**
 * Pure boundary-driven scheduler. Laptop transitions are emitted one at a time,
 * so a changed snapshot never drops a required exit or replays an enter.
 * Every clip finishes before program() is called again. Speech changes never
 * cut poses: laptop exits/look-up are emitted before the desired talking action.
 * Only disconnect interrupts ordinary awake playback for safety. Explicit display
 * wake may snap via wakeProgram(). work_talk starts/ends in WORK pose.
 */
class CappiScheduler(manifest: CappiManifest) {
    private val actions = manifest.actions.associateBy { it.id }
    private val work = requireAction(manifest, "work", ClipMode.ENTER_LOOP_EXIT, 3)
    // Old packs remain usable through a laptop-exit -> standing-speech fallback.
    private val workTalk = manifest.action("work_talk")?.let {
        requireAction(manifest, "work_talk", ClipMode.ENTER_LOOP_EXIT, 3)
    }
    private val staticHold = requireAction(manifest, "static_hold", ClipMode.HOLD, 1)
    private val question = manifest.action("question")?.let {
        requireAction(manifest, "question", ClipMode.ONCE, 1).also { a ->
            require(!a.modelSelectable) { "question cue must be state-owned" }
        }
    }
    val neutralClip: String get() = staticHold.clips[0]
    private var presentedQuestions: Set<Approval>? = null

    /** UI also requires actual clip completion before preserving this hold over sleep. */
    fun isQuestionHolding(snap: CappiSnapshot): Boolean = snap.connected && snap.questionAttention &&
        presentedQuestions?.containsAll(snap.questionIdentity) == true

    fun canRetainQuestionOnResume(snap: CappiSnapshot, active: Boolean, completed: Boolean,
                                 hasDrawable: Boolean): Boolean =
        active && completed && hasDrawable && isQuestionHolding(snap)
    private val talkChain = listOf("talk2", "talk3", "talk_gesture").map {
        requireAction(manifest, it, ClipMode.ONCE, 1).clips[0]
    }
    private val listenPool = listOf("breath", "breath2", "relaxed").map {
        requireAction(manifest, it, ClipMode.NEUTRAL_LOOP, 1).clips[0]
    }
    private val idlePool = manifest.actions.filter { it.mode == ClipMode.NEUTRAL_LOOP }
        .sortedBy { it.id }.map { it.clips[0] }
        .also { require(it.size >= 3) { "manifest needs at least 3 neutral loops" } }
    private val celebratePool = listOf("dance", "shadow").map {
        requireAction(manifest, it, ClipMode.ONCE, 1).clips[0]
    }
    private enum class LaptopPose { NONE, WORK, TALK }
    private var laptop = LaptopPose.NONE
    private var idleCursor = 0
    private var talkCursor = 0
    private var listenCursor = 0
    private var celebrateCursor = 0

    fun reset() {
        laptop = LaptopPose.NONE
        presentedQuestions = null
        idleCursor = 0
        talkCursor = 0
        listenCursor = 0
        celebrateCursor = 0
    }

    /** Speech starts/stops and work changes wait for the current clip boundary.
     * The UI's completion callback, not a state edge, advances ordinary playback. */
    @Suppress("UNUSED_PARAMETER")
    fun shouldInterrupt(file: String, before: CappiSnapshot, after: CappiSnapshot): Boolean =
        !after.connected

    /** Display wake is an explicit exception to ordinary no-cut pose transitions.
     * Seed the pose of the CURRENT loop so the next awake boundary still exits correctly.
     * Only a completed, still-relevant question drawable may be retained by the caller. */
    fun wakeProgram(snap: CappiSnapshot, retainCompletedQuestion: Boolean = false): CappiProgram {
        if (retainCompletedQuestion && isQuestionHolding(snap)) return program(snap)
        reset()
        if (snap.connected && !snap.questionAttention) {
            if (snap.phase == Phase.SPEAKING) {
                if (snap.sessionRunning && workTalk != null) laptop = LaptopPose.TALK
            } else if (!snap.celebrate) {
                val model = snap.modelAction?.let { actions[it]?.takeIf { a -> a.modelSelectable } }
                val modelOverridesWork = model != null && model.id != work.id &&
                    model.id != "work_talk" && model.mode != ClipMode.ENTER_LOOP_EXIT
                if (model?.id == work.id || (!modelOverridesWork &&
                        (snap.sessionRunning || snap.phase == Phase.THINKING))) laptop = LaptopPose.WORK
            }
        }
        return program(snap)
    }

    fun program(snap: CappiSnapshot): CappiProgram {
        if (!snap.connected) {
            laptop = LaptopPose.NONE
            presentedQuestions = null
            return CappiProgram(emptyList(), false)
        }
        // A question ends in a non-neutral holding pose, with no reverse/exit GIF.
        // Acknowledgement, remote disappearance, or a new card returns to neutral
        // explicitly before normal playback or the next fresh cue.
        if (presentedQuestions != null &&
            (!snap.questionAttention || !presentedQuestions!!.containsAll(snap.questionIdentity))) {
            presentedQuestions = null
            return one(neutralClip)
        }
        // Highest connected priority: speech/model/emotes cannot displace a question.
        if (snap.questionAttention) {
            exitLaptop()?.let { return it }
            if (presentedQuestions == null) {
                presentedQuestions = snap.questionIdentity.toSet()
                return CappiProgram(listOf(question?.clips?.first() ?: neutralClip), false, questionCue = true)
            }
            // Removing one card while others remain does not replay the cue.
            // Prune removed identities so a later reappearance is fresh again.
            presentedQuestions = snap.questionIdentity.toSet()
            return CappiProgram(emptyList(), false, questionCue = true)
        }
        if (snap.phase == Phase.SPEAKING) {
            if (snap.sessionRunning && workTalk != null) return laptopProgram(talking = true)
            // Final response (or old-pack fallback): resolve TALK -> WORK ->
            // neutral before standing speech. Each exit is a full, separate clip.
            return exitLaptop() ?: standingTalk()
        }
        if (snap.celebrate) return exitLaptop() ?: one(celebratePool[celebrateCursor++ % celebratePool.size])
        val model = snap.modelAction?.let { actions[it]?.takeIf { a -> a.modelSelectable } }
        if (model?.id == work.id) return laptopProgram(talking = false)
        // work_talk is state-owned: a model request cannot fake audible speech.
        if (model != null && model.id != "work_talk" && model.mode != ClipMode.ENTER_LOOP_EXIT) {
            return exitLaptop() ?: CappiProgram(model.clips, model.mode == ClipMode.HOLD)
        }
        if (snap.sessionRunning || snap.phase == Phase.THINKING) return laptopProgram(talking = false)
        exitLaptop()?.let { return it }
        if (snap.phase == Phase.HEARING) return one(listenPool[listenCursor++ % listenPool.size])
        if (snap.phase == Phase.ERROR || snap.phase == Phase.MUTED) return one(staticHold.clips[0], true)
        val motion = idlePool[idleCursor++ % idlePool.size]
        return CappiProgram(listOf(motion, staticHold.clips[0]), false)
    }

    private fun laptopProgram(talking: Boolean): CappiProgram = when (laptop) {
        LaptopPose.NONE -> {
            laptop = LaptopPose.WORK
            one(work.clips[0])
        }
        LaptopPose.WORK -> if (talking && workTalk != null) {
            laptop = LaptopPose.TALK
            one(workTalk.clips[0])
        } else one(work.clips[1], true)
        LaptopPose.TALK -> if (talking && workTalk != null) one(workTalk.clips[1], true)
        else {
            laptop = LaptopPose.WORK
            one(requireNotNull(workTalk).clips[2])
        }
    }

    /** TALK -> WORK and WORK -> NONE are separate, unskippable transitions. */
    private fun exitLaptop(): CappiProgram? = when (laptop) {
        LaptopPose.TALK -> {
            laptop = LaptopPose.WORK
            one(requireNotNull(workTalk).clips[2])
        }
        LaptopPose.WORK -> {
            laptop = LaptopPose.NONE
            one(work.clips[2])
        }
        LaptopPose.NONE -> null
    }

    private fun standingTalk(): CappiProgram {
        val chain = talkChain.indices.map { talkChain[(talkCursor + it) % talkChain.size] }
        talkCursor = (talkCursor + 1) % talkChain.size
        return CappiProgram(chain, false)
    }
    private fun one(file: String, repeat: Boolean = false) = CappiProgram(listOf(file), repeat)

    private fun requireAction(manifest: CappiManifest, id: String, mode: ClipMode, clipCount: Int): CappiAction {
        val a = manifest.action(id) ?: throw IllegalArgumentException("manifest lacks action $id")
        require(a.mode == mode) { "action $id must be $mode" }
        require(a.clips.size == clipCount) { "action $id must have $clipCount clips" }
        a.clips.forEach { require(manifest.clips.containsKey(it)) { "missing clip file $it" } }
        return a
    }
}

/** Per-avatar display edge tracker, not a global wake counter consumer.
 * Baseline an existing nonzero epoch on new/menu-entry composition; only a later
 * epoch change or an observed inactive display means a wake for this avatar.
 * Pending wake survives lifecycle STOPPED and is consumed only when playback starts. */
class CappiDisplayResume(initialActive: Boolean, initialEpoch: Long) {
    private var active = initialActive
    private var epoch = initialEpoch
    private var pendingWake = !initialActive
    private var menuReturn = false
    val isMenuReturnPending: Boolean get() = menuReturn

    fun markMenuOpened() {
        // Wear navigation can keep this avatar composed behind the pending menu.
        // Wakes observed there must not replace the explicit neutral menu handoff.
        menuReturn = true
        pendingWake = false
    }

    fun observe(displayActive: Boolean, wakeEpoch: Long) {
        if (!displayActive || wakeEpoch != epoch) pendingWake = true
        active = displayActive
        epoch = wakeEpoch
    }

    fun consumeWake(): Boolean {
        if (!active) return false
        val wake = pendingWake && !menuReturn
        pendingWake = false
        menuReturn = false
        return wake
    }
}
