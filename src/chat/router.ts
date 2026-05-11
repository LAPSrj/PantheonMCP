import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Database } from "bun:sqlite";
import type { Paths } from "../storage/index.ts";
import {
  ChatError,
  type AskResult,
  type Message,
  type MessageInput,
  type Mode,
  type PendingAsk,
  type PublicAgent,
  type Subscriber,
} from "./types.ts";
import {
  isHandleAvailable,
  type AvailabilityResult,
} from "./collision.ts";
import { TombstoneMap } from "./tombstones.ts";
import { persistMessage } from "./persistence.ts";
import { appendAudit } from "./audit.ts";
import {
  DEFAULT_PRUNE_GRACE_MS,
  DEFAULT_STALE_THRESHOLD_MS,
  advanceChatCursor,
  heartbeat as presenceHeartbeat,
  listActive,
  readChatCursor,
  removeSubscriber as presenceRemove,
  upsertSubscriber,
} from "./presence.ts";
import { selectReceivableRows } from "./watcher.ts";
import { isAdminConsoleMessage } from "./format.ts";
import type { MessageRow } from "./persistence.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Format the body of a `status_digest` DM. Header line + one line
 * per changed agent grouped by project. Format chosen for compact
 * read-at-a-glance — peers shouldn't have to scroll a digest. */
export function renderStatusDigest(changed: ReadonlyArray<Subscriber>): string {
  const byProject = new Map<string, Subscriber[]>();
  for (const s of changed) {
    const list = byProject.get(s.project) ?? [];
    list.push(s);
    byProject.set(s.project, list);
  }
  const projects = Array.from(byProject.keys()).sort();
  const lines: string[] = [
    `status_digest — ${changed.length} agent${changed.length === 1 ? "" : "s"} changed status since last digest`,
  ];
  for (const project of projects) {
    lines.push(`[${project}]`);
    const subs = byProject.get(project)!.slice().sort((a, b) =>
      a.username.localeCompare(b.username),
    );
    for (const s of subs) {
      const tag = modeTagForDigest(s.mode);
      const status = s.status || "(empty)";
      lines.push(`  ${s.username}${tag} — ${status}`);
    }
  }
  return lines.join("\n");
}

function modeTagForDigest(mode: Mode): string {
  switch (mode) {
    case "all":
      return "";
    case "quiet":
      return "[Q]";
    case "project":
      return "[P]";
    case "dm":
      return "[D]";
  }
}

const MENTION_RE = /@([a-zA-Z0-9_.\-]+)/g;

export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) out.add(m[1]!);
  return Array.from(out);
}

export interface RouterOptions {
  paths: Paths;
  /** Optional SQLite handle for chat-history persistence. When omitted,
   * messages are not persisted (used for ephemeral router tests). */
  db?: Database | null;
  tombstones?: TombstoneMap;
  clock?: () => number;
  max_in_memory_messages?: number;
}

const DEFAULT_MAX_IN_MEMORY = 2000;

/** §11c chat router. Owns the in-memory subscriber map, the message
 * dispatch path (with scope visibility + mode delivery filter +
 * mention parsing + ask/answer correlation), and the optional SQLite
 * persistence handle.
 *
 * The router does NOT own its own watcher loop — `subscribe(agent_id, listener)`
 * gives listeners that fire on every visible+deliverable message; the
 * MCP layer wires this to the per-agent stdio watcher. */
export class ChatRouter {
  readonly paths: Paths;
  readonly tombstones: TombstoneMap;
  private readonly db: Database | null;
  private readonly clock: () => number;
  private readonly maxInMemory: number;

  private readonly subscribers = new Map<string, Subscriber>();
  private readonly usernameIndex = new Map<string, string>(); // lower(name) → agent_id
  private readonly recent: Message[] = [];
  private readonly cursors = new Map<string, number>();
  private readonly emitter = new EventEmitter();
  private readonly pendingAsks = new Map<string, PendingAsk>();
  private seqCounter = 0;
  /** Agents whose status changed since the last `sweepStatusDigest`.
   * Per Yapsmith's chat-mcp revamp, we no longer broadcast a
   * `system_kind: "status_update"` message on every change — they
   * accumulate here and the daemon-tick batches them into a periodic
   * `status_digest` DM. */
  private readonly statusChangedAgents = new Set<string>();

  constructor(options: RouterOptions) {
    this.paths = options.paths;
    this.db = options.db ?? null;
    this.tombstones = options.tombstones ?? new TombstoneMap();
    this.clock = options.clock ?? Date.now;
    this.maxInMemory = options.max_in_memory_messages ?? DEFAULT_MAX_IN_MEMORY;
    this.emitter.setMaxListeners(1000);
  }

  /** Expose the underlying SQLite handle (read-only access). Used by
   * the lifecycle layer to read presence + write rest_requests rows
   * on the same connection without re-opening the file. `null` for
   * routers constructed without a db (in-process tests). */
  chatDb(): Database | null {
    return this.db;
  }

  /** Resolve the project an agent is logged into. Used by the
   * schema-registry handlers to scope `register_schema` / `get_schema`
   * etc. to the caller's project without each handler reaching into
   * the subscriber map directly. Returns null when the agent is not
   * connected to this router. */
  getSubscriberProject(agent_id: string): string | null {
    return this.subscribers.get(agent_id)?.project ?? null;
  }

