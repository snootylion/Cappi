package dev.dsh.watch.device

import dev.dsh.watch.core.QueueLine
import dev.dsh.watch.core.TodoItem
import dev.dsh.watch.core.UiState
import dev.dsh.watch.ui.mainMenuEntries
import org.junit.Assert.*
import org.junit.Test

class ProfileMenuTest {

    private fun state() = UiState(
        base = "", token = "",
        todos = listOf(TodoItem("t", "pending")),
        queue = listOf(QueueLine("q", "hi", "queued")),
    )

    @Test fun legacyListKeepsSamsungEntry() {
        val routes = mainMenuEntries(state()).map { it.route }
        assertTrue(routes.contains("samsung-home"))
    }

    @Test fun genericProfileHidesVendorEntryButKeepsCounts() {
        val entries = mainMenuEntries(state(), GenericWearOsProfile)
        val routes = entries.map { it.route }
        assertFalse(routes.contains("samsung-home"))
        assertEquals(1, entries.first { it.route == "todos" }.count)
        assertEquals(1, entries.first { it.route == "queue" }.count)
        assertEquals(routes.size, routes.distinct().size)
        // Head of the menu is unchanged apart from the vendor row.
        assertEquals(listOf("pairing", "connection", "sessions", "models", "wifi-settings", "watch-settings", "buttons", "avatar-toggle"),
            routes.take(8))
    }

    @Test fun avatarTogglePresentOnEveryProfileWithoutHardware() {
        // Generic Wear OS must offer the companion/remote switch by touch:
        // no Samsung buttons, no vendor intents, no hardware shortcut required.
        for (profile in listOf(GenericWearOsProfile, GalaxyWatch4Profile)) {
            val entries = mainMenuEntries(state(), profile)
            assertTrue(entries.any { it.route == "avatar-toggle" })
            assertEquals("Avatar mode · Off",
                mainMenuEntries(state().copy(avatarMode = false), profile).first { it.route == "avatar-toggle" }.label)
            assertEquals("Avatar mode · On",
                mainMenuEntries(state().copy(avatarMode = true), profile).first { it.route == "avatar-toggle" }.label)
        }
    }

    @Test fun galaxyProfileKeepsVendorEntry() {
        val routes = mainMenuEntries(state(), GalaxyWatch4Profile).map { it.route }
        assertEquals(mainMenuEntries(state()).map { it.route }, routes)
    }
}
