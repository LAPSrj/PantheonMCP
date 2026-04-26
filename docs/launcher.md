# Launcher

`src/launcher/` is the multi-adapter spawn-target dispatcher per §5
and §11a. Each terminal emulator gets its own adapter; the dispatcher
detects the host at spawn time, picks the highest-priority match, and
either builds a spawn plan in the requested mode or walks the
graceful-downgrade ladder.

The launcher does NOT actually spawn processes — it returns a
`SpawnPlan` describing what to spawn. The summon-handler wiring
(landing alongside §11a's downstream consumers) calls `child_process.spawn`
on the plan and applies the §11a 200ms stderr probe when the plan
requests it.

## Adapter interface

```ts
interface Adapter {
  name: string;
  detect(env: NodeJS.ProcessEnv): boolean;
  capabilities(): ReadonlySet<Capability>;
  buildSpawnPlan(args: SpawnArgs): SpawnPlan;
}
```

Detection MUST be cheap — env-var checks only, no disk or network I/O.
`capabilities()` returns the subset of `new-window | new-tab-here |
new-tab-window | split-pane | named-windows | color | tab-title` the
adapter supports. `buildSpawnPlan` may assume the dispatcher already
gated `args.target.mode` against `capabilities()`.

## Detection priority (§5)

```
WT_SESSION             → wt
KITTY_PID/_WINDOW_ID   → kitty
WEZTERM_PANE           → wezterm   (stub — see below)
ITERM_SESSION_ID       → iterm2    (stub)
TMUX                   → tmux
GNOME_TERMINAL_SCREEN  → gnome     (stub)
TERM_PROGRAM=Apple_Terminal → terminal_app (stub)
ALACRITTY_LOG/_SOCKET  → alacritty
(none)                 → generic   (universal fallback)
```

First detect-true wins. `generic` always matches and serves as the
catch-all final entry.

### Adapter status

| Adapter        | Status | Notes |
|----------------|--------|-------|
| wt             | ✅ full | Wraps `wt.exe` via Windows interop. Color via named-hex map. |
| kitty          | ✅ full | `kitty @ launch` when `KITTY_LISTEN_ON` set; else `kitten @ launch`. |
| tmux           | ✅ full | Universal across host terminals. `escape_tmux` to leave the session. |
| alacritty      | ✅ full | Single mode (new-window) via `--working-directory` + `-e`. |
| generic        | ✅ full | Spawns the exec command directly. No tabs/splits/color. |
| wezterm        | 🟡 stub | Detect works; `buildSpawnPlan` errors `adapter_not_implemented`. |
| iterm2         | 🟡 stub | Same. AppleScript wiring TBD. |
| gnome          | 🟡 stub | Same. `gnome-terminal --tab/--window` wiring TBD. |
| terminal_app   | 🟡 stub | Same. AppleScript wiring TBD. |

Stubs are fully detectable so future implementations swap into
`adapters/<name>.ts` and update `adapters/index.ts` without touching
the dispatcher. Until then, the downgrade ladder falls through to
`generic` for stub-detected hosts (the dispatcher catches
`adapter_not_implemented` the same way it catches
`unsupported_capability`).

## Graceful downgrade

When the requested mode isn't supported, the dispatcher walks the
`DOWNGRADE_LADDER`:

```
split-pane → new-tab-window → new-tab-here → new-window
```

Starting at the entry **after** the requested mode, the dispatcher
tries each fallback against the same adapter. The first match wins
and the plan gets a `downgrade_note` explaining what happened.

If the adapter has no supported mode in the entire ladder (typical
for stub adapters), the dispatcher falls through to `generic` with
`mode: "new-window"` and a stronger downgrade note.

`target: { strict: true }` skips the ladder entirely and throws
`AdapterError("unsupported_capability")` instead.

## tmux escape

When `target.escape_tmux: true` and the detected adapter is `tmux`,
the dispatcher re-picks an adapter with `tmux` skipped — landing on
the host terminal that tmux runs inside. Default is `false` (stay in
tmux). This mirrors the §5 design: tmux's "new-window" semantics
differ from OS-level new-window, so callers who want an actual OS
window opt in explicitly.

## Env-knob shim

The legacy summon-mcp environment variable is honored:

| Variable                  | Effect                                       |
|---------------------------|----------------------------------------------|
| `PANTHEON_TAB_TARGET`     | Preferred. `same/current` → `new-tab-here`; `new/window` → `new-window`; `per-summoner` → `new-tab-window`. Any other string → `new-tab-window` (with the string interpreted as a window name by the caller). |
| `SUMMON_MCP_TAB_TARGET`   | DEPRECATED; one-release compat. Same semantics, only consulted when `PANTHEON_TAB_TARGET` is unset. **Removal target: pantheon v1.0**. |

Per-call `target.mode` always wins over both env vars.

## Window registry

Per §11a / §15: `~/.local/state/pantheon/windows.json` tracks named
windows that pantheon has spawned into. Shape:

```ts
interface WindowRecord {
  tabCount: number;
  tabSpawnHistory: Array<{
    when: number;             // ms timestamp
    summoner: string | null;  // who initiated the spawn
    persona: string;          // who's now living in the new tab/pane
    tab_index?: number;       // 0-based; populated when known
  }>;
}
```

`recordSpawn(paths, windowName, spawn)` appends to the history and
increments `tabCount`. Writes go through `mutateJsonAtomic` so
concurrent spawns can't lose entries.

The registry is **best-effort**: the user can close tabs externally
and `tabCount` will drift; on the next spawn we rebuild from
observation by simply appending. No reconciler runs against external
state. The dispatcher uses `predictNextTabIndex(paths, windowName)`
as a guess for `target.tab_index` when split-pane requests don't
supply one.

## Stderr probe

Plans for split-pane spawns set `requires_stderr_probe: true`. The
dispatcher (TODO when summon handlers wire) captures stderr for ~200ms
after spawn before calling `unref` on the child, so silent failures
("pane too small to split", etc.) surface as a warning in the summon
response.

## Auto-trust `~/.claude.json`

Before every spawn, the summon handler writes the persona's `cwd` into
the user's `~/.claude.json` `projects` map with
`hasTrustDialogAccepted: true` (and `hasCompletedOnboarding: true`).
This skips Claude Code's first-time trust prompt, which would
otherwise block the spawned session at startup until the user clicks
"Yes, trust." Idempotent: when the project entry already has
`hasTrustDialogAccepted: true`, the call is a no-op.

The write goes through `mutateJsonAtomic` (fingerprint-guarded
mutate-then-rename) so concurrent CC instances reading or writing
the same file never see a partial JSON document. This matters because
**Claude Code itself writes `~/.claude.json`** on every CC session;
clobbering it mid-write would torch other sessions' state.

Path resolution (in order of precedence):
1. `claude_config_path` field on `HandlerContext` (tests inject directly).
2. `paths.claudeConfigPath`, which honors:
   - `PANTHEON_CLAUDE_CONFIG` env override.
   - `<PANTHEON_HOME>/.claude.json` when `PANTHEON_HOME` is set (test sandbox redirect).
   - Otherwise `path.join(os.homedir(), ".claude.json")`.

The auto-trust step is **best-effort**: read or write failures land in
the summon response's `stamp_warnings` array and do not block the
spawn. The summon response also surfaces a `trust:
{ path, trusted_now, trusted_already }` block so callers can verify
which file was touched.

The trust write happens BEFORE `executeSpawnPlan` so the new
`claude` process finds the trust flag set on its first boot.

## Failure modes (caller-visible)

The summon handler composes several layers; each can fail
independently. The response shape surfaces failures cleanly so the
caller knows which step tripped:

| Failure                              | Surfaced as                                    |
|--------------------------------------|-------------------------------------------------|
| Target persona not registered        | `IdentityError("not_registered")`               |
| Cross-project summon without `_any`  | `ToolError("cross_project_blocked")`            |
| Spawn captures stderr in 200ms probe | `ToolError("spawn_failed")` with stderr text    |
| `child_process.spawn` itself throws  | `internal_error` (uncaught — extremely rare)    |
| `recordSpawn` write failure          | Best-effort: appears in `stamp_warnings` array; spawn succeeds |
| `stampSummoned` write failure        | Same — best-effort warning                      |
| `recordExit` write failure on `exit` | Best-effort: `registry_decremented: false` in response |
| `~/.claude.json` write failure       | Best-effort: appears in `stamp_warnings`; spawn proceeds (user can hit "Yes, trust" manually) |

The best-effort failures (registry / stamps) are deliberate: the tab
is already open by the time these run. Aborting the spawn would mean
killing a tab the user can already see, which is worse than leaving
the registry slightly out of sync. The `stamp_warnings` array makes
the drift visible to the caller; `pantheon doctor` (TODO) will
surface accumulated drift across runs.

The `recordExit` decrement is the counterbalancing pressure: every
session that exits via the `exit` tool decrements the registry,
keeping `tabCount` in sync with the actual open tab count over time.
Sessions killed externally (closed via the X button, terminal
crash, etc.) leave drift; the next spawn into the same window
appends to history without reconciling against external state.

## TODO

- Implement wezterm / iterm2 / gnome / terminal_app adapters as
  follow-ons. The dispatcher needs no changes; just drop a real
  module into `adapters/<name>.ts` and update `adapters/index.ts`.
- Wire `summon` family handlers (`src/mcp/handlers/spawn.ts`) to call
  `resolveSpawnPlan` + `child_process.spawn` + 200ms stderr probe +
  `recordSpawn`. That's the next chunk after this one lands.
- Cross-platform routing (WSL ↔ Windows): when target persona's
  platform differs from the host's, the spawn argv needs a
  `wsl.exe -d <distro> -- ...` wrapper. Defer until a real
  cross-platform summon use case appears.