  // -------------------------------------------------------------------- //
  // Subscriber lifecycle
  // -------------------------------------------------------------------- //

  /** Validate availability + insert a subscriber. Per §10, `transient`
   * decides whether the handle is registered as a persona or stays
   * chat-only. Throws `ChatError` on collision. */
  add(
    options: {
      username: string;
      project: string;
      transient: boolean;
      status?: string;
      mode?: Mode;
      /** When the caller has already claimed `username` as a persona
       * in their session, pass it here so the collision check
       * doesn't reject `registered_persona` against the owner's
       * own handle. */
      claimed_persona?: string;
      /** True when the MCP client declared `claude/channel`
       * experimental capability — surfaces in `Subscriber.supports_channels`
       * so the dispatch path can branch between channel push and the
       * Monitor watcher fallback. Defaults false. */
      supports_channels?: boolean;
    },
  ): Subscriber {
    const availability = this.checkAvailability(
      options.username,
      undefined,
      options.claimed_persona,
    );
    if (!availability.available) {
      this.throwForAvailability(options.username, availability);
    }
    const now = this.clock();
    const subscriber: Subscriber = {
      agent_id: randomUUID(),
      username: options.username,
      transient: options.transient,
      project: options.project || "misc",
      status: options.status ?? "",
      mode: options.mode ?? "all",
      connected_at: now,
      last_seen: now,
      last_event_at: now,
      status_updated_at: now,
      promoted_at: null,
      supports_channels: options.supports_channels ?? false,
    };
    this.subscribers.set(subscriber.agent_id, subscriber);
    this.usernameIndex.set(options.username.toLowerCase(), subscriber.agent_id);
    this.cursors.set(subscriber.agent_id, this.seqCounter);
    this.presenceUpsert(subscriber);
    return subscriber;
  }

  /** Remove a subscriber. Records a tombstone for guests so the
   * 30s reclaim window applies. Cancels any pending asks involving
   * the leaver. Returns the removed subscriber (or null). */
  remove(agent_id: string): Subscriber | null {
    const sub = this.subscribers.get(agent_id);
    if (!sub) return null;
    this.subscribers.delete(agent_id);
    this.usernameIndex.delete(sub.username.toLowerCase());
    this.cursors.delete(agent_id);
    this.emitter.removeAllListeners(`message:${agent_id}`);
    this.presenceRemove(agent_id);
    if (sub.transient) {
      this.tombstones.add(sub.username, agent_id);
    }
    // Cancel asks that reference this agent. Targets get a
    // `respondent_disconnected` resolve; askers' pending asks are
    // dropped (the asker won't be around to read the result).
    for (const [ask_id, ask] of this.pendingAsks) {
      if (ask.target_username === sub.username) {
        clearTimeout(ask.timeout_handle);
        this.pendingAsks.delete(ask_id);
        ask.resolver(null);
      } else if (ask.from_username === sub.username) {
        clearTimeout(ask.timeout_handle);
        this.pendingAsks.delete(ask_id);
      }
    }
    return sub;
  }

  /** Mutate fields on an existing subscriber. Returns the updated
   * subscriber. Username changes go through `checkAvailability`. */
  update(
    agent_id: string,
    patch: { username?: string; project?: string; status?: string },
  ): Subscriber {
    const sub = this.subscribers.get(agent_id);
    if (!sub) {
      throw new ChatError("not_logged_in", `Agent '${agent_id}' is not logged in.`);
    }
    if (patch.username !== undefined && patch.username !== sub.username) {
      const availability = this.checkAvailability(patch.username, sub.username);
      if (!availability.available) {
        this.throwForAvailability(patch.username, availability);
      }
      this.usernameIndex.delete(sub.username.toLowerCase());
      sub.username = patch.username;
      this.usernameIndex.set(patch.username.toLowerCase(), agent_id);
    }
    if (patch.project !== undefined) sub.project = patch.project || "misc";
    if (patch.status !== undefined && patch.status !== sub.status) {
      sub.status = patch.status;
      sub.status_updated_at = this.clock();
    }
    sub.last_seen = this.clock();
    this.presenceUpsert(sub);
    return sub;
  }

  setMode(agent_id: string, mode: Mode): void {
    const sub = this.subscribers.get(agent_id);
    if (!sub) throw new ChatError("not_logged_in", `Agent '${agent_id}' is not logged in.`);
    sub.mode = mode;
    this.presenceUpsert(sub);
  }

  /** Mark an agent's status as changed since the last digest sweep.
   * The `update_status` MCP handler calls this instead of immediately
   * emitting a `system_kind: "status_update"` message — per the
   * over-broadcast fix, status changes are batched into a periodic
   * `status_digest` DM. Idempotent (the underlying Set dedupes). */
  markStatusChanged(agent_id: string): void {
    if (this.subscribers.has(agent_id)) this.statusChangedAgents.add(agent_id);
  }

