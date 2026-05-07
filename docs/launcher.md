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

## Pane-geometry policy (split-pane defaults)

Multi-pane summons into the same tab grow into a balanced grid
(capped at 3 columns) instead of column-narrowing. The policy lives
in `src/launcher/pane-geometry.ts`; the spawn handler reads/writes
per-tab geometry from the window registry and passes the resolved
direction + target-pane to the wt adapter.

Confirmed sequence as panes accumulate (n = total pane count after
the spawn):

| n  | shape       | what changed                                           |
|----|-------------|--------------------------------------------------------|
| 1  | `[1]`       | initial tab pane                                       |
| 2  | `[1, 1]`    | add column (V-split off pane 0)                        |
| 3  | `[2, 1]`    | add row to col 0 (H-split below col-0 bottom)          |
| 4  | `[2, 2]`    | add row to col 1 (H-split below col-1 bottom)          |
| 5  | `[2, 2, 1]` | add column (V-split off TOP of rightmost column)       |
| 6  | `[2, 2, 2]` | add row to col 2 (H-split)                             |
| 7  | `[3, 2, 2]` | add row to leftmost-smallest col (col 0)               |
| 8  | `[3, 3, 2]` | add row to next leftmost-smallest col (col 1)          |
| 9  | `[3, 3, 3]` | add row to col 2 — 3x3 capacity                        |
| 10+| `[4, ...]`  | continue adding rows to leftmost-smallest column       |

### Unified rule

> Add a new COLUMN if `cols < 3` AND every existing column has
> `row_count >= cols` (the layout is a balanced rectangle wanting to
> grow wider). Otherwise add a ROW to the leftmost column with the
> smallest row count.

Verify by hand: at `[2, 2]` (n=4), cols=2, all rows=2 ≥ 2 ✓ → add
column → `[2, 2, 1]`. At `[2, 2, 1]` (n=5), cols=3 → first clause
fails → add row to leftmost-smallest col (col 2, row count 1) →
`[2, 2, 2]`.

### Direction + focus pane

Each decision returns BOTH a direction (`V` for new column, `H` for
new row) AND a wt pane index to focus before the split:

- **Add column**: focus the TOP pane of the rightmost column;
  `split-pane -V` carves the new column out of its right half.
- **Add row**: focus the BOTTOM pane of the target column;
  `split-pane -H` stacks the new pane below it.

The wt adapter emits `focus-pane -t <id> ; split-pane -V|-H ; ...`.
Without the `focus-pane` step, `wt split-pane` lands on whichever
pane is currently focused — which yields the column-narrowing
pattern.

### Caller override

`target.split = "horizontal" | "vertical"` (or CLI
`--target-split h|v`) forces the direction and bypasses the policy
clause that picks direction. The focus-pane step still runs with the
policy-chosen target so even an explicit-direction split lands in
the right pane. To override BOTH direction and target, callers can
pass `target.focus_pane_id` directly (mostly an internal field; not
documented for end users).

### Persistence

Per-tab geometry persists in `~/.pantheon/windows.json`
under each window's `geometryByTab[tab_index]` field as a
column-major `PaneId[][]` plus `next_pane_id`. Survives across CLI
invocations (`pantheon summon` / `mcp__pantheon__summon` share the
same registry). `pantheon doctor` doesn't reconcile against
externally-closed panes — drift is accepted per the best-effort
caveat below.

### Best-effort caveat

The registry is a SHADOW of wt's actual layout, not authoritative.
Users can:

- Close panes via mouse / `Ctrl+Shift+W` — pantheon doesn't see
  these. The next split into that tab walks from a stale geometry
  and may land off-target.
- Manually `wt focus-pane` before a split — pantheon's geometry
  doesn't track manual focus.

Documented; we don't try to be a window server. The 3x3 capacity
limit minimises drift impact since we don't grow into arbitrarily
deep trees.

## WSL launch scripts (wt adapter)

When the `wt` adapter spawns into a WSL target (`SpawnArgs.wsl_distro`
set), it does NOT pass an inline bash payload via `bash -lc '...'`.
Instead it writes a self-deleting `.sh` script to `os.tmpdir()` and
invokes:

```
wsl.exe -d <distro> -- bash -l <script_path>
```

The script body, in order:

1. `#!/usr/bin/env bash` shebang.
2. `rm -f -- "$0"` — self-delete on the first executable line. bash
   keeps the file descriptor open across `unlink`, so the script
   keeps running normally and `/tmp` doesn't accumulate.
