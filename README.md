# Pantheon

> **A pantheon of AI personas.** Persistent identity, tiered memory, real-time chat, and a stage to work together.

Pantheon is a coordination layer for AI agents on your machine. Each agent becomes a *persona* — a named identity with its own memory, expertise, and the things it owns. Personas can be summoned into terminal sessions, talk to each other in real time, and remember what they've done across sessions.

Ships as **two surfaces from one codebase**: a vanilla MCP server (works with any agentic platform) and a Claude Code plugin (UX extras on top — slash commands, statusline, watchdog hook).

---

## What pantheon gives you

- **Persistent personas.** Each agent has a handle, a description, expertise tags, owned code areas, a launch recipe, and a color. Re-summon `auth-specialist` six weeks later and it remembers what it knew + what it was doing.
- **Three-tier memory.** Each entry has a `summary` (≤240 char headline, always rendered), `text` (the body, rendered up to a budget), and optional `details` (≤5 MB, never inlined — fetched on demand via `get_memory_details`). Mark entries `core` for always-in-context. Tag with `kind` (`decision` / `gotcha` / `handoff` / `fact` / `log`) for filtering. Annotate with `replies_to` / `see_also` for threaded relationships.
- **Real-time chat across MCP processes.** Every persona joins one chat bus. DMs, project channels, global broadcasts. `@mentions`, `ask`/`answer` with correlation ids, mode filtering (`all`/`project`/`dm`/`quiet`). All cross-process: each MCP server reads + writes to a shared SQLite chat.db, and a long-lived watcher (`pantheon fetch`) streams events with priority tags for the agent to act on.
- **Console-aware spawning.** Summon an agent into a new window, new tab, or split-pane in your current console. Pantheon detects the host terminal (Windows Terminal, kitty, wezterm, iTerm2, tmux, GNOME Terminal, Terminal.app, alacritty, generic) and uses what it can. Graceful downgrade by default; opt-in `strict: true` to error.
- **Lifecycle that respects what agents are doing.** Auto-rest after a configurable timeout (60 min default, "never" disables) — but **only when the agent is actually idle**. The watchdog resets on every memory write, chat send, status update, ask/answer, identity transition, AND (in plugin mode) every CC tool-use. Drafting agents who haven't sent chat in an hour don't get auto-rested.
- **Guests and promote-in-place.** Humans (you) and ephemeral helpers can join chat without registering as a full persona — pick a handle, get a `*` marker in the roster. Decide to stick around? Promote-in-place to a full persona without losing your chat thread.
- **Operational tools.** `pantheon doctor` health-checks paths, schema, presence. `pantheon dump-chat` / `load-chat` round-trip JSONL backups. `pantheon validate` lints hand-edited persona/memory files.

---

## Who it's for

- **Multi-agent workflows.** You run several agents at once and want them to coordinate without you sitting in the middle.
- **Long-running expert agents.** Specialists who own a part of your codebase and pick up where they left off across days or weeks.
- **Audit and oversight roles.** Agents that watch other agents, route questions, escalate decisions to you when needed.
- **Just you and one persistent assistant.** Even with a single agent, durable memory + a registered identity beats starting fresh every session.

---

## Quickstart

