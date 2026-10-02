package dev.dsh.watch.cappi

/** Model-requested actions expire back to the auto schedule after this long. */
const val CAPPI_ACTION_TIMEOUT_MS = 60_000L

/**
 * Pure reducer for `t: 'cappi'` SSE events and snapshot restores (plain-JVM
 * tested; the ViewModel owns only the timeout job). The bridge allowlists ids;
 * the watch additionally treats missing/empty/'clear' as "back to auto".
 */
fun reduceCappiAction(current: String?, action: String?): String? =
    if (action.isNullOrEmpty() || action == "clear") null else action
