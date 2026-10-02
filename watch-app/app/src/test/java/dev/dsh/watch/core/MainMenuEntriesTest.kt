package dev.dsh.watch.core

import dev.dsh.watch.ui.mainMenuEntries
import org.junit.Assert.*
import org.junit.Test

class MainMenuEntriesTest {
    @Test fun primaryOrderAndRemainingEntriesStayStable() {
        val entries = mainMenuEntries(UiState(base = "", token = ""))
        assertEquals(listOf("Pair with Mac", "Disconnect", "Switch thread", "Switch model", "Wi-Fi"), entries.take(5).map { it.label })
        assertEquals(listOf("pairing", "connection", "sessions", "models", "wifi-settings"), entries.take(5).map { it.route })
        assertEquals(listOf("watch-settings", "buttons", "avatar-toggle", "samsung-home", "todos", "jobs", "agents",
            "pending", "queue", "images", "projects", "permissions", "status", "type", "settings"),
            entries.drop(5).map { it.route })
        assertEquals(entries.size, entries.map { it.route }.distinct().size)
    }

    @Test fun avatarToggleLabelFollowsMode() {
        val off = mainMenuEntries(UiState(base = "", token = "", avatarMode = false))
        assertEquals("Avatar mode · Off", off.first { it.route == "avatar-toggle" }.label)
        val on = mainMenuEntries(UiState(base = "", token = "", avatarMode = true))
        assertEquals("Avatar mode · On", on.first { it.route == "avatar-toggle" }.label)
    }

    @Test fun reconnectLabelAndExistingCountsArePreserved() {
        val entries = mainMenuEntries(UiState(base = "", token = "", offlineClock = true,
            todos = listOf(TodoItem("Test", "pending")), queue = listOf(QueueLine("q", "Hi", "queued"))))
        assertEquals("Reconnect", entries.first { it.route == "connection" }.label)
        assertEquals(1, entries.first { it.route == "todos" }.count)
        assertEquals(1, entries.first { it.route == "queue" }.count)
    }
}