  /** Snapshot the changed-agents set, build a per-recipient
   * `status_digest` DM, and clear the set. Called by the daemon-tick
   * (gated by time-since-last per
   * `PANTHEON_STATUS_DIGEST_MINUTES`). Returns the number of digest
   * messages dispatched (one per non-dm/non-quiet recipient when
   * there's at least one change to report; 0 otherwise).
   *
   * dm-mode and quiet-mode peers do NOT receive the digest — quiet
   * drops system events, and dm-mode shouldn't be flooded with
   * ambient batches. They can still pull current status via
   * `list_agents`.
   *
   * The digest is sent as `scope: "dm"` per recipient with
   * `system_kind: "status_digest"`. The renderer (`watcher.ts`)
   * forces `[no reply]` and a `· status_digest` label. */
  /** Per-agent keepalive ping. The Anthropic prompt cache TTL on
   * the 1-hour cache variant expires after 60 minutes of inactivity;
   * agents whose chat is silent for that long pay a fresh-cache cost
   * on their next turn. This sweep DMs every online subscriber whose
   * last delivered event is older than `keepalive_ms`, regardless of
   * delivery mode (cache-warming applies to everyone, not just `all`-
   * mode peers). The keepalive is wrapped as `<silent-event>` by the
   * watcher so the model doesn't reply — but its runtime still makes
   * an API call to process the turn, which touches the cache.
   *
   * Self-consistent: the keepalive itself bumps the recipient's
   * `last_event_at` via the dispatch loop, so the next sweep won't
   * fire for that agent until `keepalive_ms` later. */
  sweepKeepalive(
    keepalive_ms: number,
    now: number = this.clock(),
  ): number {
    if (keepalive_ms <= 0) return 0;
    let dispatched = 0;
    for (const sub of this.subscribers.values()) {
      if (now - sub.last_event_at < keepalive_ms) continue;
      this.addMessage({
        from_agent_id: "system",
        scope: "dm",
        target: sub.username,
        text: "keepalive ping — cache-warming heartbeat, no action needed.",
        system: true,
        system_kind: "keepalive",
      });
      dispatched++;
    }
    return dispatched;
  }

  sweepStatusDigest(now: number = this.clock()): number {
    if (this.statusChangedAgents.size === 0) return 0;
    // Snapshot + clear so concurrent updates during render don't get
    // dropped — they'll appear in the NEXT digest.
    const changedIds = Array.from(this.statusChangedAgents);
    this.statusChangedAgents.clear();
    const changedSubs: Subscriber[] = [];
    for (const id of changedIds) {
      const s = this.subscribers.get(id);
      if (s) changedSubs.push(s);
    }
    if (changedSubs.length === 0) return 0;
    let dispatched = 0;
    for (const recipient of this.subscribers.values()) {
      // Quiet drops system messages outright. dm-mode peers shouldn't
      // be flooded with the batched ambient signal — they opted out
      // of project chatter for a reason.
      if (recipient.mode === "quiet" || recipient.mode === "dm") continue;
      // Per-recipient digest excludes the recipient themselves —
      // they already know their own change. If the only changer was
      // the recipient, skip emission entirely (no "alpha changed:
      // alpha" self-noise).
      const others = changedSubs.filter((s) => s.agent_id !== recipient.agent_id);
      if (others.length === 0) continue;
      this.addMessage({
        from_agent_id: "system",
        scope: "dm",
        target: recipient.username,
        text: renderStatusDigest(others),
        system: true,
        system_kind: "status_digest",
      });
      dispatched++;
    }
    void now;
    return dispatched;
  }

  /** Mark a subscriber as freshly promoted from guest to persona. The
   * handle stays the same; only the `transient` flag flips. Caller
   * (the MCP `login({ promote })` handler) is responsible for the
   * registry write FIRST per §10 atomicity. */
  flipToPromoted(agent_id: string): Subscriber {
    const sub = this.subscribers.get(agent_id);
    if (!sub) throw new ChatError("not_logged_in", `Agent '${agent_id}' is not logged in.`);
    if (!sub.transient) return sub; // idempotent
    sub.transient = false;
    sub.promoted_at = this.clock();
    this.presenceUpsert(sub);
    return sub;
  }

  /** Defensive sweep: drop in-memory subscribers whose SQLite presence
   * row has been pruned (heartbeat older than `prune_grace_ms`).
   *
   * The same-session re-login idempotence guard (chat handler) prevents
   * NEW orphans from being created. This sweep cleans up subscribers
   * that lost their heartbeat for any other reason — pre-fix /compact
   * leftovers, or any future leak path where `chat_agent_id` moves
   * away from a subscriber without `remove` being called.
   *
   * Without this, `router.subscribers` can grow unbounded across the
   * lifetime of a long-running MCP process, and `checkAvailability`
   * keeps treating dead-by-heartbeat sessions as live peers.
   *
   * No-op when no db is wired (test routers without persistence).
   * Returns the number of in-memory subscribers reaped. */
  sweepInMemoryOrphans(
    options: { prune_grace_ms?: number; now?: number } = {},
  ): number {
    if (!this.db) return 0;
    const now = options.now ?? this.clock();
    const grace = options.prune_grace_ms ?? DEFAULT_PRUNE_GRACE_MS;
    const cutoff = now - grace;
    let reaped = 0;
    // Snapshot agent_ids first so we can mutate during iteration.
    const ids = Array.from(this.subscribers.keys());
    for (const id of ids) {
      try {
        const row = this.db
          .query("SELECT 1 AS x FROM subscribers WHERE agent_id = ? AND last_heartbeat > ?")
          .get(id, cutoff) as { x: number } | undefined;
        if (!row) {
          // No fresh row → presence has been pruned (or never written).
          // Drop the in-memory entry. `remove` handles tombstone +
          // ask cleanup + best-effort presence-remove (idempotent
          // when the row is already gone).
          this.remove(id);
          reaped++;
        }
      } catch {
        // best-effort — never let a sweep error crash the daemon
      }
    }
    return reaped;
  }

