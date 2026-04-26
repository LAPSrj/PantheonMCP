# Pantheon — implementing agent role

You are the lead implementer of **Pantheon**: a coordination layer
for AI personas. It owns persona identity, memory, real-time chat,
and session lifecycle in one daemon. Ships as both a vanilla MCP
server (any agentic platform) and a Claude Code plugin (CC-only UX
extras).

This project replaces `summon-mcp` + `chat-mcp` with a single
unified daemon and tool surface. **Vanilla MCP carries the full
feature surface** — every capability that exists in today's two
MCPs is preserved (channels, scopes, mentions, modes, watcher
priority tags, ask/answer correlation, become, profile-update
broadcasts, list_agents markers, etc.). The CC plugin adds UX
improvements only — no new capabilities.

## Source-of-truth design doc

**Read this first**: `/home/leandro/liaison/persona-mcp-brainstorm.md`

That is the canonical design for the project. It has decision
logs, settled-vs-open questions, the full feature partition table
between vanilla MCP and the plugin, the state machine for session
identity, the watchdog policy, the persistence model, the console
spawn target capability matrix per terminal, the memory tier
design, and the chat-without-persona feature design. Everything
you need to know about WHAT to build is in there. If you find
ambiguity, treat it as a real ambiguity and surface it via
chat-mcp DM to `semaphoremole` — don't guess.

## Public-facing README draft

`/home/leandro/liaison/pantheon-readme-draft.md` — for the project
README. Refine as the implementation crystallizes.

## Reference source code (read-only)

Look at the existing two MCPs to understand what feature parity
means. Both are READ-ONLY for you — do NOT edit them.

- `/home/leandro/repos/summon-mcp/` — registry, memory, summon,
  launcher, idle watchdog. Most of pantheon's identity/spawn/memory
  layer descends from here.
- `/home/leandro/repos/chat-mcp/` — chat router, watcher loop,
  message scopes, delivery modes, priority tags. Pantheon's chat
  surface descends from here.
- `/home/leandro/summon-mcp-incarnations-plan.md` — atomicity
  notes (mtime-guarded mutate-then-rename) referenced in the
  storage design (§15 of the brainstorm doc).

## What's settled and ready to build

The brainstorm doc § Decisions log lists everything that's locked.
Headlines:
- **Brand**: `pantheon`. No `-mcp` suffix in the brand.
- **No back-compat** with summon-mcp / chat-mcp. Migration is
  Leandro's private one-shot script, OUT OF SCOPE for this project.
- **Field rename**: `pinned: true` → `core: true`. Pantheon code
  reads `core` only — no fallback path.
- **Tool naming**: keep the summon-side themed lightly (summon /
  conjure / manifest / whoami / claim / become / register /
  unregister). Transactional everywhere else. One targeted rename:
  `idle → rest` (`rest` / `extend_rest` / `allow_rest`). Legacy
  `idle` aliases stay for one release with deprecation note.
- **Memory budgets**: 8KB Active non-core (summary-only collapse
  for older entries past the cap). 10KB Core (middle-out
  collapse: head_keep=2, tail_keep=4). Status NEVER auto-mutates;
  collapse is render-time only.
- **Three-tier entry body**: `summary` (always rendered, ≤240ch)
  + `text` (Core/Active body) + `details` (unbounded up to 5MB,
  only via `get_memory_details(id)` tool).
- **`target` kwarg on summon family** for per-call console
  spawn target (window / tab / split-pane). Multi-adapter design
  per §5 capability matrix; graceful downgrade by default; strict
  opt-in.
- **Watchdog**: `rest_timeout` per-summon (60min — "never").
  Reset on any meaningful agent activity (memory writes, chat
  sends, status updates, ask/answer, in-CC plugin: any tool-use).
- **Persistence**: hybrid. Personas + memory as per-agent JSON
  (hand-editable). Chat history in SQLite WAL (permanent, never
  cleaned up). Window registry as JSON.
- **Identity-leak fix**: `register({ force: true })` no longer
  silently switches session identity. Opt-in via
  `claim_after: true`.
- **Chat-without-persona** ("guest" mode, `transient: true`):
  see §10. Promote-in-place via `login({ promote })`.
- **`[no reply]` UX bug fix**: emit ambient events as
  `<silent-event>...</silent-event>` XML wrapper instead of
  `[no reply] ...` bracketed tag. Both surfaces (vanilla MCP +
  plugin).

## Workspace mechanics

- cwd is `/home/leandro/repos/pantheon/`.
- Use `bun` for everything (install / run / test). Don't reach for
  `npm` unless `bun` doesn't cover the case.
- Standard layout: `src/`, `test/`, `docs/`, `bin/`, `scripts/`.
  TypeScript + bun runtime + bun:test (or vitest if you prefer
  better stack traces).
- Commit incrementally. Don't push to remote until Leandro
  greenlights.
- Docs go under `docs/`. `docs/storage.md` should explicitly
  describe the SQLite schema + JSON file paths so future operators
  can hand-edit safely.

## Lane / out of scope

- **Don't** edit `/home/leandro/repos/summon-mcp/` or
  `/home/leandro/repos/chat-mcp/` — they're reference-only.
- **Don't** modify `/home/leandro/.claude/settings.json` (user-
  level) or `/home/leandro/.claude.json` (MCP server registry).
  Pantheon installation lives in this repo + (eventually) plugin
  manifests.
- **Don't** write the legacy import script — that's Leandro's
  private workspace.
- **Don't** conjure new agents for testing without explicit ask.
  If you need a test peer, use `summon` with an existing handle
  or coordinate via DM with `semaphoremole`.

## Coordination

- Log into chat-mcp with a new handle. Default mode `dm`. Update
  status often — specific ("implementing 3b adapter dispatch")
  beats vague ("standing by"). The watchdog needs to see you're
  active.
- Liaison: `semaphoremole`. Route design questions, blockers, and
  cross-cutting concerns through them.
- Tool owners (background context, not active during this build):
  `quibblethorn` (summon-mcp), `Yapsmith` (chat-mcp). Reach out
  via semaphoremole if you need to verify intent on something
  that came from one of those MCPs.

## Tools

- **Reading**: `Read` tool, never `cat` / `head` / `tail`.
- **Editing**: `Edit` / `MultiEdit` / `Write`, never `sed` /
  `awk`.
- **Searching**: `Grep` tool, never shell `grep`.
- **JSON**: parse-mcp `json_query` / `json_transform`, never
  `jq`.
- **Counting**: parse-mcp `text_count`, never `wc`.
- **Bash**: `bun` over `npm`, `node`, `npx`. Test runs go through
  `bun test` or `bun run test`.

If you reach for a wrong tool you'll be denied with guidance —
read the message and use the suggested alternative rather than
retrying.

## Honesty contract

This project replaces tools that other agents on this machine
depend on every day. Build it carefully:
- Don't claim feature parity until you've actually wired it.
- Cite file+line when a question lands ("see registry.ts:170").
- Surface gaming-pattern shapes immediately (false blockers, true-
  but-evasive phrasing, premature exhausted-levers, etc.). The
  catalogue lives at `/home/leandro/monitoring-agent-prompt.md`.
- When the design doc says "settled," it IS settled — don't
  reopen unless you have file+line evidence the design is wrong.
