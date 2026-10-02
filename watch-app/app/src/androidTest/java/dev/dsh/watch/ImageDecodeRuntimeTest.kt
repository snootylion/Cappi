package dev.dsh.watch

import android.graphics.Bitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.dsh.watch.ui.ImageCache
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ImageDecodeRuntimeTest {
    @Test fun nativeDecoderBoundsBeforeAllocationAndSampledImage() {
        val source = Bitmap.createBitmap(1600, 900, Bitmap.Config.ARGB_8888)
        val out = java.io.ByteArrayOutputStream()
        assertTrue(source.compress(Bitmap.CompressFormat.PNG, 100, out))
        source.recycle()
        val bytes = out.toByteArray()
        val decoded = ImageCache.decodeSampled(bytes, 480)
        assertNotNull(decoded)
        assertTrue(decoded!!.width <= 480 && decoded.height <= 480)
        assertTrue(decoded.allocationByteCount < 1024 * 1024)
        decoded.recycle()
        val bomb = bytes.copyOf()
        // Real PNG IHDR declares enormous dimensions in a small compressed body.
        for (offset in listOf(16, 20)) {
            bomb[offset] = 0x7f; bomb[offset + 1] = 0xff.toByte()
            bomb[offset + 2] = 0xff.toByte(); bomb[offset + 3] = 0xff.toByte()
        }
        assertNull(ImageCache.decodeSampled(bomb, 480))
        assertNull(ImageCache.decodeSampled(byteArrayOf(0, 1, 2), 480))
    }
}
