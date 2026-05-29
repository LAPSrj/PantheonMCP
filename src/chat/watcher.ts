import type { Database } from "bun:sqlite";
import {
  guestMarker,
  formatLocalTime,
  modeMarker,
  SILENT_KINDS,
  wrapSilentEvent,
  type PriorityTag,
} from "./format.ts";
import { listActive, type PresenceRow } from "./presence.ts";
import type { MessageRow } from "./persistence.ts";
import type { Mode, SystemKind } from "./types.ts";

/** §11c watcher loop. Tails the SQLite chat-history table by `seq`,
 * filters per the receiver's mode + scope, formats with priority
 * tags or `<silent-event>` wrappers, and emits one line per event
 * (with coalescing for silent ambient flurries).
 *
 * Pure SQLite read path — no router-state mutation. Multiple watcher
 * processes can run concurrently against the same chat.db; each
 * tracks its own cursor and emits independently. */

export interface ReceiverState {
  agent_id: string;
  username: string;
  project: string;
  mode: Mode;
}

export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_WAIT_MS = 500;
export const DEFAULT_COALESCE_WINDOW_MS = 1000;
export const DEFAULT_RECEIVER_REFRESH_MS = 5000;

export interface TailOptions {
  db: Database;
  receiver: ReceiverState;
  /** SQL `seq > ?` lower bound. */
  since_seq: number;
  limit?: number;
}

export interface WatcherEvent {
  /** Formatted output line. */
  line: string;
  /** Source message ids coalesced into this line. */
  message_ids: string[];
  /** The largest seq among coalesced sources — used to advance the
   * caller's cursor. */
  last_seq: number;
}

/** Read raw rows past `since_seq` and apply the receiver's filter,
 * but DO NOT format or coalesce. Used by tests and by `tailLoop`. */
export function selectReceivableRows(options: TailOptions): MessageRow[] {
  const limit = options.limit ?? DEFAULT_BATCH_SIZE;
  const rows = options.db
    .query("SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?")
    .all(options.since_seq, limit) as MessageRow[];
  if (rows.length === 0) return [];

  const mentioned = mentionsForRows(options.db, options.receiver.username, rows);

  return rows.filter((row) => {
    if (row.from_agent_id === options.receiver.agent_id) return false;
    if (!isVisibleRow(row, options.receiver)) return false;
    return isDeliverableRow(row, options.receiver, mentioned);
  });
}

export function isVisibleRow(row: MessageRow, receiver: ReceiverState): boolean {
  switch (row.scope) {
    case "global":
      return true;
    case "project":
      return row.project === receiver.project;
    case "dm":
      return row.target_username === receiver.username;
  }
}

export function isDeliverableRow(
  row: MessageRow,
  receiver: ReceiverState,
  mentioned: Set<string>,
): boolean {
  // Always-deliverable channel: keepalives + admin console broadcasts.
  // Admin is the only special-cased actor in pantheon (no general role
  // attribute); the canonical pair is from_agent_id="system" +
  // from_username_inline="admin", both of which persist in SQLite.
  if (row.kind === "keepalive") return true;
  if (row.from_agent_id === "system" && row.from_username_inline === "admin") {
    return true;
  }
  // Personal: DM to me OR @mention of me.
  const personal = row.scope === "dm" || mentioned.has(row.id);
  if (personal) return true;
  switch (receiver.mode) {
    case "all":
      return true;
    case "quiet":
      return row.kind === null || !isSilentKind(row.kind);
    case "project":
      return row.scope === "project";
    case "dm":
      return false;
  }
}

/** Compose all output for the rows in one shot, including silent-event
 * coalescing. Used by `tailOnce`. */
export function formatBatch(
  rows: MessageRow[],
  receiver: ReceiverState,
): WatcherEvent[] {
  const out: WatcherEvent[] = [];
  let pendingSilent: MessageRow[] = [];

  const flushSilent = () => {
    if (pendingSilent.length === 0) return;
    out.push(coalesceSilent(pendingSilent));
    pendingSilent = [];
  };

  for (const row of rows) {
    if (isSilentRow(row)) {
      pendingSilent.push(row);
    } else {
      flushSilent();
      out.push(formatDirected(row, receiver));
    }
  }
  flushSilent();
  return out;
}

