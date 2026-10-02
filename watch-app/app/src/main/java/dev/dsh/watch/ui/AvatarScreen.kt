package dev.dsh.watch.ui

import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import android.content.Context
import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.widget.ImageView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.wear.compose.material.Icon
import dev.dsh.watch.R
import dev.dsh.watch.cappi.BoundCharacter
import dev.dsh.watch.cappi.CappiSnapshot
import dev.dsh.watch.cappi.CappiProgram
import dev.dsh.watch.cappi.CharacterAssets
import dev.dsh.watch.cappi.CharacterScheduler
import dev.dsh.watch.cappi.parseCappiManifest
import dev.dsh.watch.cappi.parseCharacterPack
import dev.dsh.watch.core.Phase
import dev.dsh.watch.core.UiState
import dev.dsh.watch.core.unreviewedQuestions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import androidx.compose.runtime.snapshotFlow

/**
 * Cappi avatar mode: full-round black canvas, Cappi GIF layer, mini mic
 * element, blue queue arc, and full-screen question cue. No status labels or question badge.
 *
 * Character selection is data-driven: [characterId] names a pack under
 * `assets/characters/<id>/pack.json` (see `docs/characters.md`). Null/unknown
 * resolves to the registry default (`cappi-original`, the owner-approved
 * original pack), with `dot-default` as the fallback when Cappi assets are
 * missing or corrupt — so a clean checkout still animates. A saved
 * pre-clearance `"cappi-legacy-local"` selection migrates to `cappi-original`.
 *
 * Touch exit: the avatar canvas owns every tap target (mic, queue arc,
 * question cue) and the route is the nav root, so swipe-back cannot leave it.
 * A touch-hold anywhere on the face reopens Menu, where `Avatar mode · On`
 * toggles back to remote mode. Same outcome as the hardware double-press
 * shortcut; generic Wear OS has no buttons to preserve.
 */
