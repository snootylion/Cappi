package dev.dsh.watch.util

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

object Haptics {

    private fun vibrator(context: Context): Vibrator? = if (Build.VERSION.SDK_INT >= 31) {
        context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

    /** One medium buzz — submit sent. */
    fun buzzMedium(context: Context) {
        val v = vibrator(context) ?: return
        if (!v.hasAmplitudeControl()) {
            @Suppress("DEPRECATION")
            v.vibrate(40)
        } else {
            v.vibrate(VibrationEffect.createOneShot(40, 160))
        }
    }

    /** Two short buzzes — approval sent. */
    fun buzzDouble(context: Context) {
        val v = vibrator(context) ?: return
        if (!v.hasAmplitudeControl()) {
            @Suppress("DEPRECATION")
            v.vibrate(longArrayOf(0, 35, 90, 35), -1)
        } else {
            v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 35, 90, 35), intArrayOf(0, 140, 0, 140), -1))
        }
    }

    /** One light buzz — SSE reconnected after a drop. */
    fun buzzLight(context: Context) {
        val v = vibrator(context) ?: return
        if (!v.hasAmplitudeControl()) {
            @Suppress("DEPRECATION")
            v.vibrate(18)
        } else {
            v.vibrate(VibrationEffect.createOneShot(18, 80))
        }
    }

    /** Long buzz — error. */
    fun buzzError(context: Context) {
        val v = vibrator(context) ?: return
        if (!v.hasAmplitudeControl()) {
            @Suppress("DEPRECATION")
            v.vibrate(longArrayOf(0, 350), -1)
        } else {
            v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 350), intArrayOf(0, 200), -1))
        }
    }
}
