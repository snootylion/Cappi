package dev.dsh.watch

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Role X instrumented render validation: the REAL [dev.dsh.watch.ui.AvatarScreen]
 * (same composable, same vector/asset/missing-fallback loader as production)
 * renders on Android for both shipped packs, the debug-only imported-asset
 * pack, and a missing pack — driven by the debug-only, test-owned
 * `AvatarRenderProbeActivity` with synthetic [dev.dsh.watch.core.UiState]
 * snapshots. No [dev.dsh.watch.core.BridgeViewModel], no App SSE pipeline,
 * no live bridge traffic (synthetic states use a blank unpaired base and the
 * probe never constructs a ViewModel).
 *
 * Machine-readable verdicts come from the probe's platform status strip
 * (`probe_status`, computed on-device with real Resources/AssetManager) plus
 * a real `android.widget.ImageView` hosted by the renderer. Host-side
 * `screencap` captures (REPORT-CA evidence) show the same pixels, sampled
 * twice per state so animation (differing frames) is proven, not assumed.
 */
@RunWith(AndroidJUnit4::class)
class AvatarRenderProbeTest {

    private val pkg = "dev.dsh.watch"
    private val probe = "dev.dsh.watch.probe.AvatarRenderProbeActivity"

    private fun device(): UiDevice =
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    private fun launch(character: String, snapshot: String, overlay: Boolean = true): UiDevice {
        val d = device()
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent().apply {
            setClassName(pkg, probe)
            putExtra("probe_character", character)
            putExtra("probe_snapshot", snapshot)
            putExtra("probe_overlay", overlay)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
        ctx.startActivity(intent)
        return d
    }

    /**
     * True production default path: no `probe_character` extra, so null
     * reaches AvatarScreen exactly as a fresh install with no saved choice.
     */
    private fun launchDefault(snapshot: String, overlay: Boolean = true): UiDevice {
        val d = device()
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent().apply {
            setClassName(pkg, probe)
            putExtra("probe_snapshot", snapshot)
            putExtra("probe_overlay", overlay)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
        ctx.startActivity(intent)
        return d
    }

    private fun statusText(d: UiDevice): String {
        // Headless swiftshader emulators can raise a transient System UI ANR
        // that steals window focus from the probe; waiting it out (Wait, never
        // Close) keeps the renderer in the foreground.
        var node = d.wait(Until.findObject(By.res(pkg, "probe_status")), 10_000)
        if (node == null) {
            dismissSystemAnr(d)
            node = d.wait(Until.findObject(By.res(pkg, "probe_status")), 15_000)
        }
        assertNotNull("probe status strip never appeared", node)
        return node.text.orEmpty()
    }

    private fun dismissSystemAnr(d: UiDevice) {
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            if (d.hasObject(By.res(pkg, "probe_status"))) return
            val wait = d.findObject(By.text("Wait"))
            if (wait != null) {
                runCatching { wait.click() }
                d.waitForIdle(2_000)
            } else {
                d.waitForIdle(1_000)
            }
        }
    }

    private fun assertRendererAlive(d: UiDevice) {
        // The real AvatarScreen hosts its frames in a platform ImageView.
        dismissSystemAnr(d)
        val image = d.wait(Until.findObject(By.clazz("android.widget.ImageView")), 15_000)
        assertNotNull("renderer ImageView never appeared", image)
        assertEquals("probe lost foreground to a crash/system dialog", pkg, d.currentPackageName)
    }

    @Test fun dotDefaultIdleRendersCompiledVector() {
        val d = launch("dot-default", "idle")
        val status = statusText(d)
        assertTrue("expected dot-default pack, got: $status", status.contains("pack=dot-default"))
        assertTrue("expected compiled-vector target, got: $status", status.contains("target=CompiledVector(res=0x"))
        assertRendererAlive(d)
    }

    @Test fun emberMinSpeakingRendersCompiledVector() {
        val d = launch("ember-min", "speaking")
        val status = statusText(d)
        assertTrue("expected ember-min pack, got: $status", status.contains("pack=ember-min"))
        assertTrue("expected compiled-vector target, got: $status", status.contains("target=CompiledVector(res=0x"))
        assertRendererAlive(d)
    }

    @Test fun cappiOriginalDefaultIdleRendersGif() {
        // The clean-checkout default pack is the owner-approved original art:
        // real GIF bytes through the pre-existing ImageDecoder path (never a
        // silently substituted vector redraw — filenames/actions preserved).
        val d = launch("cappi-original", "idle")
        val status = statusText(d)
        assertTrue("expected cappi-original pack, got: $status", status.contains("pack=cappi-original"))
        assertTrue(
            "expected GIF target for original art, got: $status",
            status.contains("target=Gif(path=characters/cappi-original/"),
        )
        assertRendererAlive(d)
    }

    @Test fun defaultSelectionResolvesToCappiOriginal() {
        // No character extra → null reaches AvatarScreen (fresh-install path):
        // the registry default (cappi-original GIF) must render, never dot.
        val d = launchDefault("idle")
        val status = statusText(d)
        assertTrue("expected default cappi-original pack, got: $status", status.contains("pack=cappi-original"))
        assertTrue(
            "expected default GIF target, got: $status",
            status.contains("target=Gif(path=characters/cappi-original/"),
        )
        assertRendererAlive(d)
    }

    @Test fun cappiOriginalSpeakingRendersGifStateDriven() {
        // Audible-output state on the GIF pack stays on the GIF path with a
        // live renderer (speech styles the schedule; it never swaps artwork).
        val d = launch("cappi-original", "speaking")
        val status = statusText(d)
        assertTrue("expected cappi-original pack, got: $status", status.contains("pack=cappi-original"))
        assertTrue(
            "expected GIF target while speaking, got: $status",
            status.contains("target=Gif(path=characters/cappi-original/"),
        )
        assertRendererAlive(d)
    }

    @Test fun cappiOriginalQuestionSelectsQuestionCue() {
        // Pending-question state owns the cue on the original pack too: the
        // state-owned question.gif plays, never a model-requestable clip.
        val d = launch("cappi-original", "question")
        val status = statusText(d)
        assertTrue("expected question cue program, got: $status", status.contains("questionCue=true"))
        assertTrue("expected original question clip, got: $status", status.contains("question.gif"))
        assertRendererAlive(d)
    }

    @Test fun cappiOriginalGifIsAnimated() {
        // The shipped GIF bytes must actually animate: Movie duration > 0
        // proves multiple frames (a silently substituted static redraw would
        // report 0). Dimensions must match the pack contract (98x98).
        val inst = InstrumentationRegistry.getInstrumentation()
        val ctx = inst.targetContext
        val text = ctx.assets.open("characters/cappi-original/pack.json").bufferedReader().use { it.readText() }
        val pack = dev.dsh.watch.cappi.parseCharacterPack(text)
        assertEquals("cappi-original", pack.packId)
        val sched = dev.dsh.watch.cappi.CharacterScheduler(pack)
        val snap = dev.dsh.watch.cappi.CappiSnapshot(
            connected = true, phase = dev.dsh.watch.core.Phase.LISTENING,
            sessionRunning = false, micOpen = false, pendingCount = 0,
        )
        val program = runCatching { sched.reset(); sched.program(snap) }.getOrNull()
        assertNotNull("idle program must exist", program)
        val clips = requireNotNull(program).clips
        assertTrue("idle program must be non-empty", clips.isNotEmpty())
        for (file in listOf(clips.first(), "question.gif").distinct()) {
            assertTrue("expected GIF clip, got: $file", file.endsWith(".gif"))
            ctx.assets.open("characters/cappi-original/$file").use { input ->
                val movie = android.graphics.Movie.decodeStream(input)
                assertNotNull("GIF must decode: $file", movie)
                val m = requireNotNull(movie)
                assertEquals("width must match pack contract: $file", 98, m.width())
                assertEquals("height must match pack contract: $file", 98, m.height())
                assertTrue("GIF must animate (duration>0): $file", m.duration() > 0)
            }
        }
    }

    @Test fun questionSnapshotSelectsQuestionCue() {
        val d = launch("dot-default", "question")
        val status = statusText(d)
        assertTrue("expected question cue program, got: $status", status.contains("questionCue=true"))
        assertTrue("expected question clip, got: $status", status.contains("dot_question.xml"))
        assertRendererAlive(d)
    }

    @Test fun importedAssetVectorInflatesFromRuntimeXml() {
        // import-probe vectors exist ONLY as asset XML (no compiled drawable):
        // the renderer must take the AssetVector inflation path, never the GIF
        // decoder, and still host a live ImageView.
        val d = launch("import-probe", "idle")
        val status = statusText(d)
        assertTrue("expected import-probe pack, got: $status", status.contains("pack=import-probe"))
        assertTrue(
            "expected asset-vector target for import-only XML, got: $status",
            status.contains("target=AssetVector(path=characters/import-probe/"),
        )
        assertRendererAlive(d)
    }

    @Test fun importedAssetXmlRendersThroughSubsetRenderer() {
        // Import-only vectors (raw asset text, no compiled drawable) cannot
        // inflate through the framework OR compat VectorDrawable loaders —
        // both require a binary XmlBlock parser (ClassCastException proven
        // on-device). AvatarScreen renders them through AssetVectorRenderer
        // instead; this runs that REAL renderer against the real asset bytes
        // and asserts actual pixels: probe_idle_a is a #4D4D4D square on a
        // 64x64 viewport, so its center must be that fill.
        val inst = InstrumentationRegistry.getInstrumentation()
        val ctx = inst.targetContext
        val drawable = dev.dsh.watch.cappi.AssetVectorRenderer.render(
            ctx.resources,
            openAsset = { path -> ctx.assets.open(path) },
            assetPath = "characters/import-probe/probe_idle_a.xml",
        )
        assertNotNull("subset renderer must handle the probe vector", drawable)
        requireNotNull(drawable) { "subset renderer must handle the probe vector" }
        assertTrue(
            "rendered import must be sized",
            drawable.intrinsicWidth > 0 && drawable.intrinsicHeight > 0,
        )
        val bitmap = android.graphics.Bitmap.createBitmap(
            drawable.intrinsicWidth, drawable.intrinsicHeight,
            android.graphics.Bitmap.Config.ARGB_8888,
        )
        drawable.setBounds(0, 0, bitmap.width, bitmap.height)
        drawable.draw(android.graphics.Canvas(bitmap))
        val cx = bitmap.width / 2
        val cy = bitmap.height / 2
        val pixel = bitmap.getPixel(cx, cy)
        assertEquals("center pixel must be the probe fill", 0xFF4D4D4D.toInt(), pixel)
        // Garbage in, safe out: malformed XML and non-vector content refuse
        // (null) instead of misrendering — the UI falls back to neutral.
        assertEquals(
            null,
            dev.dsh.watch.cappi.AssetVectorRenderer.render(
                ctx.resources,
                openAsset = { path -> ctx.assets.open(path) },
                assetPath = "characters/dot-default/pack.json",
            ),
        )
    }

    @Test fun missingPackFallsBackToDefaultSafely() {
        val d = launch("missing-pack", "idle")
        val status = statusText(d)
        assertTrue("expected fallback to cappi-original, got: $status", status.contains("pack=cappi-original"))
        assertTrue("expected asset-miss note in log-backed summary path, got: $status", status.contains("req=missing-pack"))
        assertRendererAlive(d)
    }
}
