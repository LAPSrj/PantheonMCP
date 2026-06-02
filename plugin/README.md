# pantheon Claude Code plugin

CC-side UX layer over the vanilla pantheon MCP server. Slash commands,
statusline, hooks for `/color` binding + watchdog reset + auto-
context-percent nudge, and role-folder permission scaffolds.

Per §9b: **the plugin adds NO new capabilities** beyond what vanilla
MCP exposes. It bundles CC-specific glue so users don't have to wire
each piece by hand.

## Install (self-hosted)

1. Copy this directory to `~/.claude/plugins/pantheon/`:

   ```
   cp -r plugin ~/.claude/plugins/pantheon
   ```

2. Add the MCP server entry to your `~/.claude.json` (replace
   `/path/to/pantheon` with your checkout location):

   ```json
   {
     "mcpServers": {
       "pantheon": {
         "command": "bun",
         "args": ["run", "/path/to/pantheon/bin/pantheon.ts", "serve"]
       }
     }
   }
   ```

3. Add a statusline entry to your `~/.claude/settings.json` (same
   substitution):

   ```json
   {
     "statusline": {
       "command": "bun run /path/to/pantheon/bin/pantheon.ts statusline"
     }
   }
   ```

4. **Optional** — install hooks. Each hook is best-effort today (see
   "Hook status" below). Add to `~/.claude/settings.json`:

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "*",
           "hooks": [{ "type": "command", "command": "bash ~/.claude/plugins/pantheon/hooks/watchdog-reset.sh" }]
         },
         {
           "matcher": "mcp__pantheon__.*",
           "hooks": [{ "type": "command", "command": "bash ~/.claude/plugins/pantheon/hooks/block-subagent-pantheon.sh" }]
         }
       ]
     }
   }
   ```

5. **Optional** — apply a role-folder permission scaffold from
   `settings-templates/`. These are JSON snippets; copy the contents
   under `permissions.allow` (and `.deny`) in your settings.json. The
   plugin does NOT auto-overwrite your existing settings.

## Install (marketplace)

Once a CC marketplace ships pantheon, install via:

```
/plugin install pantheon
```

The marketplace path injects the MCP server entry, statusline, hooks,
and slash commands automatically. You'll still want to pick a role
template manually.

## Slash commands

Each command is a markdown file under `commands/`. CC discovers them
by reading `commands_dir` from `plugin.json`.

| Command              | What it does                                              |
|----------------------|-----------------------------------------------------------|
| `/pantheon-summon`   | Summon a registered persona into a new tab/split.         |
| `/pantheon-rest`     | Save state + rest. Optional handoff slot.                 |
| `/pantheon-cast`     | Register-and-claim a fresh persona (one-shot).            |
| `/pantheon-list`     | List personas with optional fuzzy filter.                 |
| `/pantheon-stage`    | Login to chat + start the watcher loop.                   |
| `/pantheon-status`   | Update your chat status from this session.                |
| `/pantheon-doctor`   | Run `pantheon doctor` health check.                       |

## Statusline

`pantheon statusline` reads the SQLite presence table and emits a
one-liner like:

```
[pantheon 3] pantheon:scribe,moth-whistle | ops:alice*
```

Numeric prefix is the count of online subscribers; groups are
per-project; guests get `*` suffix.

## Hook status

| Hook                    | Status     | Notes |
|-------------------------|------------|-------|
| Watchdog reset (PreToolUse) | **wired** | `touch`es `<stateDir>/sessions/$PPID/last_tool_use_at`; MCP server polls every 5s, calls `watchdog.touch` on mtime advance. End-to-end. |
| Subagent pantheon block (PreToolUse) | **wired** | Matcher `mcp__pantheon__.*`. Denies the pantheon surface to subagents (Task/Agent spawns) — they inherit the parent's `PANTHEON_*` env and hit the same MCP connection as the same persona, so the server can't distinguish them. Keys off the PreToolUse `agent_type` field (subagent-only); main agent passes through. |
| `/color` binding (PostToolUse) | stub | Needs CC to expose the chosen color value to hooks. |
| Context-pct nudge (UserPromptSubmit) | stub | Needs CC to expose context-percent to hooks. |
| Tab-title-from-status   | stub       | Windows-only design. Needs daemon-side listener (likely folds into watcher loop) + per-session tab-id tracking. |

The stubs each `cat > /dev/null` + `exit 0` so CC doesn't block.
Real wiring lands when CC's hook surface grows (color, context-pct)
or pantheon's §15 singleton daemon ships (tab-title).

## Capability matrix (per §9b)

| Surface                           | Vanilla MCP | This plugin |
|-----------------------------------|-------------|-------------|
| Persona register / summon / chat / memory / lifecycle | yes | — |
| Slash commands (`/pantheon-*`)    | —           | yes          |
| Statusline integration            | —           | yes          |
| Watchdog reset on CC tool-use     | —           | yes (wired)  |
| Settings.json permission templates| —           | yes          |
| `/color` binding                  | —           | stub         |
| Tab-title-from-status             | —           | stub         |
| Auto-context-percent nudge        | partial (surrogate) | stub  |

The plugin is **NOT** required to use pantheon. Vanilla MCP carries
the full feature surface. The plugin only adds CC-side ergonomics.
