# CLAUDE.md

Contributor context for Claude Code (and other agentic harnesses) when
working on the pantheon codebase.

> If you're a USER of pantheon (not a contributor), see `README.md` for
> install + usage. This file is for people changing the source.

## Codebase tour

```
src/
├── storage/      Atomic JSON helpers + SQLite WAL handle. Path resolver.
├── identity/     Persona registry, claim/register state machine, fork.
├── memory/       Three-tier render (summary/text/details), snapshots, handoffs, annotations.
├── watchdog/     Per-session rest_timeout, reset triggers.
├── chat/         Router, presence, scopes, modes, ask/answer, watcher loop.
├── launcher/     Terminal-adapter detection, spawn plan, downgrade ladder.
│   └── adapters/ wt, kitty, tmux, alacritty, generic (+ stub adapters).
├── mcp/          Tool surface: tool defs (tools.ts), handlers/, dispatch.ts.
│   └── handlers/ identity / memory / chat / lifecycle / spawn — one file per tool group.
├── responses/    Response-template machinery (login-note, watcher banner, whoami).
├── resume/       Resume-summary builder for manifest/claim/login responses.
├── schemas/      Schema registry + JSON Schema validator subset.
├── cli/          pantheon CLI subcommands (serve, fetch, doctor, dump-chat, …).
└── __tests__/    Cross-process E2E suite (auto-rest, ask round-trip, two-process flow).

bin/              Bun-runnable entry points (pantheon.ts, pantheon-fetch.ts).
plugin/           Claude Code plugin: slash commands, hooks, settings-templates.
docs/             Per-layer reference docs (storage / identity / memory / …).
```

Each layer has its own `__tests__/` next to the source. Cross-layer
integration lives under `src/__tests__/e2e/`.

## Local dev setup

```bash
bun install
bun test           # runs every *.test.ts under src/
bun run tsc --noEmit   # typecheck (strict)
```

Tests use `PANTHEON_HOME` to sandbox the storage root — never write to
the user's real `~/.pantheon/`. Each test sets up a `mkdtempSync` dir
and points `PANTHEON_HOME` at it.

## Conventions

### Adding a new MCP tool

1. Add the tool definition (name, description, JSON Schema) to
   `src/mcp/tools.ts`. Match an existing entry's shape.
2. Implement the handler in the appropriate `src/mcp/handlers/<group>.ts`
   and register it in `src/mcp/handlers/index.ts`.
3. The dispatcher (`src/mcp/dispatch.ts`) auto-validates calls against
   each tool's `inputSchema` — `additionalProperties: false` is
   enforced, and unknown args / missing required fields return
   `invalid_args`. No need to re-validate inside the handler.
4. Add tests under `src/mcp/__tests__/` — mirror the pattern in an
   adjacent test file.

### Memory writes (v2 — topic-scoped)

Memory is topic-scoped + lazy (`docs/memory-redesign/5-proposal-v2.md`;
`docs/memory.md` has the reference). The shape:

- **Kinds (8):** `rule`, `fact`, `gotcha`, `pointer`, `note`, `handoff`,
  `reminder`, `watcher`. Legacy kinds (decision/log/audit/…) are
  auto-mapped on read + warned on write (`src/memory/taxonomy.ts`).
- **Topics:** every durable kind (rule/fact/gotcha/pointer) + handoff +
  watcher needs a `topic`; the slug is `<topic>/<name>`. Notes inherit
  the session topic; reminders are due-gated. The reserved topic `always`
  loads (as summaries) every session.
- **Watcher kind (8th — `docs/memory-redesign/6-watcher-kind.md`):** a
  watch lane (cron/Monitor job whose resources die with the arming
  session). `WatcherMeta` (`src/memory/types.ts`) binds TWO things:
  `owner_agent_id` (arming session — the orphan trigger) +
  `owner_username` (canonical persona — re-arm pool), plus a `rearm`
  payload. Orphaned-ness is render-DERIVED, never stored:
  `isWatcherOrphaned(entry, liveAgentIds)` (the `isReminderDue` analog).
  Render shows a loud `ORPHANED WATCHERS` top block when the owner left
  presence (`live_agent_ids` is threaded into `RenderOptions` from
  `ChatRouter.liveAgentIds()`); the daemon-tick `sweepOrphanedWatchers`
  pushes a sibling. Tools (`src/mcp/handlers/watcher.ts`): `arm_watcher`,
  `claim_watcher` (atomic CAS rebind via `mutateStore`, `src/memory/
  watcher.ts`), `close_watcher` (fade). v1 = persona scope only +
  explicit close; project scope is a flagged fast-follow.
