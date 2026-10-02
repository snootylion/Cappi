package dev.dsh.watch.service

import org.junit.Assert.*
import org.junit.Test

/**
 * Watchdog + status-contract guards (pure JVM, no AudioRecord, no sockets).
 * Covers: bounded uplink constants, publish/clear generation fencing, and
 * the privacy rule (snapshots carry counts/buckets only — never audio,
 * transcripts, URLs, or secrets).
 */
class MicStatusTest {

    @Test fun uplinkIsBounded() {
        assertEquals(40_000L, MicStatus.WRITE_WATCHDOG_MS)
        assertEquals(1_800_000L, MicStatus.ABSOLUTE_CAP_MS) // thirty minutes, not the same typo as production
        assertTrue(MicStatus.WRITE_WATCHDOG_MS < MicStatus.ABSOLUTE_CAP_MS)
    }

    @Test fun publishAndClearAreGenerationFenced() {
        val gen = System.currentTimeMillis()
        MicStatus.publish(MicStatus.Snapshot(gen, "s-1", "capturing", txChunks = 3, txBytes = 12288))
        assertEquals("capturing", MicStatus.flow.value?.state)
        assertEquals(3L, MicStatus.flow.value?.txChunks)
        assertEquals(12288L, MicStatus.flow.value?.txBytes)
        // A stale clear for another generation must not wipe the live one.
        MicStatus.clear(gen + 1)
        assertEquals("capturing", MicStatus.flow.value?.state)
        MicStatus.clear(gen)
        assertNull(MicStatus.flow.value)
    }

    @Test fun snapshotsCarryNoSensitivePayload() {
        val snap = MicStatus.Snapshot(1L, "watch-1", "capturing",
            txChunks = 10, txBytes = 40960, zeroChunks = 2, readErrors = 1, rmsBucket = 42)
        // Privacy: only counters + buckets. There is simply no field for raw
        // audio, transcripts, URLs, tokens, or pins — assert the shape.
        val fields = snap.javaClass.declaredFields.map { it.name }.toSet()
        assertTrue(fields.containsAll(setOf("txChunks", "txBytes", "zeroChunks", "readErrors", "rmsBucket")))
        for (forbidden in listOf("audio", "pcm", "transcript", "url", "token", "secret", "pin")) {
            assertTrue("snapshot must not carry $forbidden", fields.none { it.contains(forbidden, ignoreCase = true) })
        }
    }
}
