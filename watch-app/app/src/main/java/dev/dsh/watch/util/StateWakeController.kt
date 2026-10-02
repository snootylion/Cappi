package dev.dsh.watch.util

import android.content.Context
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import dev.dsh.watch.core.AmbientWakeOwnership
import dev.dsh.watch.core.StateWakePolicy
import dev.dsh.watch.core.StateWakeDiagnostics
import dev.dsh.watch.core.StateWakeDiagnosticChanges
import dev.dsh.watch.core.StateWakeSnapshot
import dev.dsh.watch.core.UiState
import java.lang.ref.WeakReference

/** Bounded legacy compatibility path, not a background activity launch or an alarm. */
class StateWakeController(context: Context) {
    private val power = context.applicationContext.getSystemService(PowerManager::class.java)
    private val ownership = AmbientWakeOwnership()
    private val policy = StateWakePolicy()
    private val diagnostics = StateWakeDiagnosticChanges()
    private var lock: PowerManager.WakeLock? = null

    fun focused() {
        if (owner?.get() !== this) owner?.get()?.leave()
        owner = WeakReference(this)
        ownership.focused()
    }
    fun enterAmbient() { ownership.enterAmbient() }
    fun pause(ambient: Boolean) { ownership.pause(ambient); if (!ambient) release() }
    fun stop(ambient: Boolean, visible: Boolean) {
        ownership.stop(ambient, visible)
        if (!ambient || !visible) release()
    }
    fun leave() {
        ownership.leave()
        release()
        if (owner?.get() === this) owner = null
    }
    fun isInteractive(): Boolean = power?.isInteractive == true

    fun onState(state: UiState, cappiRoot: Boolean, ambient: Boolean, sdkAmbient: Boolean, visible: Boolean, alive: Boolean) {
        val currentOwner = owner?.get() === this
        val allowed = alive && cappiRoot && state.avatarMode && state.wakeOnActivity &&
            state.connected && !state.offlineClock && ownership.permits(ambient && sdkAmbient, visible, currentOwner)
        if (!alive || !cappiRoot || !state.avatarMode || !state.wakeOnActivity || !state.connected || state.offlineClock || !visible) release()
        val snapshot = StateWakeSnapshot.from(state)
        val reason = policy.observe(snapshot, allowed, SystemClock.elapsedRealtime())
        val diagnostic = StateWakeDiagnostics(
            state.connected, cappiRoot, state.avatarMode, state.wakeOnActivity,
            ambient, sdkAmbient, visible, alive, currentOwner, ownership.hasForeground,
            ownership.hasAmbientLease, isInteractive(), state.offlineClock, snapshot.questions.size,
            snapshot.speaking, snapshot.working, snapshot.error, policy.decision, policy.reason, policy.eventRevision,
        )
        if (diagnostics.changed(diagnostic)) Log.i(TAG, diagnostic.toString())
        if (reason != null) wake(reason.name)
    }

    @Suppress("DEPRECATION")
    private fun wake(reason: String) {
        try {
            val pm = power ?: return
            if (!pm.isWakeLockLevelSupported(PowerManager.SCREEN_BRIGHT_WAKE_LOCK)) {
                Log.w(TAG, "Screen wake level unsupported")
                return
            }
            val active = lock ?: pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "dsh:state-wake",
            ).also { it.setReferenceCounted(false); lock = it }
            active.acquire(8_000L) // Bounded even if a lifecycle callback never arrives.
            Log.i(TAG, "Requested bounded screen wake: $reason")
        } catch (_: SecurityException) {
            release()
            Log.w(TAG, "Platform denied screen wake; no permission or notification bypass")
        } catch (e: RuntimeException) {
            release()
            Log.w(TAG, "Screen wake unavailable: ${e.javaClass.simpleName}")
        }
    }

    fun release() {
        lock?.runCatching { if (isHeld) release() }
        lock = null
    }
    companion object {
        private const val TAG = "DSHWake"
        // HOME alias and grid entry can own separate activities, but only one may wake.
        private var owner: WeakReference<StateWakeController>? = null
    }
}
