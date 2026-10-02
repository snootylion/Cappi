package dev.dsh.watch.core

import org.junit.Assert.*
import org.junit.Test

class ReasoningSelectionTest {
    private val scope = ModelScope("https://bridge.example", "test-token", "thread-a")
    private val model = "opaque-model-a"
    private val low = ReasoningOption("effort:low", "Low", "Less reasoning")
    private val high = ReasoningOption("effort:high", "High")
    private val levels = ReasoningState(model, listOf(low, high), low.value, low.value, true, null)
    private val catalog = ModelCatalog(scope.sessionId,
        listOf(ModelOption(model, "Model A", "p", "a"), ModelOption("opaque-model-b", "Model B", "p", "b")),
        model, ModelCurrent("p", "a", "low"), reasoning = levels)
    private fun state(p: ModelPickerState = ModelPickerState(scope, 7, catalog)) = UiState(
        connected = true, base = scope.base, token = scope.token, sessionId = scope.sessionId, modelPicker = p)

    @Test fun currentEffortDisabledAndOnlyAdvertisedOpaqueValuesAreAllowed() {
        val s = state().copy(sessionRunning = true)
        val p = s.modelPicker!!
        assertFalse(p.canSetReasoning(s, model, low.value))
        assertTrue(p.canSetReasoning(s, model, high.value))
        assertFalse(p.canSetReasoning(s, model, "high")) // Actual raw native id is NOT an option token.
        assertFalse(p.canSetReasoning(s, model, "invented"))
    }

    @Test fun capturedModelCannotRetargetOrRestoreAnOldModel() {
        val changed = catalog.copy(currentValue = "opaque-model-b",
            reasoning = levels.copy(modelId = "opaque-model-b"))
        val s = state(ModelPickerState(scope, 7, changed))
        assertFalse(s.modelPicker!!.canSetReasoning(s, model, high.value))
        assertTrue(s.modelPicker.canSetReasoning(s, "opaque-model-b", high.value))
        val mismatched = state(ModelPickerState(scope, 7, catalog.copy(reasoning = levels.copy(modelId = "other"))))
        assertFalse(mismatched.modelPicker!!.canSetReasoning(mismatched, model, high.value))
    }

    @Test fun fixedEmptyMissingAndUnknownModelReasoningAreReadOnly() {
        for (c in listOf(catalog.copy(reasoning = null), catalog.copy(currentValue = null),
            catalog.copy(reasoning = levels.copy(adjustable = false)),
            catalog.copy(reasoning = levels.copy(options = listOf(high), currentValue = null)),
            catalog.copy(reasoning = levels.copy(options = emptyList())),
            catalog.copy(reasoning = levels.copy(modelId = null)))) {
            val s = state(ModelPickerState(scope, 7, c))
            assertFalse(s.modelPicker!!.canSetReasoning(s, model, high.value))
        }
    }

    @Test fun modelAndReasoningWritesShareOneBusyGate() {
        val s = state()
        for (p in listOf(s.modelPicker!!.copy(loading = true), s.modelPicker.copy(applying = "opaque-model-b"),
            s.modelPicker.copy(applying = model, applyingReasoning = high.value),
            s.modelPicker.copy(applyingReasoning = high.value))) {
            assertTrue(p.busy)
            assertFalse(p.canSetReasoning(s, model, high.value))
            assertFalse(p.canSelect(s, "opaque-model-b"))
        }
    }

    @Test fun offlineStaleAndErrorReasoningCannotBeSent() {
        val s = state()
        for (changed in listOf(s.copy(connected = false), s.copy(offlineClock = true),
            s.copy(sessionId = "other"), s.copy(base = "https://other.example"), s.copy(token = "different"))) {
            assertFalse(changed.modelPicker!!.canSetReasoning(changed, model, high.value))
        }
        assertFalse(s.modelPicker!!.invalidate().canSetReasoning(s, model, high.value))
        assertFalse(s.modelPicker.copy(error = "Unavailable").canSetReasoning(s, model, high.value))
    }

