package dev.dsh.watch

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import dev.dsh.watch.ui.ResponseScreen
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.navigation.NavController
import androidx.navigation.NavType
import androidx.navigation.navArgument
import androidx.wear.compose.material.Text
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import dev.dsh.watch.core.BridgeViewModel
import dev.dsh.watch.core.isPairedEndpoint
import dev.dsh.watch.device.ALL_PROFILES
import dev.dsh.watch.device.DeviceSettings
import dev.dsh.watch.device.WatchDevice
import dev.dsh.watch.ui.AvatarScreen
import dev.dsh.watch.util.AmbientDisplay
import dev.dsh.watch.util.Haptics
import dev.dsh.watch.util.PressCoordinator
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.rememberUpdatedState
import dev.dsh.watch.ui.DeviceSettingsState
import dev.dsh.watch.ui.DshColors
import dev.dsh.watch.ui.DshTheme
import dev.dsh.watch.ui.DshType
import dev.dsh.watch.ui.HomeScreen
import dev.dsh.watch.ui.OfflineClockScreen
import dev.dsh.watch.ui.ImageDetailScreen
import dev.dsh.watch.ui.ImagesScreen
import dev.dsh.watch.ui.ButtonsScreen
import dev.dsh.watch.ui.JobsScreen
import dev.dsh.watch.ui.mainMenuEntries
import dev.dsh.watch.ui.ModelPickerScreen
import dev.dsh.watch.ui.PairingWizardScreen
import dev.dsh.watch.ui.MenuScreen
import dev.dsh.watch.ui.PendingScreen
import dev.dsh.watch.ui.PermissionsScreen
import dev.dsh.watch.ui.ProjectsScreen
import dev.dsh.watch.ui.QueueScreen
import dev.dsh.watch.ui.SessionsScreen
import dev.dsh.watch.ui.SettingsScreen
import dev.dsh.watch.ui.StatusScreen
import dev.dsh.watch.ui.TodosScreen
import dev.dsh.watch.ui.TypeScreen
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import androidx.wear.ambient.AmbientLifecycleObserver
import dev.dsh.watch.util.StateWakeController
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val homeRequests = mutableIntStateOf(0)
    // Individual HOME events are delivered synchronously: Compose counters can coalesce.
    var onLowerPress: (() -> Unit)? = null
    var cancelLowerGesture: (() -> Unit)? = null
    var displayActive by mutableStateOf(true)
        private set
    var wakeEpoch by mutableLongStateOf(0L)
        private set
    var ambientLowBit by mutableStateOf(false)
        private set
    var ambientBurnInProtection by mutableStateOf(false)
        private set
    var ambientOffsetDp by mutableFloatStateOf(0f)
        private set
    /** Bumped whenever the device profile/alias preference changes. */
    var deviceGeneration by mutableIntStateOf(0)
        private set
    /** Vendor/platform routing for this unit; replaced (never mutated) on reload. */
    lateinit var watchDevice: WatchDevice
        private set
    /** Foreground lower-HOME gesture state; pure logic, injectable clock in tests. */
    val pressCoordinator = PressCoordinator()
    private var ambient = false
    private var started = false
    private var snapOnDisplay = false
    private var cappiRoot = true
    private var ambientTick = 0
    private var screenWake: StateWakeController? = null
    private var ambientObserver: AmbientLifecycleObserver? = null
    private var speechQuietJob: Job? = null

    fun setWakeRoot(root: Boolean) {
        cappiRoot = root
        if (!root) screenWake?.release()
        updateDisplayState()
    }

    /** Explicit navigation away must revoke ownership before starting another app. */
    fun revokeWakeOwnership() { screenWake?.leave() }

    /**
     * Re-resolves the device profile from preferences + hardware and applies
     * the stored HOME-alias choice. Called from Settings; reversible.
     */
    fun reloadDeviceProfile() {
        val prefs = DeviceSettings.prefs(this)
        watchDevice = WatchDevice(DeviceSettings.resolve(prefs, Build.MANUFACTURER, Build.MODEL))
        WatchDevice.applyHomeAliasEnabled(this, DeviceSettings.isHomeAliasEnabled(prefs))
        deviceGeneration++
    }

    private fun updateDisplayState() {
        val active = started && !ambient && screenWake?.isInteractive() != false
        if (active && !displayActive && snapOnDisplay) {
            wakeEpoch++
            snapOnDisplay = false
        }
        displayActive = active
        // Non-Cappi screens also become low-power when the SDK puts the activity in ambient.
        val state = (application as App).bridgeViewModel().state.value
        window.decorView.alpha = AmbientDisplay.windowAlpha(
            interactive = active,
            companionAmbientFace = cappiRoot && state.avatarMode && !state.offlineClock,
            lowBitAmbient = ambientLowBit,
        )
    }

    private fun observeWakeState() {
        val state = (application as App).bridgeViewModel().state.value
        screenWake?.onState(state, cappiRoot, ambient, ambientObserver?.isAmbient == true,
            window.decorView.windowVisibility == android.view.View.VISIBLE, !isFinishing && !isDestroyed)
    }

    override fun onStart() {
        super.onStart()
        started = true
        updateDisplayState()
    }

    override fun onUserLeaveHint() {
        revokeWakeOwnership()
        super.onUserLeaveHint()
    }

    override fun onDestroy() {
        speechQuietJob?.cancel()
        screenWake?.leave()
        // Let the observer receive ON_DESTROY so its WearableActivityController is released.
        super.onDestroy()
        ambientObserver = null
    }

    override fun onPause() {
        // Foreground onNewIntent delivery can transiently pause this activity.
        // Do not destroy the first HOME press merely because another arrives.
        Log.i("DSHKeys", "pause focused=${hasWindowFocus()}")
        screenWake?.pause(ambient)
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        Log.i("DSHKeys", "resume focused=${hasWindowFocus()}")
        if (hasWindowFocus()) screenWake?.focused()
        updateDisplayState()
    }

    override fun onStop() {
        Log.i("DSHKeys", "stop cancelGesture")
        cancelLowerGesture?.invoke()
        screenWake?.stop(ambient, window.decorView.windowVisibility == android.view.View.VISIBLE)
        started = false
        snapOnDisplay = true
        updateDisplayState()
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        Log.i("DSHKeys", "focus=$hasFocus")
        if (hasFocus && !ambient) screenWake?.focused()
        if (!hasFocus) cancelLowerGesture?.invoke()
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        Log.i("DSHKeys", "newIntent at=${SystemClock.uptimeMillis()} act=${intent.action} cats=${intent.categories} flags=${intent.flags} component=${intent.component} extraKeys=${intent.extras?.keySet()} focused=${hasWindowFocus()} handler=${onLowerPress != null}")
        when (classifyIntent(intent)) {
            // Samsung already recognizes the double press and sends ONE shortcut
            // launch. It must never enter the delayed SINGLE/queue-send path.
            WatchDevice.HomeIntent.ShortcutToggle -> toggleCappiShortcut()
            // Ordinary HOME remains separate from the configured double shortcut.
            WatchDevice.HomeIntent.HomePress -> {
                if (hasWindowFocus() && onLowerPress != null) onLowerPress?.invoke()
                else homeRequests.intValue++
            }
            WatchDevice.HomeIntent.Other -> Unit
        }
    }

    /**
     * True only on devices carrying the Wear platform feature (watches). Pure
     * PackageManager query so ambient gating is testable via [AmbientDisplay].
     */
    private fun hasWatchFeature(): Boolean = try {
        packageManager.hasSystemFeature(PackageManager.FEATURE_WATCH)
    } catch (_: Exception) {
        false
    }

    private fun classifyIntent(intent: android.content.Intent): WatchDevice.HomeIntent =
        watchDevice.classify(
            intent.action, intent.categories, intent.component?.className, intent.flags,
        )

    private fun toggleCappiShortcut() {
        cancelLowerGesture?.invoke()
        val bridge = (application as App).bridgeViewModel()
        bridge.toggleAvatarMode()
        homeRequests.intValue++
        Haptics.buzzDouble(this)
        Log.i("DSHKeys", "Samsung double shortcut: avatar=${bridge.state.value.avatarMode}; no queue command")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = DeviceSettings.prefs(this)
        watchDevice = WatchDevice(DeviceSettings.resolve(prefs, Build.MANUFACTURER, Build.MODEL))
        // HOME replacement is optional and reversible: the stored choice wins,
        // the normal app-grid entry always remains installed.
        WatchDevice.applyHomeAliasEnabled(this, DeviceSettings.isHomeAliasEnabled(prefs))
        // A cold HOME launch does not call onNewIntent. Record it here too so
        // restored navigation state cannot reopen a submenu after process death.
        if (classifyIntent(intent) == WatchDevice.HomeIntent.HomePress) homeRequests.intValue++
        // Process-scoped bridge owner: the grid entry and the HOME alias can be
        // separate live activity instances, but they must share ONE
        // BridgeViewModel/SSE/TtsPlayer — otherwise every reply is spoken twice.
        val bridge = (application as App).bridgeViewModel()
        screenWake = StateWakeController(this)
        val observer = AmbientLifecycleObserver(this, object : AmbientLifecycleObserver.AmbientLifecycleCallback {
            override fun onEnterAmbient(ambientDetails: AmbientLifecycleObserver.AmbientDetails) {
                // Samsung can deliver focus after onResume; current focus is stronger
                // evidence than a missing earlier callback, but never trust a hidden window.
                if (hasWindowFocus() && window.decorView.windowVisibility == android.view.View.VISIBLE &&
                    !isFinishing && !isDestroyed) screenWake?.focused()
                ambient = true
                snapOnDisplay = true
                ambientLowBit = ambientDetails.deviceHasLowBitAmbient
                ambientBurnInProtection = ambientDetails.burnInProtectionRequired
                ambientOffsetDp = if (ambientBurnInProtection) -2f else 0f
                screenWake?.enterAmbient()
                updateDisplayState()
                Log.i("DSHWake", "Enter ambient visible=${window.decorView.windowVisibility == android.view.View.VISIBLE}")
                observeWakeState()
            }
            override fun onUpdateAmbient() {
                if (ambientBurnInProtection) {
                    ambientTick++
                    ambientOffsetDp = AmbientDisplay.burnInOffsetDp(ambientTick, ambientBurnInProtection)
                }
            }
            override fun onExitAmbient() {
                ambient = false
                // Some Wear builds exit ambient without another onResume/focus event.
                if (hasWindowFocus() && window.decorView.windowVisibility == android.view.View.VISIBLE &&
                    !isFinishing && !isDestroyed) screenWake?.focused()
                ambientOffsetDp = 0f
                updateDisplayState()
                Log.i("DSHWake", "Exit ambient epoch=$wakeEpoch")
                observeWakeState()
            }
        })
        // Ambient mode needs the Wear shared library (present on watches, absent
        // on phones/generic emulators even though the manifest declares it with
        // required="false"). Attaching the observer without it throws
        // IllegalStateException during ON_CREATE dispatch and crashes launch,
        // so gate on the watch feature and degrade to interactive-only
        // (ambient stays false; window stays opaque) when it is missing.
        if (AmbientDisplay.isAmbientSupported(hasWatchFeature())) {
            ambientObserver = observer
            try {
                lifecycle.addObserver(observer)
            } catch (_: IllegalStateException) {
                // Wear library vanished between the check and dispatch:
                // stay interactive rather than crash.
                ambientObserver = null
            }
        } else {
            ambientObserver = null
        }
        // Not repeatOnLifecycle/Compose: the collector must survive ambient STOPPED.
        lifecycleScope.launch {
            var lastSpeaking = bridge.state.value.speakingOutput
            bridge.state.collect { state ->
                updateDisplayState()
                observeWakeState()
                if (state.speakingOutput != lastSpeaking) {
                    lastSpeaking = state.speakingOutput
                    speechQuietJob?.cancel()
                    if (!state.speakingOutput) speechQuietJob = lifecycleScope.launch {
                        delay(1_500L)
                        observeWakeState() // One settled speech-end check, never an ambient poll.
                    }
                }
            }
        }
        // A cold shortcut launch has no onNewIntent; don't replay on rotation.
        if (savedInstanceState == null && classifyIntent(intent) == WatchDevice.HomeIntent.ShortcutToggle) toggleCappiShortcut()
        setContent {
            DshTheme {
                AppRoot(activity = this@MainActivity, vm = bridge, homeRequest = homeRequests.intValue)
            }
        }
    }
}

