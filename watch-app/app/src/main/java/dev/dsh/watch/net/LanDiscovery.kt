package dev.dsh.watch.net

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.UUID

/** UDP candidates are untrusted. One socket, ten upfront probes, bounded total work. */
internal object LanDiscovery {
    val DEFAULT_PORTS = (8788..8797).toList()

    fun scan(
        timeoutMs: Int,
        cancelled: (() -> Boolean)? = null,
        ports: List<Int> = DEFAULT_PORTS,
        address: InetAddress = InetAddress.getByName("255.255.255.255"),
        accept: (String, Int) -> Boolean = { _, _ -> false },
    ): List<String> {
        if (cancelled?.invoke() == true) return emptyList()
        val deadline = System.nanoTime() + timeoutMs.coerceIn(250, 3000) * 1_000_000L
        fun remaining(): Int = ((deadline - System.nanoTime()) / 1_000_000).toInt().coerceAtLeast(0)
        val nonce = UUID.randomUUID().toString().replace("-", "")
        val probe = "DSHW1DISCOVER $nonce".toByteArray(Charsets.UTF_8)
        val prefix = "DSHW1BRIDGE $nonce "
        val found = ArrayList<String>()
        DatagramSocket().use { sock ->
            sock.broadcast = true
            for (port in ports) {
                if (remaining() <= 0 || cancelled?.invoke() == true) return found
                sock.send(DatagramPacket(probe, probe.size, address, port))
            }
            // Extra byte detects truncated oversize replies; never accept their prefix.
            val buffer = ByteArray(513)
            repeat(8) {
                if (remaining() <= 0 || cancelled?.invoke() == true) return found
                sock.soTimeout = remaining().coerceAtLeast(1)
                val packet = DatagramPacket(buffer, buffer.size)
                try { sock.receive(packet) } catch (_: SocketTimeoutException) { return found }
                if (packet.length > 512) return@repeat
                val text = String(packet.data, 0, packet.length, Charsets.UTF_8).trim()
                if (!text.startsWith(prefix)) return@repeat
                val portText = text.removePrefix(prefix)
                if (!portText.matches(Regex("[0-9]{1,5}"))) return@repeat
                val port = portText.toIntOrNull()?.takeIf { it in 1..65535 } ?: return@repeat
                val rawHost = packet.address.hostAddress ?: return@repeat
                val host = if (':' in rawHost) "[$rawHost]" else rawHost
                val candidate = "$host:$port"
                if (candidate !in found) {
                    found.add(candidate)
                    if (remaining() > 0 && accept(candidate, remaining())) return found
                }
            }
        }
        return found
    }
}
