import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Database } from "bun:sqlite";
import type { Paths } from "../storage/index.ts";
import {
  ChatError,
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
import {
  DEFAULT_STALE_THRESHOLD_MS,
  advanceChatCursor,
  heartbeat as presenceHeartbeat,
  listActive,
  readChatCursor,
  removeSubscriber as presenceRemove,
  upsertSubscriber,
} from "./presence.ts";
import { selectReceivableRows } from "./watcher.ts";
import type { MessageRow } from "./persistence.ts";

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

  constructor(options: RouterOptions) {
    this.paths = options.paths;
    this.db = options.db ?? null;
    this.tombstones = options.tombstones ?? new TombstoneMap();
    this.clock = options.clock ?? Date.now;
    this.maxInMemory = options.max_in_memory_messages ?? DEFAULT_MAX_IN_MEMORY;
    this.emitter.setMaxListeners(1000);
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
      status_updated_at: now,
      promoted_at: null,
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
      system_actor: "system",
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
      ...(input.system_actor !== undefined ? { system_actor: input.system_actor } : {}),
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
      sub.last_seen = this.clock();
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
    if (msg.system_actor === "admin") return true;
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

  ask(args: {
    from_agent_id: string;
    target_username: string;
    text: string;
    timeout_ms?: number;
  }): Promise<{ text: string; from: string; status: "answered" } | null> {
    const sender = this.subscribers.get(args.from_agent_id);
    if (!sender) {
      throw new ChatError("not_logged_in", `Agent '${args.from_agent_id}' is not logged in.`);
    }
    const target = this.getByUsername(args.target_username);
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
    const question = this.addMessage({
      from_agent_id: args.from_agent_id,
      scope: "dm",
      target: args.target_username,
      text: args.text,
      ask_id,
    });
    const timeoutMs = args.timeout_ms ?? 30_000;
    return new Promise((resolve) => {
      const timeout_handle = setTimeout(() => {
        if (this.pendingAsks.delete(ask_id)) {
          resolve(null);
        }
      }, timeoutMs);
      this.pendingAsks.set(ask_id, {
        ask_id,
        question_message_id: question.id,
        from_agent_id: args.from_agent_id,
        from_username: sender.username,
        target_username: args.target_username,
        resolver: resolve,
        timeout_handle,
      });
    });
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
    const ask = this.pendingAsks.get(args.correlation_id);
    if (!ask) {
      throw new ChatError(
        "answer_unknown",
        `No pending ask with correlation_id '${args.correlation_id}'.`,
      );
    }
    if (ask.target_username !== sub.username) {
      throw new ChatError(
        "answer_unknown",
        `Ask '${args.correlation_id}' targets '${ask.target_username}', not you ('${sub.username}').`,
      );
    }
    return this.addMessage({
      from_agent_id: args.from_agent_id,
      scope: "dm",
      target: ask.from_username,
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

  private checkAvailability(
    username: string,
    ignoreSelf?: string,
    claimedPersona?: string,
  ): AvailabilityResult {
    return isHandleAvailable({
      username,
      subscribers: this.subscribers.values(),
      tombstones: this.tombstones,
      paths: this.paths,
      ...(ignoreSelf !== undefined ? { ignore_self_username: ignoreSelf } : {}),
      ...(claimedPersona !== undefined ? { claimed_persona: claimedPersona } : {}),
    });
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