@Composable
fun AvatarScreen(
    state: UiState,
    onMicToggle: () -> Unit,
    onSendOldest: () -> Unit,
    onPending: () -> Unit,
    displayActive: Boolean = true,
    wakeEpoch: Long = 0,
    ambientLowBit: Boolean = false,
    ambientOffsetDp: Float = 0f,
    characterId: String? = null,
    onMenu: () -> Unit = {},
) {
    val context = LocalContext.current
    val bound = remember(context, characterId) {
        loadBoundCharacter(context, characterId)
    }
    val sched = remember(bound, state.sessionId, state.base, state.token) { bound?.sched }
    val unseen = state.unreviewedQuestions

    val latest by androidx.compose.runtime.rememberUpdatedState(CappiSnapshot(
        connected = state.connected && !state.offlineClock,
        phase = if (state.speakingOutput) Phase.SPEAKING else if (state.phase == Phase.SPEAKING) Phase.IDLE else state.phase,
        sessionRunning = state.sessionRunning,
        micOpen = state.micOpen,
        pendingCount = state.pending.size,
        questionAttention = unseen.isNotEmpty(),
        questionIdentity = unseen,
        celebrate = false, // celebrations are explicit model emotes, never stale completion flags
        modelAction = state.cappiAction,
    ))
    val image = remember(context) { ImageView(context).apply {
        setBackgroundColor(android.graphics.Color.BLACK)
        scaleType = ImageView.ScaleType.FIT_CENTER
    } }
    // These describe the ACTUAL displayed drawable, not just pending state.
    // Keep overlay ownership through acknowledgement until a replacement is shown.
    var questionActive by remember(image) { mutableStateOf(false) }
    var questionCompleted by remember(image) { mutableStateOf(false) }
    val displayResume = remember(image) { dev.dsh.watch.cappi.CappiDisplayResume(displayActive, wakeEpoch) }
    // A cancelled IO decode may finish after a replacement owner has started.
    // Its outer finally must never stop the replacement owner's drawable.
    val playbackOwner = remember(image) { java.util.concurrent.atomic.AtomicReference<Any?>() }
    // Clear only when the screen is actually removed, not when speech changes
    // restart the playback coroutine. A stopped drawable keeps its last frame.
    androidx.compose.runtime.DisposableEffect(image) {
        onDispose {
            (image.drawable as? AnimatedImageDrawable)?.stop()
            image.setImageDrawable(null)
        }
    }
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    // State changes while awake still wait for clip boundaries. Display inactivity
    // cancels this owner completely: no animation, decode, or polling while ambient.
    LaunchedEffect(sched, lifecycle, displayActive, wakeEpoch) {
        val owner = Any()
        playbackOwner.set(owner)
        displayResume.observe(displayActive, wakeEpoch)
        if (!displayActive || sched == null) {
            (image.drawable as? AnimatedImageDrawable)?.stop()
            return@LaunchedEffect
        }
        lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) {
            // Fresh/menu-entry avatars baseline the existing wake counter and start
            // neutral. An actual display edge jumps straight to the latest pose.
            val menuReturn = displayResume.isMenuReturnPending
            var wakePending = displayResume.consumeWake()
            val keepQuestion = !menuReturn && sched.canRetainQuestionOnResume(latest,
                active = questionActive, completed = questionCompleted, hasDrawable = image.drawable != null)
            if (!keepQuestion && !wakePending) sched.reset()
            var needsNeutral = !keepQuestion && !wakePending
            var queued = emptyList<String>()
            var queuedQuestion = false
            var previous: CappiSnapshot? = null
            try {
                while (true) {
                    val snapshot = latest.copy(micOpen = false)
                    if (!snapshot.connected) {
                        image.setImageDrawable(null)
                        questionActive = false
                        questionCompleted = false
                        sched.reset()
                        needsNeutral = true
                        queued = emptyList()
                        snapshotFlow { latest.connected }.first { it }
                        continue
                    }
                    // Every GIF finishes before reevaluating speech/work state.
                    // Required look-up/return/put-away clips run in full; no speech
                    // edge cuts props or neutral motion. Audio is not delayed, and
                    // stale speech is not replayed after it ends. Pending stays tappable.
                    if (snapshot != previous) queued = emptyList()
                    if (queued.isEmpty()) {
                        val program = when {
                            wakePending -> {
                                wakePending = false
                                needsNeutral = false
                                sched.wakeProgram(snapshot, retainCompletedQuestion = keepQuestion)
                            }
                            needsNeutral -> {
                                needsNeutral = false
                                CappiProgram(listOf(sched.neutralClip), false)
                            }
                            else -> sched.program(snapshot)
                        }
                        queued = program.clips
                        queuedQuestion = program.questionCue
                    }
                    previous = snapshot
                    if (queued.isEmpty()) {
                        // Question hold: no looping, decoding, polling, or restarting.
                        // Compare equally normalized snapshots so an open mic cannot spin.
                        snapshotFlow { latest.copy(micOpen = false) }.first { it != snapshot }
                        continue
                    }
                    val file = queued.first()
                    val playingQuestion = queuedQuestion
                    queued = queued.drop(1)
                    val clipTarget = bound?.clipTarget(context, file)
                    coroutineScope {
                        val playback = launch {
                            // Compiled vector frames (.xml in res/drawable)
                            // render as drawable resources with pack-driven
                            // hold timing; imported vector assets without a
                            // compiled resource inflate from the asset XML via
                            // parser; GIF packs decode exactly as before.
                            // Missing/unavailable art falls back to the pack's
                            // neutral clip, then waits.
                            if (clipTarget is ClipTarget.Vector) {
                                image.setImageResource(clipTarget.resId)
                                questionActive = playingQuestion
                                questionCompleted = false
                                delay(clipTarget.holdMs)
                                questionCompleted = playingQuestion
                                return@launch
                            }
                            if (clipTarget is ClipTarget.AssetVector) {
                                val inflated = withContext(Dispatchers.IO) {
                                    loadAssetVectorDrawable(context, clipTarget.assetPath)
                                }
                                if (inflated != null) {
                                    image.setImageDrawable(inflated)
                                    questionActive = playingQuestion
                                    questionCompleted = false
                                    delay(clipTarget.holdMs)
                                    questionCompleted = playingQuestion
                                    return@launch
                                }
                                // Unparseable asset XML: fall through to the
                                // neutral fallback below (useful validation,
                                // never a GIF-decoder crash).
                            }
                            val gifPath = (clipTarget as? ClipTarget.Gif)?.assetPath
                                ?: "${bound?.assetBase ?: "cappi"}/$file"
                            val drawable = try {
                                withContext(Dispatchers.IO) {
                                    context.assets.open(gifPath).use { input ->
                                        ImageDecoder.decodeDrawable(ImageDecoder.createSource(
                                            java.nio.ByteBuffer.wrap(input.readBytes())))
                                    }
                                }
                            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                                throw cancelled
                            } catch (_: Exception) {
                                // Corrupt/unavailable motion: try the pack's neutral
                                // clip once, then wait rather than spinning or
                                // crashing the UI.
                                val fallbackShown = bound?.let { b ->
                                    when (val fb = b.neutralFallbackTarget(context)) {
                                        is ClipTarget.Vector -> {
                                            image.setImageResource(fb.resId)
                                            questionActive = playingQuestion
                                            questionCompleted = false
                                            true
                                        }
                                        is ClipTarget.AssetVector -> withContext(Dispatchers.IO) {
                                            loadAssetVectorDrawable(context, fb.assetPath)
                                        }?.let {
                                            image.setImageDrawable(it)
                                            questionActive = playingQuestion
                                            questionCompleted = false
                                            true
                                        } ?: false
                                        is ClipTarget.Gif -> withContext(Dispatchers.IO) {
                                            runCatching { context.assets.open(fb.assetPath).use { input ->
                                                ImageDecoder.decodeDrawable(ImageDecoder.createSource(
                                                    java.nio.ByteBuffer.wrap(input.readBytes())))
                                            } }.getOrNull()
                                        }?.let {
                                            image.setImageDrawable(it)
                                            questionActive = playingQuestion
                                            questionCompleted = false
                                            true
                                        } ?: false
                                        null -> false
                                    }
                                } ?: false
                                delay(3_000)
                                questionCompleted = playingQuestion && fallbackShown
                                return@launch
                            }
                            image.setImageDrawable(drawable)
                            questionActive = playingQuestion
                            questionCompleted = false
                            try {
                                if (file != sched.neutralClip && drawable is AnimatedImageDrawable) {
                                    kotlinx.coroutines.suspendCancellableCoroutine<Unit> { continuation ->
                                        val completion = dev.dsh.watch.cappi.AnimationCompletion {
                                            if (continuation.isActive) continuation.resume(Unit) { _, _, _ -> }
                                        }
                                        val callback = object : android.graphics.drawable.Animatable2.AnimationCallback() {
                                            override fun onAnimationEnd(d: Drawable?) = completion.complete()
                                        }
                                        drawable.repeatCount = 0 // single pass, overriding GIF loop metadata
                                        drawable.registerAnimationCallback(callback)
                                        continuation.invokeOnCancellation {
                                            completion.cancel()
                                            drawable.stop()
                                        }
                                        // Never clear/unregister this drawable's sole callback:
                                        // Wear's posted postOnAnimationEnd runnable dereferences
                                        // the live callback list without a null check. Detaching
                                        // the completion makes late events inert; the stopped
                                        // drawable and tiny callback are collected together.
                                        drawable.start()
                                    }
                                } else delay(3_000) // reference hold, not GIF's 40ms metadata
                                questionCompleted = playingQuestion // never reached on cancellation
                            } finally {
                                (drawable as? AnimatedImageDrawable)?.stop()
                                // Keep final frame visible during the next bounded decode.
                            }
                        }
                        val interrupt = launch {
                            snapshotFlow { latest }.first { sched.shouldInterrupt(file, snapshot, it) }
                            playback.cancelAndJoin()
                        }
                        playback.join()
                        interrupt.cancelAndJoin()
                    }
                }
            } finally {
                if (playbackOwner.get() === owner) (image.drawable as? AnimatedImageDrawable)?.stop()
                // Retain the last frame through lifecycle restarts until replacement;
                // screen disposal and disconnected state clear it.
            }
        }
    }

    val ambientFilter = remember {
        android.graphics.ColorMatrixColorFilter(android.graphics.ColorMatrix().apply { setSaturation(0f) })
    }
    BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black)
        .pointerInput(onMenu) { detectTapGestures(onLongPress = { onMenu() }) }) {
        val diameter = minOf(maxWidth, maxHeight)
        val shift = if (displayActive) 0f else ambientOffsetDp.takeIf { it.isFinite() }?.coerceIn(-4f, 4f) ?: 0f
        AndroidView(
            factory = { image },
            update = { view ->
                // Render attributes only: never restart/decode animation on recomposition.
                view.alpha = if (displayActive) 1f else if (ambientLowBit) 0f else 0.2f
                view.colorFilter = if (displayActive) null else ambientFilter
            },
            modifier = Modifier.align(Alignment.Center).offset(x = shift.dp, y = shift.dp).size(diameter * 0.72f),
        )

        // Remove underlying touch AND accessibility controls while the cue owns the screen.
        if (displayActive && !questionActive) {
            // Small visible mic, adequate 48dp touch target at the top right.
            Box(Modifier.align(Alignment.Center)
                .offset(x = diameter * 0.28f, y = diameter * -0.28f)
                .size(48.dp).clickable(role = Role.Button, onClick = onMicToggle),
                contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_mic),
                    contentDescription = if (state.micOpen) "Turn microphone off" else "Turn microphone on",
                    tint = if (state.micOpen) DshColors.success else DshColors.danger,
                    modifier = Modifier.size(22.dp))
            }
            val queued = state.queue.firstOrNull()
            // Empty queue: no arc and no invisible queue touch/accessibility target.
            // Otherwise the arc follows the bottom-left edge with a larger hit target.
            if (queued != null) {
                androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) {
                    val inset = 3.dp.toPx()
                    drawArc(DshColors.accent.copy(alpha = if (state.connected) 1f else 0.25f),
                        startAngle = 125f, sweepAngle = 30f, useCenter = false,
                        topLeft = androidx.compose.ui.geometry.Offset(inset, inset),
                        size = androidx.compose.ui.geometry.Size(size.width - inset * 2, size.height - inset * 2),
                        style = androidx.compose.ui.graphics.drawscope.Stroke(3.dp.toPx(), cap = androidx.compose.ui.graphics.StrokeCap.Round))
                }
                Box(Modifier.align(Alignment.Center)
                    .offset(x = diameter * -0.32f, y = diameter * 0.28f)
                    .size(48.dp)
                    .semantics { contentDescription = "Send oldest queued message" }
                    .clickable(role = Role.Button, enabled = state.connected, onClick = onSendOldest))
            }
        }
        // Last/topmost sibling: every touch, including former mic/queue locations,
        // opens the same pending menu while the question plays or holds its last frame.
        if (displayActive && questionActive) {
            Box(Modifier.fillMaxSize()
                .semantics { contentDescription = "Open pending questions" }
                .clickable(role = Role.Button, onClick = {
                    displayResume.markMenuOpened()
                    onPending()
                }))
        }
    }
}

