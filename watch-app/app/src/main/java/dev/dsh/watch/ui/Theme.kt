package dev.dsh.watch.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.Typography

/**
 * Design system: one calm palette, one type ramp, a few shared surfaces.
 * AMOLED true-black base, layered greys, a single cyan accent, restrained
 * semantic colours. Screens must use these tokens — no raw hex / raw sizes.
 */
object DshColors {
    // ---- surfaces (layered greys, never pure grey slabs) ----
    val background = Color.Black                     // AMOLED
    val surface = Color(0xFF15171A)                  // cards / rows / chips
    val surfaceHigh = Color(0xFF1E2126)              // pressed / selected
    val outline = Color(0xFF2A2E34)                  // hairlines, ring track

    // ---- text ramp ----
    val textPrimary = Color(0xFFF2F3F5)
    val textSecondary = Color(0xFF9AA1A9)
    val textTertiary = Color(0xFF666D76)

    // ---- single accent ----
    val accent = Color(0xFF5AC8FA)                   // calm cyan-blue

    // ---- semantic ----
    val success = Color(0xFF30D158)
    val warning = Color(0xFFFFB300)
    val danger = Color(0xFFFF453A)

    // ---- voice-activity phases (identity colours, slightly tuned) ----
    val idle = Color(0xFF8A9099)                     // quiet grey
    val connecting = Color(0xFFB0B6BD)               // pale rotating dashes
    val listening = Color(0xFF4CAF7D)                // calm green breathing
    val hearing = Color(0xFF4DD0E1)                  // cyan fast pulse
    val thinking = Color(0xFFF5A524)                 // amber spinner
    val speaking = Color(0xFFAB7BE8)                 // soft violet wave
    val error = danger
    val muted = Color(0xFFF0883E)                    // warm amber-orange
    val connected = success
    val disconnected = danger
    val queueBadge = accent
    val pendingBadge = warning

    /** 14% tint of [c] over the surface — for soft semantic button fills. */
    fun tint(c: Color): Color = c.copy(alpha = 0.14f)
}

/** One type ramp for the whole app. Screens reference these, never raw sp. */
object DshType {
    val display = TextStyle(                        // big current values
        fontSize = 18.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.2.sp,
        color = DshColors.textPrimary,
    )
    val title = TextStyle(                          // screen headers
        fontSize = 14.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.3.sp,
        color = DshColors.textPrimary,
    )
    val body = TextStyle(                           // row titles, message text
        fontSize = 13.sp, fontWeight = FontWeight.Normal, letterSpacing = 0.1.sp,
        color = DshColors.textPrimary,
    )
    val secondary = TextStyle(                      // row subtitles, details
        fontSize = 11.sp, fontWeight = FontWeight.Normal,
        color = DshColors.textSecondary,
    )
    val label = TextStyle(                          // chips, buttons, badges
        fontSize = 12.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.4.sp,
        color = DshColors.textPrimary,
    )
    val caption = TextStyle(                        // timestamps, meta
        fontSize = 10.sp, fontWeight = FontWeight.Normal, letterSpacing = 0.5.sp,
        color = DshColors.textTertiary,
    )
}

@Composable
fun DshTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colors = Colors(
            background = DshColors.background,
            surface = DshColors.surface,
            onBackground = DshColors.textPrimary,
            onSurface = DshColors.textPrimary,
            onSurfaceVariant = DshColors.textSecondary,
            primary = DshColors.accent,
            onPrimary = Color.Black,
            secondary = DshColors.speaking,
            onSecondary = Color.Black,
            error = DshColors.danger,
            onError = Color.Black,
        ),
        typography = Typography(
            display1 = DshType.display,
            title1 = DshType.title,
            title2 = DshType.title,
            title3 = DshType.secondary,
            body1 = DshType.body,
            body2 = DshType.secondary,
            button = DshType.label,
            caption1 = DshType.caption,
            caption2 = DshType.caption,
            caption3 = DshType.caption,
        ),
        content = content,
    )
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

/** Raised card/row surface. */
@Composable
fun DshCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    background: Color = DshColors.surface,
    content: @Composable () -> Unit,
) {
    val base = modifier
        .clip(RoundedCornerShape(16.dp))
        .background(background)
    Box(
        modifier = if (onClick != null) base.clickable(
            interactionSource = remember { MutableInteractionSource() },
            indication = null,
            onClick = onClick,
        ) else base,
        contentAlignment = Alignment.Center,
    ) { content() }
}

/** Uppercase section label — quiet hierarchy for list headers. */
@Composable
fun DshSectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text.uppercase(),
        style = DshType.caption.copy(letterSpacing = 1.4.sp),
        textAlign = TextAlign.Center,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier.fillMaxWidth().padding(horizontal = 24.dp),
    )
}

/**
 * Low-key pill button: surface fill, no saturated slab. Semantic actions pass
 * [tint] to get a soft halo of their own colour. This replaces the stock
 * Wear [android.wear.compose.material.Button]/[android.wear.compose.material.Chip]
 * everywhere a full-colour block would shout.
 */
@Composable
fun DshPill(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = DshColors.accent,
    fill: Color = DshColors.surface,
    style: TextStyle = DshType.label,
    contentPadding: PaddingValues = PaddingValues(horizontal = 16.dp, vertical = 11.dp),
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(if (fill == DshColors.surface) fill else fill)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            )
            .padding(contentPadding),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = style.copy(color = tint),
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Pill on a soft tint of its own colour — for Approve / Deny / primary CTAs. */
@Composable
fun DshPillTinted(
    label: String,
    onClick: () -> Unit,
    tint: Color,
    modifier: Modifier = Modifier,
    style: TextStyle = DshType.label,
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(DshColors.tint(tint))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 16.dp, vertical = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = style.copy(color = tint),
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Round ghost icon button for the home dock. */
@Composable
fun DshIconButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    background: Color = DshColors.surface,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .size(46.dp)
            .clip(CircleShape)
            .background(background)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) { content() }
}

/** Status dot. */
@Composable
fun DshDot(color: Color, modifier: Modifier = Modifier, size: Int = 7) {
    Box(
        modifier = modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(color),
    )
}

/** Empty-state placeholder. */
@Composable
fun DshEmpty(text: String) {
    Text(
        text = text,
        style = DshType.secondary.copy(color = DshColors.textTertiary),
        textAlign = TextAlign.Center,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
    )
}