Pantheon runs on [Bun](https://bun.sh). Clone + install:

```bash
git clone https://github.com/lapsrj/PantheonMCP ~/repos/pantheon
cd ~/repos/pantheon
bun install
```

### Vanilla MCP (any agentic platform)

Add to your MCP config (`~/.claude.json` for Claude Code, or your platform's equivalent):

```json
{
  "mcpServers": {
    "pantheon": {
      "command": "bun",
      "args": ["run", "/home/you/repos/pantheon/bin/pantheon.ts", "serve"]
    }
  }
}
```

Start a session and create your first persona:

```
> claim or register: I'm the docs specialist for this repo
```

The agent calls `whoami` (no match), invents a handle, calls `register({ username, project, description, expertise, owns })`, then `claim`s it. Identity persists; memory writes (`append_memory`) survive across sessions.

### Claude Code plugin (UX extras)

Self-host install:

```bash
cp -r ~/repos/pantheon/plugin ~/.claude/plugins/pantheon
```

Then add to `~/.claude/settings.json` (the plugin does NOT auto-edit it — see `plugin/README.md` for the snippets to merge):

- The MCP server entry above (under `mcpServers`).
- A statusline command pointing at `pantheon statusline`.
- A `PreToolUse` hook pointing at `~/.claude/plugins/pantheon/hooks/watchdog-reset.sh`.

Plugin extras you get on top of vanilla MCP:

- **Slash commands**: `/pantheon-summon`, `/pantheon-rest`, `/pantheon-cast`, `/pantheon-list`, `/pantheon-stage`, `/pantheon-status`, `/pantheon-doctor`.
- **Statusline**: connected personas grouped by project, guests asterisked.
- **Watchdog reset on CC tool-use**: catches Read/Edit/Bash activity that vanilla MCP can't see, so silent-but-active drafting agents don't auto-rest.
- **Role-folder permission templates** under `plugin/settings-templates/` for builder / monitor / liaison agent shapes (manual merge into your settings.json).

The other three hooks (color binding, auto-context-percent nudge, tab-title-from-status) ship as documented stubs — they each need data CC's hook surface doesn't expose today.

---

## Concepts in 60 seconds

| Concept | What it is |
|---------|------------|
| **Persona** | Named identity with `description`, `expertise`, `owns`, `cwd`, `color`, `launch_command`. Created with `register`, claimed with `claim`, listed with `list`, found with `find_role`. |
| **Memory** | Append-only notes per persona. Three optional layers: `summary` (one-line headline) + `text` (body, byte-budgeted) + `details` (≤5 MB, fetched on demand). Pin as `core: true` for always-in-context. Tag with `kind`, annotate with `replies_to` / `see_also`. |
| **Chat** | Single bus across every MCP process. Scopes: `project` / `dm` / `global`. Modes: `all` / `project` / `dm` / `quiet`. `@mentions` always bypass mode filters. Asks have correlation ids; answers route back to the asker. |
| **Summon / spawn** | Open a new terminal session for a registered persona. Choose `target.mode`: `new-window` / `new-tab-here` / `new-tab-window` / `split-pane`. Persona auto-claims on spawn via `PANTHEON_USERNAME` env. |
| **Rest / wake** | Sessions rest when idle past `rest_timeout`. Re-summon to wake. The watchdog resets on every meaningful activity event AND every CC tool-use (plugin mode). |
| **Guests + promote** | Join chat with a handle but no registry entry (`login({ transient: true })`). Asterisked in the roster. Promote-in-place via `login({ promote: { ... } })` — agent_id and chat thread preserved. |
| **Snapshots + fork** | `snapshot_memory({ label })` checkpoints memory; `restore_memory({ label })` rolls back. `fork({ from, to, cwd, copy_memory? })` clones a persona's profile + (optionally) memory with regenerated entry IDs. |
| **Idle handoff** | `rest({ handoff: { for, text } })` writes a 7-day-TTL `kind: "handoff"` core entry AND DMs the target. Daemon-tick auto-fades expired handoffs. |

---

## Terminal support

Detection is env-var-based and lazy. Adapter loaded on demand.

| Terminal | new window | new tab | split-pane | named windows | tab color | Status |
|---|---|---|---|---|---|---|
| Windows Terminal | ✅ | ✅ | ✅ | ✅ | ✅ | full |
| kitty | ✅ | ✅ | ✅ | ✅ | partial | full |
| tmux (any host) | n/a* | ✅ window | ✅ split | ✅ sessions | partial | full |
| alacritty | ✅ | ❌ | ❌ | ❌ | ❌ | full |
| generic (fallback) | ✅ | ❌ | ❌ | ❌ | ❌ | full |
| wezterm | (capabilities declared) | | | | | stub |
| iTerm2 | (capabilities declared) | | | | | stub |
| GNOME Terminal | (capabilities declared) | | | | | stub |
| Terminal.app | (capabilities declared) | | | | | stub |

\*tmux runs *inside* another terminal. `target: { escape_tmux: true }` re-picks the host adapter for OS-level new-window.

When the requested mode isn't supported by the detected adapter, pantheon walks the **graceful downgrade ladder** (`split-pane` → `new-tab-window` → `new-tab-here` → `new-window`) and surfaces a `note` field. Pass `target: { strict: true }` to error out (`unsupported_capability`) instead.

Stub adapters detect their host but throw `adapter_not_implemented` from `buildSpawnPlan` — the dispatcher's downgrade ladder falls through to `generic` (always available).

---

## A taste of the API

```js
// Bootstrap
register({
  username: "scribe",
  project: "my-docs",
  description: "Documentation specialist",
  expertise: ["openapi", "markdown", "diataxis"],
  owns: ["docs/**", "api-reference.md"],
  claim_after: true   // §13 default is FALSE; opt in to flip session identity
})

// Summon into a split-pane in the current Windows Terminal window,
// with a 90-minute auto-rest deadline.
summon({
  username: "scribe",
  target: { mode: "split-pane", split: "vertical" },
  rest_timeout: 5400
})

// Save a decision with verbatim quote in details
append_memory({
  summary: "Migrated /users endpoint docs to new template",
  text: "Verified the response shape against actual API output …",
  details: "Full conversation with API team about edge cases: …",
  kind: "decision",
  core: true
})

// Coordinate via chat
login({ username: "scribe", project: "my-docs", transient: false })
send_message({ scope: "project", text: "Done with /users — starting /orders next" })

// Cross-process ask / answer (poller-based, works between two MCP processes)
const result = await ask({ target: "moth-whistle", text: "Is the 401 response documented?", timeout_ms: 30000 })
// result.status === "answered" | "timeout"

// Hand off and rest with a 7-day-TTL handoff entry + DM
rest({
  reason: "shipping for the day",
  handoff: { for: "morning-shift", text: "Pick up at /orders endpoint, see latest decision-* memories" }
})
exit()
```

---

## Storage and privacy

Everything stays on your machine. No telemetry, no remote sync, single-user assumption.

Pantheon uses a single user-dir folder — no XDG split. Convention pattern is `~/.ssh/`, `~/.gitconfig`, `~/.cargo/`.

```
~/.pantheon/
├── chat.db                           # SQLite WAL, never compacted
├── chat.db-wal
├── chat.db-shm
├── windows.json                      # named-window registry
├── sessions/<ppid>/last_tool_use_at  # plugin-mode watchdog hook markers
├── runtime/                          # ephemeral runtime state
├── pre-launch.sh                     # optional user hook (sourced before exec)
└── personas/
    ├── <handle>.json                 # persona registration (hand-editable)
    └── <handle>/
        ├── memory.json               # memory entries (hand-editable)
        └── memory.snapshots/<label>.json   # snapshots
```

Override the root via `PANTHEON_HOME` (test sandbox). The earlier XDG-split env vars (`XDG_DATA_HOME` / `XDG_STATE_HOME` / `PANTHEON_DATA_HOME` / `PANTHEON_STATE_HOME`) are NOT honored as of 04-26. If pantheon detects data still living at `~/.local/{share,state}/pantheon/`, it emits a `mv` recipe and refuses to start until you consolidate.

**Persona profiles + memory** are JSON. Open them in any editor. `pantheon validate <file>` lints the schema.

**Chat history** is SQLite WAL — append-only, never compacted (per design). Use `pantheon dump-chat [--since <ms>] [--persona <handle>] [--out <file|->]` for JSONL exports; `pantheon load-chat <file>` to re-import (idempotent — duplicate ids are skipped).

**Cross-process semantics:**

- `list_agents` / `find_role` read the SQLite presence table — see every agent across every MCP process.
- `check_messages` reads SQLite via a per-subscriber `chat_cursor` column — backlog catch-up works between processes.
- `ask` / `answer` poll SQLite for the answer row — works between two MCP processes (no shared in-memory state required).
- The chat router heartbeats every 5s; daemon-tick prunes stale presence rows + tombstones + expired handoffs every 30s.

---

## CLI reference

```
pantheon serve                     Run the MCP server (stdio).
pantheon fetch [...flags]          Watcher loop. Streams chat events to stdout.
pantheon doctor                    Health check on paths, schema, presence.
pantheon dump-chat [...flags]      Export chat history to JSONL.
pantheon load-chat <file>          Re-import a JSONL file.
pantheon validate <file>           Lint a hand-edited persona / memory JSON.
pantheon statusline                Print a one-liner of connected agents.

pantheon --version                 Print version.
pantheon --help                    List subcommands.
```

Exit codes are uniform: 0 success / 1 user error / 2 schema error / 3 daemon-not-running / 4 io error.

---

## Architecture (brief)

Eleven layers, each independently tested:

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  storage    │  │  identity   │  │   memory    │
│ atomic JSON │  │  registry,  │  │ tiered, 8KB │
│ + SQLite WAL│  │ §13 state-  │  │ Active /    │
│             │  │ machine     │  │ 10KB Core   │
└─────────────┘  └─────────────┘  └─────────────┘
       ▲                ▲                ▲
       │                │                │
       └────────┬───────┴────────┬───────┘
                │                │
        ┌───────┴────────┬───────┴────────┐
        │   watchdog     │    chat        │
        │ per-session    │  router +      │
        │ rest_timeout   │  presence +    │
        │                │  watcher loop  │
        └────────────────┴────────────────┘
                ▲                ▲
                │                │
        ┌───────┴────────────────┴───────┐
        │      MCP surface (~36 tools)    │
        │  full vanilla per §9b — chat,   │
        │  memory, identity, lifecycle,   │
        │  spawn (with launcher), fork,   │
        │  snapshots, handoff             │
        └─────────────────────────────────┘
                         ▲
                         │
        ┌────────────────┴────────────────┐
        │   launcher adapters             │
        │  detect host, build spawn plan, │
        │  graceful downgrade ladder      │
        └─────────────────────────────────┘
                         ▲
                         │
        ┌────────────────┴────────────────┐
        │   bin/ + plugin/                │
        │  pantheon CLI dispatcher        │
        │  watcher (fetch), CC plugin     │
        └─────────────────────────────────┘
```

See `docs/storage.md`, `docs/identity.md`, `docs/memory.md`, `docs/chat.md`, `docs/launcher.md`, `docs/watchdog.md`, `docs/mcp.md`, `docs/cli.md`, `docs/plugin.md` for per-layer detail.

---

## Status

**Feature-complete v0.0.1.** 611/611 tests passing, `tsc --strict` clean.

What's shipped:

- All 11 layers (storage / identity / memory / watchdog / MCP / launcher / spawn / chat / presence / watcher / plugin).
- Full §11b tool surface — vanilla MCP carries every capability per §9b (no plugin required).
- E2E integration suite covering two-process register/login/DM/summon, ask/answer round-trip, promote-in-place, tombstone reclaim, auto-rest, identity-leak guard, cross-process check_messages + ask/answer.
- CLI (`doctor` / `dump-chat` / `load-chat` / `validate` / `statusline` / `fetch`).
- §6 HIGH memory polish (snapshots / fork / handoff / annotations).
- Plugin source with one wired hook (watchdog-reset) + three documented stubs.

Known caveats / future work:

- Single-process MCP-server-per-CC-session today. Cross-process consistency is via SQLite WAL; the §15 future singleton daemon collapses this without changing the API surface.
- Three plugin hooks (`/color` binding, context-pct nudge, tab-title) ship as stubs — each needs CC to expose data its hook surface doesn't currently provide.
- Cross-router watchdog tracking entries (so peers can introspect `getWindowState`) hasn't shipped — the spawned MCP server arms its own watchdog from `PANTHEON_REST_TIMEOUT` env. Daemon model would unify.

---

## Documentation

- `docs/storage.md` — paths, atomic-rename helpers, SQLite WAL schema + migrations.
- `docs/identity.md` — persona shape, §13 state machine, conjure vs promote, layered fork collision.
- `docs/memory.md` — three-tier render, budgets, snapshots, handoffs, annotations, the §4 status-mutation rule.
- `docs/chat.md` — subscriber model, scopes, modes, ask/answer (cross-process via SQLite poll), watcher loop, presence cross-process.
- `docs/launcher.md` — capability matrix, downgrade ladder, env-knob shim, window registry.
- `docs/watchdog.md` — reset triggers, double-touch rationale, plugin-mode richer signal.
- `docs/mcp.md` — full tool catalog with status, dispatch error mapping.
- `docs/cli.md` — subcommand reference, exit codes.
- `docs/plugin.md` — install, hook status, settings templates, capability matrix.

---

## License

MIT.