/** Render target for one scheduler clip file. */
private sealed interface ClipTarget {
    data class Vector(val resId: Int, val holdMs: Long) : ClipTarget
    data class AssetVector(val assetPath: String, val holdMs: Long) : ClipTarget
    data class Gif(val assetPath: String) : ClipTarget
}

private fun assetExists(context: Context, assetPath: String): Boolean = runCatching {
    context.assets.open(assetPath).use { }
    true
}.getOrDefault(false)

/**
 * Inflate an imported vector asset (no compiled resource) via the XML
 * parser. Returns null with no throw when the asset is missing or not a
 * valid vector — the caller falls back to neutral with a bounded wait.
 *
 * The framework and compat `VectorDrawable` loaders CANNOT inflate raw text
 * streams (both need a binary `XmlBlock` parser; proven on-device — see
 * [dev.dsh.watch.cappi.AssetVectorRenderer]), so import-only asset XML
 * renders through that minimal subset renderer instead.
 */
private fun loadAssetVectorDrawable(context: Context, assetPath: String): android.graphics.drawable.Drawable? {
    return dev.dsh.watch.cappi.AssetVectorRenderer.render(
        context.resources,
        openAsset = { path ->
            runCatching { context.assets.open(path) }.getOrNull()
        },
        assetPath = assetPath,
    )
}