- **Boot + load gate:** `manifest → list_topics → load_memory(topic) →
  login → monitor`. The dispatcher rejects non-exempt tools with
  `memory_not_loaded` until `load_memory` runs (enabled only in the real
  server boot via `memory_gate_enabled`; a fresh/empty persona skips it).
- **Render (`src/memory/render.ts`):** load × detail ladder — due
  reminders (top), pinned FULL (byte-budgeted; legacy `core` still
  honored as a pin), `always` SUMMARY, declared topics FULL (oldest →
  summary under budget), notes last-5/topic, faded last-`FADED_PER_TOPIC`
  + a count, delivered handoffs (A∩H≠∅), unloaded topics as menu counts.
  **Status never auto-mutates from rendering** — collapse is render-time
  only; `recall_memory(id)` returns full text.
- **Global render ceiling (`RENDER_TOTAL_BUDGET_BYTES`, env
  `PANTHEON_RENDER_MAX_BYTES`, default 24 KB):** a single shared FULL-text
  budget across the render's full sections (orphaned watchers → due
  reminders → pinned → declared-topic durable → delivered handoffs),
  spent in that priority order via `selectFullGlobal` in `render.ts`. The
  per-section budgets (PIN 10 KB, TOPIC_FULL 8 KB/topic) still apply; the
  ceiling additionally bounds the cross-topic accumulation (N loaded
  topics each contributing up to 8 KB) so an oversized boot render can't
  be spilled by the MCP-client harness to a flat, unisolated
  `tool-results/*.txt` a subagent could read. Pins are sacrosanct (never
  globally demoted, but their bytes draw down the shared budget); bodies
  past the ceiling collapse to summary + a loud `RenderResult.warning`.
  A non-positive / unparseable env value disables the ceiling (Infinity).
- **Decay (`src/memory/decay.ts`)** runs at the `load_memory` session
  boundary: handoff matching-session fade (§8), next-session reminder
  consumption, superseded → forgotten. Date-reminder delivery is on the
  daemon-tick (`sweepDueReminders`).
- **Validation (`src/memory/validation.ts`)** is enforced on write —
  hard issues throw a `MemoryError` (`kind_legacy`/`new_topic` stay
  advisory): kind enum, summary_is_header, topic_required, pin/always
  budget guards. (The warn-only `PANTHEON_MEMORY_ENFORCE` flag was
  removed once the whole fleet migrated.)
- **Removed inputs (§16 hard-cut):** `core` and `details` are no longer
  accepted by `append_memory` / `update_memory` — passing either returns
  `invalid_args`. Use `pin` + `pin_reason` instead of `core`; put payload
  in `text`. The stored `details` field + the `get_memory_details` read
  path remain for legacy entries.
- **Write field `summary_max240`:** the agent-facing summary input on
  `append`/`update`/`set_memory` (+ the project-memory write tools) is
  named `summary_max240` (the ≤240 cap is in the name). Storage and all
  reads (`list`/`get`/`recall`) stay `summary` — the rename is write-side
  only; the handler stores `args.summary_max240` into the `summary` field.
- **Compact write responses (§16):** `append_memory`/`update_memory` (and
  the project-memory equivalents) return a compact ack, not the full
  entry — they no longer echo back the `text` the caller just sent.
  append → `{ id, status, text_chars, derived?: { summary, expires_at } }`
  (only server-derived values surface); update → `{ id, status, changed[],
  unchanged[], coerced?, text_chars? }` (before/after diff of the patch).
  Pass `verbose: true` to get the full entry back.
- `append_memory` is the always-safe entry point; `update_memory` /
  `fade_memory` mutate; `forget_memory` (alias `delete`) tombstones.
