package dev.dsh.watch.core

import org.junit.Assert.*
import org.junit.Test

class ModelSelectionTest {
    private val scope = ModelScope("https://bridge.example", "test-token", "thread-a")
    private val first = ModelOption("opaque-first", "First", "provider-a", "model-a")
    private val second = ModelOption("opaque-second", "Second", "provider-b", "model-b")
    private val catalog = ModelCatalog(scope.sessionId, listOf(first, second), first.value)
    private fun state(p: ModelPickerState = ModelPickerState(scope, 7, catalog)) = UiState(
        connected = true, base = scope.base, token = scope.token, sessionId = scope.sessionId, modelPicker = p)

    @Test fun currentModelDisabledButActualOtherModelSelectableEvenWhileWorking() {
        val s = state().copy(sessionRunning = true)
        val p = s.modelPicker!!
        assertFalse(p.canSelect(s, first.value))
        assertTrue(p.canSelect(s, second.value))
        assertFalse(p.canSelect(s, "invented"))
    }

    @Test fun busyOfflineAndInvalidatedSelectionsAreDisabled() {
        val s = state()
        for (p in listOf(s.modelPicker!!.copy(loading = true), s.modelPicker.copy(applying = second.value),
            s.modelPicker.copy(error = "Failed"), s.modelPicker.invalidate())) {
            assertFalse(p.canSelect(s, second.value))
        }
        assertFalse(s.modelPicker!!.canSelect(s.copy(connected = false), second.value))
        assertFalse(s.modelPicker.canSelect(s.copy(offlineClock = true), second.value))
        assertFalse(s.modelPicker.canSelect(s.copy(sessionId = "other"), second.value))
    }

    @Test fun noOptimisticSelectionAndConfirmedResponseWins() {
        val s = state(ModelPickerState(scope, 8, catalog, applying = second.value))
        assertEquals(first.value, s.modelPicker!!.catalog!!.currentValue)
        val confirmed = catalog.copy(currentValue = second.value)
        val done = s.applyModelCatalog(scope, 8, confirmed)
        assertEquals(second.value, done.modelPicker!!.catalog!!.currentValue)
        assertNull(done.modelPicker.applying)
    }

    @Test fun staleRequestOwnerBodyAndConnectionResponsesAreDropped() {
        val s = state()
        assertSame(s, s.applyModelCatalog(scope, 6, catalog))
        assertSame(s, s.applyModelCatalog(scope.copy(ownerId = "different-picker"), 7, catalog))
        assertSame(s, s.applyModelCatalog(scope, 7, catalog.copy(sessionId = "other")))
        for (changed in listOf(s.copy(sessionId = "other"), s.copy(base = "https://other.example"),
            s.copy(token = "new-token"), s.copy(connected = false), s.copy(offlineClock = true),
            s.copy(modelPicker = null))) {
            assertSame(changed, changed.applyModelCatalog(scope, 7, catalog))
            assertSame(changed, changed.failModelRequest(scope, 7, "late failure", true))
        }
    }

    @Test fun switchingAwayAndBackCannotReviveOldPicker() {
        val s = state()
        val sessionBack = s.withVisiblePending(emptyList(), "other").withVisiblePending(emptyList(), scope.sessionId)
        val baseBack = s.withQuestionConnection("https://other.example", scope.token)
            .withQuestionConnection(scope.base, scope.token)
        val tokenBack = s.withQuestionConnection(scope.base, "different")
            .withQuestionConnection(scope.base, scope.token)
        for (back in listOf(sessionBack, baseBack, tokenBack)) {
            assertTrue(back.modelPicker!!.invalidated)
            assertSame(back, back.applyModelCatalog(scope, 7, catalog))
            assertFalse(back.modelPicker.canSelect(back, second.value))
        }
    }

    @Test fun failedWriteClearsCurrentAndDoesNotRetryOrSelect() {
        val s = state(ModelPickerState(scope, 8, catalog, applying = second.value))
        val failed = s.failModelRequest(scope, 8, "Try refresh", true)
        assertNull(failed.modelPicker!!.catalog)
        assertNull(failed.modelPicker.applying)
        assertFalse(failed.modelPicker.loading)
        assertEquals("Try refresh", failed.modelPicker.error)
        assertFalse(failed.modelPicker.canSelect(failed, first.value))
    }

