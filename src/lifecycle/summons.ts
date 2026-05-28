import crypto from "node:crypto";
import type { Database } from "bun:sqlite";

/** Summon boot-verification (§14 watchdog companion). Each genuine
 * summon writes a row here keyed by a per-summon nonce (also injected
 * into the child as PANTHEON_SUMMON_ID). The child's first `login`
 * confirms the row by that nonce — instance-level attribution that
 * survives auto-suffixing, already-online siblings, and concurrent
 * remanifests (none of which carry the nonce). The summoner's 30s
 * daemon-tick verifies its own pending rows past the boot window:
 * re-spawns once (reusing the nonce), then marks `failed` + DMs the
 * summoner.
 *
 * Schema lives in sqlite.ts migration v8. Mirrors the rest_requests
 * triad: writer / sweep / TTL-prune. Unlike rest_requests, rows are
 * NOT deleted on use — a summon record outlives the agent's presence
 * (subscriber rows are deleted on logout) so retry state and the
 * summoner<->agent link have a longer life. Terminal + aged rows are
 * TTL-swept by `pruneStaleSummons`. */

export type SummonState = "pending" | "confirmed" | "failed";

export interface SummonRecord {
  id: string;
  summoner_agent_id: string | null;
  target_username: string;
  target_project: string;
  spawn_args_json: string | null;
  spawned_at: number;
  confirmed_at: number | null;
  confirmed_agent_id: string | null;
  retries: number;
  state: SummonState;
  created_at: number;
}

interface SummonRow {
  id: string;
  summoner_agent_id: string | null;
  target_username: string;
  target_project: string;
  spawn_args_json: string | null;
  spawned_at: number;
  confirmed_at: number | null;
  confirmed_agent_id: string | null;
  retries: number;
  state: string;
  created_at: number;
}

/** Boot window: how long a summon may go unconfirmed before the
 * verify sweep treats it as a no-show. Generous — covers slow MCP
 * connect / machine load; an agent legitimately mid-bootstrap can
 * take 30-60s. */
export const DEFAULT_BOOT_WINDOW_MS = 120 * 1000; // 120s

/** Max automatic re-spawns before giving up and notifying. 1 keeps
 * the duplicate-agent risk bounded (a re-spawn of a slow-but-alive
 * agent produces one auto-suffixed sibling, not a pile). */
export const DEFAULT_MAX_SUMMON_RETRIES = 1;

/** Retention TTL for summon rows. Comfortably exceeds the verification
 * lifecycle (2 * boot window + buffer) so a row is never pruned while
 * still being verified; beyond it, terminal rows are dead audit weight
 * and stuck `pending` rows (summoner died before the window) are
 * abandoned. A single age rule covers both. */
export const DEFAULT_SUMMON_TTL_MS = 10 * 60 * 1000; // 10 min

function rowToRecord(r: SummonRow): SummonRecord {
  return {
    id: r.id,
    summoner_agent_id: r.summoner_agent_id,
    target_username: r.target_username,
    target_project: r.target_project,
    spawn_args_json: r.spawn_args_json,
    spawned_at: r.spawned_at,
    confirmed_at: r.confirmed_at,
    confirmed_agent_id: r.confirmed_agent_id,
    retries: r.retries,
    state: r.state as SummonState,
    created_at: r.created_at,
  };
}

/** Record a pending summon. `id` is the caller-supplied nonce (so the
 * same value can be injected into the child env in one place). */
export function writeSummon(
  db: Database,
  args: {
    id?: string;
    summoner_agent_id: string | null;
    target_username: string;
    target_project: string;
    spawn_args_json?: string | null;
    now?: number;
  },
): string {
  const id = args.id ?? crypto.randomUUID();
  const now = args.now ?? Date.now();
  db.run(
    `INSERT INTO summons (
       id, summoner_agent_id, target_username, target_project,
       spawn_args_json, spawned_at, confirmed_at, confirmed_agent_id,
       retries, state, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, 'pending', ?)`,
    [
      id,
      args.summoner_agent_id,
      args.target_username,
      args.target_project,
      args.spawn_args_json ?? null,
      now,
      now,
    ],
  );
  return id;
}

/** Confirm a summon by nonce — called from the child's `login`. Sets
 * confirmed_at + confirmed_agent_id and flips state to `confirmed`.
 * Idempotent and monotonic: a row already `confirmed` is left as-is
 * (the WHERE guard), so a presence-lapse re-login by the same child
 * doesn't churn it. Returns the number of rows updated (1 on the
 * first confirm, 0 if the id is unknown or already confirmed). */
export function confirmSummon(
  db: Database,
  id: string,
  confirmed_agent_id: string,
  now: number = Date.now(),
): number {
  return db.run(
    `UPDATE summons
       SET confirmed_at = ?, confirmed_agent_id = ?, state = 'confirmed'
     WHERE id = ? AND state != 'confirmed'`,
    [now, confirmed_agent_id, id],
  ).changes;
}

/** Pending rows owned by a given summoner, oldest spawn first. The
 * verify sweep scopes to its own agent_id so two live summoners never
 * both retry the same row (v1 — when the dedicated daemon lands it
 * sweeps every row instead, no schema change). */
export function pendingSummonsForSummoner(
  db: Database,
  summoner_agent_id: string,
): SummonRecord[] {
  const rows = db
    .query(
      `SELECT id, summoner_agent_id, target_username, target_project,
              spawn_args_json, spawned_at, confirmed_at, confirmed_agent_id,
              retries, state, created_at
         FROM summons
        WHERE summoner_agent_id = ? AND state = 'pending'
        ORDER BY spawned_at ASC`,
    )
    .all(summoner_agent_id) as SummonRow[];
  return rows.map(rowToRecord);
}

/** Mark a re-spawn: bump retries and reset the boot window. The nonce
 * (id) is reused, so the re-spawned child confirms the same row. */
export function bumpSummonRetry(
  db: Database,
  id: string,
  now: number = Date.now(),
): void {
  db.run(
    `UPDATE summons SET retries = retries + 1, spawned_at = ? WHERE id = ?`,
    [now, id],
  );
}

/** Give up on a summon — terminal `failed`. Kept (not deleted) as an
 * audit row until TTL prune. */
export function markSummonFailed(db: Database, id: string): void {
  db.run(`UPDATE summons SET state = 'failed' WHERE id = ?`, [id]);
}

/** Lookup by id without mutating. Test seam + observability. */
export function getSummon(db: Database, id: string): SummonRecord | null {
  const row = db
    .query(
      `SELECT id, summoner_agent_id, target_username, target_project,
              spawn_args_json, spawned_at, confirmed_at, confirmed_agent_id,
              retries, state, created_at
         FROM summons WHERE id = ?`,
    )
    .get(id) as SummonRow | undefined;
  return row ? rowToRecord(row) : null;
}

/** Drop rows whose `spawned_at` is older than ttl_ms. One age rule
 * covers every terminal state AND stuck `pending` rows (summoner died
 * before the window elapsed). A row mid-verification keeps a fresh
 * spawned_at (writeSummon / bumpSummonRetry stamp it), so it is never
 * pruned while still being checked. Returns the count deleted. */
export function pruneStaleSummons(
  db: Database,
  ttl_ms: number = DEFAULT_SUMMON_TTL_MS,
  now: number = Date.now(),
): number {
  const result = db.run(`DELETE FROM summons WHERE spawned_at < ?`, [
    now - ttl_ms,
  ]);
  return Number(result.changes ?? 0);
}
