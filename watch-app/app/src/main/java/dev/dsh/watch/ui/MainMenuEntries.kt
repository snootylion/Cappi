package dev.dsh.watch.ui

import dev.dsh.watch.core.UiState
import dev.dsh.watch.device.DeviceProfile
import dev.dsh.watch.device.GalaxyWatch4Profile

data class MenuEntry(val label: String, val count: Int, val route: String)

/** Keep the remainder stable when adding/reordering the four primary actions. */
fun mainMenuEntries(state: UiState): List<MenuEntry> =
    mainMenuEntries(state, GalaxyWatch4Profile)

/**
 * Profile-aware menu: vendor entries (currently "samsung-home") appear only
 * when [DeviceProfile.allowSamsungIntents] is true. The legacy overload above
 * preserves the historical full list (existing tests); new callers pass the
 * active profile.
 *
 * The "avatar-toggle" entry flips the companion character UI versus the
 * remote control UI. It is present on EVERY profile (including generic Wear
 * OS) so mode switching never requires a Samsung button or any hardware
 * shortcut; the double-press shortcut remains as a convenience alias for the
 * same [dev.dsh.watch.core.BridgeViewModel.toggleAvatarMode] flip.
 */
fun mainMenuEntries(state: UiState, profile: DeviceProfile): List<MenuEntry> {
    val entries = arrayListOf(
        MenuEntry("Pair with Mac", 0, "pairing"),
        MenuEntry(if (state.offlineClock) "Reconnect" else "Disconnect", 0, "connection"),
        MenuEntry("Switch thread", 0, "sessions"),
        MenuEntry("Switch model", 0, "models"),
        MenuEntry("Wi-Fi", 0, "wifi-settings"),
        MenuEntry("Watch settings", 0, "watch-settings"),
        MenuEntry("Buttons", 0, "buttons"),
        MenuEntry(if (state.avatarMode) "Avatar mode · On" else "Avatar mode · Off", 0, "avatar-toggle"),
    )
    if (profile.allowSamsungIntents) entries += MenuEntry("Samsung Home", 0, "samsung-home")
    entries += listOf(
        MenuEntry("Todos", state.todos.size, "todos"),
        MenuEntry("Jobs", state.jobs.size, "jobs"),
        MenuEntry("Agents", state.agents.size, "agents"),
        MenuEntry("Pending", state.pending.size, "pending"),
        MenuEntry("Queue", state.queue.size, "queue"),
        MenuEntry("Images", state.images.size, "images"),
        MenuEntry("Projects", state.projects.size, "projects"),
        MenuEntry("Permissions", 0, "permissions"),
        MenuEntry("Status", 0, "status"),
        MenuEntry("Type", 0, "type"),
        MenuEntry("Settings", 0, "settings"),
    )
    return entries
}
