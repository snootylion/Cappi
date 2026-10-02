package dev.dsh.watch

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.lifecycle.HasDefaultViewModelProviderFactory
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.CreationExtras
import androidx.lifecycle.viewmodel.MutableCreationExtras
import dev.dsh.watch.core.BridgeViewModel

/**
 * Process-scoped owner of the single bridge/audio pipeline.
 *
 * The app-grid entry (.MainActivity, singleTask) and the HOME alias
 * (.RemoteHomeActivity → MainActivity) can surface as separate live activity
 * instances in separate tasks (t39/t40/t42 observed; the alias has no
 * launchMode of its own). If each activity instance owned its own
 * BridgeViewModel — as the activity-scoped compose default did — each
 * owned a separate SSE connection and TtsPlayer, and the bridge's
 * `watchSend` broadcast every audio chunk to both: a distinct, delayed echo
 * of every spoken reply.
 *
 * The Application outlives every activity instance, so storing the single
 * ViewModelStore here guarantees exactly one BridgeViewModel / SSE supervisor /
 * TtsPlayer per process, with consistent mic and speaker state no matter how
 * many activity instances come and go.
 */
class App : Application(), ViewModelStoreOwner, HasDefaultViewModelProviderFactory {

    /** Never cleared by activity churn — only explicit clearing runs onCleared. */
    override val viewModelStore: ViewModelStore = ViewModelStore()

    /** Explicit factory: BridgeViewModel is an AndroidViewModel(application). */
    override val defaultViewModelProviderFactory: ViewModelProvider.Factory =
        ViewModelProvider.AndroidViewModelFactory(this)

    // This store belongs to the Application, not an Activity: there is no
    // Activity/view-tree to inherit extras from, so APPLICATION_KEY must be
    // supplied here or AndroidViewModel creation throws at runtime.
    override val defaultViewModelCreationExtras: CreationExtras =
        MutableCreationExtras().apply {
            set(ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY, this@App)
        }

    /**
     * The one process-owned bridge/audio owner. Every call returns the same
     * BridgeViewModel from [viewModelStore]. Its onCleared teardown (mic stop,
     * TTS release, SSE cancel, owned-session stop) runs only if this store is
     * cleared — never because one activity instance disappeared.
     */
    fun bridgeViewModel(): BridgeViewModel =
        ViewModelProvider(this)[BridgeViewModel::class.java]

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "DSH Remote",
                NotificationManager.IMPORTANCE_LOW
            )
        )
    }

    companion object {
        const val CHANNEL_ID = "dsh_remote"
    }
}