  /** Bump this subscriber's `last_heartbeat` in the SQLite presence
   * table. Called every 5-10s by the MCP server's heartbeat scheduler.
   * No-op when no DB is wired (in-memory-only test routers). */
  heartbeat(agent_id: string): void {
    if (!this.db) return;
    if (!this.subscribers.has(agent_id)) return;
    try {
      presenceHeartbeat(this.db, agent_id, this.clock());
    } catch {
      // best-effort
    }
  }

  /** Handle was just reclaimed within the tombstone window — clear
   * the tombstone and broadcast `handle_recycled`. */
  consumeTombstoneAndBroadcast(username: string, new_agent_id: string): void {
    const tomb = this.tombstones.get(username);
    if (!tomb) return;
    this.tombstones.delete(username);
    const elapsed = this.clock() - tomb.vacated_at;
    const project = this.subscribers.get(new_agent_id)?.project;
    this.addMessage({
      from_agent_id: "system",
      scope: "project",
      text: `${username} reconnected ${Math.round(elapsed / 1000)}s after disconnect.`,
      ...(project !== undefined ? { project } : {}),
      system: true,
      system_kind: "handle_recycled",
    });
  }

  // -------------------------------------------------------------------- //
  // Message dispatch
  // -------------------------------------------------------------------- //

  addMessage(input: MessageInput): Message {
    const sender = this.subscribers.get(input.from_agent_id);
    const fromProject = sender?.project ?? input.project ?? "system";
    const fromUsernameInline = input.from_username_inline ??
      (sender && sender.transient ? sender.username : null);

    const msg: Message = {
      id: randomUUID(),
      seq: ++this.seqCounter,
      ts: this.clock(),
      from_agent_id: input.from_agent_id,
      from_project: fromProject,
      scope: input.scope,
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.project !== undefined
        ? { project: input.project }
        : sender
          ? { project: sender.project }
          : {}),
      text: input.text,
      mentions: parseMentions(input.text),
      ...(input.reply_to !== undefined ? { reply_to: input.reply_to } : {}),
      ...(input.ask_id !== undefined ? { ask_id: input.ask_id } : {}),
      ...(input.in_reply_to_ask !== undefined
        ? { in_reply_to_ask: input.in_reply_to_ask }
        : {}),
      ...(input.system !== undefined ? { system: input.system } : {}),
      ...(input.system_kind !== undefined ? { system_kind: input.system_kind } : {}),
      ...(input.user_kind !== undefined ? { user_kind: input.user_kind } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      from_username_inline: fromUsernameInline,
    };

    // SQLite-managed seq: when a db is wired, persistMessage chooses
    // the next seq atomically via SELECT MAX(seq)+1 inside its
    // transaction. Update msg.seq so dispatch + cursor + watcher all
    // agree on the same value. In-memory-only routers (test
    // harnesses) keep the pre-assigned per-process seq from
    // ++this.seqCounter above.
    if (this.db) {
      try {
        const persistedSeq = persistMessage(this.db, msg);
        msg.seq = persistedSeq;
        if (persistedSeq > this.seqCounter) this.seqCounter = persistedSeq;
      } catch {
        // best-effort — never fail a send because of persistence
      }
    }
    // §6 HIGH durable chat audit log — append-only JSONL backstop
    // for cross-agent dispute resolution. Gated by env; no-op when
    // disabled. Best-effort so an audit-write hiccup never blocks
    // a send.
    appendAudit(this.paths, msg);
    this.recent.push(msg);
    if (this.recent.length > this.maxInMemory) {
      this.recent.splice(0, this.recent.length - this.maxInMemory);
    }

    // Suppression — sender, explicit not_for, ask-reply asker (their
    // `ask` tool's return value already carries the answer).
    const suppressed = new Set<string>();
    if (input.not_for) suppressed.add(input.not_for);
    suppressed.add(input.from_agent_id);
    if (msg.in_reply_to_ask) {
      const pending = this.pendingAsks.get(msg.in_reply_to_ask);
      if (pending) suppressed.add(pending.from_agent_id);
    }
    for (const id of suppressed) this.advanceCursor(id, msg.seq);

    for (const sub of this.subscribers.values()) {
      if (suppressed.has(sub.agent_id)) continue;
      if (!this.isVisible(sub, msg)) continue;
      if (!this.isDeliverable(sub, msg)) continue;
      const tickNow = this.clock();
      sub.last_seen = tickNow;
      // Keepalive sweep gating: bump only when the message would
      // actually reach the recipient's watcher. setMode/heartbeat
      // bump last_seen but NOT last_event_at, so the keepalive
      // sweeper still pings idle agents who only do bookkeeping.
      sub.last_event_at = tickNow;
      this.emitter.emit(`message:${sub.agent_id}`, msg);
    }
    this.emitter.emit("message:*", msg);

    if (msg.in_reply_to_ask) {
      const ask = this.pendingAsks.get(msg.in_reply_to_ask);
      if (ask) {
        // Resolve only when the answerer is the original target.
        const senderName = sender?.username ?? input.from_username_inline ?? "";
        if (senderName === ask.target_username) {
          clearTimeout(ask.timeout_handle);
          this.pendingAsks.delete(msg.in_reply_to_ask);
          ask.resolver({ text: msg.text, from: senderName, status: "answered" });
        }
      }
    }
    return msg;
  }

