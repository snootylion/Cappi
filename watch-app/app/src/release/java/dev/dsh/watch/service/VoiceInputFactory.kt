package dev.dsh.watch.service

/** Release has no injectable input path. */
internal object VoiceInputFactory {
    @androidx.annotation.RequiresPermission(android.Manifest.permission.RECORD_AUDIO)
    fun create(): VoiceInput = createAndroidVoiceInput()
}
