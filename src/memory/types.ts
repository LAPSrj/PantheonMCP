/** Memory subsystem types. Mirrors §4 of the brainstorm doc. */

import type { MemoryRevision } from "./history.ts";

export type MemoryStatus = "active" | "faded" | "forgotten";

/** Three-tier entry body per §4 / §11b:
 *
 *   - `summary`   — ≤240 char one-line headline. Always rendered (Core, Active, Index).
 *   - `text`      — load-bearing body. Rendered in Core/Active when within budget.
 *                   Counted against the byte budget.
 *   - `details`   — optional ≤5MB verbatim payload (quotes, chat dialogs,
 *                   post-mortem prose). NEVER inlined at startup; only via
 *                   `get_memory_details(id)`. Does NOT count against budget.
 *
 * `core: true` is pantheon's replacement for summon-mcp's `pinned: true`.
 * Code reads `core` only — no `pinned` fallback (§9 / §11b decision).
 */
export interface MemoryEntry {
  id: string;
  date: string;
  summary: string;
  text: string;
  status: MemoryStatus;
  details?: string;
  kind?: string;
  /** Username of the summoner whose session created this entry, when
   * the entry was appended during a summon-spawned session. Optional. */
  summoner_username?: string;
  /** When true, the entry is treated as Core: rendered in full at
   * startup subject to the 10KB middle-out cap. */
  core?: boolean;
  /** ms-epoch expiry timestamp. The §6 MEDIUM idle-handoff slot
   * sets this to `now + 7 days` for `kind: "handoff"` entries; the
   * daemon-tick auto-fades past expiry. Schema-additive — existing
   * entries without `expires_at` never auto-fade. */
  expires_at?: number;
  /** §6 MEDIUM memory annotations / threading. Entry id this entry
   * is replying to. Renderer indents children under their parent in
   * the Index synopsis. Validated at write time — referenced ids
   * must exist in the same persona's memory. */
  replies_to?: string;
  /** §6 MEDIUM. Entry ids cited inline at the end of the synopsis
   * (`[id1] [id2]`). Validated at write time. */
  see_also?: string[];
  /** Structured handoff metadata — populated only on `kind: "handoff"`
   * entries written via `rest({ handoff })`. The free-form `text`
   * carries the prose (in-flight threads, decisions, lessons); this
   * carries the parts a reconnecting session can consume directly.
   * Surfaces structured in the next session's boot payload. */
  handoff?: HandoffMeta;

  /** Watcher metadata — populated only on `kind: "watcher"` entries
   * (`docs/memory-redesign/6-watcher-kind.md`). The free-form `text`
   * carries the prose ("what this watch is for", history, caveats);
   * this carries the two bindings + the machine-usable re-arm payload a
   * successor needs to re-arm without archaeology. See `WatcherMeta`. */
  watcher?: WatcherMeta;

  // ── Redesign v2 (5-proposal-v2.md) — all schema-additive + optional.
  // Existing entries lack them; readers default. See the proposal for
  // the model. P1 adds storage; later phases add behavior.

  /** v2: topic for topic-scoped load. Unified with the slug domain
   * (`slug = <topic>/<name>`). The reserved value `"always"` is loaded
   * every session. */
  topic?: string;
  /** v2: pin → render this entry in FULL every session, regardless of
   * topic (a detail+load flag, byte-budgeted). */
  pin?: boolean;
  /** v2: single-sentence justification required alongside `pin`. */
  pin_reason?: string;
  /** v2 reminder: due as an epoch-ms instant (stored UTC) or the
   * literal `"next-session"`. Absent on a `kind:"reminder"` entry means
   * an open (no-date) reminder that resurfaces until acted on. */
  due?: number | "next-session";
  /** v2: id of the entry this one supersedes. The superseded entry is
   * coerced to `forgotten`. */
  supersedes?: string;
  /** v2: per-persona session ordinal stamped at write time. Drives
   * handoff matching-session fade + next-session reminders. */
  session_seq?: number;
  /** v2 handoff: count of distinct matching sessions that have
   * delivered this handoff (see §8 fade rule). */
  matched?: number;
  /** v2 handoff: the session_seq of the last matching delivery, so the
   * `matched` counter advances at most once per session. */
  last_matched_seq?: number;
  /** v2 reminder: set once the daemon-tick has pushed a notification for
   * a due date-reminder, so it isn't re-pushed every tick. */
  notified?: boolean;
  /** v2 provenance — opt-in, multiple per entry. Where this memory came
   * from, SNAPSHOTTED at write time (durable against chat/transcript
   * pruning). NEVER rendered at boot and stripped from `recall_memory`
   * (which only flags `has_source`); fetched via `get_memory_source(id)`.
   * Each ref keeps the snapshot text AND the coordinates the existing
   * read tools consume, so an agent can re-verify live. See `MemorySource`. */
  sources?: MemorySource[];

  /** Per-entry update history (`src/memory/history.ts`). Append-only,
   * chronological FULL snapshots of every prior content state — the first
   * element is the original (creation) state, each later one is the state
   * an edit replaced; the live entry is the current tip. Recorded by
   * `updateEntry` / `amendEntry` on any tracked-field change. NEVER
   * rendered or auto-returned (stripped from `recall_memory`, which flags
   * `has_history`); fetched via `get_memory_history(id)`. */
  revisions?: MemoryRevision[];
}

