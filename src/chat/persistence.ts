import type { Database } from "bun:sqlite";
import type { Message, Scope } from "./types.ts";

/** Persist a single message + its mentions. Runs inside a transaction
 * so a crash mid-write leaves no partial mentions. */
export function persistMessage(db: Database, msg: Message): void {
  db.transaction(() => {
    db.run(
      `INSERT INTO messages (
         id, seq, ts, scope, project, target_username,
         from_agent_id, from_transient, from_username_inline,
         text, kind, reply_to, correlation_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        msg.seq,
        msg.ts,
        msg.scope,
        msg.project ?? null,
        msg.target ?? null,
        msg.from_agent_id,
        // Kind tracking is stored on every system message; for normal
        // user messages it's null. For the from_transient flag we
        // need to know if the sender was a guest at write time —
        // resolved by the router via subscriber state and passed in
        // via `from_username_inline` (set when guest, null when persona).
        msg.from_username_inline !== null && msg.from_username_inline !== undefined ? 1 : 0,
        msg.from_username_inline ?? null,
        msg.text,
        msg.system_kind ?? null,
        msg.reply_to ?? null,
        msg.ask_id ?? msg.in_reply_to_ask ?? null,
      ],
    );
    for (const mention of msg.mentions) {
      db.run(
        "INSERT OR IGNORE INTO mentions (message_id, mentioned_username) VALUES (?, ?)",
        [msg.id, mention],
      );
    }
  })();
}

/** Pull recent messages matching scope/project/target/since. Used by
 * `check_messages` and the watcher's catch-up read. Sorted ts DESC
 * (newest first) per §12-H. */
export interface QueryFilter {
  scope?: Scope;
  project?: string;
  target_username?: string;
  from_agent_id?: string;
  since_ts?: number;
  limit?: number;
}

export function queryMessages(db: Database, filter: QueryFilter = {}): MessageRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.scope) {
    where.push("scope = ?");
    params.push(filter.scope);
  }
  if (filter.project) {
    where.push("project = ?");
    params.push(filter.project);
  }
  if (filter.target_username) {
    where.push("target_username = ?");
    params.push(filter.target_username);
  }
  if (filter.from_agent_id) {
    where.push("from_agent_id = ?");
    params.push(filter.from_agent_id);
  }
  if (filter.since_ts !== undefined) {
    where.push("ts > ?");
    params.push(filter.since_ts);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filter.limit ?? 100;
  const sql = `SELECT * FROM messages ${whereClause} ORDER BY ts DESC LIMIT ?`;
  const allParams = [...params, limit] as never[];
  return db.query(sql).all(...allParams) as MessageRow[];
}

/** Raw row shape — kind/from_transient as stored. Renderers convert
 * back to `Message` shape when needed. */
export interface MessageRow {
  id: string;
  seq: number;
  ts: number;
  scope: Scope;
  project: string | null;
  target_username: string | null;
  from_agent_id: string;
  from_transient: number;
  from_username_inline: string | null;
  text: string;
  kind: string | null;
  reply_to: string | null;
  correlation_id: string | null;
}