    @Test fun reasoningChangesOnlyAfterConfirmedResponse() {
        val s = state(ModelPickerState(scope, 8, catalog, applying = model, applyingReasoning = high.value))
        assertEquals(low.value, s.modelPicker!!.catalog!!.reasoning!!.currentValue)
        assertEquals("low", s.modelPicker.catalog!!.current!!.reasoningEffort)
        val confirmed = catalog.copy(current = ModelCurrent("p", "a", "high"),
            reasoning = levels.copy(currentValue = high.value))
        val done = s.applyModelCatalog(scope, 8, confirmed)
        assertEquals(high.value, done.modelPicker!!.catalog!!.reasoning!!.currentValue)
        assertEquals("high", done.modelPicker.catalog!!.current!!.reasoningEffort)
        assertNull(done.modelPicker.applyingReasoning)
        assertFalse(done.modelPicker.busy)
        assertSame(s, s.applyModelCatalog(scope, 7, confirmed))
    }

    @Test fun failedReasoningWriteClearsUnverifiedEffortWithoutRetry() {
        val s = state(ModelPickerState(scope, 8, catalog, applying = model, applyingReasoning = high.value))
        val failed = s.failModelRequest(scope, 8, "Model changed; refresh", true)
        assertNull(failed.modelPicker!!.catalog)
        assertNull(failed.modelPicker.applyingReasoning)
        assertNull(failed.modelPicker.applying)
        assertFalse(failed.modelPicker.busy)
        assertNotNull(failed.modelPicker.error)
    }

    @Test fun targetChangedAfterReasoningDispatchInvalidatesEntirePicker() {
        val s = state(ModelPickerState(scope, 8, catalog, applying = model, applyingReasoning = high.value))
        val done = s.applyModelCatalog(scope, 8, catalog.copy(targetChanged = true))
        assertTrue(done.modelPicker!!.invalidated)
        assertNull(done.modelPicker.catalog)
        assertNull(done.modelPicker.applyingReasoning)
    }

    @Test fun parserPreservesDefaultChoiceAndEffectiveVersusActualEffort() {
        val parsed = parseModelCatalog("""{"sessionId":"thread-a","options":[],"currentValue":"opaque-model-a",
          "current":{"provider":"p","model":"a","reasoningEffort":null},
          "reasoning":{"modelId":"opaque-model-a","options":[
            {"value":"provider-default","name":"Provider default"},
            {"value":"effort:adaptive-max","name":"Adaptive Max","description":"Native description"}],
            "currentValue":"provider-default","defaultValue":"provider-default","adjustable":true,"unavailableReason":null}}
        """)
        assertNull(parsed.current!!.reasoningEffort)
        assertEquals("provider-default", parsed.reasoning!!.currentValue)
        assertEquals("provider-default", parsed.reasoning.defaultValue)
        assertEquals("Native description", parsed.reasoning.options[1].description)
        val s = state(ModelPickerState(scope, 7, parsed))
        assertTrue(s.modelPicker!!.canSetReasoning(s, model, "effort:adaptive-max"))
        assertFalse(s.modelPicker.canSetReasoning(s, model, "provider-default"))
        val explicit = s.copy(modelPicker = s.modelPicker.copy(catalog = parsed.copy(
            reasoning = parsed.reasoning.copy(currentValue = "effort:adaptive-max"))))
        assertTrue(explicit.modelPicker!!.canSetReasoning(explicit, model, "provider-default"))
    }

    @Test fun parserKeepsUnsupportedReasonAndLegacyCatalogSafe() {
        val legacy = parseModelCatalog("""{"sessionId":"thread-a","options":[],"currentValue":null}""")
        assertNull(legacy.reasoning)
        val unsupported = parseModelCatalog("""{"sessionId":"thread-a","options":[],"currentValue":null,
          "reasoning":{"modelId":null,"options":[],"currentValue":null,"defaultValue":null,
          "adjustable":false,"unavailableReason":"Not supported by this model"}}""")
        assertFalse(unsupported.reasoning!!.adjustable)
        assertEquals("Not supported by this model", unsupported.reasoning.unavailableReason)
    }

    @Test fun malformedReasoningMetadataIsRejected() {
        val bad = listOf("[]", """{"options":[],"adjustable":"true"}""",
            """{"options":[],"adjustable":true,"currentValue":42}""",
            """{"options":[{"value":"x"}],"adjustable":true}""",
            """{"options":[{"value":"x","name":"A"},{"value":"x","name":"B"}],"adjustable":true}""")
        for (r in bad) {
            try {
                parseModelCatalog("""{"sessionId":"thread-a","options":[],"currentValue":null,"reasoning":$r}""")
                fail("Accepted malformed reasoning metadata")
            } catch (_: RuntimeException) { }
        }
    }
}
