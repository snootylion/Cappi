package dev.dsh.watch.cappi

/** Clip playback mode, mirroring the manifest schema. */
enum class ClipMode { ONCE, NEUTRAL_LOOP, ENTER_LOOP_EXIT, HOLD }

data class ClipInfo(val file: String, val durationS: Double)

data class CappiAction(
    val id: String,
    val mode: ClipMode,
    val clips: List<String>,
    val modelSelectable: Boolean,
)

data class CappiManifest(val actions: List<CappiAction>, val clips: Map<String, ClipInfo>) {
    fun action(id: String): CappiAction? = actions.firstOrNull { it.id == id }
}

/**
 * Dependency-free JSON reader for the machine-generated manifest shape
 * (objects, arrays, strings, numbers, booleans, null). Keeps the parser unit
 * testable on plain JVM without android.jar behaviour or extra dependencies.
 */
internal object MiniJson {
    fun parse(text: String): Any? {
        val p = Parser(text)
        val v = p.parseValue()
        p.skipWs()
        require(p.i == text.length) { "trailing content at ${p.i}" }
        return v
    }

    private class Parser(val s: String) {
        var i = 0
        fun parseValue(): Any? {
            skipWs()
            require(i < s.length) { "unexpected end of JSON" }
            return when (s[i]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> parseString()
                't' -> expect("true", true)
                'f' -> expect("false", false)
                'n' -> expect("null", null)
                else -> parseNumber()
            }
        }

        fun skipWs() {
            while (i < s.length && s[i].isWhitespace()) i++
        }

        private fun parseObject(): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            i++ // {
            skipWs()
            if (i < s.length && s[i] == '}') {
                i++
                return out
            }
            while (true) {
                skipWs()
                require(i < s.length && s[i] == '"') { "expected string key at $i" }
                val key = parseString()
                skipWs()
                require(i < s.length && s[i] == ':') { "expected ':' at $i" }
                i++
                out[key] = parseValue()
                skipWs()
                require(i < s.length) { "unterminated object" }
                if (s[i] == '}') {
                    i++
                    return out
                }
                require(s[i] == ',') { "expected ',' at $i" }
                i++
            }
        }

        private fun parseArray(): List<Any?> {
            val out = ArrayList<Any?>()
            i++ // [
            skipWs()
            if (i < s.length && s[i] == ']') {
                i++
                return out
            }
            while (true) {
                out.add(parseValue())
                skipWs()
                require(i < s.length) { "unterminated array" }
                if (s[i] == ']') {
                    i++
                    return out
                }
                require(s[i] == ',') { "expected ',' at $i" }
                i++
            }
        }

        private fun parseString(): String {
            require(s[i] == '"')
            i++
            val sb = StringBuilder()
            while (true) {
                require(i < s.length) { "unterminated string" }
                val c = s[i++]
                if (c == '"') return sb.toString()
                if (c != '\\') {
                    sb.append(c)
                    continue
                }
                require(i < s.length) { "unterminated escape" }
                when (val e = s[i++]) {
                    '"', '\\', '/' -> sb.append(e)
                    'b' -> sb.append('\b')
                    'f' -> sb.append('\u000C')
                    'n' -> sb.append('\n')
                    'r' -> sb.append('\r')
                    't' -> sb.append('\t')
                    'u' -> {
                        require(i + 4 <= s.length) { "bad unicode escape" }
                        sb.append(s.substring(i, i + 4).toInt(16).toChar())
                        i += 4
                    }
                    else -> throw IllegalArgumentException("bad escape \\$e")
                }
            }
        }

        private fun parseNumber(): Double {
            val start = i
            while (i < s.length && s[i] !in ",:]}\"' \t\n\r") i++
            return s.substring(start, i).toDouble()
        }

        private fun expect(word: String, value: Any?): Any? {
            require(s.startsWith(word, i)) { "expected $word at $i" }
            i += word.length
            return value
        }
    }
}

@Suppress("UNCHECKED_CAST")
fun parseCappiManifest(json: String): CappiManifest {
    val root = MiniJson.parse(json) as? Map<String, Any?>
        ?: throw IllegalArgumentException("manifest root must be an object")
    require((root["schema_version"] as? Double)?.toInt() == 1) { "unsupported manifest schema" }
    val clipsRaw = root["clips"] as? Map<String, Any?> ?: throw IllegalArgumentException("manifest lacks clips")
    val clips = clipsRaw.mapValues { (name, v) ->
        val o = v as? Map<String, Any?> ?: throw IllegalArgumentException("bad clip $name")
        val w = (o["width"] as? Double)?.toInt()
        val h = (o["height"] as? Double)?.toInt()
        require(w == 98 && h == 98) { "PoC pack contract: clip $name is ${w}x$h, want 98x98" }
        ClipInfo(file = name, durationS = (o["duration_s"] as? Double) ?: 0.0)
    }
    val actionsRaw = root["actions"] as? List<Any?> ?: throw IllegalArgumentException("manifest lacks actions")
    val actions = actionsRaw.map { a ->
        val o = a as? Map<String, Any?> ?: throw IllegalArgumentException("bad action")
        val id = o["id"] as? String ?: throw IllegalArgumentException("action lacks id")
        val mode = when (o["mode"] as? String) {
            "once" -> ClipMode.ONCE
            "neutral_loop" -> ClipMode.NEUTRAL_LOOP
            "enter_loop_exit" -> ClipMode.ENTER_LOOP_EXIT
            "hold" -> ClipMode.HOLD
            else -> throw IllegalArgumentException("action $id has unknown mode")
        }
        val files = (o["clips"] as? List<Any?>)?.map { it as? String ?: throw IllegalArgumentException("bad clip ref in $id") }
            ?: throw IllegalArgumentException("action $id lacks clips")
        require(files.isNotEmpty()) { "action $id has no clips" }
        files.forEach { require(clips.containsKey(it)) { "action $id references missing clip $it" } }
        if (mode == ClipMode.ENTER_LOOP_EXIT) require(files.size == 3) { "action $id must be [enter, loop, exit]" }
        CappiAction(
            id = id,
            mode = mode,
            clips = files,
            modelSelectable = (o["model_selectable"] as? Boolean) ?: false,
        )
    }
    return CappiManifest(actions = actions, clips = clips)
}
