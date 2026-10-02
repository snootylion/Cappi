# Cappi plugin + skill — manual follow-up (NOT installed by automation)

The watch ↔ bridge path is implemented and tested (Phase 4, desktop):
`POST /watch/cappi` → validated → `t: 'cappi'` SSE → watch holds the action
(60 s timeout) → scheduler plays it subject to pending/offline overrides.

What remains is harness-side: a `cappi_action` tool so the **model** can request
actions, and a companion skill for reply style. Installing anything into the
live DSH profile is parent-owned — do it by hand, following the repo's plugin
conventions (cf. the investigated `@deepseek-ai/dsh-tools` registration types).

## Tool contract: `cappi_action`

- **Name:** `cappi_action`
- **Description (for the model):** "Show a Cappi avatar animation on the user's
  Galaxy Watch (avatar mode). Use sparingly: celebrations on real completions,
  work while doing longer tasks, talk while explaining. Never claim a pending
  question via this tool — pending items are surfaced by the harness, not faked."
- **Schema:** `{ action: string }` where action is one of the 18 allowlisted ids
  (see `bridge/cappi.mjs` `CAPPI_ALLOWLIST`), or `"clear"` to return Cappi to
  the auto schedule.
- **Handler behavior:**
  1. Reject anything off the allowlist (mirror `parseCappiCommand` semantics —
     never invent assets/URLs).
  2. Session scope: only act when the calling session is the watch-linked
     session (same targeting rules as todos/approvals); otherwise return
     `{ ok: false, error: 'not the watch session' }`.
  3. Read the bridge token from `dsh-watch/bridge/token` (mode 600, same user),
     `POST http://127.0.0.1:8787/watch/cappi` with `{"action": …}`.
     The bridge is transport-agnostic — loopback works; LAN token rules apply.
  4. Return the bridge's `{ ok, action }` (or its error) as the tool result.
- **Test before enabling:** with the bridge running and the watch on avatar
  mode, invoke the tool (real session, harmless moment): `dance` → watch plays
  the dance clip once; `clear` → auto schedule resumes. Record the run here.

## Skill: `cappi` (companion style for the watch-linked conversation)

Scope: applies to the watch-linked Cappi conversation only, not every session.

- Keep replies short, warm and glanceable: 1–3 short sentences or a few
  tight bullets. No preamble, no hedging paragraphs.
- During longer work, send brief progress updates (what just finished, what is
  next) rather than one big dump at the end.
- Full detail when the user asks for it, or when a warning/error needs a real
  explanation — clarity beats brevity for anything risky or destructive.
- Pair visible moments with tool calls: `work` while starting a long task,
  `talk_*` while explaining, `dance`/`shadow` only on genuine completions.
- Never narrate fake UI state ("I pressed…", "I see a question…") — the watch
  owns its display; the harness owns todos, queue and approvals truth.
