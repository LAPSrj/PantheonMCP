import crypto from "node:crypto";
import type { Database } from "bun:sqlite";

/** Force-rest / force-exit IPC. A caller (typically a summoner) writes
 * a row addressed to the target's chat agent_id; the target's pantheon
 * MCP server consumes pending rows on its 30s prune tick and runs the
 * rest / exit pipeline. Schema lives in sqlite.ts migration v6.
 *
 * Companion to the PANTHEON_BLOCK_SELF_EXIT env-var gate: when the
 * spawned agent has self-exit blocked, the only paths to ending its
 * session are (a) the watchdog rest_timeout firing, or (b) a row
 * landing here.
 *
 * Rows are deleted on consume — the table holds only pending requests,
 * never history. Stale unconsumed rows (caller died or never came
 * online) are TTL-swept by `pruneStaleRestRequests`. */

export type RestRequestKind = "rest" | "exit";

export interface RestRequest {
  id: string;
  target_agent_id: string;
  from_agent_id: string | null;
  reason: string | null;
  kind: RestRequestKind;
  created_at: number;
}

interface RestRequestRow {
  id: string;
  target_agent_id: string;
  from_agent_id: string | null;
  reason: string | null;
  kind: string;
  created_at: number;
}

/** Default TTL for unconsumed rows. Beyond this, the prune sweep
 * deletes them — the caller is presumed dead or never came back, the
 * target either never came online or died, and the row is dead
 * weight. */
export const DEFAULT_REST_REQUEST_TTL_MS = 5 * 60 * 1000; // 5 min

export function writeRestRequest(
  db: Database,
  args: {
    target_agent_id: string;
    from_agent_id: string | null;
    kind: RestRequestKind;
    reason?: string | null;
    now?: number;
  },
): string {
  const id = crypto.randomUUID();
  const now = args.now ?? Date.now();
  db.run(
    `INSERT INTO rest_requests (id, target_agent_id, from_agent_id, reason, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, args.target_agent_id, args.from_agent_id, args.reason ?? null, args.kind, now],
  );
  return id;
}

/** Atomically claim and return all pending rows for the given
 * agent_id, deleting them from the table in the same statement. No
 * audit trail is preserved — once consumed, the request is gone.
 * Returned in created_at order. */
export function consumePendingRestRequests(
  db: Database,
  target_agent_id: string,
): RestRequest[] {
  const rows = db
    .query(
      `DELETE FROM rest_requests
       WHERE target_agent_id = ?
       RETURNING id, target_agent_id, from_agent_id, reason, kind, created_at`,
    )
    .all(target_agent_id) as RestRequestRow[];
  if (rows.length === 0) return [];
  rows.sort((a, b) => a.created_at - b.created_at);
  return rows.map((r) => ({
    id: r.id,
    target_agent_id: r.target_agent_id,
    from_agent_id: r.from_agent_id,
    reason: r.reason,
    kind: r.kind as RestRequestKind,
    created_at: r.created_at,
  }));
}

/** Look up pending rows without consuming. Test seam + observability. */
export function pendingRestRequests(
  db: Database,
  target_agent_id: string,
): RestRequest[] {
  const rows = db
    .query(
      `SELECT id, target_agent_id, from_agent_id, reason, kind, created_at
       FROM rest_requests
       WHERE target_agent_id = ?
       ORDER BY created_at ASC`,
    )
    .all(target_agent_id) as RestRequestRow[];
  return rows.map((r) => ({
    id: r.id,
    target_agent_id: r.target_agent_id,
    from_agent_id: r.from_agent_id,
    reason: r.reason,
    kind: r.kind as RestRequestKind,
    created_at: r.created_at,
  }));
}

/** Drop rows older than ttl_ms. Returns the count deleted. Idempotent;
 * safe to call on every prune tick. Consumed rows don't exist (consume
 * deletes), so this only ever sweeps stale unconsumed rows. */
export function pruneStaleRestRequests(
  db: Database,
  ttl_ms: number = DEFAULT_REST_REQUEST_TTL_MS,
  now: number = Date.now(),
): number {
  const result = db.run(
    `DELETE FROM rest_requests WHERE created_at < ?`,
    [now - ttl_ms],
  );
  return Number(result.changes ?? 0);
}
