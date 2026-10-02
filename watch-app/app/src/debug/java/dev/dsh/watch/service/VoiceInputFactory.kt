package dev.dsh.watch.service

/** In-process instrumentation seam only. No receiver, manifest entry or main asset. */
internal object VoiceInputFactory {
    @Volatile var syntheticFactory: (() -> VoiceInput)? = null
    @androidx.annotation.RequiresPermission(android.Manifest.permission.RECORD_AUDIO)
    fun create(): VoiceInput = syntheticFactory?.invoke() ?: createAndroidVoiceInput()
}
