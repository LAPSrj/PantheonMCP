import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";

/** Bumped when the schema changes. Each `vN` migration runs once and is
 * recorded in `schema_version`. Migrations are idempotent: re-opening an
 * up-to-date DB applies nothing. */
export const CURRENT_SCHEMA_VERSION = 1;

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
