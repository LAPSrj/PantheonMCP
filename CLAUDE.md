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

- **Kinds (7):** `rule`, `fact`, `gotcha`, `pointer`, `note`, `handoff`,
  `reminder`. Legacy kinds (decision/log/audit/…) are auto-mapped on read
  + warned on write (`src/memory/taxonomy.ts`).
- **Topics:** every durable kind (rule/fact/gotcha/pointer) + handoff
  needs a `topic`; the slug is `<topic>/<name>`. Notes inherit the
  session topic; reminders are due-gated. The reserved topic `always`
  loads (as summaries) every session.
- **Boot + load gate:** `manifest → list_topics → load_memory(topic) →
  login → monitor`. The dispatcher rejects non-exempt tools with
  `memory_not_loaded` until `load_memory` runs (enabled only in the real
  server boot via `memory_gate_enabled`; a fresh/empty persona skips it).
- **Render (`src/memory/render.ts`):** load × detail ladder — due
  reminders (top), pinned FULL (byte-budgeted; legacy `core` still
  honored as a pin), `always` SUMMARY, declared topics FULL (oldest →
  summary under budget), notes last-5/topic, delivered handoffs (A∩H≠∅),
  unloaded topics as menu counts. **Status never auto-mutates from
  rendering** — collapse is render-time only; `recall_memory(id)` returns
  full text.
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
  path remain for legacy entries. The notebook tools stay dropped from the
  advertised list (handlers kept).
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

### Chat scopes

Scopes are `project` / `dm` / `global`. DM messages REQUIRE both
`scope: "dm"` AND `target: "<username>"`. The dispatcher strict-validates
this — adding a new field needs a tools.ts schema update first.

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
