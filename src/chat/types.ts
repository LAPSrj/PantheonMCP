/** §11c chat router types. */

export type Scope = "project" | "dm" | "global";
export type Mode = "all" | "quiet" | "project" | "dm";
export type SystemKind =
  | "join"
  | "leave"
  | "rename"
  | "project_change"
  | "status_update"
  | "status_digest"
  | "keepalive"
  | "promotion"
  | "handle_recycled"
  | "profile_update"
  | "summon_failed";

export interface Subscriber {
  /** Stable agent_id assigned by the router on `login`. */
  agent_id: string;
  /** Display handle. */
  username: string;
  /** When `true`, the subscriber is a guest — no registry-backed
   * identity, no memory, no summon recipe. */
  transient: boolean;
  project: string;
  status: string;
  mode: Mode;
  /** ms timestamps. */
  connected_at: number;
  last_seen: number;
  /** Time of the last event actually pushed to this subscriber's
   * watcher stream — i.e. a message that passed visibility +
   * deliverability checks for this recipient. Distinct from
   * `last_seen` (which is bumped on agent-initiated activity like
   * setMode / checkMessages too). The keepalive sweep uses this to
   * decide whether the agent's prompt cache needs warming. */
  last_event_at: number;
  status_updated_at: number;
  /** When the subscriber was promoted from guest to persona,
   * `promoted_at` records the moment. Otherwise null. */
  promoted_at: number | null;
  /** True when the MCP client declared support for the
   * `claude/channel` experimental capability at login. Channels-
   * enabled subscribers receive deliverable messages as inline
   * `notifications/claude/channel` push events instead of via the
   * Monitor watcher loop, so the bootstrap can skip the Monitor
   * instructions. Optional (defaults to false at every read site).
   * Per-process only — not persisted in the SQLite presence table. */
  supports_channels?: boolean;
  /** §6 LOW — structured status metadata for dashboards. Optional;
   * present when the agent set them via `update_status({ task?,
   * blocker?, eta? })`. The free-form `status` line is still the
   * canonical signal; metadata is decoration that `list_agents` can
   * render alongside. Per-process only — not persisted in SQLite
   * (matches `supports_channels` scoping). */
  status_meta?: StatusMeta;
}

/** §6 LOW — structured status metadata. Free-form strings;
 * convention-driven shape. */
export interface StatusMeta {
  task?: string;
  blocker?: string;
  /** Free-form ETA string ("2pm", "EOD", "after lunch"). Not parsed. */
  eta?: string;
}

export interface PendingAsk {
  ask_id: string;
  question_message_id: string;
  from_agent_id: string;
  from_username: string;
  target_username: string;
  /** Resolved with the answer text (and `from`) on success, or `null`
   * on timeout / respondent-disconnect. */
  resolver: (
    answer: { text: string; from: string; status: "answered" } | null,
  ) => void;
  timeout_handle: ReturnType<typeof setTimeout>;
}

/** Tombstone for a recently-vacated guest handle. Pure in-memory;
 * does NOT persist. Sweep stale via daemon-tick. */
export interface Tombstone {
  username: string;
  vacated_at: number;
  prior_agent_id: string;
}

export interface MessageInput {
  from_agent_id: string;
  scope: Scope;
  text: string;
  /** Required for `dm` scope — recipient's username. Optional for
   * `project` scope (defaults to the sender's project). Ignored for
   * `global`. */
  target?: string;
  /** Required for `project` scope when filtering across projects;
   * defaults to the sender's project. */
  project?: string;
  reply_to?: string;
  /** Set on `ask` so the message carries a correlation_id; `answer`
   * messages set it via `in_reply_to_ask`. */
  ask_id?: string;
  in_reply_to_ask?: string;
  system?: boolean;
  system_kind?: SystemKind;
  /** Guest-supplied display name stored inline for non-registry-backed
   * messages. Persona messages set this to null and resolve via
   * registry on render. */
  from_username_inline?: string | null;
  /** When set, this agent_id will NOT receive the message via the
   * watcher stream and its read cursor advances past the message.
   * Used by the ask/answer dedupe path. */
  not_for?: string;
  /** Caller-typed message kind for structured chat (D.6 audit reshape).
   * Free-form string set by `send_structured`; pantheon stores it
   * alongside the optional `payload` and renders `[kind:X]` in the
   * watcher line so receivers see the type at a glance. Distinct from
   * `system_kind` (reserved for SystemKind values on system messages). */
  user_kind?: string;
  /** Structured payload for typed messages. Stored as JSON in SQLite.
   * Receivers retrieve via `get_message` (parsed back to an object).
   * Schema validation against a registered schema_id is opt-in and
   * happens at the handler layer; the router stores whatever it gets. */
  payload?: unknown;
}

export interface Message extends Required<Omit<MessageInput, "target" | "project" | "reply_to" | "ask_id" | "in_reply_to_ask" | "system" | "system_kind" | "from_username_inline" | "not_for" | "user_kind" | "payload">> {
  id: string;
  seq: number;
  ts: number;
  /** Parsed from `text` at send time. */
  mentions: string[];
  /** Sender's project at send time (cached so cross-project filtering
   * doesn't need to chase the live subscriber). */
  from_project: string;
  /** Optional fields back; required-typed in MessageInput as appropriate. */
  target?: string;
  project?: string;
  reply_to?: string;
  ask_id?: string;
  in_reply_to_ask?: string;
  system?: boolean;
  system_kind?: SystemKind;
  from_username_inline?: string | null;
  user_kind?: string;
  payload?: unknown;
}

export interface PublicAgent {
  username: string;
  project: string;
  status: string;
  transient: boolean;
  mode: Mode;
  connected_at: number;
  last_seen: number;
  status_updated_at: number;
  /** §6 LOW status-with-metadata. Only populated when the
   * subscriber's `status_meta` is set in this process's memory.
   * Cross-process consumers (other MCPs reading via the SQLite
   * presence table) see no meta — it isn't persisted. */
  status_meta?: StatusMeta;
}

export class ChatError extends Error {
  code: ChatErrorCode;
  extra: Record<string, unknown>;
  constructor(
    code: ChatErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "ChatError";
  }
}

export type ChatErrorCode =
  | "username_taken"
  | "username_prefix_collision"
  | "username_reserved"
  | "username_invalid"
  | "cwd_mismatch"
  | "already_registered"
  | "not_logged_in"
  | "not_a_guest"
  | "no_persona"
  | "ask_target_unknown"
  | "ask_target_transient"
  | "answer_unknown"
  | "respondent_disconnected"
  | "missing_target"
  | "target_requires_dm"
  | "recipient_offline"
  | "agent_id_not_username"
  | "ambiguous_agent_id"
  | "agent_id_not_live"
  | "promote_validation_failed";

/** Discriminated outcome of an `ask`. The router used to return
 * `{text, from} | null`; the new shape distinguishes timeout vs
 * respondent-disconnect explicitly so the MCP handler doesn't have
 * to guess. */
export type AskResult =
  | { status: "answered"; text: string; from: string }
  | { status: "timeout"; reason: "no_response" | "respondent_disconnected" };