/**
 * App-scoped fallback so no AppRoot caller can accidentally resolve an
 * activity-owned copy: the Application's ViewModelStore holds the single
 * BridgeViewModel for the whole process.
 */
@Composable
private fun appBridgeViewModel(): BridgeViewModel {
    val app = LocalContext.current.applicationContext as App
    return remember(app) { app.bridgeViewModel() }
}

@Composable
fun AppRoot(activity: MainActivity, vm: BridgeViewModel = appBridgeViewModel(), homeRequest: Int = 0) {
    val state by vm.state.collectAsState()
    val nav = rememberSwipeDismissableNavController()
    val initialDestination = remember { if (state.isPairedEndpoint()) "home" else "pairing" }
    val context = LocalContext.current
    // Profile re-resolves when Settings writes an override (deviceGeneration).
    val profile = remember(activity.deviceGeneration) { activity.watchDevice.profile }
    // Physical wearing orientation confirmed by the user: upper=Back/mic,
    // lower=HOME/send-or-double-toggle. Never infer physical position from key names.
    var atRoot by remember { mutableStateOf(true) }
    val latestState by rememberUpdatedState(state)
    // No microphone prompt on boot or pairing. Continue only an explicit tap,
    // and discard a pending action if pairing changed during the system dialog.
    var pendingMicAction by remember { mutableStateOf<(() -> Unit)?>(null) }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val action = pendingMicAction
        pendingMicAction = null
        if (granted) action?.invoke()
    }
    fun withMicPermission(action: () -> Unit) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            action()
        } else {
            val base = state.base
            val token = state.token
            pendingMicAction = {
                if (latestState.base == base && latestState.token == token) action()
            }
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
    val latestRoot by rememberUpdatedState(atRoot)
    DisposableEffect(nav) {
        val listener = NavController.OnDestinationChangedListener { _, dest, _ ->
            atRoot = dest.route == "home"
            activity.setWakeRoot(atRoot)
        }
        activity.setWakeRoot(atRoot)
        nav.addOnDestinationChangedListener(listener)
        onDispose {
            activity.setWakeRoot(false)
            nav.removeOnDestinationChangedListener(listener)
        }
    }
    // Physical Back routing is profile-gated. On validated profiles the root
    // Cappi screen uses Back as the mic toggle; on generic Wear OS the root
    // keeps system Back behavior so the app never steals Back for the
    // microphone by default. Off-root Back is always in-app navigation:
    // leaving it to Wear OS could exit into Samsung Home.
    androidx.activity.compose.BackHandler(enabled = profile.rootBackTogglesMic || !atRoot) {
        if (atRoot) {
            withMicPermission { vm.toggleMic(); Haptics.buzzLight(context) }
        } else {
            nav.popBackStack()
        }
    }
    DisposableEffect(activity, vm, state.sessionId, state.connected, atRoot) {
        val handler = Handler(Looper.getMainLooper())
        val coordinator = activity.pressCoordinator
        fun execute(actions: List<PressCoordinator.Outcome>) {
            val current = latestState
            if (actions.isEmpty()) return
            Log.i("DSHKeys", "gate actions=$actions focused=${activity.hasWindowFocus()} root=$latestRoot targetSessionMatches=${current.sessionId}")
            for (action in actions) when (action) {
                PressCoordinator.Outcome.ToggleCompanion -> {
                    vm.toggleAvatarMode()
                    Haptics.buzzDouble(context)
                }
                is PressCoordinator.Outcome.SteerQueue -> {
                    vm.queueSteer(action.queueId)
                    Haptics.buzzMedium(context)
                }
            }
        }
        val flush = Runnable {
            val actions = coordinator.flush(
                latestState.sessionId, latestState.queue.firstOrNull()?.id, latestState.connected,
            )
            // The gate always advances; execution still needs focus + root.
            if (activity.hasWindowFocus() && latestRoot) execute(actions)
        }
        val cancel = {
            Log.i("DSHKeys", "gate cancel pending=${coordinator.hasPending}")
            handler.removeCallbacksAndMessages(null); coordinator.cancel()
        }
        Log.i("DSHKeys", "gate bind root=$atRoot profile=${profile.id}")
        activity.cancelLowerGesture = cancel
        activity.onLowerPress = {
            if (!latestRoot) {
                cancel()
                nav.popBackStack("home", false)
            } else {
                // The coordinator flushes the old gesture against its original
                // queue/session capture before starting the next one.
                val actions = coordinator.press(
                    latestState.sessionId, latestState.queue.firstOrNull()?.id, latestState.connected,
                )
                Log.i("DSHKeys", "gate press actions=$actions remainingMs=${coordinator.flushDueAtMs}")
                // onLowerPress only fires while focused (see onNewIntent), but
                // re-check: focus can be lost between delivery and dispatch.
                if (activity.hasWindowFocus()) execute(actions)
                handler.removeCallbacks(flush)
                coordinator.flushDueAtMs?.let { handler.postAtTime(flush, it) }
            }
        }
        onDispose {
            cancel()
            activity.onLowerPress = null
            activity.cancelLowerGesture = null
        }
    }
    LaunchedEffect(homeRequest) {
        if (homeRequest > 0 && !atRoot) nav.popBackStack("home", false)
    }
    fun openSystemScreen(samsungHome: Boolean) {
        activity.revokeWakeOwnership()
        activity.watchDevice.openSystemScreen(context, samsungHome)
    }
    val view = androidx.compose.ui.platform.LocalView.current
    DisposableEffect(view, state.keepScreenAwake, state.offlineClock) {
        view.keepScreenOn = state.keepScreenAwake && !state.offlineClock
        onDispose { view.keepScreenOn = false }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        SwipeDismissableNavHost(
            navController = nav,
            startDestination = initialDestination,
            modifier = Modifier.fillMaxSize(),
        ) {
            composable("home") {
                LaunchedEffect(state.sessionId, state.connected) {
                    if (state.connected) vm.loadSessions()
                }
                if (state.offlineClock) OfflineClockScreen(onMenu = { nav.navigate("menu") }) else if (state.avatarMode) AvatarScreen(
                    state = state,
                    characterId = state.characterId,
                    displayActive = activity.displayActive,
                    wakeEpoch = activity.wakeEpoch,
                    ambientLowBit = activity.ambientLowBit,
                    ambientOffsetDp = activity.ambientOffsetDp,
                    onMicToggle = {
                        withMicPermission { vm.toggleMic() }
                    },
                    onSendOldest = {
                        val oldest = state.queue.firstOrNull()
                        if (oldest != null && state.connected) vm.queueSteer(oldest.id)
                    },
                    onPending = { nav.navigate("pending") { launchSingleTop = true } },
                    // Touch-hold exit for buttonless watches: avatar home is the
                    // nav root, so swipe-back cannot leave it. Long-press reopens
                    // Menu, where `Avatar mode · On` toggles back to remote.
                    onMenu = { nav.navigate("menu") { launchSingleTop = true } },
                ) else HomeScreen(
                    state = state,
                    onMicToggle = {
                        withMicPermission { vm.toggleMic() }
                    },
                    onStop = {
                        vm.abortMicUplink()
                        vm.stopVoice()
                    },
                    onMenu = { nav.navigate("menu") },
                    onSessions = { nav.navigate("sessions") },
                    onSteer = vm::queueSteer,
                    onText = { nav.navigate("response") },
                    onPending = { nav.navigate("pending") { launchSingleTop = true } },
                    onVoiceOutputToggle = vm::toggleVoiceOutput,
                    onDismissError = vm::dismissError,
                    onPair = { nav.navigate("pairing") },
                )
            }

            composable("response") { ResponseScreen(state = state) }

            composable("buttons") { ButtonsScreen(profile) }

            composable("menu") {
                MenuScreen(
                    entries = mainMenuEntries(state, profile),
                    onNavigate = { route ->
                        when (route) {
                            "avatar-toggle" -> {
                                // Touch-accessible companion/remote switch for every
                                // profile (generic Wear OS has no Samsung buttons).
                                // Same flip as the hardware double-press shortcut.
                                vm.toggleAvatarMode()
                                Haptics.buzzDouble(context)
                                nav.popBackStack("home", false)
                            }                            "connection" -> {
                                if (state.offlineClock) {
                                    vm.reconnect()
                                    nav.popBackStack("home", false)
                                    val wifi = context.applicationContext.getSystemService(android.net.wifi.WifiManager::class.java)
                                    if (wifi?.isWifiEnabled == false) {
                                        context.startActivity(android.content.Intent(android.provider.Settings.ACTION_WIFI_SETTINGS)
                                            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
                                    }
                                } else {
                                    vm.disconnect()
                                    nav.popBackStack("home", false)
                                }
                            }
                            "wifi-settings" -> context.startActivity(android.content.Intent(android.provider.Settings.ACTION_WIFI_SETTINGS)
                                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
                            "watch-settings" -> openSystemScreen(false)
                            "samsung-home" -> openSystemScreen(true)
                            "models" -> nav.navigate(route) { launchSingleTop = true }
                            else -> nav.navigate(route)
                        }
                    },
                )
            }

            composable("models") {
                ModelPickerScreen(state = state, onOpen = vm::openModels, onClose = vm::closeModels,
                    onRefresh = vm::loadModels, onSet = vm::setModel, onSetReasoning = vm::setReasoning)
            }

            composable("todos") { TodosScreen(todos = state.todos, onRefresh = vm::refresh) }
            composable("jobs") { JobsScreen(title = "jobs", jobs = state.jobs, onRefresh = vm::refresh) }
            composable("agents") { JobsScreen(title = "agents", jobs = state.agents, onRefresh = vm::refresh) }

            composable("pending") {
                // Once on entry, not keyed to incoming cards: later questions remain fresh.
                androidx.compose.runtime.LaunchedEffect(Unit) { vm.reviewPendingQuestions() }
                PendingScreen(
                    pending = state.pending,
                    onApprove = { id, choice, _ -> vm.approve(id, choice, null) },
                    onApproveChoices = vm::approveChoices,
                    onDismiss = vm::dismissPending,
                    onTypeAnswer = { id ->
                        vm.setPendingTarget(id)
                        nav.navigate("type")
                    },
                )
            }

            composable("queue") {
                QueueScreen(
                    queue = state.queue,
                    onSteer = { id ->
                        vm.queueSteer(id)
                        nav.popBackStack()
                    },
                    onRemove = vm::queueRemove,
                    onClear = vm::queueClear,
                )
            }

            composable("status") {
                val ping = remember { mutableStateOf<String?>(null) }
                StatusScreen(
                    state = state,
                    onRefresh = vm::refresh,
                    onMuteToggle = vm::toggleMute,
                    onStopVoice = vm::stopVoice,
                    onTestTts = { vm.speakTest() },
                    onPing = { vm.ping { result -> ping.value = result } },
                    pingResult = ping.value,
                    onOpenPermissions = { nav.navigate("permissions") },
                )
            }

            composable("sessions") {
                SessionsScreen(
                    state = state,
                    onRefresh = {
                        vm.refreshSnapshot()
                        vm.loadSessions()
                    },
                    onSelect = { id ->
                        vm.selectSession(id) {
                            nav.navigate("home") { popUpTo("home") { inclusive = true } }
                        }
                    },
                    onNew = { nav.navigate("projects") },
                    onAuto = { vm.selectSession("") },
                )
            }

            composable("projects") {
                ProjectsScreen(
                    state = state,
                    onRefresh = {
                        vm.refreshSnapshot()
                        vm.loadProjects()
                    },
                    onNewDefault = {
                        vm.newSession(workspaceId = null, cwd = null) {
                            nav.navigate("home") { popUpTo("home") { inclusive = true } }
                        }
                    },
                    onNewInProject = { wsId, path ->
                        vm.newSession(
                            workspaceId = wsId,
                            cwd = if (wsId == null) path else null,
                        ) {
                            nav.navigate("home") { popUpTo("home") { inclusive = true } }
                        }
                    },
                    onNewInPath = {
                        vm.enterPathMode()
                        nav.navigate("type")
                    },
                )
            }

            composable("permissions") {
                PermissionsScreen(
                    state = state,
                    onRefresh = vm::refreshSnapshot,
                    onSet = { preset -> vm.setPermission(preset) },
                )
            }

            composable("settings") {
                val ping = remember { mutableStateOf<String?>(null) }
                // profileOverrideId read is a preference read, not composition state:
                // key it on deviceGeneration so a save-then-reload round-trips.
                @Suppress("UNUSED_VARIABLE")
                val generation = activity.deviceGeneration
                val prefs = remember(context, generation) { DeviceSettings.prefs(context) }
                val packs = remember(context, state.characterId) {
                    runCatching {
                        context.assets.list("characters")?.toList().orEmpty()
                            .filter { dev.dsh.watch.cappi.CharacterAssets.isSafePackId(it) }
                            .sorted()
                    }.getOrDefault(listOf("cappi-original", "dot-default", "ember-min"))
                        .ifEmpty { listOf("cappi-original", "dot-default", "ember-min") }
                }
                SettingsScreen(
                    base = state.base,
                    token = state.token,
                    certPin = dev.dsh.watch.net.SecureTransport.displayPin(state.certPinSha256),
                    allowInsecureLan = state.allowInsecureLan,
                    characterId = state.characterId,
                    availableCharacters = (packs + state.characterId).distinct().sorted(),
                    keepScreenAwake = state.keepScreenAwake,
                    onKeepScreenAwake = vm::toggleKeepScreenAwake,
                    wakeOnActivity = state.wakeOnActivity,
                    onWakeOnActivity = vm::toggleWakeOnActivity,
                    onSaveSecure = { b, t, p, i -> vm.applySettings(b, t, p, i) },
                    onCharacterSelect = vm::selectCharacter,
                    onPing = { vm.ping { result -> ping.value = result } },
                    pingResult = ping.value,
                    avatarMode = state.avatarMode,
                    onAvatarModeToggle = {
                        vm.toggleAvatarMode()
                        Haptics.buzzDouble(context)
                    },
                    device = DeviceSettingsState(
                        overrideId = DeviceSettings.loadOverride(prefs),
                        effectiveName = profile.displayName,
                        homeCaptureEnabled = DeviceSettings.isHomeAliasEnabled(prefs),
                        offersHomeCapture = profile.offersHomeCapture,
                    ),
                    onProfileOverride = { id ->
                        DeviceSettings.saveOverride(prefs, id)
                        activity.reloadDeviceProfile()
                    },
                    onHomeCapture = { enabled ->
                        DeviceSettings.setHomeAliasEnabled(prefs, enabled)
                        activity.reloadDeviceProfile()
                    },
                )
            }

            composable("pairing") {
                PairingWizardScreen(
                    vm = vm,
                    deviceAliasDefault = "Watch",
                    onPaired = {
                        if (!nav.popBackStack("home", false)) {
                            nav.navigate("home") { popUpTo("pairing") { inclusive = true }; launchSingleTop = true }
                        }
                    },
                    onOpenAdvanced = { nav.navigate("settings") },
                )
            }

            composable("images") {
                ImagesScreen(
                    images = state.images,
                    fetch = { ref -> vm.imageBytes(ref) },
                    onOpen = { index -> nav.navigate("image/$index") },
                )
            }

            composable(
                route = "image/{index}",
                arguments = listOf(navArgument("index") { type = NavType.IntType }),
            ) { entry ->
                val index = entry.arguments?.getInt("index") ?: 0
                ImageDetailScreen(
                    images = state.images,
                    index = index,
                    fetch = { ref -> vm.imageBytes(ref) },
                    onOpenMac = { ref -> vm.openImageOnMac(ref) },
                    openMacSupported = state.openMacSupported,
                    onExit = { nav.popBackStack() },
                )
            }

            composable("type") {
                val newSessionMode = state.typeMode == "new-session"
                // Leaving without sending must not leak the mode into a later Type entry.
                DisposableEffect(Unit) {
                    onDispose { vm.setPendingTarget(null) }
                }
                TypeScreen(
                    pendingRequestId = state.pendingRequestId,
                    pendingTitle = when {
                        newSessionMode -> "New session · cwd"
                        else -> state.pending
                            .firstOrNull { it.id == state.pendingRequestId }
                            ?.title
                    },
                    onSubmit = { text ->
                        if (newSessionMode) {
                            vm.newSession(workspaceId = null, cwd = text) {
                                nav.navigate("home") { popUpTo("home") { inclusive = true } }
                            }
                        } else {
                            vm.submit(text)
                        }
                    },
                    onApproveFree = { id, text, onSuccess -> vm.approve(id, "_free", text, onSuccess) },
                    questionActive = state.pendingRequestId == null || state.pending.any {
                        it.id == state.pendingRequestId && it.title == state.pendingQuestionTitle
                    },
                    dictating = state.dictating,
                    dictationSettling = state.dictationSettling,
                    dictationPartial = state.dictationPartial,
                    dictationFinal = state.dictationFinal,
                    dictationRevision = state.dictationRevision,
                    mainMicOn = state.micOpen,
                    onStopMainMic = vm::stopMicUplink,
                    onDictate = {
                        val id = state.pendingRequestId
                        if (id != null) withMicPermission {
                            if (latestState.pendingRequestId == id) vm.startDictation(id)
                        }
                    },
                    onStopDictation = { vm.stopDictation() },
                    onSent = {
                        vm.setPendingTarget(null)
                        nav.popBackStack()
                    },
                )
            }
        }

        // Command-failure toast (auto-clears after 3s in the ViewModel)
        state.toast?.let { msg ->
            Text(
                text = msg,
                style = DshType.label.copy(color = DshColors.danger),
                textAlign = TextAlign.Center,
                maxLines = 3,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(horizontal = 30.dp, vertical = 30.dp),
            )
        }
    }
}
