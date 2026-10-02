package dev.dsh.watch.cappi

/** Recorded GW4 double-HOME shortcut: MAIN, no categories, MainActivity,
 * NEW_TASK|RESET_TASK_IF_NEEDED. Ordinary HOME targets RemoteHomeActivity;
 * app-grid launches have LAUNCHER. Keep those paths strictly separate. */
fun isSamsungCappiShortcut(
    action: String?, categories: Set<String>?, component: String?, flags: Int,
): Boolean = action == "android.intent.action.MAIN" && categories.isNullOrEmpty() &&
    component == "dev.dsh.watch.MainActivity" &&
    (flags and 0x10200000) == 0x10200000
