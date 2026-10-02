package dev.dsh.watch.device

import org.junit.Assert.*
import org.junit.Test

class DeviceSettingsTest {

    @Test fun placeholderDetection() {
        assertTrue(DeviceSettings.isPlaceholderEndpoint(null))
        assertTrue(DeviceSettings.isPlaceholderEndpoint(""))
        assertTrue(DeviceSettings.isPlaceholderEndpoint("   "))
        assertTrue(DeviceSettings.isPlaceholderEndpoint("http://192.0.2.1:8787"))
        assertTrue(DeviceSettings.isPlaceholderEndpoint("http://192.0.2.1"))
        assertFalse(DeviceSettings.isPlaceholderEndpoint("http://192.168.1.10:8787"))
        assertFalse(DeviceSettings.isPlaceholderEndpoint("https://bridge.example.com"))
    }

    @Test fun storageContractIsStable() {
        // Package id + prefs file retained; only new keys added.
        assertEquals("dsh_remote", DeviceSettings.PREFS_NAME)
        assertEquals("device_profile_override", DeviceSettings.KEY_PROFILE_OVERRIDE)
        assertEquals("home_alias_enabled", DeviceSettings.KEY_HOME_ALIAS_ENABLED)
        assertEquals("dev.dsh.watch.RemoteHomeActivity", WatchDevice.HOME_ALIAS_CLASS)
    }
}