/** One provenance reference on a memory entry. At least one resolution
 * coordinate is set; the snapshot fields capture what the coordinate
 * resolved to at write time. Coordinates map to the existing read tools:
 *   - `message_id`           → `get_message({ message_id })`        (chat)
 *   - `session_id`+`message_at` → `get_history_message({ … })`      (transcript)
 *   - `quote`                → `validate_user_quote({ username, quote })`
 * `username` for the quote path is the entry's owning persona. */
export interface MemorySource {
  /** chat.db message id. */
  message_id?: string;
  /** CC transcript coordinates. */
  session_id?: string;
  message_at?: string;
  /** Verbatim user-typed substring (validatable against the transcript). */
  quote?: string;
  /** Optional human label the agent supplied (e.g. "Leandro 2026-06-01"). */
  label?: string;
  /** Snapshot captured at write — the resolved message/quote text. */
  text?: string;
  /** Author handle of the snapshotted message, when resolvable. */
  author?: string;
  /** ms-epoch timestamp of the snapshotted message, when resolvable. */
  ts?: number;
  /** True when the coordinate resolved to `text` at write time; false
   * when resolution failed (bad id / not found) and only the
   * agent-supplied fields were stored. */
  resolved?: boolean;
}

/** The machine-usable slice of a context handoff (see the canonical
 * shape in the `write-handoff` skill). Everything here is optional —
 * an agent fills what it has. The prose-shaped sections (in-flight
 * threads, decisions made, lessons learned, gotchas) stay in the
 * entry's `text`; they don't structure usefully. */
export interface HandoffMeta {
  /** The trust posture the user set this session — ideally a verbatim
   * quote. Decay-free; dictates how the next session makes calls. */
  trust_posture?: string;
  /** Ordered "first 30 minutes" checklist for the next session. */
  pickup?: string[];
  /** Memory entries the next session must read, each with the
   * one-line load-bearing reason. The boot path can resolve these. */
  memory_refs?: { id: string; why: string }[];
  /** Explicit "do NOT do X" directives carried into the next session. */
  prohibitions?: string[];
}

/** Watcher metadata — the machine-usable slice of a watch lane (see the
 * model in `docs/memory-redesign/6-watcher-kind.md`). TWO bindings:
 * `owner_agent_id` (the arming session — the EXACT orphan trigger) and
 * `owner_username` (the canonical persona — responsibility / re-arm
 * pool). "Orphaned" is NEVER stored — it is derived at render time from
 * the live presence set (`isWatcherOrphaned`), mirroring `isReminderDue`. */
export interface WatcherMeta {
  /** The chat `agent_id` of the arming session (`ctx.chat_agent_id`).
   * Orphan trigger: the watcher is orphaned iff this id is absent from
   * the live presence set. Re-bound by `claim_watcher` on re-arm. */
  owner_agent_id: string;
  /** The CANONICAL persona handle (`ctx.session.claimedUsername`, never
   * the suffixed chat handle). Who is responsible / who may claim. */
  owner_username: string;
  /** The re-arm pool — reuses the persona/project memory tiers, not a
   * new axis. `persona`: any live sibling of `owner_username` may claim
   * (entry in persona memory). `project`: any live session in the
   * project may claim (entry in project memory). Default `persona`. */
  scope: "persona" | "project";
  /** Everything a successor needs to re-arm WITHOUT reading source. The
   * prose stays in the entry `text`; this is the executable slice. */
  rearm: {
    /** Cron specs / IDs to recreate (e.g. `CronCreate` args). */
    crons?: string[];
    /** Monitor commands / shell to re-run. */
    commands?: string[];
    /** Pointer to a ledger / notes file, when the lane keeps one. */
    ledger?: string;
    /** Free-form "to re-arm: …" instructions. */
    notes?: string;
  };
  /** Human-readable "done when …". The owner checks it; v1 close is
   * explicit (`close_watcher`), not auto-evaluated. */
  close_condition?: string;
  /** ms-epoch when first armed. */
  armed_at: number;
  /** ms-epoch of the last successful `claim_watcher` re-arm, if any.
   * The liveness check IS the claim TTL: a claim re-binds the owner to
   * the (live) claiming session, so if that session later dies the
   * watcher simply re-orphans on the next cycle — no separate timer. */
  last_rearmed_at?: number;
  /** Daemon-tick push dedup (the reminder `notified` analog): set true
   * when the tick has pushed the "ORPHANED — re-arm now" notification,
   * so siblings don't re-push every 30s. Reset to false by
   * `claim_watcher` on a successful re-arm. NOT a status — orphaned-ness
   * itself is always derived live from presence, never stored. */
  orphan_notified?: boolean;
}

export interface MemoryStore {
  version: 1;
  entries: MemoryEntry[];
  /** v2 — the last per-persona session ordinal issued by `beginSession`.
   * Stamped on entries written that session (`session_seq`); drives the
   * handoff matching-session fade (§8) + next-session reminders.
   * Schema-additive: a store without it starts at 0. */
  session_seq?: number;
}

/** Index-shape returned by `list_memory`. Cheap; no body content. */
export interface MemoryIndexEntry {
  id: string;
  date: string;
  status: MemoryStatus;
  core: boolean;
  summary: string;
  size_kb: number;
  has_details: boolean;
  kind?: string;
  /** v2: topic, when present. */
  topic?: string;
}

export class MemoryError extends Error {
  code: MemoryErrorCode;
  extra: Record<string, unknown>;
  constructor(
    code: MemoryErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "MemoryError";
  }
}

export type MemoryErrorCode =
  | "entry_not_found"
  | "entry_too_large"
  | "summary_too_long"
  | "missing_text"
  | "invalid_status"
  | "invalid_reference";
