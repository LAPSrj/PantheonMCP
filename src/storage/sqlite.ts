import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";

/** Bumped when the schema changes. Each `vN` migration runs once and is
 * recorded in `schema_version`. Migrations are idempotent: re-opening an
 * up-to-date DB applies nothing. */
export const CURRENT_SCHEMA_VERSION = 9;

/** Migrations indexed by the version they bring the schema to. So
 * `MIGRATIONS[1]` brings a fresh DB from version 0 to version 1. */
const MIGRATIONS: Record<number, (db: Database) => void> = {
  1: (db) => {
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        scope TEXT NOT NULL,
        project TEXT,
        target_username TEXT,
        from_agent_id TEXT NOT NULL,
        from_transient INTEGER NOT NULL DEFAULT 0,
        from_username_inline TEXT,
        text TEXT NOT NULL,
        kind TEXT,
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
    `);
  },
  2: (db) => {
    // §11c presence cross-process: each connected chat subscriber gets
    // a row here, refreshed on every heartbeat. `list_agents` reads
    // rows whose `last_heartbeat` is fresher than the stale-threshold
    // (configurable; default 30s). The daemon-tick `pruneStale`
    // sweep deletes stale rows after a longer grace.
    db.exec(`
      CREATE TABLE subscribers (
        agent_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        project TEXT NOT NULL,
        transient INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'all',
        status TEXT NOT NULL DEFAULT '',
        connected_at INTEGER NOT NULL,
        status_updated_at INTEGER NOT NULL,
        last_heartbeat INTEGER NOT NULL,
        promoted_at INTEGER
      );
      CREATE INDEX idx_subscribers_username ON subscribers(username);
      CREATE INDEX idx_subscribers_project ON subscribers(project);
      CREATE INDEX idx_subscribers_heartbeat ON subscribers(last_heartbeat DESC);
    `);
  },
  3: (db) => {
    // §11c watcher loop hot path: SELECT WHERE seq > ? ORDER BY seq.
    // The existing idx_messages_ts is per-timestamp; seq is the
    // cursor the watcher tracks across polls.
    db.exec(`CREATE INDEX idx_messages_seq ON messages(seq);`);
  },
  4: (db) => {
    // §11c cross-process check_messages: each subscriber gets a
    // persistent chat_cursor (last seq consumed). check_messages
    // pulls rows past the cursor + advances after returning.
    // Preserves chat-mcp's manual-catch-up semantics in vanilla
    // MCP cross-process configurations.
    db.exec(
      `ALTER TABLE subscribers ADD COLUMN chat_cursor INTEGER NOT NULL DEFAULT 0;`,
    );
  },
  5: (db) => {
    // Structured-message support (D.6 in nyus-improvement-audit):
    // pantheon-as-neutral-infra exposes a free-form `user_kind` for
    // caller-typed messages plus a `payload` JSON string for the
    // typed body. `kind` (existing) keeps serving system_kind only;
    // splitting the columns avoids namespace collisions between
    // SystemKind values and user-provided kinds.
    db.exec(`
      ALTER TABLE messages ADD COLUMN user_kind TEXT;
      ALTER TABLE messages ADD COLUMN payload TEXT;
      CREATE INDEX idx_messages_user_kind ON messages(user_kind, ts DESC)
        WHERE user_kind IS NOT NULL;
    `);
  },
  6: (db) => {
    // Cross-process force-rest / force-exit IPC. A summoner's MCP
    // process writes a row here addressed to a target agent_id; the
    // target's pantheon-server consumes pending rows on its 30s
    // prune tick and runs the rest / exit pipeline. Companion to
    // PANTHEON_BLOCK_SELF_EXIT — when the spawned agent has
    // self-exit blocked, the only paths to ending its session are
    // (a) the watchdog rest_timeout firing, or (b) a force_rest /
    // force_exit row landing here.
    //
    // Rows are DELETE-RETURNING'd on consume — the table holds only
    // pending requests, never history. TTL-pruned in the same prune
    // sweep: rows older than a few minutes get deleted (caller died
    // or never came online; target never came online or died).
    db.exec(`
      CREATE TABLE rest_requests (
        id TEXT PRIMARY KEY,
        target_agent_id TEXT NOT NULL,
        from_agent_id TEXT,
        reason TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('rest','exit')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_rest_requests_target ON rest_requests(target_agent_id);
      CREATE INDEX idx_rest_requests_created ON rest_requests(created_at);
    `);
  },
  7: (db) => {
    // Project-scoped schema registry. Pantheon's `register_schema` /
    // `get_schema` / `list_schemas` / `unregister_schema` (and
    // `send_structured`'s validation lookup) move out of the
    // file-backed `~/.pantheon/schemas.json` and into chat.db, keyed
    // by (project, schema_id). Same DB as subscribers and messages —
    // cross-process consistency comes for free.
    //
    // Legacy entries from schemas.json are imported into project
    // `__legacy_global__` on every chat.db open while the file is
    // still present (idempotent; see `importLegacySchemas`).
    db.exec(`
      CREATE TABLE schemas (
        project TEXT NOT NULL,
        schema_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        description TEXT,
        registered_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project, schema_id)
      );
      CREATE INDEX idx_schemas_project ON schemas(project);
    `);
  },
  8: (db) => {
    // Summon boot-verification (§14 watchdog companion). Each summon is
    // a first-class lifecycle record — the SQLite-native analogue of the
    // PANTHEON_EXIT_SENTINEL nonce, mirroring the rest_requests pattern
    // (writer / sweep / TTL-prune).
    //
    // `id` is the per-summon nonce, injected into the child as
    // PANTHEON_SUMMON_ID. The child's first `login` stamps confirmed_at
    // + confirmed_agent_id by THAT id, so attribution is instance-level:
    // it survives auto-suffixing (vellumpike -> vellumpike2 -> renamed
    // back), already-online siblings, and concurrent remanifests — none
    // of which carry the nonce. A username/glob match cannot do this.
    //
    // The summoner's 30s daemon-tick verifies its OWN pending rows
    // (summoner_agent_id) past the boot window: re-spawns once (reusing
    // the same nonce, bumping retries), then marks `failed` and DMs the
    // summoner. Hand-started / manually-manifested sessions never go
    // through spawnPersona, so they get no row and are never checked.
    //
    // `spawn_args_json` is the verbatim summon args, replayed on retry
    // so the re-spawn is faithful (same prompt/target/model/etc).
    //
    // Rows outlive the agent's presence (subscribers rows are deleted on
    // logout) — retry state + the summoner<->agent link need a longer
    // life than presence. TTL-pruned once terminal + aged.
    db.exec(`
      CREATE TABLE summons (
        id TEXT PRIMARY KEY,
        summoner_agent_id TEXT,
        target_username TEXT NOT NULL,
        target_project TEXT NOT NULL,
        spawn_args_json TEXT,
        spawned_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        confirmed_agent_id TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending','confirmed','failed')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_summons_summoner ON summons(summoner_agent_id);
      CREATE INDEX idx_summons_state ON summons(state);
    `);
  },
  9: (db) => {
    // Zombie-detection observability: `last_activity_at` records when the
    // agent's event loop last made progress (reset by the watchdog on
    // every MCP tool dispatch + PreToolUse hook touch). Distinct from
    // `last_heartbeat` (process-aliveness, bumped unconditionally by the
    // 5s timer). A session whose heartbeat is fresh but last_activity_at
    // is stale is a zombie — alive process, frozen agent. `list_agents`
    // surfaces the gap as `idle_for_ms`. Nullable: a row with no value
    // yet (or a process that never wired a watchdog) renders idle_for_ms
    // = null rather than a bogus zero.
    db.exec(
      `ALTER TABLE subscribers ADD COLUMN last_activity_at INTEGER;`,
    );
  },
};

/** Open (and lazily create) the chat-history database in WAL mode.
 * Runs any pending migrations; safe to call repeatedly. */
export function openChatDb(dbPath: string): Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");

  ensureSchemaVersionTable(db);
  runPendingMigrations(db);

  return db;
}

function ensureSchemaVersionTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    )
  `);
}

function currentVersion(db: Database): number {
  const row = db.query("SELECT MAX(version) AS v FROM schema_version").get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

function runPendingMigrations(db: Database): void {
  let version = currentVersion(db);
  while (version < CURRENT_SCHEMA_VERSION) {
    const next = version + 1;
    const migrate = MIGRATIONS[next];
    if (!migrate) {
      throw new Error(
        `Missing migration to schema version ${next}; ` +
          `pantheon expects migrations 1..${CURRENT_SCHEMA_VERSION} to be defined.`,
      );
    }
    db.transaction(() => {
      migrate(db);
      db.run("INSERT INTO schema_version (version) VALUES (?)", [next]);
    })();
    version = next;
  }
}