private fun BoundCharacter.clipTarget(context: Context, file: String): ClipTarget {
    return when (val r = dev.dsh.watch.cappi.CharacterClipResolver.resolve(
        pack, file,
        resIdOf = { name -> context.resources.getIdentifier(name, "drawable", context.packageName) },
        assetHas = { path -> assetExists(context, path) },
        assetBase = assetBase,
    )) {
        is dev.dsh.watch.cappi.ClipResolution.CompiledVector -> ClipTarget.Vector(r.resId, r.holdMs)
        is dev.dsh.watch.cappi.ClipResolution.AssetVector -> ClipTarget.AssetVector(r.assetPath, r.holdMs)
        is dev.dsh.watch.cappi.ClipResolution.Gif -> ClipTarget.Gif(r.assetPath)
        // Unsafe name, unknown clip, or vector with neither compiled
        // resource nor asset: point at neutral so decode is never attempted
        // on a bad path; playback falls back with a bounded wait.
        is dev.dsh.watch.cappi.ClipResolution.Missing -> neutralFallbackTarget(context)
            ?: ClipTarget.Gif("$assetBase/$file")
    }
}

private fun BoundCharacter.neutralFallbackTarget(context: Context): ClipTarget? {
    return when (val r = dev.dsh.watch.cappi.CharacterClipResolver.neutralFallback(
        pack, sched,
        resIdOf = { name -> context.resources.getIdentifier(name, "drawable", context.packageName) },
        assetHas = { path -> assetExists(context, path) },
        assetBase = assetBase,
    )) {
        is dev.dsh.watch.cappi.ClipResolution.CompiledVector -> ClipTarget.Vector(r.resId, r.holdMs)
        is dev.dsh.watch.cappi.ClipResolution.AssetVector -> ClipTarget.AssetVector(r.assetPath, r.holdMs)
        is dev.dsh.watch.cappi.ClipResolution.Gif -> ClipTarget.Gif(r.assetPath)
        is dev.dsh.watch.cappi.ClipResolution.Missing, null -> null
    }
}