/** One-shot tail: read receivable rows since `since_seq`, format,
 * return. Doesn't sleep. */
export function tailOnce(options: TailOptions): WatcherEvent[] {
  const rows = selectReceivableRows(options);
  return formatBatch(rows, options.receiver);
}

export interface LoopOptions {
  db: Database;
  agent_id: string;
  /** Override for the receiver's stored mode. */
  mode_override?: Mode;
  /** Where to start. Defaults to MAX(seq) so the watcher only sees
   * messages from now-onward (no history replay). */
  since_seq?: number;
  /** Poll interval when no new rows. */
  wait_ms?: number;
  /** Coalesce silent events flushed within this window into one
   * <silent-event> line. */
  coalesce_window_ms?: number;
  /** Refresh the receiver's mode/project from the presence table at
   * this cadence so a `set_mode` from elsewhere takes effect. */
  receiver_refresh_ms?: number;
  /** Cancel the loop when this signal aborts. */
  signal?: AbortSignal;
  /** Cap the loop at N iterations — only used in tests. */
  max_iterations?: number;
}

/** Raised by `tailLoop` when the receiver's presence row has been
 * deleted (logout / heartbeat lapsed past the prune grace). The CLI
 * catches this and exits with a stderr message so the caller can
 * re-login + re-spawn the watcher. */
export class SessionExpiredError extends Error {
  constructor(agent_id: string) {
    super(
      `Session expired — agent_id '${agent_id}' is no longer present in the chat router. ` +
        `Re-login and re-spawn the watcher.`,
    );
    this.name = "SessionExpiredError";
  }
}

/** Long-poll generator. Streams `WatcherEvent`s indefinitely until
 * the signal aborts. Per-iteration: read a batch of rows past the
 * cursor; if empty, sleep `wait_ms`. Silent events are buffered up
 * to `coalesce_window_ms` to absorb flurries; non-silent events
 * flush the buffer first. Throws `SessionExpiredError` if the
 * receiver's presence row disappears mid-loop. */
export async function* tailLoop(options: LoopOptions): AsyncGenerator<WatcherEvent> {
  const waitMs = options.wait_ms ?? DEFAULT_WAIT_MS;
  const coalesceMs = options.coalesce_window_ms ?? DEFAULT_COALESCE_WINDOW_MS;
  const refreshMs = options.receiver_refresh_ms ?? DEFAULT_RECEIVER_REFRESH_MS;

  let receiver = await loadReceiver(options.db, options.agent_id, options.mode_override);
  if (!receiver) throw new SessionExpiredError(options.agent_id);
  let receiverLoadedAt = Date.now();

  let lastSeq = options.since_seq ?? readMaxSeq(options.db);
  let pendingSilent: MessageRow[] = [];
  let pendingSilentSince = Number.POSITIVE_INFINITY;

  let iterations = 0;
  while (!options.signal?.aborted) {
    if (options.max_iterations !== undefined && iterations >= options.max_iterations) break;
    iterations++;

    if (Date.now() - receiverLoadedAt > refreshMs) {
      const refreshed = await loadReceiver(options.db, options.agent_id, options.mode_override);
      if (!refreshed) {
        // Presence row evaporated. Flush any pending silent buffer
        // first so the caller still sees them, then signal expiry.
        if (pendingSilent.length > 0) yield coalesceSilent(pendingSilent);
        throw new SessionExpiredError(options.agent_id);
      }
      receiver = refreshed;
      receiverLoadedAt = Date.now();
    }

    const rows = selectReceivableRows({
      db: options.db,
      receiver,
      since_seq: lastSeq,
    });

    for (const row of rows) {
      lastSeq = row.seq;
      if (isSilentRow(row)) {
        if (pendingSilent.length === 0) pendingSilentSince = Date.now();
        pendingSilent.push(row);
      } else {
        if (pendingSilent.length > 0) {
          yield coalesceSilent(pendingSilent);
          pendingSilent = [];
          pendingSilentSince = Number.POSITIVE_INFINITY;
        }
        yield formatDirected(row, receiver);
      }
    }

    if (
      pendingSilent.length > 0 &&
      Date.now() - pendingSilentSince >= coalesceMs
    ) {
      yield coalesceSilent(pendingSilent);
      pendingSilent = [];
      pendingSilentSince = Number.POSITIVE_INFINITY;
    }

    if (rows.length === 0) {
      await sleep(waitMs, options.signal);
    }
  }

  // Flush any pending silent events on shutdown.
  if (pendingSilent.length > 0) {
    yield coalesceSilent(pendingSilent);
  }
}

