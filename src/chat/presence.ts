import type { Database } from "bun:sqlite";
import type { Mode, Subscriber } from "./types.ts";

/** §11c path-4a presence-via-SQLite. Each MCP process upserts its
 * subscriber rows + heartbeats every 5-10s. `list_agents` reads the
 * table filtered by `last_heartbeat > now - stale_threshold_ms`.
 *
 * In-memory subscribers (per-router) are still the hot path for
 * dispatch/visibility checks within a process; SQLite is the
 * cross-process visibility channel. The two are kept consistent by
 * the router writing-through on add/remove/update/setMode/flip. */

export const DEFAULT_STALE_THRESHOLD_MS = 30_000;
export const DEFAULT_PRUNE_GRACE_MS = 60_000;

export interface PresenceRow {
  agent_id: string;
  username: string;
  project: string;
  transient: boolean;
  mode: Mode;
  status: string;
  connected_at: number;
  status_updated_at: number;
  last_heartbeat: number;
  promoted_at: number | null;
}

/** Insert-or-update a subscriber row. Used on `login` and on every
 * heartbeat. `last_heartbeat` is bumped to the current clock.
 *
 * `chat_cursor` is **deliberately preserved** across upserts via the
 * ON CONFLICT clause (it's NOT in the DO UPDATE SET list). Without
 * this, every heartbeat / setMode / status change would reset the
 * cursor to 0 and a session would re-receive every message it had
 * already consumed. New rows start at chat_cursor = 0 (default
 * column value) so a reconnect under the same handle starts at the
 * full backlog — matching today's chat-mcp catch-up semantics. */
export function upsertSubscriber(
  db: Database,
  sub: Subscriber,
  now: number = Date.now(),
): void {
  db.run(
    `INSERT INTO subscribers (
       agent_id, username, project, transient, mode, status,
       connected_at, status_updated_at, last_heartbeat, promoted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       username = excluded.username,
       project = excluded.project,
       transient = excluded.transient,
       mode = excluded.mode,
       status = excluded.status,
       connected_at = excluded.connected_at,
       status_updated_at = excluded.status_updated_at,
       last_heartbeat = excluded.last_heartbeat,
       promoted_at = excluded.promoted_at`,
    [
      sub.agent_id,
      sub.username,
      sub.project,
      sub.transient ? 1 : 0,
      sub.mode,
      sub.status,
      sub.connected_at,
      sub.status_updated_at,
      now,
      sub.promoted_at,
    ],
  );
}

/** Bump `last_heartbeat` only — no other fields change. Cheap; fires
 * every 5-10s from the MCP server's heartbeat scheduler.
 *
 * Returns the number of rows updated (0 when the row has been pruned,
 * 1 when the heartbeat landed). The caller uses the zero-rowcount
 * signal to decide whether to self-heal via `upsertSubscriber` — see
 * `ChatRouter.heartbeat`. */
export function heartbeat(
  db: Database,
  agent_id: string,
  now: number = Date.now(),
): number {
  return db.run("UPDATE subscribers SET last_heartbeat = ? WHERE agent_id = ?", [
    now,
    agent_id,
  ]).changes;
}

/** Remove a subscriber row. Used on `logout`. */
export function removeSubscriber(db: Database, agent_id: string): void {
  db.run("DELETE FROM subscribers WHERE agent_id = ?", [agent_id]);
}

/** Read this subscriber's persisted chat_cursor (last seq consumed
 * by `check_messages`). Returns 0 when no row exists — caller gets
 * the full backlog on first call after reconnect. */
export function readChatCursor(db: Database, agent_id: string): number {
  const row = db
    .query("SELECT chat_cursor FROM subscribers WHERE agent_id = ?")
    .get(agent_id) as { chat_cursor: number } | undefined;
  return row?.chat_cursor ?? 0;
}

/** Advance the persisted chat_cursor to `seq`. Monotonic — won't
 * walk backward (the WHERE clause guards against it). */
export function advanceChatCursor(
  db: Database,
  agent_id: string,
  seq: number,
): void {
  db.run(
    "UPDATE subscribers SET chat_cursor = ? WHERE agent_id = ? AND chat_cursor < ?",
    [seq, agent_id, seq],
  );
}

/** Read all rows whose `last_heartbeat` is fresher than the stale
 * threshold. Optional project filter. Used by `list_agents` and
 * `find_role`. */
export function listActive(
  db: Database,
  options: {
    project?: string;
    stale_threshold_ms?: number;
    now?: number;
  } = {},
): PresenceRow[] {
  const now = options.now ?? Date.now();
  const threshold = options.stale_threshold_ms ?? DEFAULT_STALE_THRESHOLD_MS;
  const cutoff = now - threshold;
  const params: unknown[] = [cutoff];
  let sql = "SELECT * FROM subscribers WHERE last_heartbeat > ?";
  if (options.project) {
    sql += " AND project = ?";
    params.push(options.project);
  }
  sql += " ORDER BY username COLLATE NOCASE";
  const rows = db.query(sql).all(...(params as never[])) as Array<{
    agent_id: string;
    username: string;
    project: string;
    transient: number;
    mode: string;
    status: string;
    connected_at: number;
    status_updated_at: number;
    last_heartbeat: number;
    promoted_at: number | null;
  }>;
  return rows.map((r) => ({
    agent_id: r.agent_id,
    username: r.username,
    project: r.project,
    transient: r.transient === 1,
    mode: r.mode as Mode,
    status: r.status,
    connected_at: r.connected_at,
    status_updated_at: r.status_updated_at,
    last_heartbeat: r.last_heartbeat,
    promoted_at: r.promoted_at,
  }));
}

/** DELETE rows whose `last_heartbeat` is older than the prune grace.
 * Returns the number of pruned rows. The grace is intentionally
 * longer than the stale threshold so a momentarily-late heartbeat
 * doesn't get the row evicted (`list_agents` already hides it). */
export function pruneStale(
  db: Database,
  options: { prune_grace_ms?: number; now?: number } = {},
): number {
  const now = options.now ?? Date.now();
  const grace = options.prune_grace_ms ?? DEFAULT_PRUNE_GRACE_MS;
  const cutoff = now - grace;
  const before = (db.query("SELECT COUNT(*) AS c FROM subscribers").get() as { c: number }).c;
  db.run("DELETE FROM subscribers WHERE last_heartbeat < ?", [cutoff]);
  const after = (db.query("SELECT COUNT(*) AS c FROM subscribers").get() as { c: number }).c;
  return before - after;
}

/** Test helper: total row count regardless of staleness. */
export function totalSubscribers(db: Database): number {
  return (db.query("SELECT COUNT(*) AS c FROM subscribers").get() as { c: number }).c;
}
