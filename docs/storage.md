# Storage

Pantheon uses a hybrid persistence model per the §15 design (see
`/home/leandro/liaison/persona-mcp-brainstorm.md`):

- **Personas + memory** — per-agent JSON files, hand-editable. Atomic
  rename on write; mtime-guarded mutate-then-rename for memory writes
  (which can race between concurrent incarnations).
- **Chat history** — SQLite in WAL mode. Append-heavy, query-rich, never
  cleaned up.
- **Window registry** — JSON. Runtime state; not load-bearing if lost.

## Filesystem layout

Defaults follow the XDG Base Directory spec.

```
${XDG_DATA_HOME:-~/.local/share}/pantheon/
├── chat.db                              # SQLite (WAL)
├── chat.db-wal
├── chat.db-shm
└── personas/
    ├── <handle>.json                    # persona registration
    └── <handle>/
        └── memory.json                  # persona memory entries

${XDG_STATE_HOME:-~/.local/state}/pantheon/
├── windows.json                         # named-window registry
├── daemon.sock                          # daemon Unix socket
├── daemon.pid                           # daemon pid file
└── runtime/                             # 0700-mode ephemeral state
    └── <session>.json
```

### Override env vars

| Variable               | Effect                                               |
|------------------------|------------------------------------------------------|
| `PANTHEON_HOME`        | Overrides BOTH data and state roots to the same dir. |
| `PANTHEON_DATA_HOME`   | Overrides data root only (wins over `PANTHEON_HOME`).|
| `PANTHEON_STATE_HOME`  | Overrides state root only (wins over `PANTHEON_HOME`).|
| `XDG_DATA_HOME`        | Standard XDG. Used when no Pantheon override is set. |
| `XDG_STATE_HOME`       | Standard XDG. Used when no Pantheon override is set. |

`PANTHEON_HOME` is the convenience knob for tests and sandboxed runs;
the split overrides exist for environments that want data on a
durable volume but state on tmpfs.

## JSON files

All JSON writes go through `writeJsonAtomic` (`src/storage/json.ts`):

1. Write payload to `<target>.tmp.<pid>.<ts>.<rand>` via
   `open(O_WRONLY|O_CREAT, 0o600)`.
2. `fsync` the temp file.
3. `rename(2)` it over the destination — POSIX-atomic on the same
   filesystem.
4. On failure, the temp file is unlinked.

Memory writes (and any other multi-writer JSON) use `mutateJsonAtomic`,
which:

1. Stats the current file's mtime.
2. Reads + parses the current value.
3. Calls the caller's `mutator` to compute the next value.
4. Writes the temp file.
5. Re-stats the mtime — if it moved between (1) and (5), a sibling
   raced; unlink the temp and retry. Up to 3 attempts with 5ms backoff,
   then `StorageError("mutate_conflict")`.

Single-instance use never trips a retry; the cost is one extra `stat`
per write. The pattern descends from
`/home/leandro/summon-mcp-incarnations-plan.md` §2.1.

### Reader tolerance

`readJson` retries once after a 5ms backoff if `JSON.parse` fails, in
case the read caught a writer mid-rename on a system where the rename
isn't fully atomic. (POSIX guarantees atomicity on the same filesystem,
but defensive reads are cheap.)

### Persona file shape

The persona file at `personas/<handle>.json` carries the registered
identity. Schema lives in `src/types.ts` (TBD); think of it as a
superset of summon-mcp's `AgentEntry` plus pantheon-specific fields
(`session_name`, `summon_count`, `provisional`, etc.).

### Memory file shape

`personas/<handle>/memory.json` is a `MemoryStore`:

```json
{
  "version": 1,
  "entries": [
    {
      "id": "decision-storage-layout",
      "date": "2026-04-25T20:00:00.000Z",
      "summary": "≤240 char headline, always rendered.",
      "text": "Body — load-bearing facts, decisions. Counts toward budget.",
      "details": "Optional unbounded prose, ≤5MB, only via get_memory_details.",
      "kind": "decision",
      "core": true,
      "summoner_username": "leandro",
      "status": "active"
    }
  ]
}
```

Pantheon reads `core` only — there is no `pinned` fallback. (The
brainstorm explicitly forbids back-compat shims; existing data is
imported via Leandro's private one-shot script before pantheon goes
live.)

