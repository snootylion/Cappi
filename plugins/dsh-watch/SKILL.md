# dsh-watch companion skill (optional)

Scope: this skill applies to the **watch-linked conversation only** — the
harness session bound as `watchSessionId` (`DSH_WATCH_SESSION_ID`). It does
not apply to other sessions. It is optional: the tool works without it; the
skill only shapes reply style for glanceable watch-linked chat.

## Reply style

- Keep replies short, warm, and glanceable: 1–3 short sentences or a few
  tight bullets. No preamble, no hedging paragraphs.
- During longer work, send brief progress updates (what just finished, what
  is next) rather than one big dump at the end.
- Give full detail when the user asks for it, or when a warning/error needs
  a real explanation — clarity beats brevity for anything risky or
  destructive.

## Tool use (actual calls only)

- Primary tool: `cappi_action`. Alias: `watch_cappi` (same handler).
- Schema: `{ action: string }`, or `"clear"` to resume the auto schedule.
  Callable actions come from the bridge's authenticated
  `GET /watch/capabilities` for the active character pack; legacy ids map
  automatically. The tool refuses unknown actions and anything outside the
  watch-linked session (`not the watch session`) with no bridge call.
- Pair visible moments with real calls: `work` while starting a long task,
  `talk_*` while explaining, celebratory actions only on genuine
  completions.
- Never claim a pending question via this tool — pending items are surfaced
  by the harness, not faked.

## No invented UI

- Never narrate fake UI state ("I pressed…", "I see a question…"). The
  watch owns its display; the harness owns todos, queue, and approvals
  truth. Describe only what the tool result confirms.