// ---------- helpers ---------- //

export function readMaxSeq(db: Database): number {
  const row = db.query("SELECT MAX(seq) AS s FROM messages").get() as { s: number | null };
  return row.s ?? 0;
}

async function loadReceiver(
  db: Database,
  agent_id: string,
  override?: Mode,
): Promise<ReceiverState | null> {
  const rows = listActive(db);
  const me = rows.find((r: PresenceRow) => r.agent_id === agent_id);
  if (!me) return null;
  return {
    agent_id,
    username: me.username,
    project: me.project,
    mode: override ?? me.mode,
  };
}

function mentionsForRows(
  db: Database,
  username: string,
  rows: MessageRow[],
): Set<string> {
  if (rows.length === 0) return new Set();
  const placeholders = rows.map(() => "?").join(",");
  const params = [username, ...rows.map((r) => r.id)] as never[];
  const out = db
    .query(
      `SELECT message_id FROM mentions
       WHERE mentioned_username = ? AND message_id IN (${placeholders})`,
    )
    .all(...params) as { message_id: string }[];
  return new Set(out.map((r) => r.message_id));
}

function isSilentRow(row: MessageRow): boolean {
  if (!row.kind) return false;
  return isSilentKind(row.kind);
}

function isSilentKind(kind: string): boolean {
  return SILENT_KINDS.has(kind as SystemKind);
}

function priorityTagForRow(
  row: MessageRow,
  receiver: ReceiverState,
  mentioned: boolean,
): PriorityTag {
  // §11c table: required for asks targeting me; likely for DMs to me
  // or admin broadcasts; maybe for project mentions; no for ambient.
  // Exception: status_digest is ambient by design even though it
  // arrives as a DM (per-recipient delivery), so force [no reply].
  if (row.kind === "status_digest") return "[no reply]";
  if (row.correlation_id && row.target_username === receiver.username) {
    return "[required reply]";
  }
  if (row.scope === "dm" && row.target_username === receiver.username) {
    return "[likely reply]";
  }
  // Admin console broadcasts (the only special-cased actor in pantheon
  // — there is no general role attribute). Detected via the persisted
  // pair (from_agent_id="system", from_username_inline="admin").
  if (row.from_agent_id === "system" && row.from_username_inline === "admin") {
    return "[likely reply]";
  }
  if (mentioned) return "[maybe reply]";
  return "[no reply]";
}

/** Watcher emit threshold: messages whose body exceeds this byte
 * count get source-truncated to a stub that names the sender +
 * carries the message_id, so observers can call `get_message` to
 * pull the full text. CC's Monitor harness has its own per-event
 * cap that truncates messages mid-text without warning; pantheon's
 * source-truncation lands ahead of that cap so the agent gets a
 * structured signal ("call get_message") instead of a silent cut.
 *
 * Default 1500 chars — conservative; may need bumping if CC's cap
 * turns out to be larger. Configurable via env
 * `PANTHEON_WATCHER_TRUNCATE_AT`. */
const DEFAULT_WATCHER_TRUNCATE_AT = 1500;

function watcherTruncateThreshold(): number {
  const raw = process.env.PANTHEON_WATCHER_TRUNCATE_AT;
  if (raw === undefined) return DEFAULT_WATCHER_TRUNCATE_AT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WATCHER_TRUNCATE_AT;
  return n;
}

/** Body-for-emit: returns the full text when within threshold, else
 * a stub naming the sender + message_id. Used by `formatDirected`
 * for both DM/project/global rows and `status_digest` rows. */
