package dev.dsh.watch.net

import org.junit.Assert.*
import org.junit.Test
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import kotlin.concurrent.thread

class LanDiscoveryTest {
    @Test fun tenProbesSentUpfrontOnSameSocketEvenWhenOnlyLastResponds() {
        val host = InetAddress.getByName("127.0.0.1")
        val servers = (1..10).map { DatagramSocket(0, host).apply { soTimeout = 1000 } }
        val origins = java.util.Collections.synchronizedList(mutableListOf<Int>())
        val workers = servers.mapIndexed { i, socket -> thread {
            val packet = DatagramPacket(ByteArray(513), 513)
            socket.receive(packet)
            origins.add(packet.port)
            if (i == 9) {
                val nonce = String(packet.data, 0, packet.length).substringAfter(' ')
                val reply = "DSHW1BRIDGE $nonce 19999".toByteArray()
                socket.send(DatagramPacket(reply, reply.size, packet.address, packet.port))
            }
        } }
        try {
            val found = LanDiscovery.scan(1000, ports = servers.map { it.localPort }, address = host) { _, _ -> true }
            workers.forEach { it.join(1500) }
            assertEquals(listOf("127.0.0.1:19999"), found)
            assertEquals(10, origins.size)
            assertEquals(1, origins.toSet().size)
            assertEquals((8788..8797).toList(), LanDiscovery.DEFAULT_PORTS)
        } finally { servers.forEach { it.close() } }
    }

    @Test fun eightPacketsTotalOversizeAndForeignCannotBecomeCandidates() {
        val host = InetAddress.getByName("127.0.0.1")
        val server = DatagramSocket(0, host)
        val worker = thread {
            val packet = DatagramPacket(ByteArray(513), 513); server.receive(packet)
            val nonce = String(packet.data, 0, packet.length).substringAfter(' ')
            repeat(8) {
                val reply = (if (it == 0) "DSHW1BRIDGE $nonce 19999" + " ".repeat(600) else "DSHW1BRIDGE wrong 19999").toByteArray()
                server.send(DatagramPacket(reply, reply.size, packet.address, packet.port))
            }
            val reply = "DSHW1BRIDGE $nonce 19999".toByteArray()
            server.send(DatagramPacket(reply, reply.size, packet.address, packet.port))
        }
        try { assertTrue(LanDiscovery.scan(1000, ports = listOf(server.localPort), address = host).isEmpty()) }
        finally { worker.join(1500); server.close() }
    }

    @Test fun boundedRawBodyAndInvalidUtf8NeverEchoPrivateBytes() {
        assertEquals("{}", PairingTransport.readBoundedUtf8("{}".byteInputStream()))
        for (bytes in listOf(ByteArray(16385) { 65 }, byteArrayOf(0xc3.toByte(), 0x28))) {
            try { PairingTransport.readBoundedUtf8(bytes.inputStream()); fail("must reject") }
            catch (e: java.io.IOException) { assertTrue(e.message!!.startsWith("JSON body")) }
        }
        for (text in listOf("{\"x\":01}", "{\"x\":-01}", "{\"x\":1}\u00a0")) {
            try { StrictJson.parse(text); fail("invalid JSON grammar") } catch (_: java.io.IOException) { }
        }
    }
}