    @Test fun readFailureRetainsLastConfirmedButDisablesSelectionUntilRefresh() {
        val s = state(ModelPickerState(scope, 7, catalog, loading = true))
        val failed = s.failModelRequest(scope, 7, "Unavailable", false)
        assertEquals(catalog, failed.modelPicker!!.catalog)
        assertFalse(failed.modelPicker.canSelect(failed, second.value))
        assertFalse(failed.modelPicker.loading)
    }

    @Test fun parseActualCatalogPreservesOpaqueValuesAndProviderLabels() {
        val parsed = parseModelCatalog("""{
          "ok":true,"sessionId":"thread-a","options":[
           {"value":"opaque:first/+","name":"First","provider":"p","providerName":"Provider","modelId":"m"}],
          "currentValue":"opaque:first/+","current":{"provider":"p","model":"m","reasoningEffort":"high"},
          "scopeHint":"Also used for new or unconfigured threads","updatesDefault":true
        }""")
        assertEquals("opaque:first/+", parsed.options.single().value)
        assertEquals(parsed.options.single().value, parsed.currentValue)
        assertEquals("Provider", parsed.options.single().providerName)
        assertEquals(ModelCurrent("p", "m", "high"), parsed.current)
        assertEquals("Also used for new or unconfigured threads", parsed.scopeHint)
    }

    @Test fun canonicalCurrentOutsideCatalogRemainsAuthoritativeNotRequestedValue() {
        val parsed = parseModelCatalog("""{"sessionId":"thread-a","options":[],"currentValue":"canonical",
            "current":{"provider":"native-provider","model":"canonical-name"}}""")
        val s = state(ModelPickerState(scope, 8, catalog, applying = second.value))
        val done = s.applyModelCatalog(scope, 8, parsed)
        assertEquals("canonical", done.modelPicker!!.catalog!!.currentValue)
        assertEquals("canonical-name", done.modelPicker.catalog!!.current!!.model)
        assertNotEquals(second.value, done.modelPicker.catalog!!.currentValue)
    }

    @Test fun emptyAndUnknownCurrentAreNotInvented() {
        val parsed = parseModelCatalog("""{"sessionId":"thread-a","options":[],"currentValue":null,"current":null}""")
        assertTrue(parsed.options.isEmpty())
        assertNull(parsed.currentValue)
        assertNull(parsed.current)
        val unknown = state(ModelPickerState(scope, 7, catalog.copy(currentValue = null)))
        assertTrue(unknown.modelPicker!!.canSelect(unknown, second.value))
    }

    @Test fun malformedCatalogsAreRejected() {
        val bodies = listOf("{}", "[]", "null",
            """{"options":[],"currentValue":null}""",
            """{"sessionId":"thread-a","options":[]}""",
            """{"sessionId":"thread-a","options":null,"currentValue":null}""",
            """{"sessionId":"thread-a","options":[{"value":"","name":"A"}],"currentValue":null}""",
            """{"sessionId":"thread-a","options":[{"value":"x","name":"A"},{"value":"x","name":"B"}],"currentValue":null}""",
            """{"sessionId":"thread-a","options":[],"currentValue":42}""",
            """{"sessionId":"thread-a","options":[],"currentValue":null,"current":{"model":"m"}}""")
        for (body in bodies) {
            try { parseModelCatalog(body); fail("Accepted malformed catalog") } catch (_: RuntimeException) { }
        }
    }

    @Test fun backendTargetChangedInvalidatesBeforeLocalSseCatchesUp() {
        val confirmed = parseModelCatalog("""{"sessionId":"thread-a","options":[],
            "currentValue":"confirmed-old-thread","current":{"provider":"p","model":"m"},"targetChanged":true}""")
        val s = state(ModelPickerState(scope, 8, catalog, applying = second.value))
        val done = s.applyModelCatalog(scope, 8, confirmed)
        assertEquals(scope.sessionId, done.sessionId) // SSE has not updated yet.
        assertTrue(done.modelPicker!!.invalidated)
        assertNull(done.modelPicker.catalog)
        assertNull(done.modelPicker.applying)
        assertFalse(done.modelPicker.canSelect(done, second.value))
        assertFalse(parseModelCatalog("""{"sessionId":"thread-a","options":[],"currentValue":null}""").targetChanged)
    }

    @Test fun tokensAreNotInScopeDiagnostics() {
        assertFalse(scope.toString().contains(scope.token))
    }
}