- **Provenance — `sources[]` (opt-in):** `append_memory`/`update_memory`
  accept a `sources` array (`src/memory/types.ts` `MemorySource`). Each
  item cites ONE origin and is SNAPSHOTTED at write
  (`resolveSources` in `handlers/memory.ts`): `{ message_id }` resolves via
  `getMessageById`, `{ session_id, message_at }` via `fetchHistoryMessage`,
  `{ quote }` via `validateUserQuote` — best-effort, an unresolvable
  coordinate stores `resolved: false` rather than failing the write. The
  stored ref keeps both the snapshot text (durable vs pruning) and the
  coordinates for live re-verification. Never rendered and STRIPPED from
  `recall_memory` (which adds a `has_source` flag); fetched via
  `get_memory_source(id)` / `get_memory_source_any` — the
  `has_details`/`get_memory_details` pattern. Not mandatory on any kind.

### Chat scopes

Scopes are `project` / `dm` / `global`. DM messages REQUIRE both
`scope: "dm"` AND `target: "<username>"`. The dispatcher strict-validates
this — adding a new field needs a tools.ts schema update first.

**Addressing sibling incarnations.** One persona can have many live
sessions (`righthand`, `righthand2`, …) — the suffix is assigned at login
when the canonical handle is already taken; it carries NO role meaning, and
the canonical (unsuffixed) handle is just "whoever grabbed the bare slot
first." A DM to the bare canonical handle DELIVERS to the canonical session
(no rejection) — but if that persona has live siblings, the send result
includes a `hints[]` line naming them ("Delivered to canonical 'X'. It has
live clones: […]. If this was meant for a sibling, re-send with the
sibling's exact username."). To target a specific clone, DM its EXACT
suffixed handle. `list_agents` surfaces the grouping the other way: a
canonical entry with live siblings carries a `clones` array of their
handles. Edge case: if the canonical handle isn't live but siblings are,
the DM still fails (no canonical session to deliver to) — but the
`recipient_offline` error names the live siblings so you can re-address
one. Set a DISTINGUISHING `status` at login (role/lane) so peers can tell
your sessions apart.

### Single-agent projects

A project can be locked to ONE persona (one persona, many concurrent
sessions — not a fleet). Flag lives at `projects/<project>/config.json`
(`{ "single_agent": true }`, `src/storage/project-config.ts`); toggle via
`pantheon project single-agent <project> [--off]`. Two enforcement points:

- **Registry gate** — `createPersona` (`src/identity/registry.ts`) refuses
  a SECOND distinct persona in a single-agent project (`project_single_agent`
  IdentityError). Every creation path funnels through here (register /
  conjure / summon / fork / merge / promote), so the one gate covers them
  all. Re-registering the SAME handle (idempotent update, or force-overwrite
  from a new cwd) is allowed; the lock wins over `force`. `merge` reduces the
  count so it's never blocked.
- **Tool surface** — sessions in a single-agent project get a trimmed
  `tools/list` (no persona-creation, no shared project-memory, no
  cross-persona `*_any` reads; chat + `force_*` stay). The hidden set is
  `SINGLE_AGENT_HIDDEN` (`src/mcp/tools.ts`, computed from tool names).
  Resolved at MCP boot (`resolveBootSingleAgent` in `src/mcp/server.ts`)
  from the env-named persona or cwd — BEFORE the chat `login` tool call —
  and stashed on `ctx.single_agent`. The dispatcher also rejects hidden
  tools (`tool_unavailable_single_agent`) so hiding is authoritative.

### Storage atomicity

Every JSON write goes through `writeJsonAtomic` (`src/storage/json.ts`):
write to `<file>.tmp.<rand>`, fsync, rename. Memory writes additionally
use mtime-guarded mutate-then-rename to prevent sibling-incarnation
clobbering. See `docs/storage.md` for the full pattern.

### Commit style

Lowercase prefix `area: short summary`. Body explains the why, not the
what. Co-author trailer for AI-assisted commits. Don't amend pushed
commits.

## Tooling preferences

- **bun** for everything (install / run / test). No npm / node / npx.
- **Read / Edit / Write** tools for files. No `cat` / `sed` / `awk`.
- **Grep tool** for searching. No shell `grep`.
- Avoid `git -C <path>` — always run from the repo root.
