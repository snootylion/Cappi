package dev.dsh.watch.net

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

/** Limits apply before native bitmap allocation, even for tiny compressed bombs. */
internal object ImageSafety {
    const val MAX_BYTES = 6 * 1024 * 1024
    const val MAX_EDGE = 8192
    const val MAX_PIXELS = 16_000_000L

    fun readBounded(stream: InputStream): ByteArray = stream.use {
        val out = ByteArrayOutputStream()
        val chunk = ByteArray(8192)
        while (true) {
            val n = it.read(chunk, 0, minOf(chunk.size, MAX_BYTES + 1 - out.size()))
            if (n < 0) break
            out.write(chunk, 0, n)
            if (out.size() > MAX_BYTES) throw IOException("Image unavailable: exceeds 6 MiB limit")
        }
        out.toByteArray()
    }

    /** Null = invalid decoder header. Power-of-two sampling stays <=768px max. */
    fun sampleForBounds(width: Int, height: Int, target: Int): Int? {
        if (width <= 0 || height <= 0 || width > MAX_EDGE || height > MAX_EDGE ||
            width.toLong() * height > MAX_PIXELS) return null
        val max = target.coerceIn(1, 768)
        var sample = 1
        while ((width + sample - 1) / sample > max || (height + sample - 1) / sample > max) sample *= 2
        return sample
    }
}
