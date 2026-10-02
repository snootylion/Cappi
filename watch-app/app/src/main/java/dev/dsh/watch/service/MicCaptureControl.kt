package dev.dsh.watch.service

/** Record-off drains EOF; teardown/rebind aborts transport. Neither changes agent state. */
internal class MicCaptureControl {
    @Volatile var recording = true
        private set
    @Volatile var aborted = false
        private set
    val transportActive: Boolean get() = !aborted
    fun finishRecording() { recording = false }
    fun beginAbort() { aborted = true } // suppress outcomes before hard disconnect interrupts IO
    fun abort() { aborted = true; recording = false }
}
