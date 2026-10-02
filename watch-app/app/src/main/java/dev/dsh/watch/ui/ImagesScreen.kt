package dev.dsh.watch.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text
import dev.dsh.watch.core.ImageItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Shared thumbnail cache: ref → decoded bitmap (inSampleSize targeting ~120px). */
object ImageCache {
    private val thumbs = mutableStateMapOf<String, Bitmap>()
    private val full = mutableStateMapOf<String, Bitmap>()
    private val inFlight = mutableSetOf<String>()
    private val unavailable = mutableStateMapOf<String, Boolean>()
    fun isUnavailable(ref: String): Boolean = unavailable[ref] == true

    fun thumb(ref: String): Bitmap? = thumbs[ref]
    fun fullImage(ref: String): Bitmap? = full[ref]

    suspend fun loadThumb(ref: String, fetch: suspend () -> ByteArray?) {
        if (thumbs.containsKey(ref) || ref in inFlight) return
        inFlight.add(ref)
        try {
            val bytes = withContext(Dispatchers.IO) { fetch() } ?: run { unavailable[ref] = true; return }
            val bmp = withContext(Dispatchers.IO) { decodeSampled(bytes, TARGET) } ?: run { unavailable[ref] = true; return }
            unavailable.remove(ref)
            thumbs[ref] = bmp
        } finally {
            inFlight.remove(ref)
        }
    }

    suspend fun loadFull(ref: String, fetch: suspend () -> ByteArray?) {
        if (full.containsKey(ref)) return
        val bytes = withContext(Dispatchers.IO) { fetch() } ?: run { unavailable[ref] = true; return }
        val bmp = withContext(Dispatchers.IO) { decodeSampled(bytes, FULL_TARGET) } ?: run { unavailable[ref] = true; return }
        unavailable.remove(ref)
        full[ref] = bmp
    }

    private const val TARGET = 120
    private const val FULL_TARGET = 480

    internal fun decodeSampled(bytes: ByteArray, target: Int): Bitmap? {
        if (bytes.size > dev.dsh.watch.net.ImageSafety.MAX_BYTES) return null
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        val sample = dev.dsh.watch.net.ImageSafety.sampleForBounds(opts.outWidth, opts.outHeight, target) ?: return null
        val dec = BitmapFactory.Options().apply { inSampleSize = sample }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, dec)
    }
}

/**
 * Grid of ≤2-thumbnail rows. Each row is a ScalingLazyColumn item; tapping a thumb
 * opens image/{index}.
 */
@Composable
fun ImagesScreen(images: List<ImageItem>, fetch: suspend (String) -> ByteArray?, onOpen: (Int) -> Unit) {
    val listState = rememberScalingLazyListState()

    LaunchedEffect(images.size) {
        images.forEach { ImageCache.loadThumb(it.ref) { fetch(it.ref) } }
    }

    if (images.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            DshEmpty("No images yet")
        }
        return
    }

    val rows = images.chunked(2)
    ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxWidth()) {
        items(rows.size) { r ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
            ) {
                rows[r].forEachIndexed { c, item ->
                    val index = r * 2 + c
                    Thumbnail(item, index, fetch, onOpen)
                }
                if (rows[r].size == 1) {
                    Spacer60()
                }
            }
        }
    }
}

@Composable
private fun Spacer60() {
    Box(modifier = Modifier.size(60.dp))
}

@Composable
private fun Thumbnail(
    item: ImageItem,
    index: Int,
    fetch: suspend (String) -> ByteArray?,
    onOpen: (Int) -> Unit,
) {
    val bmp = ImageCache.thumb(item.ref)
    LaunchedEffect(item.ref) { ImageCache.loadThumb(item.ref) { fetch(item.ref) } }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.clickable { onOpen(index) },
    ) {
        Box(
            modifier = Modifier
                .size(60.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(DshColors.surfaceHigh),
            contentAlignment = Alignment.Center,
        ) {
            if (bmp != null) {
                Image(
                    bitmap = bmp.asImageBitmap(),
                    contentDescription = item.label,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Text(
                    text = if (ImageCache.isUnavailable(item.ref)) "!" else "…",
                    style = DshType.display.copy(color = DshColors.textTertiary),
                    maxLines = 1,
                )
            }
        }
        if (item.label.isNotEmpty()) {
            Text(
                text = item.label,
                style = DshType.caption,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
