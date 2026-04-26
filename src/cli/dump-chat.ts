import { queryMessages, type MessageRow } from "../chat/index.ts";
import { openChatDb, resolvePaths } from "../storage/index.ts";

export interface DumpChatOptions {
  /** ts >= this filter (ms epoch). Omitted = all history. */
  since?: number;
  /** Filter to messages from/to/mentioning this persona. */
  persona?: string;
  /** Hard cap on rows pulled. Default 1_000_000. */
  limit?: number;
  env?: NodeJS.ProcessEnv;
}

/** JSONL-shaped row, schema-stable across releases. Mirrors the
 * `messages` table column-for-column so re-imports via load-chat
 * round-trip cleanly. */
export interface JsonlRow {
  id: string;
  ts: number;
  scope: string;
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

/** Stream rows matching the filter. Returns the rows directly so
 * callers can pipe to a file or stdout. The CLI wrapper handles
 * formatting + I/O. */
export function dumpChat(options: DumpChatOptions = {}): JsonlRow[] {
  const paths = resolvePaths(options.env ?? process.env);
  const db = openChatDb(paths.chatDbPath);
  try {
    // queryMessages sorts ts DESC; for export we want ts ASC so the
    // resulting JSONL is replay-friendly.
    const rows = queryMessages(db, {
      ...(options.since !== undefined ? { since_ts: options.since - 1 } : {}),
      limit: options.limit ?? 1_000_000,
    });
    let filtered: MessageRow[] = rows;
    if (options.persona) {
      filtered = personaFilter(db, rows, options.persona);
    }
    // Reverse to get ts ASC for replay.
    filtered.reverse();
    return filtered.map(toJsonlRow);
  } finally {
    db.close();
  }
}

function personaFilter(
  db: import("bun:sqlite").Database,
  rows: MessageRow[],
  persona: string,
): MessageRow[] {
  // Resolve the persona's agent_ids (a single persona can have
  // multiple historical agent_ids across reconnects; take any
  // subscriber row matching the username).
  const agents = db
    .query("SELECT agent_id FROM subscribers WHERE username = ?")
    .all(persona) as { agent_id: string }[];
  const agentSet = new Set(agents.map((a) => a.agent_id));
  // Mention-targeting goes through the mentions table — pull mention
  // ids in one query.
  const mentionIds = new Set<string>(
    (db
      .query("SELECT message_id FROM mentions WHERE mentioned_username = ?")
      .all(persona) as { message_id: string }[]).map((r) => r.message_id),
  );
  return rows.filter(
    (r) =>
      agentSet.has(r.from_agent_id) ||
      r.target_username === persona ||
      r.from_username_inline === persona ||
      mentionIds.has(r.id),
  );
}

function toJsonlRow(r: MessageRow): JsonlRow {
  return {
    id: r.id,
    ts: r.ts,
    scope: r.scope,
    project: r.project,
    target_username: r.target_username,
    from_agent_id: r.from_agent_id,
    from_transient: r.from_transient,
    from_username_inline: r.from_username_inline,
    text: r.text,
    kind: r.kind,
    reply_to: r.reply_to,
    correlation_id: r.correlation_id,
  };
}

export function rowsToJsonl(rows: JsonlRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
}