## SQLite chat history

Open a connection via `openChatDb(path)` (`src/storage/sqlite.ts`).
The function creates the file if missing, sets `journal_mode=WAL`,
`synchronous=NORMAL`, `foreign_keys=ON`, and runs any pending
migrations.

### Schema (v1)

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  scope TEXT NOT NULL,           -- "project" | "dm" | "global"
  project TEXT,
  target_username TEXT,
  from_agent_id TEXT NOT NULL,
  from_transient INTEGER NOT NULL DEFAULT 0,
  from_username_inline TEXT,
  text TEXT NOT NULL,
  kind TEXT,                     -- system_kind for system msgs
  reply_to TEXT,
  correlation_id TEXT
);
CREATE INDEX idx_messages_ts ON messages(ts DESC);
CREATE INDEX idx_messages_scope_project ON messages(scope, project, ts DESC);
CREATE INDEX idx_messages_target ON messages(target_username, ts DESC)
  WHERE target_username IS NOT NULL;
CREATE INDEX idx_messages_from_agent ON messages(from_agent_id, ts DESC);
CREATE INDEX idx_messages_correlation ON messages(correlation_id)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_messages_kind ON messages(kind, ts DESC)
  WHERE kind IS NOT NULL;

CREATE TABLE mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mentioned_username TEXT NOT NULL,
  PRIMARY KEY (message_id, mentioned_username)
);
CREATE INDEX idx_mentions_user ON mentions(mentioned_username, message_id);

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY
);
INSERT INTO schema_version (version) VALUES (1);
```

### Column glossary

| Column                  | Semantics                                        |
|-------------------------|--------------------------------------------------|
| `id`                    | UUID assigned at insert time.                    |
| `seq`                   | Monotonic per-process counter for cursor advance.|
| `ts`                    | Unix ms timestamp.                               |
| `scope`                 | `"project"` / `"dm"` / `"global"`.               |
| `project`               | Project code; populated for `project` scope. May be set on `dm`/`global` for filtering. |
| `target_username`       | DM target (when `scope="dm"`) or project name routing. |
| `from_agent_id`         | Sender's chat-router agent_id (UUID).            |
| `from_transient`        | `1` when sender was a guest at send time.        |
| `from_username_inline`  | Guest sender's handle stored inline; persona senders resolve via registry. |
| `text`                  | Message body.                                    |
| `kind`                  | `system_kind` ("keepalive" / "promotion" / "handle_recycled" / "profile_update" / etc.). NULL for normal user messages. |
| `reply_to`              | Optional message id this replies to.             |
| `correlation_id`        | `ask_id` for ask/answer correlation.             |
| `mentions`              | Joined table — `@user` parses recorded per row.  |

### Migrations

`schema_version` records every applied version. `runPendingMigrations`
walks from `MAX(version)+1` to `CURRENT_SCHEMA_VERSION`, applying each
migration inside a transaction and inserting a new row on success.
Adding a v2 migration: define `MIGRATIONS[2]` in `src/storage/sqlite.ts`
and bump `CURRENT_SCHEMA_VERSION`. Migrations must be idempotent under
the assumption they only ever run once (the `schema_version` insert
guarantees that).

### Hand-editing chat history

SQLite is harder to hand-edit than JSON, so pantheon ships:

- `pantheon dump-chat [--since X] [--persona Y] [--out file.jsonl]`
  — exports to JSONL.
- `pantheon load-chat file.jsonl` — re-imports.
- Direct `sqlite3 chat.db "SELECT ..."` works.

## Crash recovery

| Failure                       | Outcome                                         |
|-------------------------------|-------------------------------------------------|
| Daemon crash mid-JSON-write   | Atomic rename — old or new file present, never partial. Temp file may linger; it's named `*.tmp.*` and the next `writeJsonAtomic` of that target won't conflict. Sweep at startup is OK to add later. |
| Daemon crash mid-SQLite-write | WAL rollback on next open. Uncommitted txns vanish; committed ones survive. |
| Daemon `kill -9` mid-promote  | Registry write happens last; reconciler self-heals (see §10 / §13). |
| Daemon `kill -9` mid-claim    | In-memory only; restart leaves session unclaimed; reconciler prompts re-claim. |
