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

2. Add the MCP server entry to your `~/.claude.json`:

   ```json
   {
     "mcpServers": {
       "pantheon": {
         "command": "bun",
         "args": ["run", "/home/leandro/repos/pantheon/bin/pantheon.ts", "serve"]
       }
     }
   }
   ```

3. Add a statusline entry to your `~/.claude/settings.json`:

   ```json
   {
     "statusline": {
       "command": "bun run /home/leandro/repos/pantheon/bin/pantheon.ts statusline"
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
[pantheon 3] pantheon:vellumpike,moth-whistle | ops:leandro*
```

Numeric prefix is the count of online subscribers; groups are
per-project; guests get `*` suffix.

## Hook status

| Hook                    | Status            | Notes |
|-------------------------|-------------------|-------|
| Watchdog reset (PreToolUse) | partial      | Writes a marker file; daemon-tick polling integration TBD. Vanilla MCP rule (§14) covers the common case. |
| `/color` binding (PostToolUse) | stub       | Documents intent; needs CC color-exposure path to wire. |
| Context-pct nudge (UserPromptSubmit) | stub | Documents intent + threshold ladder; needs CC context-pct exposure. |
| Tab-title-from-status   | stub              | Windows-only design. Needs daemon-side listener; likely folds into watcher loop. |

The stubs ship as documented future-extension points. They exit 0
silently so CC doesn't block on them. Real wiring lands when CC's
hook integration matures or pantheon's §15 singleton daemon ships.

## Capability matrix (per §9b)

| Surface                           | Vanilla MCP | This plugin |
|-----------------------------------|-------------|-------------|
| Persona register / summon / chat / memory / lifecycle | ✅ | — |
| Slash commands (`/pantheon-*`)    | —           | ✅          |
| Statusline integration            | —           | ✅          |
| `/color` binding                  | —           | ✅ (stub)   |
| Tab-title-from-status             | —           | ✅ (stub)   |
| Watchdog reset on CC tool-use     | —           | ✅ (stub)   |
| Settings.json permission templates| —           | ✅          |
| Auto-context-percent nudge        | partial (surrogate) | ✅ proper hook (stub) |

The plugin is **NOT** required to use pantheon. Vanilla MCP carries
the full feature surface. The plugin only adds CC-side ergonomics.