/**
 * Character loading order. An explicitly requested pack loads on demand; the
 * automatic chain only takes license-safe packs: the registry default
 * (`cappi-original`), then `dot-default` when Cappi assets are missing or
 * corrupt, then any other license-safe pack. A saved pre-clearance
 * `cappi-legacy-local` selection migrates to `cappi-original`.
 */
private fun loadBoundCharacter(context: Context, characterId: String?): BoundCharacter? {
    var safeWant = characterId?.takeIf { CharacterAssets.isSafePackId(it) }
    if (safeWant == "cappi-legacy-local") safeWant = "cappi-original"
    if (safeWant != null) {
        loadAssetPack(context, safeWant, requireLicenseSafe = false)?.let { return it }
    }
    loadAssetPack(context, "cappi-original", requireLicenseSafe = true)?.let { return it }
    loadAssetPack(context, "dot-default", requireLicenseSafe = true)?.let { return it }
    val ids = runCatching {
        context.assets.list(CharacterAssets.CHARACTERS_ROOT)?.toList().orEmpty()
    }.getOrDefault(emptyList())
    for (id in ids.sorted()) {
        if (id == "cappi-original" || id == "dot-default" || id == safeWant) continue
        loadAssetPack(context, id, requireLicenseSafe = true)?.let { return it }
    }
    // Last resort: the pre-clearance local import, if present on this device.
    loadLegacyCappi(context)?.let { return it }
    return null
}

private fun loadAssetPack(context: Context, id: String, requireLicenseSafe: Boolean): BoundCharacter? {
    if (!CharacterAssets.isSafePackId(id)) return null
    val path = CharacterAssets.packAssetPath(id) ?: return null
    val text = runCatching {
        context.assets.open(path).bufferedReader().use { it.readText() }
    }.getOrNull() ?: return null
    val pack = runCatching { parseCharacterPack(text) }.getOrNull() ?: return null
    if (requireLicenseSafe && !CharacterAssets.canShipPublicly(pack)) return null
    val sched = runCatching { CharacterScheduler(pack) }.getOrNull() ?: return null
    return BoundCharacter(pack, sched, CharacterAssets.assetDir(id))
}

/** Legacy local-parity pack: present only after an explicit local import. */
private fun loadLegacyCappi(context: Context): BoundCharacter? {
    val text = runCatching {
        context.assets.open(CharacterAssets.LEGACY_MANIFEST).bufferedReader().use { it.readText() }
    }.getOrNull() ?: return null
    val manifest = runCatching { parseCappiManifest(text) }.getOrNull() ?: return null
    val sched = runCatching { CharacterScheduler.fromLegacy(manifest) }.getOrNull() ?: return null
    return BoundCharacter(sched.pack, sched, CharacterAssets.LEGACY_CAPPI_DIR)
}
