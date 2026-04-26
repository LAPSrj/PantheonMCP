# Watchdog

`src/watchdog/` owns the per-session auto-rest timer described in §14.
It does not write to disk; it owns timers + last-activity stamps and
fires a deadline callback that flips the session to resting via the
identity layer.

## What it watches

A **session** — one MCP-proxy connection from a Claude Code (or any
MCP client) tab to the daemon. Sessions are runtime-only state per
§15: lost on daemon restart and re-armed when the proxy reconnects
and the session is re-registered. The watchdog never persists.

## Per-session `rest_timeout`

Carried on each `summon` / `conjure` / `summon_any` / `conjure_any`
call. Stored on the session record (NOT on the persona profile) so
two summons of the same persona get independent timers.

| Value          | Meaning                                                |
|----------------|--------------------------------------------------------|
| `3600` (default) | Seconds. Minimum 3600 (60 min) per §14.              |
| `> 3600`       | Larger windows allowed; no upper bound.                |
| `"never"`      | String literal disables auto-rest entirely. **No timer is armed at all** — not just a long timer. |

`< 3600` is rejected (`rest_timeout_too_short`). `0`, `-1`, `null`,
or any non-finite number is rejected (`rest_timeout_invalid`). Use
the explicit `"never"` to disable.

## Reset triggers (§14)

The watchdog re-arms its timer on every `touch(sessionId)` call.
Tool handlers should call `Watchdog.touch` after any qualifying
activity. The trigger taxonomy lives in `src/watchdog/triggers.ts`:

- **`RESET_TRIGGER_TOOLS`** — minimum coverage list, mirroring §14:
  `send_message`, `update_status`, `ask`, `answer`, `set_mode`,
  `append_memory`, `update_memory`, `fade_memory`, `forget_memory`,
  `recall_memory`, `get_memory_details`, `set_memory`, `claim`,
  `manifest`, `become`, `register`, `update_profile`, `unregister`,
  `extend_rest`.
- **`NON_RESET_TOOLS`** — pure observation that should NOT reset:
  `check_messages`, `list_agents`, `list`, `whoami`, `session_info`,
  `get_memory`, `list_memory`, `find_role`. These are reads where
  the agent is observed (peers / clients querying it) rather than
  observing.
- **Unknown tools** default to reset (`isResetTrigger` returns true).
  Better to over-reset than to forget to wire a new tool and have an
  actively-working agent get auto-rested.

In **vanilla MCP mode**, the dispatcher additionally calls
`Watchdog.touch(sessionId)` on every incoming MCP request from the
session — broader than the explicit list, matching §14's "we already
see every call; treat as activity" rule. The explicit list still
matters as documentation and as the floor for the plugin path.

In **plugin mode**, the CC `PreToolUse` hook also calls
`Watchdog.touch(sessionId)` on every tool-use event, including
non-MCP tools (Read / Edit / Bash / etc.) — the §14 "richer signal"
the plugin gets that vanilla MCP cannot.

The watchdog does NOT reset on:

- Watcher events received (the agent is observed, not observing).
- Keepalive heartbeats from the chat router.
- Daemon-internal queries from peers (e.g. another agent calling
  `list({ query })` looking for a role).

These never call `touch`.

## On deadline

When the timer fires, `onDeadline(session)` runs. The default,
`defaultOnDeadline`, calls `transitionRestEnter(session)` from the
identity layer — the session flips to `claimed_persona(*)` with
`resting: true`. The chat subscription is NOT torn down; rest is a
session state, not a logout.

Persisting the new rest_reason to the persona registry (via
`stampRested(paths, username, "auto_rest_timeout", ...)`) is the
caller's responsibility. The watchdog does not write to disk so it
stays trivially testable. The daemon's wiring composes the two:

```ts
wd.register({
  session,
  rest_timeout: 3600,
  onDeadline: (s) => {
    defaultOnDeadline(s);
    if (s.claimedUsername) {
      stampRested(paths, s.claimedUsername, "auto_rest_timeout", null);
    }
  },
});
```

## Concurrency / leak safety

`touch` always cancels the previous timer before arming a new one
(`clearTimeout(prev) → setTimeout(...)` order inside `arm()`). A
session bombarded with 1000 touches accumulates exactly one pending
timer at a time. Test in `__tests__/watchdog.test.ts` covers this.

`shutdown()` clears every pending timer at daemon shutdown. Never
leak timers across daemon-process boundary (the host process
disposes them anyway, but explicit shutdown lets bun-test runs
re-instantiate cleanly).

## Testing

The watchdog accepts an injected `Scheduler` interface
(`now / setTimeout / clearTimeout`). Tests use `FakeScheduler` to
advance virtual time deterministically — no real wall-clock waits.
The `realScheduler` wraps `globalThis.setTimeout` for production.

## Wiring map (TODO when MCP layer lands)

- `src/mcp/handlers/summon.ts` reads `rest_timeout` from the request,
  validates it, and calls `Watchdog.register(...)`.
- Every tool handler whose name is in `RESET_TRIGGER_TOOLS` calls
  `Watchdog.touch(sessionId)` after the handler succeeds.
- The vanilla-MCP dispatcher calls `Watchdog.touch(sessionId)` on
  every incoming request as a belt-and-braces measure.
- `unregister` (or daemon-side disconnect detection) calls
  `Watchdog.unregister(sessionId)`.
- Plugin's CC PreToolUse hook calls into a daemon endpoint that calls
  `Watchdog.touch(sessionId)`.
