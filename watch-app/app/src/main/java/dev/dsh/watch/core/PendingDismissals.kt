package dev.dsh.watch.core

import java.nio.ByteBuffer
import java.security.MessageDigest

/** Watch-only tombstones: no answer/deny/cancel commands or question text stored.
 * A new request or changed wizard card has a different fingerprint and is shown.
 * Keep at most512 recent dismissals; immutable snapshots allow SSE/UI concurrency.
 */
class PendingDismissals(saved: String = "", private val limit: Int = 512) {
    @Volatile private var keys: List<String> = saved.lineSequence()
        .filter { it.matches(Regex("[0-9a-f]{64}")) }.distinct().toList().takeLast(limit)

    init { require(limit > 0) }

    @Synchronized
    fun dismiss(base: String, token: String, item: Approval): String {
        val key = fingerprint(base, token, item)
        keys = (keys.filterNot { it == key } + key).takeLast(limit)
        return keys.joinToString("\n")
    }

    fun visible(base: String, token: String, items: List<Approval>): List<Approval> {
        val hidden = keys.toSet()
        return items.filterNot { fingerprint(base, token, it) in hidden }
    }

    private fun fingerprint(base: String, token: String, item: Approval): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val fields = listOf(base.trim().trimEnd('/'), token, item.id, item.kind,
            item.title, item.detail.orEmpty(), item.multi.toString()) +
            item.options.flatMap { listOf(it.id, it.label) }
        for (field in fields) {
            val bytes = field.toByteArray(Charsets.UTF_8)
            digest.update(ByteBuffer.allocate(4).putInt(bytes.size).array())
            digest.update(bytes)
        }
        return digest.digest().joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
    }
}