3. **`export PATH=<summoner's PATH>`** — see the gotcha below.
4. `export <K>=<V>` for each entry in `args.exec_env`.
5. `cd <args.cwd> || { error message; sleep 5; exit 1; }` — the
   `sleep 5` keeps the tab open long enough for the human to read
   the error before WT closes it.
6. `exec <args.exec_command> <args.exec_args...>`.

Why a script file (not `bash -lc '<inline>'`):

- **wt.exe parses literal `;` in argv as its own subcommand
  separator.** A payload like `export A=1; export B=2; cd /work && exec
  claude` gets split into multiple wt subcommands and emits
  `0x80070002 file not found` for each fragment. With a script file,
  argv is just `bash -l <path>` — no shell metacharacters for wt.exe
  to mis-parse.
- Same pattern summon-mcp uses across many production summons.

### PATH propagation gotcha (critical, do not remove)

The `export PATH=<summoner's PATH>` line in the script body is
**load-bearing**. Ubuntu's default `.bashrc` early-bails on
non-interactive shells (the `case $- in *i*) ...` guard), so `bash -l`
does NOT initialize `nvm`/`pnpm`/`asdf` shims even though it's a login
shell. Without the explicit PATH export, the spawned tab opens
successfully — wt.exe is happy, the user sees a fresh window — and
then immediately fails with `claude: command not found` once the
script's `exec` line runs.

This bug class is silent: there's no error during `child_process.spawn`,
no stderr probe trip, the tab simply dies seconds after appearing. We
hit it once during initial validation; quibblethorn (summon-mcp owner)
flagged it from his own production debugging history.

The PATH export precedes the user-supplied `exec_env` exports so
callers who set `PATH` explicitly in `exec_env` still win.

### Test seam

Set `PANTHEON_WT_SCRIPT_DIR=<dir>` in env to redirect script writes
out of `os.tmpdir()`. Used by `src/launcher/__tests__/dispatch.test.ts`
so the suite can inspect produced script content without crawling /tmp.

## Window registry

Per §11a / §15: `~/.pantheon/windows.json` tracks named
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
  geometryByTab?: Record<number, TabGeometry>;
}

interface TabGeometry {
  /** column-major: columns[c][r] = wt pane index at column c, row r */
  columns: number[][];
  /** next wt pane index assigned on the next split */
  next_pane_id: number;
}
```

`recordSpawn(paths, windowName, spawn)` appends to the history,
increments `tabCount`, and updates `geometryByTab[spawn.tab_index]`:

- `mode: "new-tab"` / `"new-window"` seeds a fresh single-pane
  `TabGeometry`.
- `mode: "split-pane"` applies the spawn handler's `SplitDecision`
  via `applyDecision(currentGeometry, decision)` so the registry
  always reflects the post-split state.

Writes go through `mutateJsonAtomic` so concurrent spawns can't lose
entries.

The registry is **best-effort**: the user can close tabs externally
and `tabCount` (or per-tab geometry) will drift; on the next spawn
we walk from the stale state and append. No reconciler runs against
external state. `predictNextTabIndex(paths, windowName)` returns a
guess for `target.tab_index` when split-pane requests don't supply
one. `getTabGeometry(paths, window, tab_index)` returns the
persisted geometry for the spawn handler's policy decision.

## Stderr probe

Plans for split-pane spawns set `requires_stderr_probe: true`. The
summon handler captures stderr for ~200ms after spawn before calling
`unref` on the child, so silent failures ("pane too small to split",
etc.) surface as a warning in the summon response.

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
the drift visible to the caller; `pantheon doctor` surfaces
accumulated drift across runs.

The `recordExit` decrement is the counterbalancing pressure: every
session that exits via the `exit` tool decrements the registry,
keeping `tabCount` in sync with the actual open tab count over time.
Sessions killed externally (closed via the X button, terminal
crash, etc.) leave drift; the next spawn into the same window
appends to history without reconciling against external state.

## Pending work

- **wezterm / iterm2 / gnome / terminal_app adapters** are stubs
  today — they declare the adapter shape so the dispatcher detects
  them, but `buildSpawnPlan` throws `adapter_not_implemented` and
  the dispatcher falls through to `generic`. To finish one, drop a
  real module into `adapters/<name>.ts` and add it to the dispatch
  table in `adapters/index.ts`. The dispatcher itself needs no
  changes.
