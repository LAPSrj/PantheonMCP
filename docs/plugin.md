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
hook. Without it, an agent doing >60min of pure Read/Edit/Bash
without chatting auto-rests despite being actively useful — the
exact bug class that hurt the 2026-04-25 session.

**Status: WIRED end-to-end.** Implementation:

1. **Hook**: `plugin/hooks/watchdog-reset.sh` is registered for
   PreToolUse with empty matcher (fires on every tool-use). It
   resolves the sessions root from `PANTHEON_HOME` /
   `PANTHEON_STATE_HOME` / `XDG_STATE_HOME` / `$HOME/.local/state`
   then `mkdir -p` + `touch`es:

   ```
   <stateDir>/sessions/$PPID/last_tool_use_at
   ```

   `$PPID` is the CC parent process pid — guaranteed equal between
   the hook and the pantheon MCP server (CC is parent of both).
   The file's MTIME is the wire format; contents are irrelevant.

2. **Daemon-tick consumer**: `src/mcp/hook-poller.ts` exports
   `HookPoller`. The MCP server registers one in `server.ts` and
   polls every 5s (same cadence as the chat heartbeat). The poller
   `stat`s the marker; when mtime advances past the last-seen,
   it calls `watchdog.touch(ctx.session.id)`. Idempotent — no
   re-fires until the next mtime advance.

3. **Cleanup**: `sweepStaleSessionDirs(paths)` runs at MCP server
   boot. Dirs whose `last_tool_use_at` (or dir mtime fallback)
   is older than 1 hour are `rm -rf`ed. CC sessions whose CC
   parent has long since exited don't accumulate.

4. **Multi-MCP within one CC session**: PPID is shared, so all
   pantheon MCP servers in the same CC session read the same
   marker. Each only resets ITS OWN watchdog session id — no
   cross-talk. (Other MCP processes from other plugins can write
   under different sessions roots; ours is namespaced under
   `pantheon/sessions/`.)

The vanilla MCP "every request counts" rule (§14) still applies
in parallel — both signals reset the same watchdog. Belt and
braces.

### `PostToolUse` matcher=`color` → `color-binding.sh`

**Status: STUB. Not currently wirable.** After the user runs CC's
`/color` command, the intent is to persist the chosen color to the
claimed persona via `update_profile({ color })`. The hook can't be
wired today because CC doesn't expose the chosen color value in a
hook-readable way (no env var, no stdin payload field). Wire when
CC exposes the color through one of those channels.

### `UserPromptSubmit` → `context-pct-nudge.sh`

**Status: STUB. Not currently wirable.** §6 HIGH auto-context-
percent nudge with the threshold ladder (70% soft / 85% strong /
95% urgent). The hook can't be wired today because CC doesn't
expose context-percent via hook payload or env var. When CC
exposes it (the most likely path is a hook-payload field), wire
this against the templated message bodies in
`src/responses/templates/context-nudge-{70,85,95}.md` (TBD).

### `tab-title.sh` (Windows-only future)

**Status: STUB. Architecturally distinct path.** Re-titles the
WT/kitty/wezterm tab from chat status updates. Needs a long-lived
listener (the watcher loop already provides one — folding this in
is the most natural path) plus per-session tab-id tracking. Lands
when the §15 singleton daemon ships AND CC's per-MCP-process tab
identity is reachable.

### Why the other three stay stubs

The watchdog-reset hook had a clean wiring path: filesystem marker
file the daemon-tick polls. The three remaining hooks each need
data that doesn't exist in CC's hook surface today:

- `/color` → CC has the value internally but doesn't pipe it to
  hooks.
- `context-pct` → same shape; CC has the value, doesn't expose.
- `tab-title` → needs a listener architecture pantheon doesn't
  have until the daemon model lands.

These ship as documented stubs (each script `cat > /dev/null` +
`exit 0`) rather than half-wired implementations that would lie
about what they do. When CC's hook surface grows, swap each stub
for the real script and document the wiring change in the
respective section above.

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
| Watchdog reset on CC tool-use     | —           | ✅ (wired)       |
| Settings.json templates           | —           | ✅               |
| `/color` binding                  | —           | 🟡 stub (CC exposure needed) |
| Auto-context-pct nudge            | surrogate   | 🟡 stub (CC exposure needed) |
| Tab-title-from-status (Win)       | —           | 🟡 stub (daemon model needed) |

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