  /** §11c cross-process catch-up. Reads from SQLite using the
   * subscriber's persisted `chat_cursor` (preserved across
   * heartbeats), applies the watcher's same visibility/deliverability
   * pipeline, and advances the cursor past every row examined (not
   * just the rows returned, so unfiltered rows aren't re-considered
   * next call).
   *
   * Falls back to the in-memory `takeMessages` path when no db is
   * wired (test routers). The cross-process consistency only
   * matters when the db is wired. */
  checkMessages(agent_id: string, limit = 50): { messages: Message[]; more: boolean } {
    if (!this.db) return this.takeMessages(agent_id, limit);
    const sub = this.subscribers.get(agent_id);
    if (!sub) return { messages: [], more: false };

    const cursor = readChatCursor(this.db, agent_id);
    // Pull `limit + 1` to detect more-pages without an extra round-trip.
    // The query already orders by seq ASC so the last row is the
    // latest examined.
    const rows = this.db
      .query("SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all(cursor, limit + 1) as MessageRow[];
    if (rows.length === 0) return { messages: [], more: false };

    // Apply the watcher's filter pipeline — same data path so the
    // streaming watcher and the polling check_messages stay in sync.
    const filtered = selectReceivableRows({
      db: this.db,
      receiver: {
        agent_id,
        username: sub.username,
        project: sub.project,
        mode: sub.mode,
      },
      since_seq: cursor,
      limit: limit + 1,
    });

    let returned = filtered;
    let more = false;
    if (returned.length > limit) {
      more = true;
      returned = returned.slice(0, limit);
    }

    // Advance cursor past every row examined — including filtered-out
    // ones — so they're not re-checked next call. The cap is the
    // largest seq in the raw query, NOT the largest seq returned.
    const lastExamined = rows[rows.length - 1]!.seq;
    advanceChatCursor(this.db, agent_id, lastExamined);
    if (returned.length > 0) sub.last_seen = this.clock();

    const messages = returned.map((r) => this.rowToMessage(r));
    return { messages, more };
  }

  /** Convert a SQLite row into a Message. Mentions are reconstructed
   * by re-parsing the text via the same regex that `addMessage` uses
   * — cheaper than a per-row mentions JOIN at this point in the call
   * (the watcher does the JOIN once per batch for delivery filter). */
  private rowToMessage(row: MessageRow): Message {
    return {
      id: row.id,
      seq: row.seq,
      ts: row.ts,
      from_agent_id: row.from_agent_id,
      from_project: row.project ?? "system",
      scope: row.scope,
      ...(row.target_username !== null ? { target: row.target_username } : {}),
      ...(row.project !== null ? { project: row.project } : {}),
      text: row.text,
      mentions: parseMentions(row.text),
      ...(row.reply_to !== null ? { reply_to: row.reply_to } : {}),
      ...(row.kind !== null ? { system_kind: row.kind as never, system: true } : {}),
      ...(row.correlation_id !== null
        ? row.kind !== null
          ? {}
          : { ask_id: row.correlation_id }
        : {}),
      from_username_inline: row.from_username_inline,
    };
  }

  takeMessages(agent_id: string, limit = 50): { messages: Message[]; more: boolean } {
    const sub = this.subscribers.get(agent_id);
    if (!sub) return { messages: [], more: false };
    const cursor = this.cursors.get(agent_id) ?? 0;
    const out: Message[] = [];
    let last = cursor;
    let more = false;
    for (const m of this.recent) {
      if (m.seq <= cursor) continue;
      if (!this.isVisible(sub, m)) continue;
      last = m.seq;
      if (!this.isDeliverable(sub, m)) continue;
      if (out.length >= limit) {
        more = true;
        break;
      }
      out.push(m);
    }
    if (last > cursor) this.cursors.set(agent_id, last);
    if (out.length > 0) sub.last_seen = this.clock();
    return { messages: out, more };
  }

  isVisible(sub: Subscriber, msg: Message): boolean {
    if (msg.from_agent_id === sub.agent_id) return false;
    switch (msg.scope) {
      case "global":
        return true;
      case "project":
        return sub.project === (msg.project ?? msg.from_project);
      case "dm":
        return msg.target === sub.username;
    }
  }

  isDeliverable(sub: Subscriber, msg: Message): boolean {
    if (msg.system_kind === "keepalive") return true;
    if (isAdminConsoleMessage(msg)) return true;
    const personal =
      msg.scope === "dm" || msg.mentions.includes(sub.username);
    if (personal) return true;
    switch (sub.mode) {
      case "all":
        return true;
      case "quiet":
        return !msg.system;
      case "project":
        return msg.scope === "project";
      case "dm":
        return false;
    }
  }

  // -------------------------------------------------------------------- //
  // Ask / answer
  // -------------------------------------------------------------------- //

  async ask(args: {
    from_agent_id: string;
    target_username: string;
    text: string;
    timeout_ms?: number;
  }): Promise<AskResult> {
    const sender = this.subscribers.get(args.from_agent_id);
    if (!sender) {
      throw new ChatError("not_logged_in", `Agent '${args.from_agent_id}' is not logged in.`);
    }
    // Cross-process target lookup: a target may live in another
    // process and be invisible to this router's in-memory map. Look
    // up via the SQLite presence table when a db is wired so
    // cross-process asks resolve.
    const target = this.lookupSubscriberAcross(args.target_username);
    if (!target) {
      throw new ChatError(
        "ask_target_unknown",
        `No connected agent named '${args.target_username}'.`,
      );
    }
    if (target.transient) {
      throw new ChatError(
        "ask_target_transient",
        `Cannot ask a guest — formal asks need durable identity.`,
      );
    }
    const ask_id = randomUUID();
    this.addMessage({
      from_agent_id: args.from_agent_id,
      scope: "dm",
      target: args.target_username,
      text: args.text,
      ask_id,
    });
    const timeoutMs = args.timeout_ms ?? 30_000;

    if (this.db) {
      // Cross-process path: poll the SQLite messages table for the
      // answer row. The answer message has correlation_id = ask_id
      // AND target_username = asker_username (since `answer` DMs
      // the original asker). Returns "no_response" on timeout OR
      // "respondent_disconnected" when the target's presence row
      // disappears past the prune grace.
      return this.pollForAnswer(sender.username, args.target_username, ask_id, timeoutMs);
    }

    // In-memory fallback (test routers without db) — keep the
    // pendingAsks map for fast in-process resolution.
    return new Promise<AskResult>((resolve) => {
      const timeout_handle = setTimeout(() => {
        if (this.pendingAsks.delete(ask_id)) {
          resolve({ status: "timeout", reason: "no_response" });
        }
      }, timeoutMs);
      this.pendingAsks.set(ask_id, {
        ask_id,
        question_message_id: ask_id,
        from_agent_id: args.from_agent_id,
        from_username: sender.username,
        target_username: args.target_username,
        resolver: (answer) =>
          answer === null
            ? resolve({ status: "timeout", reason: "respondent_disconnected" })
            : resolve({ status: "answered", text: answer.text, from: answer.from }),
        timeout_handle,
      });
    });
  }

  /** Look up a subscriber across processes via the SQLite presence
   * table when a db is wired; falls back to the in-memory map for
   * test routers. */
  private lookupSubscriberAcross(
    username: string,
  ): { username: string; transient: boolean } | null {
    const local = this.getByUsername(username);
    if (local) return local;
    if (!this.db) return null;
    const rows = listActive(this.db, { now: this.clock() });
    const row = rows.find((r) => r.username === username);
    return row ? { username: row.username, transient: row.transient } : null;
  }

  /** §11c cross-process ask/answer poll. Stops on answer arrival,
   * timeout, or respondent-disconnect (presence row vanished or
   * stale past the prune grace). */
  private async pollForAnswer(
    asker_username: string,
    target_username: string,
    ask_id: string,
    timeout_ms: number,
  ): Promise<AskResult> {
    if (!this.db) return { status: "timeout", reason: "no_response" };
    const startedAt = this.clock();
    const pollMs = 250;
    while (this.clock() - startedAt < timeout_ms) {
      const answer = this.db
        .query(
          "SELECT from_agent_id, from_username_inline, text FROM messages " +
            "WHERE correlation_id = ? AND target_username = ? ORDER BY ts ASC LIMIT 1",
        )
        .get(ask_id, asker_username) as
        | {
            from_agent_id: string;
            from_username_inline: string | null;
            text: string;
          }
        | undefined;
      if (answer) {
        let fromName = answer.from_username_inline;
        if (!fromName) {
          const senderRow = this.db
            .query("SELECT username FROM subscribers WHERE agent_id = ?")
            .get(answer.from_agent_id) as { username: string } | undefined;
          fromName = senderRow?.username ?? `agent:${answer.from_agent_id.slice(0, 8)}`;
        }
        return { status: "answered", text: answer.text, from: fromName };
      }
      // Check target presence — disappeared past the prune grace
      // means respondent-disconnected. Use the prune grace (60s) not
      // the stale threshold (30s) so a late heartbeat doesn't false-
      // positive disconnect.
      const targetRow = this.db
        .query(
          "SELECT 1 AS x FROM subscribers WHERE username = ? AND last_heartbeat > ?",
        )
        .get(target_username, this.clock() - DEFAULT_PRUNE_GRACE_MS) as
        | { x: number }
        | undefined;
      if (!targetRow) {
        return { status: "timeout", reason: "respondent_disconnected" };
      }
      await sleep(pollMs);
    }
    return { status: "timeout", reason: "no_response" };
  }

  answer(args: {
    from_agent_id: string;
    correlation_id: string;
    text: string;
  }): Message {
    const sub = this.subscribers.get(args.from_agent_id);
    if (!sub) {
      throw new ChatError("not_logged_in", `Agent '${args.from_agent_id}' is not logged in.`);
    }

    // Cross-process: query SQLite for the original ask row. The ask
    // has correlation_id = ask_id AND target_username = our handle.
    let askMeta: { target_username: string; from_agent_id: string } | null = null;
    if (this.db) {
      const row = this.db
        .query(
          "SELECT target_username, from_agent_id FROM messages " +
            "WHERE correlation_id = ? AND target_username = ? ORDER BY ts ASC LIMIT 1",
        )
        .get(args.correlation_id, sub.username) as
        | { target_username: string; from_agent_id: string }
        | undefined;
      if (row) askMeta = row;
    }
    if (!askMeta) {
      const pending = this.pendingAsks.get(args.correlation_id);
      if (pending) {
        askMeta = {
          target_username: pending.target_username,
          from_agent_id: pending.from_agent_id,
        };
      }
    }
    if (!askMeta) {
      throw new ChatError(
        "answer_unknown",
        `No pending ask with correlation_id '${args.correlation_id}'.`,
      );
    }
    if (askMeta.target_username !== sub.username) {
      throw new ChatError(
        "answer_unknown",
        `Ask '${args.correlation_id}' targets '${askMeta.target_username}', not you ('${sub.username}').`,
      );
    }

    // Resolve the asker's username — and require liveness. Match the
    // recipient_offline contract used by send_message / send_structured /
    // ask: an answer to an asker who is no longer online is a silent
    // drop unless they happen to backfill via cursor on reconnect, which
    // pantheon does not promise. In-memory presence (same MCP process)
    // implies liveness; cross-process requires a fresh-heartbeat check
    // via listActive (NOT the raw subscribers table — that includes rows
    // within the prune grace whose heartbeat has already gone stale).
    let askerUsername: string | null = null;
    const askerLocal = this.subscribers.get(askMeta.from_agent_id);
    if (askerLocal) {
      askerUsername = askerLocal.username;
    } else if (this.db) {
      const live = listActive(this.db, { now: this.clock() }).find(
        (r) => r.agent_id === askMeta!.from_agent_id,
      );
      if (live) askerUsername = live.username;
    }
    if (!askerUsername) {
      throw new ChatError(
        "recipient_offline",
        `Cannot answer ask '${args.correlation_id}' — the asker is no longer connected. The answer was NOT persisted.`,
      );
    }
    return this.addMessage({
      from_agent_id: args.from_agent_id,
      scope: "dm",
      target: askerUsername,
      text: args.text,
      in_reply_to_ask: args.correlation_id,
    });
  }

  // -------------------------------------------------------------------- //
  // Subscriptions / queries
  // -------------------------------------------------------------------- //

  subscribe(agent_id: string, listener: (msg: Message) => void): () => void {
    const handler = (m: Message) => listener(m);
    this.emitter.on(`message:${agent_id}`, handler);
    return () => this.emitter.off(`message:${agent_id}`, handler);
  }

  advanceCursor(agent_id: string, seq: number): void {
    const cur = this.cursors.get(agent_id) ?? 0;
    if (seq > cur) this.cursors.set(agent_id, seq);
  }

  getByUsername(username: string): Subscriber | null {
    const id = this.usernameIndex.get(username.toLowerCase());
    return id ? this.subscribers.get(id) ?? null : null;
  }

  getByAgentId(agent_id: string): Subscriber | null {
    return this.subscribers.get(agent_id) ?? null;
  }

  allSubscribers(): Iterable<Subscriber> {
    return this.subscribers.values();
  }

  publicList(project?: string): PublicAgent[] {
    // Cross-process: when a SQLite db is wired, prefer the presence
    // table — it sees subscribers across every MCP process. Falls
    // back to the in-memory map for in-process-only test routers.
    if (this.db) {
      try {
        const rows = listActive(this.db, {
          ...(project !== undefined ? { project } : {}),
          stale_threshold_ms: DEFAULT_STALE_THRESHOLD_MS,
          now: this.clock(),
        });
        return rows.map((r) => ({
          username: r.username,
          project: r.project,
          status: r.status,
          transient: r.transient,
          mode: r.mode,
          connected_at: r.connected_at,
          last_seen: r.last_heartbeat,
          status_updated_at: r.status_updated_at,
        }));
      } catch {
        // fall through to in-memory below
      }
    }
    const out: PublicAgent[] = [];
    for (const sub of this.subscribers.values()) {
      if (project && sub.project !== project) continue;
      out.push({
        username: sub.username,
        project: sub.project,
        status: sub.status,
        transient: sub.transient,
        mode: sub.mode,
        connected_at: sub.connected_at,
        last_seen: sub.last_seen,
        status_updated_at: sub.status_updated_at,
        ...(sub.status_meta ? { status_meta: sub.status_meta } : {}),
      });
    }
    return out.sort((a, b) => a.username.localeCompare(b.username));
  }

  /** Cross-process online-handles snapshot. Used by `find_role` to
   * compute the `online` flag against the persona registry. Falls
   * back to in-memory when no DB is wired. */
  onlineUsernames(): Set<string> {
    if (this.db) {
      try {
        const rows = listActive(this.db, { now: this.clock() });
        return new Set(rows.map((r) => r.username.toLowerCase()));
      } catch {
        // fall through
      }
    }
    const out = new Set<string>();
    for (const sub of this.subscribers.values()) out.add(sub.username.toLowerCase());
    return out;
  }

  // -------------------------------------------------------------------- //
  // Internals
  // -------------------------------------------------------------------- //

  private presenceUpsert(sub: Subscriber): void {
    if (!this.db) return;
    try {
      upsertSubscriber(this.db, sub, this.clock());
    } catch {
      // best-effort — never fail a router op because of presence write
    }
  }

  private presenceRemove(agent_id: string): void {
    if (!this.db) return;
    try {
      presenceRemove(this.db, agent_id);
    } catch {
      // best-effort
    }
  }

  checkAvailability(
    username: string,
    ignoreSelf?: string,
    claimedPersona?: string,
  ): AvailabilityResult {
    return isHandleAvailable({
      username,
      // Cross-process collision: each MCP server has its own router
      // and `this.subscribers` only knows about THIS process's
      // subscribers. Without merging the SQLite-side `listActive`
      // rows, two MCP processes could each pass `add()` and end up
      // chatting under the same name — the bug surfaced when running
      // a registered persona twice via `manifest`.
      subscribers: this.allKnownSubscribers(),
      tombstones: this.tombstones,
      paths: this.paths,
      ...(ignoreSelf !== undefined ? { ignore_self_username: ignoreSelf } : {}),
      ...(claimedPersona !== undefined ? { claimed_persona: claimedPersona } : {}),
    });
  }

  /** Iterable view of every active subscriber visible to this
   * process — in-memory (this router's own) + SQLite-side
   * (peer routers' subscribers, kept fresh by their heartbeats).
   * Deduplicated by `agent_id`; in-memory entries win when both
   * sources have the same id (the local copy is the freshest).
   * `listActive` filters by 30s heartbeat threshold so a crashed
   * peer doesn't lock up its handle forever. */
  private allKnownSubscribers(): Iterable<Subscriber> {
    const merged = new Map<string, Subscriber>();
    if (this.db) {
      try {
        const rows = listActive(this.db, { now: this.clock() });
        for (const r of rows) {
          merged.set(r.agent_id, {
            agent_id: r.agent_id,
            username: r.username,
            project: r.project,
            transient: r.transient,
            status: r.status,
            mode: r.mode,
            connected_at: r.connected_at,
            last_seen: r.last_heartbeat,
            // Cross-process rows don't carry per-recipient delivery
            // timestamps. Seed last_event_at from the heartbeat so a
            // remote subscriber doesn't get spuriously keepalived
            // immediately on the first sweep after this router boots.
            last_event_at: r.last_heartbeat,
            status_updated_at: r.status_updated_at,
            promoted_at: r.promoted_at,
          });
        }
      } catch {
        // best-effort — fall through to in-memory only on DB error
      }
    }
    for (const sub of this.subscribers.values()) {
      merged.set(sub.agent_id, sub);
    }
    return merged.values();
  }

  /** Walk `<base>2`, `<base>3`, ..., `<base><max>` and return the
   * first incarnation handle that passes `isHandleAvailable`. Used by
   * the login handler to surface a `suggested_suffix` when a username
   * collision blocks a spawn — the human (or the
   * `--chat-username-suffix auto` flag) can grab that handle without
   * a separate availability probe round trip.
   *
   * Returns `null` when nothing is available within the search window
   * (defaults to 99 — well past any realistic concurrent-incarnation
   * count). The candidate uses the dotless form (`<base><N>`) which
   * always passes the incarnation rule even without the dash-suffix
   * relaxation. */
  nextAvailableIncarnation(
    base: string,
    opts: { max?: number; claimed_persona?: string } = {},
  ): string | null {
    const max = opts.max ?? 99;
    for (let n = 2; n <= max; n++) {
      const candidate = `${base}${n}`;
      const r = this.checkAvailability(
        candidate,
        undefined,
        opts.claimed_persona,
      );
      if (r.available) return candidate;
    }
    return null;
  }

  private throwForAvailability(username: string, result: AvailabilityResult): never {
    if (result.available) {
      throw new ChatError("username_taken", `Internal: throwForAvailability called on available result.`);
    }
    const code: ChatError["code"] =
      result.reason === "registered_persona"
        ? "already_registered"
        : result.reason === "subscriber_taken"
          ? "username_taken"
          : result.reason === "tombstoned"
            ? "username_taken"
            : "username_prefix_collision";
    throw new ChatError(
      code,
      `Handle '${username}' is unavailable: ${result.reason}${
        result.conflicting ? ` (conflicts with '${result.conflicting}')` : ""
      }.`,
      { reason: result.reason, ...(result.conflicting ? { conflicting: result.conflicting } : {}) },
    );
  }
}
