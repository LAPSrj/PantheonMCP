# Claude Code plugin (§9b)

Pantheon ships as **two surfaces from one codebase** per §9b:

1. **Vanilla MCP server** — full feature parity for any MCP client.
2. **Claude Code plugin** — UX-only refinements for CC users.

This doc covers the plugin layer (the source lives at `plugin/` in
the repo). Vanilla MCP doesn't need any of this.

## What the plugin is (and isn't)

**Is:**

- A directory of CC-side glue (slash commands, statusline,
  hooks, settings templates).
- An installer manifest (`plugin/plugin.json`) that points CC at
  the right entry points.
- Self-hostable today; marketplace-installable when CC's plugin
  marketplace stabilizes.

**Isn't:**

- A second pantheon implementation. The plugin runs the same
  vanilla MCP server (`pantheon serve`) under the hood.
- A new tool surface. Per §9b: "the plugin adds NO new
  capabilities" — every callable is already in vanilla MCP.
- A required dependency. Vanilla MCP works without the plugin.

## Layout

```
plugin/
├── plugin.json              — manifest CC reads to discover everything
├── README.md                — install instructions for end users
├── commands/                — slash command markdown files
│   ├── pantheon-summon.md
│   ├── pantheon-rest.md
│   ├── pantheon-cast.md
│   ├── pantheon-list.md
│   ├── pantheon-stage.md
│   ├── pantheon-status.md
│   └── pantheon-doctor.md
├── hooks/                   — bash hook scripts
│   ├── watchdog-reset.sh
│   ├── color-binding.sh
│   ├── context-pct-nudge.sh
│   └── tab-title.sh
└── settings-templates/      — JSON snippets for role-folder permission scaffolds
    ├── role-builder.json
    ├── role-monitor.json
    └── role-liaison.json
```

## Statusline

The MCP CLI gains a `pantheon statusline` subcommand that CC's
prompt-bar integration can invoke. It reads the SQLite presence
table directly (no MCP RPC) and prints one line. Cross-process
visibility is automatic: every connected agent across every CC
session shows up.

Output shape:

```
[pantheon <count>] <project>:<handle1>,<handle2>* | <project>:<handle3>
```

Implementation: `src/cli/statusline.ts` → `runStatusline`. The
function is exported so future plugin variants (or a different
MCP host) can call it directly without re-implementing.

## Hooks

CC fires hooks at well-defined lifecycle points. The pantheon
plugin ships four hook scripts:

### `PreToolUse` → `watchdog-reset.sh`

§14 spec: in plugin mode, every CC tool-use should reset the
watchdog (the "richer signal"). Vanilla MCP only sees its own
requests; CC's Read/Edit/Bash calls are invisible without this
hook.

Today's status: **partial**. The hook writes a marker file at
`$XDG_STATE_HOME/pantheon/runtime/touch-<ppid>.json` with the
timestamp + PID. The MCP server's daemon-tick polling integration
of these markers is TODO — when wired, the daemon will read the
markers, call `Watchdog.touch(sessionId)` for fresh ones, and
delete them.

The vanilla MCP "every request counts" rule (§14) gives us
coverage for the common case today.

### `PostToolUse` matcher=`color` → `color-binding.sh`

After the user runs CC's `/color` command, persist the chosen
color to the claimed persona via `update_profile({ color })`.
Documented intent; the hook is a stub today because CC doesn't
expose the `/color` value in a stable way for hooks. When that
exposure stabilizes, wire `pantheon update-profile --color <X>`.

### `UserPromptSubmit` → `context-pct-nudge.sh`

§6 HIGH auto-context-percent nudge. Threshold ladder:

- **70%** — soft hint via chat DM: "consider saving state."
- **85%** — strong nudge: "save state + handoff if continuing."
- **95%** — "save NOW + rest before auto-compaction."

Today: stub. Needs CC to expose context-pct via hook payload or
env var. Templated message bodies live (or will live) in
`src/responses/templates/context-nudge-{70,85,95}.md`.

### `tab-title.sh` (Windows-only future)

Re-titles the WT/kitty/wezterm tab from chat status updates.
Needs a long-lived listener (likely folds into the watcher loop)
plus per-session tab-id tracking. Documented as a future-
extension point; ships as a stub today.

## Slash commands

Each command is a markdown file with frontmatter (description,
argument-hint, allowed-tools) and a body that becomes the prompt
template CC sends when the user invokes the command. CC discovers
them by reading `commands_dir` from `plugin.json` (or by being
told to scan `~/.claude/commands/pantheon/`).

The seven commands map to common pantheon workflows:

| Command            | Wraps                                                      |
|--------------------|-------------------------------------------------------------|
| `pantheon-summon`  | `summon` with `target` shorthand parsing.                   |
| `pantheon-rest`    | `rest` with optional handoff parsing + `exit` follow-up.    |
| `pantheon-cast`    | `register({ claim_after: true })` after `whoami` check.     |
| `pantheon-list`    | `list` or `find_role` based on query shape.                 |
| `pantheon-stage`   | `login` + Monitor() spawn for the watcher.                  |
| `pantheon-status`  | `update_status`.                                            |
| `pantheon-doctor`  | `pantheon doctor`.                                          |

## Settings-templates

Role-folder permission scaffolds, one per common agent shape:

| Template          | Use case                                                    |
|-------------------|-------------------------------------------------------------|
| `role-builder`    | Code-edit + Bash + full pantheon MCP. The implementer shape.|
| `role-monitor`    | Read-only inspection + chat coordination. Watcher / dashboard. |
| `role-liaison`    | Full pantheon MCP minus destructive ops (no `unregister`, no `delete_snapshot`). Coordination + memory writes. |

The plugin **does NOT auto-overwrite** the user's `settings.json` —
each template is a JSON snippet the user copies into
`permissions.allow` (and `.deny`) by hand. The `_template_meta` key
documents what to merge where.

## Capability matrix (re §9b)

Per §9b, the plugin only ships what vanilla MCP can't do alone:

| Surface                           | Vanilla MCP | Plugin           |
|-----------------------------------|-------------|------------------|
| Tools (persona/memory/chat/spawn) | ✅          | —                |
| Slash commands                    | —           | ✅               |
| Statusline                        | —           | ✅ (via CLI)     |
| `/color` binding                  | —           | ✅ (stub)        |
| Tab-title-from-status (Win)       | —           | ✅ (stub)        |
| Watchdog reset on CC tool-use     | —           | ✅ (partial)     |
| Settings.json templates           | —           | ✅               |
| Auto-context-pct nudge            | surrogate   | ✅ (stub)        |

Vanilla MCP carries the full feature surface (per §9b). Plugin
extras are pure ergonomics.

## TODO

- Wire the watchdog-reset hook end-to-end (daemon-side marker-file
  polling). Lands cleanly when the §15 singleton daemon ships.
- Stabilize the `/color` hook against CC's actual color-exposure
  contract. Currently parses `~/.claude/sessions/*.json` as a
  fallback; needs CC blessing.
- Build the context-pct nudge once CC exposes the percentage.
- Real WT/kitty/wezterm tab-title integration (Windows-only path).
