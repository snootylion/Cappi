package dev.dsh.watch.cappi

import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import androidx.core.graphics.PathParser
import org.xmlpull.v1.XmlPullParser

/**
 * Minimal runtime renderer for imported (asset-only) vector XML (Role X).
 *
 * Why this exists: neither the framework
 * (`VectorDrawable.createFromXml`) nor the compat
 * (`VectorDrawableCompat.createFromXmlInner`) loader can inflate a raw text
 * XML stream — both resolve styled attributes through `Resources`, which
 * requires a binary `XmlBlock` parser and throws `ClassCastException` on a
 * text pull parser (proven on-device, Android 15). Compiled `res/drawable`
 * vectors are unaffected and keep the framework path; only the import-only
 * branch (no compiled resource, asset XML present) renders here.
 *
 * Supported subset (deliberately small, strictly validated):
 * `<vector viewportWidth/Height>` (16..1024), nested `<group>` with
 * translate/rotate/scale (+ pivots), `<path>` with `fillColor`/`fillAlpha`
 * and `strokeColor`/`strokeWidth`/`strokeAlpha`/`strokeLineCap`/`strokeLineJoin`.
 * Anything outside the subset (gradients, `clip-path` — which would
 * over-render if ignored — unknown render-affecting content) returns null
 * and the caller falls back to the pack's neutral clip with a bounded wait.
 * Never throws: all failures (missing asset, malformed XML, bad colors,
 * bad path data, oversized viewport) yield null.
 */
object AssetVectorRenderer {

    /** Render [assetPath] from [assets] to a sized drawable, or null. */
    fun render(
        resources: Resources,
        openAsset: (String) -> java.io.InputStream?,
        assetPath: String,
    ): Drawable? {
        val stream = try {
            openAsset(assetPath)
        } catch (_: Exception) {
            null
        } ?: return null
        return try {
            stream.use { input ->
                val parser = android.util.Xml.newPullParser()
                parser.setInput(input, "UTF-8")
                var type = parser.eventType
                while (type != XmlPullParser.START_TAG && type != XmlPullParser.END_DOCUMENT) {
                    type = parser.next()
                }
                renderVector(resources, parser)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun renderVector(resources: Resources, parser: XmlPullParser): Drawable? {
        if (parser.eventType != XmlPullParser.START_TAG || parser.name != "vector") return null
        val vw = attrFloat(parser, "viewportWidth") ?: return null
        val vh = attrFloat(parser, "viewportHeight") ?: return null
        if (!vw.isFinite() || !vh.isFinite() || vw < 16 || vh < 16 || vw > 1024 || vh > 1024) return null
        // Render above viewport resolution so upscaling stays smooth; bounded.
        val scale = (256f / maxOf(vw, vh)).coerceIn(1f, 8f)
        val bitmap = Bitmap.createBitmap(
            (vw * scale).toInt().coerceAtLeast(1),
            (vh * scale).toInt().coerceAtLeast(1),
            Bitmap.Config.ARGB_8888,
        )
        val canvas = Canvas(bitmap)
        canvas.scale(scale, scale)
        val matrixStack = ArrayDeque<Matrix>().apply { add(Matrix()) }
        val depth = parser.depth
        while (true) {
            val type = parser.next()
            if (type == XmlPullParser.END_DOCUMENT) break
            if (type == XmlPullParser.END_TAG && parser.depth < depth + 1) break
            if (type == XmlPullParser.END_TAG && parser.name == "group") {
                if (matrixStack.size > 1) matrixStack.removeLast()
                continue
            }
            if (type != XmlPullParser.START_TAG) continue
            when (parser.name) {
                "group" -> {
                    val parent = matrixStack.last()
                    matrixStack.add(applyGroup(parent, parser) ?: return null)
                }
                "path" -> {
                    if (!drawPath(canvas, matrixStack.last(), parser)) return null
                }
                else -> return null // clip-path, gradients, anything unknown: refuse, don't misrender
            }
        }
        return BitmapDrawable(resources, bitmap)
    }

    private fun applyGroup(parent: Matrix, parser: XmlPullParser): Matrix? {
        // Mirror VectorDrawable group semantics: unpivot, scale, rotate, repivot+translate.
        val tx = attrFloat(parser, "translateX") ?: 0f
        val ty = attrFloat(parser, "translateY") ?: 0f
        val sx = attrFloat(parser, "scaleX") ?: 1f
        val sy = attrFloat(parser, "scaleY") ?: 1f
        val rot = attrFloat(parser, "rotation") ?: 0f
        val px = attrFloat(parser, "pivotX") ?: 0f
        val py = attrFloat(parser, "pivotY") ?: 0f
        for (v in listOf(tx, ty, sx, sy, rot, px, py)) if (!v.isFinite()) return null
        val local = Matrix()
        local.preTranslate(-px, -py)
        local.preScale(sx, sy)
        local.preRotate(rot)
        local.preTranslate(px + tx, py + ty)
        return Matrix(parent).apply { preConcat(local) }
    }

    private fun drawPath(canvas: Canvas, matrix: Matrix, parser: XmlPullParser): Boolean {
        val pathData = parser.getAttributeValue(null, "pathData") ?: return false
        val path = try {
            PathParser.createPathFromPathData(pathData)
        } catch (_: Exception) {
            return false
        }
        path.transform(matrix)
        val fillColor = parser.getAttributeValue(null, "fillColor")
        if (fillColor != null) {
            val fillAlpha = attrFloat(parser, "fillAlpha") ?: 1f
            if (!fillAlpha.isFinite()) return false
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.FILL
                try {
                    color = Color.parseColor(fillColor)
                } catch (_: IllegalArgumentException) {
                    return false
                }
                alpha = (alpha * fillAlpha.coerceIn(0f, 1f)).toInt()
            }
            canvas.drawPath(path, paint)
        }
        val strokeColor = parser.getAttributeValue(null, "strokeColor")
        if (strokeColor != null) {
            val strokeWidth = attrFloat(parser, "strokeWidth") ?: return false
            val strokeAlpha = attrFloat(parser, "strokeAlpha") ?: 1f
            if (!strokeWidth.isFinite() || !strokeAlpha.isFinite() || strokeWidth <= 0f) return false
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                try {
                    color = Color.parseColor(strokeColor)
                } catch (_: IllegalArgumentException) {
                    return false
                }
                alpha = (alpha * strokeAlpha.coerceIn(0f, 1f)).toInt()
                this.strokeWidth = strokeWidth
                strokeCap = when (parser.getAttributeValue(null, "strokeLineCap")) {
                    "square" -> Paint.Cap.SQUARE
                    "round" -> Paint.Cap.ROUND
                    else -> Paint.Cap.BUTT
                }
                strokeJoin = when (parser.getAttributeValue(null, "strokeLineJoin")) {
                    "round" -> Paint.Join.ROUND
                    "bevel" -> Paint.Join.BEVEL
                    else -> Paint.Join.MITER
                }
            }
            canvas.drawPath(path, paint)
        }
        // Paths with neither fill nor stroke draw nothing; that is valid vector
        // content (a spacer), not a failure.
        return true
    }

    private fun attrFloat(parser: XmlPullParser, name: String): Float? =
        parser.getAttributeValue(null, name)?.toFloatOrNull()
}
