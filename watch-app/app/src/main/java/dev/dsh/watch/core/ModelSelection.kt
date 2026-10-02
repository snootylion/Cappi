package dev.dsh.watch.core

import dev.dsh.watch.cappi.MiniJson

/** Opaque selection value is issued by the bridge; never split or synthesize it. */
data class ModelOption(val value: String, val name: String, val provider: String?, val modelId: String?, val providerName: String? = null)
data class ModelCurrent(val provider: String, val model: String, val reasoningEffort: String? = null)
data class ReasoningOption(val value: String, val name: String, val description: String? = null)
data class ReasoningState(val modelId: String?, val options: List<ReasoningOption>, val currentValue: String?,
    val defaultValue: String?, val adjustable: Boolean, val unavailableReason: String?)
data class ModelCatalog(val sessionId: String, val options: List<ModelOption>, val currentValue: String?,
    val current: ModelCurrent? = null, val scopeHint: String = "Also used for new or unconfigured threads",
    val targetChanged: Boolean = false, val reasoning: ReasoningState? = null)

data class ModelScope(
    val base: String,
    val token: String,
    val sessionId: String,
    val certPinSha256: String = "",
    val allowInsecureLan: Boolean = false,
    val ownerId: String = java.util.UUID.randomUUID().toString(),
) {
    fun matches(state: UiState): Boolean = base == state.base && token == state.token &&
        certPinSha256 == state.certPinSha256 && allowInsecureLan == state.allowInsecureLan &&
        sessionId == state.sessionId
    override fun toString(): String = "ModelScope(sessionId=$sessionId, credentials=redacted)"
}

fun UiState.modelScope() = ModelScope(base, token, sessionId, certPinSha256, allowInsecureLan)

data class ModelPickerState(
    val scope: ModelScope,
    val requestId: Long,
    val catalog: ModelCatalog? = null,
    val loading: Boolean = false,
    val applying: String? = null,
    val applyingReasoning: String? = null,
    val error: String? = null,
    val invalidated: Boolean = false,
) {
    fun accepts(state: UiState, request: Long): Boolean = !invalidated && requestId == request &&
        scope.sessionId.isNotBlank() && scope.matches(state) && state.connected && !state.offlineClock

    val busy: Boolean get() = loading || applying != null || applyingReasoning != null

    fun canSelect(state: UiState, value: String): Boolean = accepts(state, requestId) &&
        !busy && error == null && catalog?.sessionId == scope.sessionId &&
        catalog.currentValue != value && catalog.options.any { it.value == value }

    /** Rendered model and advertised reasoning choices must belong to the same current model. */
    fun canSetReasoning(state: UiState, expectedModel: String, effort: String): Boolean {
        val c = catalog ?: return false
        val r = c.reasoning ?: return false
        return accepts(state, requestId) && !busy && error == null && c.sessionId == scope.sessionId &&
            expectedModel.isNotBlank() && c.currentValue == expectedModel && r.modelId == expectedModel &&
            r.adjustable && r.options.size > 1 && r.currentValue != effort && r.options.any { it.value == effort }
    }

    fun invalidate(): ModelPickerState = copy(invalidated = true, loading = false, applying = null,
        applyingReasoning = null,
        catalog = null, error = "Thread or connection changed. Reopen Switch model.")

    // A failed write can have reached the server: never continue showing a guessed current model.
    fun failed(message: String, wasWrite: Boolean): ModelPickerState = copy(loading = false,
        applying = null, applyingReasoning = null, error = message, catalog = if (wasWrite) null else catalog)
}

/** Both the request owner and response body must match the original thread. */
fun UiState.applyModelCatalog(scope: ModelScope, request: Long, catalog: ModelCatalog): UiState {
    val p = modelPicker ?: return this
    if (p.scope != scope || !p.accepts(this, request) || catalog.sessionId != scope.sessionId) return this
    if (catalog.targetChanged) return copy(modelPicker = p.invalidate())
    return copy(modelPicker = p.copy(catalog = catalog, loading = false, applying = null,
        applyingReasoning = null, error = null))
}

fun UiState.failModelRequest(scope: ModelScope, request: Long, message: String, wasWrite: Boolean): UiState {
    val p = modelPicker ?: return this
    if (p.scope != scope || !p.accepts(this, request)) return this
    return copy(modelPicker = p.failed(message, wasWrite))
}

/** Strict, dependency-free parser also exercised by the JVM tests. */
fun parseModelCatalog(text: String): ModelCatalog {
    val root = MiniJson.parse(text) as? Map<*, *> ?: error("Invalid model response")
    fun requiredString(o: Map<*, *>, key: String): String =
        (o[key] as? String)?.takeIf { it.isNotBlank() } ?: error("Model response missing $key")
    fun optionalString(o: Map<*, *>, key: String): String? {
        val v = o[key] ?: return null
        require(v is String) { "Invalid model $key" }
        return v.takeIf { it.isNotBlank() }
    }
    val sessionId = requiredString(root, "sessionId")
    require(root.containsKey("currentValue")) { "Model response missing currentValue" }
    val current = optionalString(root, "currentValue")
    val raw = root["options"] as? List<*> ?: error("Model response missing options")
    val options = raw.map { item ->
        val o = item as? Map<*, *> ?: error("Invalid model option")
        ModelOption(requiredString(o, "value"), requiredString(o, "name"),
            optionalString(o, "provider"), optionalString(o, "modelId"), optionalString(o, "providerName"))
    }
    require(options.map { it.value }.distinct().size == options.size) { "Duplicate model values" }
    val selected = root["current"]?.let {
        val o = it as? Map<*, *> ?: error("Invalid current model")
        ModelCurrent(requiredString(o, "provider"), requiredString(o, "model"), optionalString(o, "reasoningEffort"))
    }
    val changed = root["targetChanged"] ?: false
    require(changed is Boolean) { "Invalid targetChanged flag" }
    val reasoning = root["reasoning"]?.let {
        val o = it as? Map<*, *> ?: error("Invalid reasoning metadata")
        val adjustable = o["adjustable"] as? Boolean ?: error("Invalid reasoning adjustable flag")
        val rows = o["options"] as? List<*> ?: error("Missing reasoning options")
        val levels = rows.map { row ->
            val r = row as? Map<*, *> ?: error("Invalid reasoning option")
            ReasoningOption(requiredString(r, "value"), requiredString(r, "name"), optionalString(r, "description"))
        }
        require(levels.map { r -> r.value }.distinct().size == levels.size) { "Duplicate reasoning values" }
        ReasoningState(optionalString(o, "modelId"), levels, optionalString(o, "currentValue"),
            optionalString(o, "defaultValue"), adjustable, optionalString(o, "unavailableReason"))
    }
    return ModelCatalog(sessionId, options, current, selected,
        optionalString(root, "scopeHint") ?: "Also used for new or unconfigured threads", changed, reasoning)
}
