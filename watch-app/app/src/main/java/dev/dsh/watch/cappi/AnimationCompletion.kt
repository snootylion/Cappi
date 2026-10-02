package dev.dsh.watch.cappi

/** Leave the platform callback registered, but detach its coroutine on completion
 * or cancellation. Android may still deliver a previously posted end event. */
class AnimationCompletion(private var onEnd: (() -> Unit)?) {
    @Synchronized fun complete() {
        val action = onEnd
        onEnd = null
        action?.invoke()
    }
    @Synchronized fun cancel() { onEnd = null }
}
