# MCP tool surface

`src/mcp/` is the vanilla MCP server entry point. Per §9b, vanilla MCP
ships the **full** surface — every tool from today's summon-mcp +
chat-mcp plus the new ones in §11b. Tools whose backing layer hasn't
landed yet are stubbed (handler returns `not_implemented` with a
layer hint) so the surface is visible from day one and the rest of
the daemon can be built against it.

## Layout

```
src/mcp/
├── tools.ts         # full ToolDef list (schemas)
├── handlers/
│   ├── identity.ts  # whoami, register, claim, manifest, become, …
│   ├── memory.ts    # append/get/recall/fade/forget/update/set/list/get_details
│   ├── lifecycle.ts # rest, extend_rest, allow_rest, exit + idle aliases
│   ├── spawn.ts     # summon/conjure stubs (§11a)
│   ├── chat.ts      # login/send_message/etc. stubs (§11c)
│   └── index.ts     # name → handler registry
├── dispatch.ts      # central tool dispatcher; maps domain errors
├── context.ts       # createContext factory
├── server.ts        # stdio bootstrap (Server + StdioServerTransport)
└── types.ts         # ToolDef, HandlerContext, ToolError, arg coercers
```

## Tool catalog

| Tool | Status | Notes |
|------|--------|-------|
| `whoami` | ✅ | Per-cwd lookup. Returns matches + a hint string. |
| `register` | ✅ | **`claim_after` defaults `false`** (§13 identity-leak fix). |
| `claim` | ✅ | Errors `not_registered` if no entry. |
| `manifest` | ✅ | Auto-claims sole match; ambiguity resolved via `hint`. |
| `become` | ✅ | Errors `not_registered`; session unchanged on failure. |
| `update_profile` | ✅ | Clears `provisional` once description+expertise+owns are all set. |
| `unregister` | ✅ | Drops memory unless `keep_memory: true`. |
| `list` | ✅ | Optional `query` fuzzy match across registry fields. |
| `session_info` | ✅ | id, parent pid, platform, claim/guest/rest state. |
| `get_memory` | ✅ | Three-tier render with `warning` for Core collapse. |
| `append_memory` | ✅ | summary/text/details/kind/core/summoner_username. 5MB details cap. |
| `update_memory` | ✅ | `details: null` clears; `core: false` demotes. |
| `set_memory` | ✅ | Replace-all. |
| `recall_memory` | ✅ | Returns full text; flips faded → active. |
| `fade_memory` | ✅ | Explicit user call only. |
| `forget_memory` | ✅ | Explicit user call only. |
| `list_memory` | ✅ | Index shape; date-desc; filters: status/core/kind/since/filter. |
| `get_memory_details` | ✅ | Returns ONLY `details` field. |
| `allow_rest` | ✅ | Authorizes rest in non-summoned sessions. |
| `rest` | ✅ | Calls `transitionRestEnter` + `stampRested("auto_rest_timeout"…)`. |
| `extend_rest` | ✅ | Rearms watchdog with `minutes * 60`s (≥3600). |
| `exit` | ✅ | Schedules SIGTERM via context's `scheduleExit`. |
| `allow_idle` | ⚠ deprecated | Alias → `allow_rest`. Surfaces `deprecation` field. |
| `idle` | ⚠ deprecated | Alias → `rest`. |
| `extend_idle` | ⚠ deprecated | Alias → `extend_rest`. |
| `summon` | ✅ | Composes registry → resolveSpawnPlan → executeSpawnPlan (200ms stderr probe) → recordSpawn → stampSummoned → watchdog.register. |
| `summon_any` | ✅ | Bypasses caller-target project equality (§9b). |
| `conjure` | ✅ | Atomic register-then-spawn. Persona stays registered if spawn fails. |
| `conjure_any` | ✅ | Same; bypasses project gate. |
| `login` | 🟡 stub | Schema includes `transient` + `promote` per §10. (§11c) |
| `logout` | 🟡 stub | (§11c) |
| `send_message` | 🟡 stub | Scope: project / dm / global. (§11c) |
| `ask` | 🟡 stub | `correlation_id` + timeout. (§11c) |
| `answer` | 🟡 stub | (§11c) |
| `set_mode` | 🟡 stub | all / quiet / project / dm. (§11c) |
| `update_status` | 🟡 stub | (§11c) |
| `check_messages` | 🟡 stub | (§11c) |
| `list_agents` | 🟡 stub | (§11c) |
| `find_role` | 🟡 stub | Joins registry + connected agents. (§11c) |

Stubs return:

```json
{
  "error": "not_implemented",
  "message": "<tool> is not yet wired in this build. ...",
  "layer": "chat-router-§11c"
}
```

with `isError: true` so MCP clients see them as errors, not as silent
"works but does nothing" calls.

## Schema additions per §11b

- **`target` kwarg** on `summon` / `summon_any` / `conjure` /
  `conjure_any`: `{ mode, window, tab_index, split, color, strict,
  escape_tmux }` — per §5.
- **`rest_timeout` kwarg** on the same family: `number` (≥3600) or
  the string `"never"`.
- **`transient: boolean`** + **`promote: { project, description,
  expertise, owns, cwd? }`** on `login` — per §10 promote-in-place.
- **`claim_after: boolean`** on `register` — defaults `false` per
  §13. Identity-leak fix.
- **`summary` / `text` / `details` / `kind` / `core` /
  `summoner_username`** on `append_memory` / `update_memory` /
  `set_memory` per §4. Details capped at 5 MB at the API boundary
  AND inside the store mutator.

## Dispatch

`dispatch(toolName, args, ctx)` resolves the handler in `HANDLERS`,
runs it, and wraps the result in MCP's `{ content, isError? }`
shape. Domain errors map cleanly:

| Error class       | `error` field is | Source layer |
|-------------------|------------------|--------------|
| `IdentityError`   | the error code   | `src/identity/` |
| `MemoryError`     | the error code   | `src/memory/` |
| `WatchdogError`   | the error code   | `src/watchdog/` |
| `ToolError`       | the error code   | `src/mcp/` |
| any other `Error` | `internal_error` | unexpected   |

After a successful handler call, dispatch calls
`Watchdog.touch(sessionId)` if the tool name is in
`RESET_TRIGGER_TOOLS`. The MCP server's request handler ALSO touches
the watchdog on every incoming request (vanilla-MCP rule per §14);
the dispatcher's per-tool gate is the explicit-list belt-and-braces
signal.

## Identity-leak fix surfacing

`register` returns:

```json
{
  "persona": { ... },
  "claimed": false,
  "note": "registered 'other'; your session identity remains 'self'; call claim() to switch."
}
```

when the calling session was already `claimed_persona(self)`. The
note is verbatim §13 wording. Set `claim_after: true` to skip the
note and have the session flip atomically.

## Stale-MCP-proxy mitigation (§6 HIGH)

Instructional copy lives under `src/responses/templates/` as
markdown. `getResponseTemplate(name, vars?)` lazy-loads + caches +
interpolates `{{key}}` placeholders. Tool handlers should call this
helper instead of inlining strings — a daemon restart picks up
template edits without requiring every Claude Code conversation to
restart its MCP proxy. The two seed templates ship with the MCP
layer: `whoami-no-match`, `whoami-sole-match`. Add more as handlers
grow.

## Boot

`bin/pantheon.js` invokes `runMcpServer()` from `src/mcp/server.ts`,
which:

1. Reads `PANTHEON_SUMMONER` env to populate `summoner_username`.
2. Builds the runtime `HandlerContext` via `createContext`.
3. Arms the watchdog with `DEFAULT_REST_TIMEOUT_SECONDS` (3600). A
   later `summon` will replace this when the launcher passes a
   per-summon `rest_timeout` via env.
4. Registers `ListToolsRequestSchema` → `TOOLS`.
5. Registers `CallToolRequestSchema` → touches watchdog, calls
   `dispatch(name, args, ctx)`.
6. Connects to a `StdioServerTransport`.
7. Wires `SIGTERM` / `SIGINT` / `exit` to `watchdog.shutdown()`.

## Summon family wiring

`summon` / `summon_any` / `conjure` / `conjure_any` compose the four
foundation layers end-to-end:

1. `readPersona(paths, username)` — registry lookup. `not_registered`
   if no entry. (Conjure variants `createPersona` first with
   `provisional: true`.)
2. `enforceSameProject(ctx, target)` for the non-`_any` variants.
   Blocks with `cross_project_blocked` when caller's claimed
   persona is in a different project.
3. Build `SpawnArgs` from the persona profile + caller args:
   - `exec_command` ← `persona.launch_command || "claude"`.
   - `exec_args` ← `persona.launch_args` + (if `resume: true` and a
     `resume_session_id` is stored) `--resume <id>` + (if `prompt`)
     the prompt string.
   - `exec_env` ← `PANTHEON_SUMMONED=1`,
     `PANTHEON_USERNAME=<persona>`,
     `PANTHEON_SUMMONER=<caller>`,
     `PANTHEON_REST_TIMEOUT=<seconds-or-"never">`,
     `PANTHEON_COLOR=<color>` if set.
   - `cwd` ← persona's registered cwd.
   - `tab_title` ← persona handle (with incarnation suffix when one
     is in flight).
   - `target` defaults `window` to `summon-<persona>` to match the
     legacy summon-mcp window-name pattern.
4. `resolveSpawnPlan(args, { env: ctx.spawn_env })` — adapter
   detection + downgrade ladder.
5. `executeSpawnPlan(plan, { executor, stderr_probe_ms })` — actual
   `child_process.spawn`. The `requires_stderr_probe` flag from §11a
   triggers the 200ms stderr capture.
6. **Edge case**: if the probe captured anything, throw
   `spawn_failed` with the captured stderr in the response payload.
   The tab may or may not have actually opened — caller decides.
7. `recordSpawn(paths, windowName, { summoner, persona, tab_index })`
   in the window registry. Best-effort; failures surface as
   `stamp_warnings` rather than aborting.
8. `stampSummoned(paths, persona)` — bumps `summon_count` and
   `last_summoned_at` on the persona profile.
9. `watchdog.register({ session: <new>, rest_timeout, onDeadline })`
   — daemon-side tracking entry. The spawned MCP server arms its
   own watchdog from `PANTHEON_REST_TIMEOUT` on boot; the daemon
   tracks via the registry entry's session id.

The MCP response shape mirrors today's summon-mcp for vanilla MCP
parity, plus the new fields:

```json
{
  "ok": true,
  "summoned": "moth-whistle",
  "project": "pantheon",
  "cwd": "/work/moth",
  "mode": "fresh",
  "plan_description": "...",
  "spawn_pid": 12345,
  "tab_title": "moth-whistle",
  "color": "purple",
  "resolved_mode": "split-pane",
  "adapter": "wt",
  "rest_timeout": 3600,
  "note": "split-pane requested; downgraded to new-tab-window."
}
```

## TODOs

- Wire chat handlers when §11c chat router lands. Chat handlers will
  also emit `<silent-event>` XML wrapper on ambient events (§7).
- Add per-session JSON file for restart-tolerant proxy state once
  the daemon model is wired (currently single-process MCP server).
- `pantheon doctor` / `pantheon dump-chat` / `pantheon load-chat`
  CLI subcommands (§11d).
- Cross-platform spawn routing (WSL ↔ Windows) — defer until a real
  use case appears.
