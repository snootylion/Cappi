package dev.dsh.watch.probe

import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import dev.dsh.watch.R
import dev.dsh.watch.cappi.CappiSnapshot
import dev.dsh.watch.cappi.CharacterAssets
import dev.dsh.watch.cappi.CharacterClipResolver
import dev.dsh.watch.cappi.CharacterPack
import dev.dsh.watch.cappi.CharacterScheduler
import dev.dsh.watch.cappi.ClipResolution
import dev.dsh.watch.cappi.parseCharacterPack
import dev.dsh.watch.core.Approval
import dev.dsh.watch.core.ApprovalOption
import dev.dsh.watch.core.Phase
import dev.dsh.watch.core.UiState
import dev.dsh.watch.ui.AvatarScreen

/**
 * Debug-only avatar render probe (Role X instrumented validation).
 *
 * Renders the REAL [AvatarScreen] with a synthetic, test-owned [UiState] —
 * never the process [dev.dsh.watch.core.BridgeViewModel], never the App SSE
 * pipeline, never live bridge traffic. Driven by intent extras so one debug
 * APK covers every evidence snapshot:
 *
 * - `probe_character`: pack id (`cappi-original`, `dot-default`, `ember-min`,
 *   debug-only `import-probe`, or a bogus id such as `missing-pack` to prove
 *   the missing-asset fallback). ABSENT extra passes null to [AvatarScreen]
 *   (the true production default path → registry default `cappi-original`).
 *   Null/unknown resolves exactly as production
 *   does (default pack), because the same [AvatarScreen] loader runs.
 * - `probe_snapshot`: `idle` (connected/listening), `speaking` (connected +
 *   audible output), or `question` (connected + one unreviewed ask card).
 * - `probe_overlay`: when false, hides the diagnostics strip so host-side
 *   `screencap` captures the pure renderer output.
 *
 * On-device diagnostics (same resolver inputs the renderer uses: real
 * `Resources.getIdentifier`, real `AssetManager`) are logged to logcat under
 * [TAG] and mirrored into a platform TextView (`R.id.probe_status`) that
 * UiAutomator asserts on — Compose nodes are invisible to UiAutomator, so a
 * real Android view carries the machine-readable verdict.
 *
 * Debug source set only: absent from release builds and clean-checkout
 * release artifacts.
 */
class AvatarRenderProbeActivity : ComponentActivity() {

