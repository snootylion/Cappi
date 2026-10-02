package dev.dsh.watch.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Text
import dev.dsh.watch.core.ImageItem
import kotlin.math.roundToInt

/**
 * Crown zoom 1–8×, drag pan (clamped), double-tap 1×/4×, [↗ Open] opens the
 * image on the Mac via the authenticated command channel ({cmd:'open-mac',
 * imageRef} — no token in any URL), ✕ exits. Bottom: "i/n".
 */
@Composable
fun ImageDetailScreen(
    images: List<ImageItem>,
    index: Int,
    fetch: suspend (String) -> ByteArray?,
    onOpenMac: (ref: String) -> Unit,
    onExit: () -> Unit,
    openMacSupported: Boolean = true,
) {
    val item = images.getOrNull(index)
    if (item == null) {
        MissingImage()
        return
    }

    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var viewport by remember { mutableStateOf(Offset.Zero) }
    val focusRequester = remember { FocusRequester() }

    val bmp = ImageCache.fullImage(item.ref)
    LaunchedEffect(item.ref) { ImageCache.loadFull(item.ref) { fetch(item.ref) } }

    // Take focus so the crown's rotary events reach this screen.
    LaunchedEffect(Unit) {
        try {
            focusRequester.requestFocus()
        } catch (_: Exception) {
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .focusRequester(focusRequester)
            .focusable()
            .onSizeChanged { viewport = Offset(it.width.toFloat(), it.height.toFloat()) }
            .onRotaryScrollEvent { event ->
                scale = (scale + event.verticalScrollPixels * 0.01f).coerceIn(1f, 8f)
                if (scale == 1f) offset = Offset.Zero
                true
            }
            .pointerInput(item.ref) {
                detectTapGestures(
                    onDoubleTap = {
                        if (scale > 1f) {
                            scale = 1f
                            offset = Offset.Zero
                        } else {
                            scale = 4f
                        }
                    },
                )
            }
            .pointerInput(item.ref) {
                detectDragGestures(
                    onDragStart = { },
                    onDrag = { _, dragAmount ->
                        if (scale > 1f) {
                            offset = clampOffset(offset + dragAmount, scale, bmp, viewport)
                        }
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        if (bmp != null) {
            Image(
                bitmap = bmp.asImageBitmap(),
                contentDescription = item.label,
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = offset.x
                        translationY = offset.y
                    },
            )
        } else {
            DshEmpty(if (ImageCache.isUnavailable(item.ref)) "Image unavailable or too large" else "Loading…")
        }

        // Top-right controls
        Row(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .fillMaxWidth()
                .padding(top = 14.dp, end = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End),
        ) {
            if (openMacSupported) MiniButton("↗") { onOpenMac(item.ref) }
            MiniButton("✕") { onExit() }
        }

        // Bottom indicator
        Text(
            text = "${index + 1}/${images.size}",
            style = DshType.secondary.copy(color = DshColors.textPrimary.copy(alpha = 0.8f)),
            maxLines = 1,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 18.dp),
        )
    }
}

@Composable
private fun MissingImage() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        DshEmpty("No image")
    }
}

@Composable
private fun MiniButton(label: String, onClick: () -> Unit) {
    DshIconButton(onClick = onClick) {
        Text(text = label, style = DshType.label, maxLines = 1)
    }
}

private fun clampOffset(current: Offset, scale: Float, bmp: Bitmap?, viewport: Offset): Offset {
    if (bmp == null || viewport.x <= 0f || viewport.y <= 0f) return Offset.Zero
    // Scaled content size keeps aspect ratio (ContentScale.Fit behavior approximated
    // by fitting the bitmap into the viewport at `scale`).
    val fit = minOf(viewport.x / bmp.width, viewport.y / bmp.height)
    val w = bmp.width * fit * scale
    val h = bmp.height * fit * scale
    val maxX = ((w - viewport.x) / 2f).coerceAtLeast(0f)
    val maxY = ((h - viewport.y) / 2f).coerceAtLeast(0f)
    return Offset(current.x.coerceIn(-maxX, maxX), current.y.coerceIn(-maxY, maxY))
}