function watcherBody(row: MessageRow): string {
  const limit = watcherTruncateThreshold();
  if (row.text.length <= limit) return row.text;
  const sender = senderHandle(row);
  return (
    `[oversized message from ${sender} — original ${row.text.length} chars; ` +
    `call mcp__pantheon__get_message({ message_id: "${row.id}" }) to read the full text.]`
  );
}

function formatDirected(row: MessageRow, receiver: ReceiverState): WatcherEvent {
  // Mention computed off the joined set inside selectReceivableRows
  // is dropped here to keep formatBatch pure; recompute cheaply for
  // the priority tag (single-row case is common). Compute against
  // the ORIGINAL text — `@user` should still flag a mention even
  // when the body is about to be source-truncated for emit.
  const mentioned = row.text.toLowerCase().includes(`@${receiver.username.toLowerCase()}`);
  const tag = priorityTagForRow(row, receiver, mentioned);
  const dateStr = formatLocalTime(row.ts); // local HH:MM:SS + tz label
  const body = watcherBody(row);
  // status_digest gets a `· status_digest` label and the body on the
  // next line, mirroring chat-mcp's keepalive-style header. No
  // sender/target suffix — it's a system event.
  if (row.kind === "status_digest") {
    return {
      line: `${tag} ${dateStr} · status_digest\n${body}`,
      message_ids: [row.id],
      last_seq: row.seq,
    };
  }
  const sender = senderHandle(row);
  const targetSuffix =
    row.scope === "dm" ? ` →${row.target_username ?? "?"}` : "";
  const replySuffix = row.reply_to ? ` ↩${row.reply_to.slice(0, 8)}` : "";
  const correlationSuffix = row.correlation_id ? ` [ask=${row.correlation_id.slice(0, 8)}]` : "";
  // Structured-message tag: when send_structured was used, surface the
  // caller-typed kind in the line so receivers see what kind of message
  // arrived without having to call get_message. The full payload is on
  // the row at row.payload (JSON string); receivers fetch via get_message.
  const kindSuffix = row.user_kind ? ` [kind:${row.user_kind}]` : "";
  const line = `${tag} ${dateStr} ${sender}${targetSuffix}${replySuffix}${correlationSuffix}${kindSuffix}: ${body}`;
  return { line, message_ids: [row.id], last_seq: row.seq };
}

function senderHandle(row: MessageRow): string {
  // Admin console messages render as a bare "admin" (no asterisk) —
  // the asterisk is the guest marker (§10), and the console is not a
  // guest. This pair is the canonical admin discriminator.
  if (row.from_agent_id === "system" && row.from_username_inline === "admin") {
    return "admin";
  }
  if (row.from_username_inline) return `${row.from_username_inline}*`;
  if (row.from_agent_id === "system") return "system";
  return `agent:${row.from_agent_id.slice(0, 8)}`;
}

function coalesceSilent(rows: MessageRow[]): WatcherEvent {
  const summary = summariseSilent(rows);
  const ts = formatLocalTime(rows[rows.length - 1]!.ts);
  const line = wrapSilentEvent(summary, { time: ts, count: rows.length });
  const lastSeq = rows.reduce((acc, r) => Math.max(acc, r.seq), 0);
  return { line, message_ids: rows.map((r) => r.id), last_seq: lastSeq };
}

function summariseSilent(rows: MessageRow[]): string {
  // Group by kind for a compact one-line digest.
  const byKind = new Map<string, number>();
  for (const r of rows) {
    const k = r.kind ?? "system";
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [kind, n] of byKind) {
    parts.push(`${n}× ${kind}`);
  }
  // Append the most-recent body so the agent has SOME context if the
  // count is small. Keep it under 200 chars.
  const newest = rows[rows.length - 1]!;
  const tail = newest.text.length > 0
    ? ` | latest: ${newest.text.length > 200 ? newest.text.slice(0, 197) + "…" : newest.text}`
    : "";
  return parts.join(", ") + tail;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// Re-export tag/marker formatters that the CLI banner uses.
export { modeMarker, guestMarker };