    data class ProbeDiagnostics(
        val loadedPackId: String,
        val lines: List<String>,
        val summary: String,
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val hasCharExtra = intent.hasExtra(EXTRA_CHARACTER)
        val requestedExtra = intent.getStringExtra(EXTRA_CHARACTER)
        // Absent extra exercises the true production default: null reaches
        // AvatarScreen exactly as a fresh install with no saved choice does.
        val screenChar: String? = if (hasCharExtra) requestedExtra else null
        val requested = requestedExtra ?: "cappi-original"
        val snapshot = intent.getStringExtra(EXTRA_SNAPSHOT) ?: "idle"
        val overlay = intent.getBooleanExtra(EXTRA_OVERLAY, true)
        val state = syntheticState(screenChar ?: "cappi-original", snapshot)
        val diag = diagnose(requested, snapshot)
        Log.i(TAG, "probe extras hasChar=$hasCharExtra requested=$requested snapshot=$snapshot")
        for (line in diag.lines) Log.i(TAG, line)
        Log.i(TAG, "summary character=$requested snapshot=$snapshot loadedPack=${diag.loadedPackId} ${diag.summary}")
        setContent {
            Box(Modifier.fillMaxSize().background(Color.Black)) {
                AvatarScreen(
                    state = state,
                    characterId = screenChar,
                    displayActive = true,
                    onMicToggle = {},
                    onSendOldest = {},
                    onPending = {},
                )
            }
        }
        if (overlay) {
            val strip = TextView(this).apply {
                id = R.id.probe_status
                text = diag.summary
                setTextColor(0xFFFFFFFF.toInt())
                setBackgroundColor(0x80000000.toInt())
                textSize = 9f
            }
            addContentView(
                strip,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.TOP,
                ),
            )
        }
    }

    /** Synthetic connected snapshots; unpaired base so nothing can dial out. */
    private fun syntheticState(characterId: String, snapshot: String): UiState {
        val question = Approval(
            id = "probe-q1",
            kind = "ask",
            title = "Probe question",
            detail = "Synthetic pending card for render validation",
            options = listOf(ApprovalOption("yes", "Yes"), ApprovalOption("no", "No")),
            multi = false,
        )
        return when (snapshot) {
            "speaking" -> UiState(
                base = "", token = "",
                connected = true, offlineClock = false,
                phase = Phase.SPEAKING, speakingOutput = true,
                sessionRunning = true, characterId = characterId,
            )
            "question" -> UiState(
                base = "", token = "",
                connected = true, offlineClock = false,
                phase = Phase.LISTENING,
                pending = listOf(question), characterId = characterId,
            )
            else -> UiState(
                base = "", token = "",
                connected = true, offlineClock = false,
                phase = Phase.LISTENING, characterId = characterId,
            )
        }
    }

    /**
     * Resolves the requested pack and its first scheduled program with the
     * exact inputs [AvatarScreen] feeds [CharacterClipResolver] on this
     * device (compiled-resource lookup + asset existence). Mirrors the
     * production load order: explicit pack, then `cappi-original`, then
     * `dot-default`, then any other license-safe pack.
     */
    private fun diagnose(requested: String, snapshot: String): ProbeDiagnostics {
        val lines = arrayListOf<String>()
        val loaded = loadProbePack(requested, lines) ?: return ProbeDiagnostics(
            loadedPackId = "<none>",
            lines = lines,
            summary = "probe req=$requested snap=$snapshot pack=<none> target=Missing reason=no-pack-loaded",
        )
        val sched = runCatching { CharacterScheduler(loaded) }.getOrNull()
        if (sched == null) {
            lines += "probe pack=${loaded.packId} scheduler-init=FAILED"
            return ProbeDiagnostics(
                loadedPackId = loaded.packId,
                lines = lines,
                summary = "probe req=$requested snap=$snapshot pack=${loaded.packId} target=Missing reason=scheduler-init-failed",
            )
        }
        val snap = when (snapshot) {
            "speaking" -> CappiSnapshot(
                connected = true, phase = Phase.SPEAKING, sessionRunning = true,
                micOpen = false, pendingCount = 0,
            )
            "question" -> CappiSnapshot(
                connected = true, phase = Phase.LISTENING, sessionRunning = false,
                micOpen = false, pendingCount = 1, questionAttention = true,
                questionIdentity = setOf(
                    Approval(
                        id = "probe-q1", kind = "ask", title = "Probe question",
                        detail = null, options = listOf(ApprovalOption("yes", "Yes")),
                        multi = false,
                    ),
                ),
            )
            else -> CappiSnapshot(
                connected = true, phase = Phase.LISTENING, sessionRunning = false,
                micOpen = false, pendingCount = 0,
            )
        }
        val program = runCatching { sched.reset(); sched.program(snap) }.getOrNull()
        val clips = program?.clips.orEmpty()
        lines += "probe pack=${loaded.packId} neutral=${sched.neutralClip} " +
            "program=[${clips.joinToString(",")}] questionCue=${program?.questionCue}"
        val assetBase = CharacterAssets.assetDir(loaded.packId)
        var first: ClipResolution? = null
        for (file in clips.ifEmpty { listOf(sched.neutralClip) }) {
            val r = CharacterClipResolver.resolve(
                loaded, file,
                resIdOf = { name ->
                    runCatching {
                        resources.getIdentifier(name, "drawable", packageName)
                    }.getOrDefault(0)
                },
                assetHas = { path ->
                    runCatching { assets.open(path).use { }; true }.getOrDefault(false)
                },
                assetBase = assetBase,
            )
            if (first == null) first = r
            lines += "probe pack=${loaded.packId} clip=$file target=${describe(r)}"
        }
        val summary = "probe req=$requested snap=$snapshot pack=${loaded.packId} " +
            "neutral=${sched.neutralClip} program=[${clips.joinToString(",")}] " +
            "questionCue=${program?.questionCue} target=${describe(first)}"
        return ProbeDiagnostics(loaded.packId, lines, summary)
    }

    private fun loadProbePack(requested: String, lines: MutableList<String>): CharacterPack? {
        val safeWant = requested.takeIf { CharacterAssets.isSafePackId(it) }
        if (safeWant != null) {
            loadAssetPack(safeWant)?.let {
                if (safeWant != it.packId) lines += "probe req=$requested loaded=${it.packId} (pack-id-mismatch)"
                return it
            }
            lines += "probe req=$requested asset-miss (no loadable pack at ${CharacterAssets.packAssetPath(safeWant)})"
        } else {
            lines += "probe req=$requested unsafe-id (falls through to default)"
        }
        loadAssetPack("cappi-original")?.let {
            lines += "probe fallback pack=cappi-original"
            return it
        }
        loadAssetPack("dot-default")?.let {
            lines += "probe fallback pack=dot-default"
            return it
        }
        val ids = runCatching {
            assets.list(CharacterAssets.CHARACTERS_ROOT)?.toList().orEmpty()
        }.getOrDefault(emptyList())
        for (id in ids.sorted()) {
            if (id == "cappi-original" || id == "dot-default" || id == safeWant) continue
            loadAssetPack(id)?.let {
                if (CharacterAssets.canShipPublicly(it)) {
                    lines += "probe fallback pack=${it.packId}"
                    return it
                }
            }
        }
        lines += "probe NO pack loaded"
        return null
    }

    private fun loadAssetPack(id: String): CharacterPack? {
        if (!CharacterAssets.isSafePackId(id)) return null
        val path = CharacterAssets.packAssetPath(id) ?: return null
        val text = runCatching {
            assets.open(path).bufferedReader().use { it.readText() }
        }.getOrNull() ?: return null
        return runCatching { parseCharacterPack(text) }.getOrNull()
    }

    private fun describe(r: ClipResolution?): String = when (r) {
        is ClipResolution.CompiledVector -> "CompiledVector(res=0x${r.resId.toString(16)} holdMs=${r.holdMs})"
        is ClipResolution.AssetVector -> "AssetVector(path=${r.assetPath} holdMs=${r.holdMs})"
        is ClipResolution.Gif -> "Gif(path=${r.assetPath})"
        is ClipResolution.Missing -> "Missing(reason=${r.reason})"
        null -> "Missing(reason=no-program)"
    }

    companion object {
        const val TAG = "AvatarProbe"
        const val EXTRA_CHARACTER = "probe_character"
        const val EXTRA_SNAPSHOT = "probe_snapshot"
        const val EXTRA_OVERLAY = "probe_overlay"
    }
}
