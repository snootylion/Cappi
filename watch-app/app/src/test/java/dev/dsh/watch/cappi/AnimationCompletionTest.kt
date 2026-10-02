package dev.dsh.watch.cappi

import org.junit.Assert.assertEquals
import org.junit.Test

class AnimationCompletionTest {
    @Test fun queuedEndAfterCancelIsHarmless() {
        var resumes = 0
        val c = AnimationCompletion { resumes++ }
        c.cancel()
        c.complete()
        c.complete()
        assertEquals(0, resumes)
    }
    @Test fun duplicateEndResumesOnce() {
        var resumes = 0
        val c = AnimationCompletion { resumes++ }
        c.complete()
        c.complete()
        c.cancel()
        assertEquals(1, resumes)
    }
    @Test fun oldCallbackCannotAdvanceNewAnimation() {
        var oldCount = 0
        var newCount = 0
        val old = AnimationCompletion { oldCount++ }
        old.cancel()
        val next = AnimationCompletion { newCount++ }
        old.complete()
        assertEquals(0, oldCount)
        assertEquals(0, newCount)
        next.complete()
        assertEquals(1, newCount)
    }
}
