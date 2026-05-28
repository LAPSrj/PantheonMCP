# Storage

Pantheon uses a hybrid persistence model:

- **Personas + memory** — per-agent JSON files, hand-editable. Atomic
  rename on write; mtime-guarded mutate-then-rename for memory writes
  (which can race between concurrent incarnations).
- **Chat history** — SQLite in WAL mode. Append-heavy, query-rich, never
  cleaned up.
- **Window registry** — JSON. Runtime state; not load-bearing if lost.

## Filesystem layout

Pantheon uses a single root: `~/.pantheon/`. This is intentionally
NOT XDG-compliant — Leandro's call (04-26 spec): keep all pantheon
state in one folder so it's easy to back up, migrate, sync, or
hand-edit. Convention pattern matches `~/.ssh/`, `~/.gitconfig`,
`~/.cargo/`.

```
~/.pantheon/
├── chat.db                              # SQLite (WAL)
├── chat.db-wal
├── chat.db-shm
├── windows.json                         # named-window registry
├── daemon.sock                          # daemon Unix socket
├── daemon.pid                           # daemon pid file
├── runtime/                             # 0700-mode ephemeral state
│   └── <session>.json
├── sessions/                            # plugin-hook marker dirs
│   └── <ppid>/last_tool_use_at
├── pre-launch.sh                        # optional user hook (§14)
└── personas/
    ├── <handle>.json                    # persona registration
    └── <handle>/
        └── memory.json                  # persona memory entries
```

### Override env vars

| Variable               | Effect                                               |
|------------------------|------------------------------------------------------|
| `PANTHEON_HOME`        | Redirects the entire root to the given path. Used by test sandboxes so suites don't clobber the user's real data. |

The earlier XDG-split env vars (`PANTHEON_DATA_HOME`,
`PANTHEON_STATE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`) are NOT
honored as of 04-26. Migration from the old layout: see
`assertNoLegacyLayout` in `src/storage/paths.ts` — pantheon detects
data still living at `~/.local/{share,state}/pantheon/` and emits a
`mv` recipe rather than auto-migrating.

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
per write. Sibling incarnations of the same persona share a memory
file; the mtime guard prevents a slow writer from clobbering a
faster one's just-committed entries.

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
      "summoner_username": "alice",
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
| `kind`                  | `system_kind` ("keepalive" / "promotion" / "handle_recycled" / "profile_update" / "summon_failed" / etc.). NULL for normal user messages. |
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
guarantees that). Current head is **v8**; v6 added `rest_requests`, v7
`schemas`, v8 `summons`.

### Summon boot-verification (`summons`, v8)

A first-class lifecycle record for verifying a summon actually came up —
the SQLite-native analogue of the per-spawn `PANTHEON_EXIT_SENTINEL`
nonce, and the §14-watchdog companion. Mirrors the `rest_requests`
writer / sweep / TTL-prune shape (`src/lifecycle/summons.ts`).

```
CREATE TABLE summons (
  id TEXT PRIMARY KEY,            -- per-summon nonce; injected as PANTHEON_SUMMON_ID
  summoner_agent_id TEXT,         -- owns the verify sweep (NULL for CLI/human summons)
  target_username TEXT NOT NULL,
  target_project TEXT NOT NULL,
  spawn_args_json TEXT,           -- verbatim summon args, replayed on retry
  spawned_at INTEGER NOT NULL,    -- last (re)spawn; boot window measured from here
  confirmed_at INTEGER,           -- set when the child logs in carrying id
  confirmed_agent_id TEXT,        -- the child's chat agent_id (summoner<->agent link)
  retries INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending'   -- pending | confirmed | failed
    CHECK (state IN ('pending','confirmed','failed')),
  created_at INTEGER NOT NULL
);
```

Lifecycle:

1. **Write** — `spawnPersona` inserts a `pending` row and injects the
   nonce as `PANTHEON_SUMMON_ID`. Skipped for `verify: false` spawns
   (dream subagents, remanifest — the summoner exits) and when no chat
   db is wired.
2. **Confirm** — the child's first `login` runs
   `confirmSummon(db, PANTHEON_SUMMON_ID, agent_id)`. Keyed on the
   **nonce**, not the username, so it's correct under auto-suffixing
   (`vellumpike` → `vellumpike2`), already-online siblings, and
   concurrent remanifests — none of which carry the nonce. Idempotent.
3. **Verify sweep** — the summoner's 30s daemon-tick
   (`sweepSummonVerifications`) checks its own `pending` rows past the
   120s boot window: `retries < 1` → re-spawn reusing the same nonce;
   else → `failed` + a `summon_failed` system DM to the summoner.
4. **TTL prune** — `pruneStaleSummons` drops rows whose `spawned_at` is
   older than 10 min (terminal audit rows, or `pending` rows whose
   summoner died before the window). Active-verification rows keep a
   fresh `spawned_at`, so they survive.

v1 scopes the sweep to the summoner's own `agent_id` (no central daemon
to own all rows). When the dedicated daemon lands the sweep widens to
every row with no schema change — the "summoner died before the window"
gap closes for free.

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
