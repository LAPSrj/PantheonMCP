# CLI

`bin/pantheon.ts` is the multi-command dispatcher. Each subcommand
re-uses the same daemon code paths (storage, chat, identity) — no
parallel implementations.

## Subcommands

```
pantheon serve                     # Run the MCP server (stdio).
pantheon fetch [...flags]          # Watcher loop. Forwards to pantheon-fetch.
pantheon doctor                    # Health check.
pantheon dump-chat [...flags]      # Export chat history to JSONL.
pantheon load-chat <file>          # Re-import a JSONL file.
pantheon validate <file>           # Lint a persona / memory JSON.

pantheon --version                 # Print version.
pantheon --help                    # Print this list.
```

## Exit codes

Uniform across every subcommand so shell scripts can branch on
the integer without parsing stderr:

| Code | Meaning              | Used by                                   |
|------|----------------------|-------------------------------------------|
| 0    | success              | every subcommand                          |
| 1    | user error           | unknown flags, missing args, doctor issues |
| 2    | schema error         | load-chat (rows rejected), validate (file invalid) |
| 3    | daemon-not-running   | reserved — surfaces once the §15 daemon mode lands |
| 4    | io error             | dump-chat (write failed), file-system errors |

`process.exit(code)` is the contract — fatal exceptions also
return 1.

## `pantheon doctor`

Health check. Walks the standard pantheon paths, opens the chat
DB, scans personas + memory, queries the presence table, reports
each check. No flags today.

| Check               | Result example                                                           |
|---------------------|--------------------------------------------------------------------------|
| `data_dir`          | `present at /home/x/.local/share/pantheon` / missing → warning           |
| `personas_dir`      | `present at <…>/personas` / missing                                      |
| `state_dir`         | `present at /home/x/.local/state/pantheon` / missing                     |
| `chat_db`           | missing → warning. (When present, `chat_db_schema` runs.)                |
| `chat_db_schema`    | `version N (expected M)` — error if mismatch (forgot to re-open daemon) |
| `personas`          | `N registered`                                                           |
| `memory file <X>`   | error if any persona's memory.json fails to parse                        |
| `presence`          | `N active session(s)` — counted via listActive                           |
| `daemon`            | "no daemon mode" until §15 future singleton lands                        |

Returns exit 0 when `errors == []`; warnings (e.g. fresh
PANTHEON_HOME with nothing in it) don't fail the check. `formatDoctorReport`
emits a human-readable block to stdout.

## `pantheon dump-chat`

Streams chat history to JSONL. One message per line, JSON-encoded
in the schema-stable `JsonlRow` shape (mirrors the `messages`
table).

```
pantheon dump-chat \
  [--since <ms_epoch>] \
  [--persona <handle>] \
  [--out <file|->]
```

- **`--since <ms_epoch>`** — `ts >= ?` filter. Common pattern:
  dump everything since yesterday's backup.
- **`--persona <handle>`** — match if the persona was the
  sender (their agent_id), the DM target (`target_username =
  handle`), the inline-named guest (`from_username_inline =
  handle`), OR the message mentions them
  (`mentions WHERE mentioned_username = handle`). Rolls all four
  filters into one query for completeness.
- **`--out <file|->`** — file path, or `-` for stdout. Default is
  stdout.

Output is sorted **`ts` ASC** (replay-friendly — re-importing via
`load-chat` produces a sensibly ordered chat.db).

## `pantheon load-chat`

Re-import a `dump-chat` JSONL file.

```
pantheon load-chat <file> [--dry-run]
```

Per `chat-cursor` design (semaphoremole spec):

- **`id` is preserved** — the same UUID. Duplicate-id rows in the
  target DB are SKIPPED, and the count surfaces as
  `skipped_duplicate=N` so re-imports are idempotent.
- **`ts`, `correlation_id`, `reply_to`, `kind`, `target_username`,
  `from_username_inline`** are preserved verbatim.
- **`seq` is REASSIGNED** by SQLite via the `SELECT
  COALESCE(MAX(seq), 0) + 1` pattern inside a transaction. The
  caller-supplied seq is ignored — preserving it would conflict
  with the cross-process monotonic-seq guarantee.
- **`--dry-run`** — parses + validates rows without writing.
  Useful for verifying a backup file before cutting over.

Reports `loaded=N skipped_duplicate=M skipped_invalid=K` to
stderr along with per-row error lines.

## `pantheon validate`

Lint a hand-edited persona or memory JSON file.

```
pantheon validate <file> [--type persona|memory]
```

`--type` is auto-detected from the path:

- `personas/<handle>.json` → `persona`
- `personas/<handle>/memory.json` → `memory`

Pass `--type` explicitly when the path doesn't match either
pattern.

Validators report:

- **persona**: missing required fields, username regex violation,
  `platform` not in `wsl/windows/mac/linux`, `mode` not in
  `fresh/resume`, `expertise`/`owns` not arrays-of-strings,
  `last_summoned_at` non-numeric.
- **memory**: `version != 1`, missing entry fields
  (`id/date/summary/text/status`), duplicate ids, `summary > 240`
  chars, `details > 5 MB`, invalid `status`, non-boolean `core`.

Exit 0 valid / 2 invalid (each error printed on stderr).

## Reusing storage helpers

Every subcommand calls into the same modules the daemon uses —
no parallel paths:

| Subcommand    | Reuses                                              |
|---------------|------------------------------------------------------|
| `doctor`      | `openChatDb`, `listPersonas`, `loadStore`, `listActive` |
| `dump-chat`   | `queryMessages`, `openChatDb`                        |
| `load-chat`   | `openChatDb`, the same SQLite-managed-seq pattern as `persistMessage` |
| `validate`    | `readJson` (storage layer); validation rules mirror the runtime checks in `identity.ts` and `memory/operations.ts`. |

Validators are derived from the runtime invariants — when the
runtime adds a constraint, the validator should mirror it (or
the runtime check itself should be liftable into a shared
helper).

## TODO

- Once the §15 daemon model lands, `doctor` gains a daemon-pid /
  socket discoverability check (and exit 3 when the user expects
  a daemon and it's not running).
- `pantheon migrate` is **explicitly out of scope** — Leandro's
  private one-shot import script handles legacy summon-mcp +
  chat-mcp data; pantheon ships clean.
