package dev.dsh.watch.core

import org.json.JSONObject

/**
 * Session collaborator: command bodies and snapshot application for
 * sessions/projects/permissions/models. Stateless; the [BridgeViewModel] owns
 * coroutine dispatch and the SSE lifecycle.
 */
object SessionCenter {

    fun sessionsCommand(): JSONObject = JSONObject().put("cmd", "sessions")

    fun selectSessionCommand(sessionId: String): JSONObject =
        JSONObject().put("cmd", "select-session").put("sessionId", sessionId)

    fun projectsCommand(): JSONObject = JSONObject().put("cmd", "projects")

    fun newSessionCommand(workspaceId: String?, cwd: String?): JSONObject {
        val body = JSONObject().put("cmd", "new-session")
        when {
            !workspaceId.isNullOrEmpty() -> body.put("workspaceId", workspaceId)
            !cwd.isNullOrEmpty() -> body.put("cwd", cwd)
        }
        return body
    }

    /**
     * {cmd:"set-permission", preset, sessionId}: the session id is the
     * captured watch session the operator acted on, so the bridge can apply
     * its 409 session-binding check (missing → 400, none watched → 409,
     * mismatch → 409 with no state change). Omitted when blank (bridge
     * rejects as missing rather than applying to a rotated session).
     *
     * [setPermissionJson] is the pure, unit-testable body builder;
     * [setPermissionCommand] wraps it for the transport without changing keys.
     */
    fun setPermissionJson(preset: String, sessionId: String = ""): String {
        fun esc(s: String): String = s.replace("\\", "\\\\").replace("\"", "\\\"")
        return if (sessionId.isNotBlank()) {
            "{\"cmd\":\"set-permission\",\"preset\":\"${esc(preset)}\",\"sessionId\":\"${esc(sessionId)}\"}"
        } else {
            "{\"cmd\":\"set-permission\",\"preset\":\"${esc(preset)}\"}"
        }
    }

    fun setPermissionCommand(preset: String, sessionId: String = ""): JSONObject =
        JSONObject(setPermissionJson(preset, sessionId))

    fun modelCommand(scope: ModelScope, modelId: String?, reasoningEffort: String?): JSONObject {
        val cmd = when {
            reasoningEffort != null -> "set-reasoning"
            modelId != null -> "set-model"
            else -> "models"
        }
        val body = JSONObject().put("cmd", cmd).put("sessionId", scope.sessionId)
        if (modelId != null) body.put("modelId", modelId)
        if (reasoningEffort != null) body.put("reasoningEffort", reasoningEffort)
        return body
    }
}
