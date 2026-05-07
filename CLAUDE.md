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

### Memory writes

- `append_memory` is the always-safe entry point. `update_memory` /
  `fade_memory` mutate; `forget_memory` (alias `delete`) tombstones.
- The renderer (`src/memory/render.ts`) collapses oldest-first when
  Active exceeds 8 KB and middle-out when Core exceeds 10 KB. **Status
  never auto-mutates from rendering** — collapse is render-time only;
  `recall_memory(id)` always returns full text.
- Three-tier body: `summary` (≤240 ch, always rendered) + `text`
  (counts toward budget) + `details` (≤5 MB, never inlined; only via
  `get_memory_details(id)`).

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
