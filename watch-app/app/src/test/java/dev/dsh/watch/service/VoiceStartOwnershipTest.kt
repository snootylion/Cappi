package dev.dsh.watch.service

import org.junit.Assert.*
import org.junit.Test

class VoiceStartOwnershipTest {
    @Test fun completionUsesLatestDuplicateStartId() {
        val owner = VoiceStartOwnership()
        owner.noteStart(1)
        val token = owner.begin()
        owner.noteStart(2)
        assertEquals(2, owner.finish(token))
        assertNull(owner.finish(token))
    }

    @Test fun oldWorkerCannotFinishNewCapture() {
        val owner = VoiceStartOwnership()
        owner.noteStart(1)
        val old = owner.begin()
        owner.cancel()
        owner.noteStart(2)
        val fresh = owner.begin()
        assertNull(owner.finish(old))
        assertEquals(2, owner.finish(fresh))
    }

    @Test fun queuedOldGracefulFinishCannotEndFreshCapture() {
        val owner = VoiceStartOwnership()
        val a = owner.begin()
        assertTrue(owner.isCurrent(a))
        owner.cancel()
        val b = owner.begin()
        assertFalse(owner.isCurrent(a))
        assertTrue(owner.isCurrent(b))
        owner.finish(b)
        assertFalse(owner.isCurrent(b))
    }

    @Test fun destroyedCaptureCompletionIsIgnored() {
        val owner = VoiceStartOwnership()
        owner.noteStart(7)
        val token = owner.begin()
        owner.cancel()
        assertNull(owner.finish(token))
    }
}
