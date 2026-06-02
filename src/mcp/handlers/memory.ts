import {
  appendEntry,
  beginSession,
  decayOnLoad,
  deleteSnapshot,
  defaultHandoffExpiresAt,
  fadeEntry,
  findMemory,
  forgetEntryWithLifecycleCoercion,
  getDetails,
  getEntry,
  HANDOFF_KIND,
  listIndex,
  listSnapshots,
  loadStore,
  recallEntry,
  renderForPrompt,
  restoreMemory,
  setMemory,
  snapshotMemory,
  updateEntry,
  validateWrite,
  clusterTopics,
  mapLegacyKind,
  type FindMemoryFilter,
  type ListIndexFilter,
  type MemoryEntry,
  type MemorySource,
} from "../../memory/index.ts";
import { listPersonas, readPersona } from "../../identity/index.ts";
import { openChatDb } from "../../storage/index.ts";
import { getMessageById } from "../../chat/index.ts";
import {
  fetchHistoryMessage,
  validateUserQuote,
} from "../../history-search/index.ts";
import { getInstructions, INSTRUCTION_TOPICS } from "../../responses/instructions.ts";
import {
  asBoolean,
  asNumber,
  asString,
  asStringRequired,
  type Handler,
  type HandlerContext,
  ToolError,
} from "../types.ts";

/** Persona memory is SELF-ONLY: an agent reads/writes its OWN claimed
 * persona, never a peer's. Cross-persona reads live behind the
 * `_any`-suffixed variants (`get_memory_any`, `recall_memory_any`, …),
 * which an operator can deny to regular agents by tool name. Shared
 * memory goes through PROJECT memory, not a peer's personal store. */
function selfUsername(claimed: string | null): string {
  if (!claimed) {
    throw new ToolError(
      "no_persona",
      "No claimed persona — call `claim` or `manifest` first.",
    );
  }
  return claimed;
}

/** Resolve the agent-supplied `sources` input into stored `MemorySource`
 * snapshots (Leandro's "snapshot at write"). Each input carries ONE
 * coordinate kind; we resolve it to durable text via the existing read
 * paths and keep both the coordinates (for later re-verification) and the
 * snapshot (durable against chat/transcript pruning). Resolution is
 * best-effort: an unresolvable coordinate stores `resolved: false` rather
 * than failing the memory write — provenance shouldn't block a save. */
function resolveSources(
  ctx: HandlerContext,
  username: string,
  raw: unknown,
): MemorySource[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: MemorySource[] = [];
  let cwd: string | null = null;
  try {
    cwd = readPersona(ctx.paths, username)?.cwd ?? null;
  } catch {
    cwd = null;
  }
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const messageId = asString(o.message_id);
    const sessionId = asString(o.session_id);
    const messageAt = asString(o.message_at);
    const quote = asString(o.quote);
    const label = asString(o.label);

    if (messageId !== undefined) {
      out.push(resolveChatMessage(ctx, messageId, label));
    } else if (sessionId !== undefined && messageAt !== undefined) {
      out.push(resolveTranscript(cwd, sessionId, messageAt, label));
    } else if (quote !== undefined) {
      out.push(resolveQuote(cwd, quote, label));
    } else if (label !== undefined) {
      // Bare label — no resolvable coordinate, but the agent's
      // attribution is still worth keeping.
      out.push({ label, resolved: false });
    }
    // Otherwise the item carried nothing usable — skip it silently.
  }
  return out;
}

function resolveChatMessage(
  ctx: HandlerContext,
  messageId: string,
  label: string | undefined,
): MemorySource {
  const base: MemorySource = { message_id: messageId, resolved: false };
  if (label !== undefined) base.label = label;
  try {
    const db = openChatDb(ctx.paths.chatDbPath);
    const row = getMessageById(db, messageId);
    if (row) {
      base.text = row.text;
      base.author = row.from_username_inline ?? row.from_agent_id;
      base.ts = row.ts;
      base.resolved = true;
    }
  } catch {
    // chat db unavailable — keep the coordinate, resolved stays false.
  }
  return base;
}

function resolveTranscript(
  cwd: string | null,
  sessionId: string,
  messageAt: string,
  label: string | undefined,
): MemorySource {
  const base: MemorySource = {
    session_id: sessionId,
    message_at: messageAt,
    resolved: false,
  };
  if (label !== undefined) base.label = label;
  if (!cwd) return base;
  try {
    const fetched = fetchHistoryMessage({ cwd, session_id: sessionId, message_at: messageAt });
    if (fetched && fetched.content.length > 0) {
      base.text = fetched.content;
      base.resolved = true;
    }
  } catch {
    // transcript not readable — keep coordinates, resolved stays false.
  }
  return base;
}

function resolveQuote(
  cwd: string | null,
  quote: string,
  label: string | undefined,
): MemorySource {
  const base: MemorySource = { quote, resolved: false };
  if (label !== undefined) base.label = label;
  if (!cwd) return base;
  try {
    const result = validateUserQuote({ cwd, quote, limit: 1 });
    const match = result.matches[0];
    if (result.found && match) {
      base.text = match.user_message;
      base.session_id = match.session_id;
      if (match.message_at !== null) base.message_at = match.message_at;
      base.resolved = true;
    }
  } catch {
    // transcript not readable — keep the quote, resolved stays false.
  }
  return base;
}

/** Project an entry for a default read path: strip `sources` (never
 * auto-returned, per the design) and surface a `has_source` flag instead.
 * The full source set is fetched on demand via `get_memory_source`. */
function withSourceFlag(entry: MemoryEntry): Record<string, unknown> {
  const { sources, ...rest } = entry;
  return { ...rest, has_source: (sources?.length ?? 0) > 0 };
}

/** Shared render path for `get_memory` (self) and `get_memory_any`
 * (peer). A peer render omits `loaded_topics` / `session_seq`, so only
 * the peer's pinned-FULL + `always`-summary surface (+ topic menu
 * counts) shows — topic bodies stay collapsed (use `recall_memory_any`
 * for a specific peer entry's full text). */
function renderMemoryFor(
  ctx: HandlerContext,
  username: string,
  includeForgotten: boolean,
  onlyCore: boolean,
): Record<string, unknown> {
  const isSelf = username === ctx.session.claimedUsername;
  const rendered = renderForPrompt(ctx.paths, username, {
    include_forgotten: includeForgotten,
    only_core: onlyCore,
    ...(isSelf ? { loaded_topics: ctx.loaded_topics } : {}),
    ...(isSelf && ctx.session_seq !== null ? { session_seq: ctx.session_seq } : {}),
    // Orphan trigger is self-only (your watch lanes, your responsibility);
    // a peer render keeps liveness undefined so it never false-alarms.
    ...(isSelf && ctx.chat ? { live_agent_ids: ctx.chat.liveAgentIds() } : {}),
  });
  return {
    username,
    text: rendered.text,
    ...(rendered.warning ? { warning: rendered.warning } : {}),
  };
};

export const get_memory: Handler = async (args, ctx) => {
  return renderMemoryFor(
    ctx,
    selfUsername(ctx.session.claimedUsername),
    asBoolean(args.include_forgotten) ?? false,
    asBoolean(args.only_core) ?? false,
  );
};

/** Cross-persona read (deniable by tool name). Renders another
 * persona's always-loaded surface (+ `only_core` for a cheap peek). */
export const get_memory_any: Handler = async (args, ctx) => {
  return renderMemoryFor(
    ctx,
    asStringRequired(args.username, "username"),
    asBoolean(args.include_forgotten) ?? false,
    asBoolean(args.only_core) ?? false,
  );
};

/** §9 / §13 — the topic menu: clustered topics + counts + due-reminder
 * count. Gate-exempt: this is the first call after manifest, before
 * `load_memory`. A fresh persona returns an empty topic list (the
 * dispatcher then skips the load gate). */
export const list_topics: Handler = async (_args, ctx) => {
  const username = selfUsername(ctx.session.claimedUsername);
  const entries = loadStore(ctx.paths, username).entries;
  const topics = clusterTopics(entries);
  const dueReminders = countDueReminders(entries, Date.now());
  return {
    username,
    topics,
    topic_count: topics.length,
    due_reminders: dueReminders,
    note:
      topics.length === 0
        ? "No topics yet — load gate is skipped; go straight to login + monitor."
        : "Pass the relevant topic(s) to `load_memory` (use \"always\" for the every-session set) before login.",
  };
};

/** §9 — REQUIRED before chat. Records the declared topics on the
 * session (lifting the dispatcher load gate) and returns the memory
 * rendered for those topics — its return shape IS the boot render. */
export const load_memory: Handler = async (args, ctx) => {
  // Loading is a self-only session operation — you load YOUR memory for
  // this conversation; there's no "load a peer into my session".
  const username = selfUsername(ctx.session.claimedUsername);
  // Accept `topics: string[]` or a single `topic: string`.
  let topics: string[] = [];
  if (Array.isArray(args.topics)) {
    topics = args.topics.filter((t): t is string => typeof t === "string");
  } else if (typeof args.topic === "string") {
    topics = [args.topic];
  }
  // Recording with zero topics is allowed (a fresh persona declaring
  // "nothing to load") — it still lifts the gate.
  ctx.loadMemory(topics);
  // §16 — start this conversation's session ordinal exactly once (the
  // first load_memory). Subsequent load_memory calls reuse it.
  const isSelf = username === ctx.session.claimedUsername;
  if (isSelf && ctx.session_seq === null) {
    ctx.setSessionSeq(beginSession(ctx.paths, username));
  }
  const sessionSeq = ctx.session_seq ?? undefined;
  // Render BEFORE the load-time decay pass, so entries consumed THIS
  // session (handoff autofade, delivered next-session reminders) still
  // appear in the response that consumes them.
  const rendered = renderForPrompt(ctx.paths, username, {
    loaded_topics: ctx.loaded_topics,
    ...(sessionSeq !== undefined ? { session_seq: sessionSeq } : {}),
    // Boot-render orphan check (the guarantee): surface watch lanes whose
    // arming session has left presence. ctx.chat is the daemon's router,
    // available even before this session's own login.
    ...(ctx.chat ? { live_agent_ids: ctx.chat.liveAgentIds() } : {}),
  });
  // §8/§10 session-boundary decay (self only; never mutate a peer).
  let decay;
  if (isSelf && sessionSeq !== undefined) {
    decay = decayOnLoad(ctx.paths, username, ctx.loaded_topics, sessionSeq);
  }
  return {
    username,
    loaded_topics: ctx.loaded_topics,
    text: rendered.text,
    ...(rendered.warning ? { warning: rendered.warning } : {}),
    ...(decay ? { decay } : {}),
  };
};

/** §11 — read-only topic-keyed pull for canonical pantheon guidance the
 * agent's CLAUDE.md doesn't inline. No topic → the topic menu. */
export const get_instructions: Handler = async (args) => {
  const topic = asString(args.topic);
  if (topic === undefined) {
    return {
      topics: INSTRUCTION_TOPICS,
      note: "Pass `topic` to pull one section, e.g. get_instructions({ topic: \"memory\" }).",
    };
  }
  const content = getInstructions(topic);
  if (content === null) {
    return {
      error: "unknown_topic",
      topic,
      available: INSTRUCTION_TOPICS,
    };
  }
  return { topic, content };
};

function countDueReminders(entries: MemoryEntry[], now: number): number {
  let n = 0;
  for (const e of entries) {
    if (e.status === "forgotten") continue;
    if (mapLegacyKind(e.kind) !== "reminder") continue;
    if (e.due === undefined || e.due === "next-session" || e.due <= now) n++;
  }
  return n;
}

export const append_memory: Handler = async (args, ctx) => {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError(
      "no_persona",
      "Memory writes require a claimed persona — call `claim` or `manifest` first.",
    );
  }
  const text = asStringRequired(args.text, "text");
  // §7/§16: the summary field is renamed `summary_max240` to carry its
  // limit as a generation-time nudge. The API accepts either name; the
  // storage field stays `summary` (tolerant-read live-safety).
  const summary = asString(args.summary_max240);
  const kind = asString(args.kind);
  // `expires_at`: a number sets an explicit TTL. When the field is
  // OMITTED entirely, a `kind: "handoff"` entry auto-gets the 7-day
  // handoff TTL — so a hand-written handoff still fades like one made
  // via `rest({ handoff })`. Passing `expires_at: null` explicitly
  // opts out (no TTL even for a handoff).
  let expiresAt = asNumber(args.expires_at);
  let expiresAtAutoSet = false;
  if (
    expiresAt === undefined &&
    !("expires_at" in args) &&
    kind === HANDOFF_KIND
  ) {
    expiresAt = defaultHandoffExpiresAt();
    expiresAtAutoSet = true;
  }
  const summonerOverride = asString(args.summoner_username);
  const summoner = summonerOverride ?? ctx.summoner_username ?? undefined;
  const repliesTo = asString(args.replies_to);
  const seeAlso = Array.isArray(args.see_also)
    ? (args.see_also.filter((v) => typeof v === "string") as string[])
    : undefined;
  // ── Redesign-v2 write fields.
  const topic = asString(args.topic);
  const pin = asBoolean(args.pin);
  const pinReason = asString(args.pin_reason);
  const supersedes = asString(args.supersedes);
  // `due`: a number (ms-epoch instant) or the literal "next-session".
  let due: number | "next-session" | undefined;
  if (typeof args.due === "number" && Number.isFinite(args.due)) {
    due = args.due;
  } else if (args.due === "next-session") {
    due = "next-session";
  }
  // Provenance — opt-in, snapshotted at write (see `resolveSources`).
  const sources = resolveSources(ctx, claimed, args.sources);

  // §12/§17 write-time validation. v2 is the only model now, so this is
  // always enforced — hard issues throw. The warn-only
  // PANTHEON_MEMORY_ENFORCE flag was removed once the whole fleet
  // migrated; advisory codes (kind_legacy / new_topic) are still returned
  // as warnings, never blocking.
  const warnings = validateWrite(
    {
      text,
      ...(summary !== undefined ? { summary } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(topic !== undefined ? { topic } : {}),
      ...(pin !== undefined ? { pin } : {}),
    },
    { existing: loadStore(ctx.paths, claimed).entries, enforce: true },
  );

  const created = appendEntry(ctx.paths, claimed, {
    text,
    ...(summary !== undefined ? { summary } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(summoner !== undefined ? { summoner_username: summoner } : {}),
    ...(repliesTo !== undefined ? { replies_to: repliesTo } : {}),
    ...(seeAlso !== undefined ? { see_also: seeAlso } : {}),
    ...(topic !== undefined ? { topic } : {}),
    ...(pin !== undefined ? { pin } : {}),
    ...(pinReason !== undefined ? { pin_reason: pinReason } : {}),
    ...(due !== undefined ? { due } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
    ...(ctx.session_seq !== null ? { session_seq: ctx.session_seq } : {}),
    ...(sources !== undefined && sources.length > 0 ? { sources } : {}),
  });
  // §7 — superseding an entry tombstones the one it replaces (recoverable
  // via include_forgotten). Tolerant: a missing/absent target is ignored.
  let supersededInfo: { superseded: string } | Record<string, never> = {};
  if (supersedes !== undefined) {
    try {
      forgetEntryWithLifecycleCoercion(ctx.paths, claimed, supersedes);
      supersededInfo = { superseded: supersedes };
    } catch {
      // target id didn't exist — supersede is advisory, don't fail the write.
    }
  }
  const warningFields = {
    ...(warnings.length > 0 ? { warnings } : {}),
    ...supersededInfo,
  };

  // A handoff written through `append_memory` bypasses the dedicated
  // `rest({ handoff })` slot (which sets a TTL, can DM the recipient,
  // and supersedes prior handoffs). When other active handoffs
  // already exist, nudge the agent to prune the pile.
  let hint: string | undefined;
  if (kind === HANDOFF_KIND) {
    const others = loadStore(ctx.paths, claimed).entries.filter(
      (e) =>
        e.kind === HANDOFF_KIND &&
        e.status === "active" &&
        e.id !== created.id,
    );
    if (others.length > 0) {
      hint =
        `${others.length} other active handoff${others.length === 1 ? "" : "s"} on file. ` +
        `Handoffs are continuity notes, not durable memory — fade stale ones with ` +
        `\`fade_memory\`, or write handoffs via \`rest({ handoff })\` and pass ` +
        `\`supersedes\` / \`supersede_prior\` to fade superseded ones automatically.`;
    }
  }

  // §16: compact response — don't echo back the text/fields the agent just
  // sent (token waste). Return the server-assigned id + status, a
  // `text_chars` integrity count, and only SERVER-DERIVED values (an
  // auto-derived summary, an auto-set handoff TTL). `verbose: true` returns
  // the full stored entry for debugging / back-compat.
  if (asBoolean(args.verbose) === true) {
    return { ...created, ...warningFields, ...(hint !== undefined ? { hint } : {}) };
  }
  const derived: Record<string, unknown> = {};
  if (summary === undefined && created.summary !== undefined) {
    derived.summary = created.summary;
  }
  if (expiresAtAutoSet && created.expires_at !== undefined) {
    derived.expires_at = created.expires_at;
  }
  // Surface source resolution so an unresolved coordinate isn't silent.
  let sourcesInfo: Record<string, unknown> | undefined;
  if (sources !== undefined && sources.length > 0) {
    sourcesInfo = {
      count: sources.length,
      resolved: sources.filter((s) => s.resolved).length,
    };
  }
  return {
    id: created.id,
    status: created.status,
    text_chars: text.length,
    ...(Object.keys(derived).length > 0 ? { derived } : {}),
    ...(sourcesInfo !== undefined ? { sources: sourcesInfo } : {}),
    ...warningFields,
    ...(hint !== undefined ? { hint } : {}),
  };
};

export const update_memory: Handler = async (args, ctx) => {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError("no_persona", "update_memory requires a claimed persona.");
  }
  const id = asStringRequired(args.id, "id");
  const patch: Record<string, unknown> = {};
  if (asString(args.summary_max240) !== undefined) patch.summary = asString(args.summary_max240);
  if (asString(args.text) !== undefined) patch.text = asString(args.text);
  if (asString(args.kind) !== undefined) patch.kind = asString(args.kind);
  if (asString(args.status) !== undefined) patch.status = asString(args.status);
  if ("replies_to" in args) {
    patch.replies_to = args.replies_to === null ? null : asString(args.replies_to);
  }
  if ("see_also" in args) {
    if (args.see_also === null) {
      patch.see_also = null;
    } else if (Array.isArray(args.see_also)) {
      patch.see_also = args.see_also.filter((v) => typeof v === "string");
    }
  }
  // ── Redesign-v2 patch fields.
  if (asString(args.topic) !== undefined) patch.topic = asString(args.topic);
  if (asBoolean(args.pin) !== undefined) patch.pin = asBoolean(args.pin);
  if (asString(args.pin_reason) !== undefined) patch.pin_reason = asString(args.pin_reason);
  if (asString(args.supersedes) !== undefined) patch.supersedes = asString(args.supersedes);
  if ("due" in args) {
    if (args.due === null) patch.due = null;
    else if (typeof args.due === "number" && Number.isFinite(args.due)) patch.due = args.due;
    else if (args.due === "next-session") patch.due = "next-session";
  }
  // Provenance patch: `null` clears; an array replaces (re-snapshotted).
  if ("sources" in args) {
    patch.sources = args.sources === null ? null : resolveSources(ctx, claimed, args.sources);
  }
  const before = getEntry(ctx.paths, claimed, id);
  const updated = updateEntry(ctx.paths, claimed, id, patch);

  // §16: compact response — report which patch fields actually changed,
  // which were no-ops, and any value the store coerced away from what was
  // requested (e.g. forget→fade, a core-strip), WITHOUT echoing bodies.
  // `verbose: true` returns the full updated entry.
  if (asBoolean(args.verbose) === true) return updated;

  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const u = updated as unknown as Record<string, unknown>;
  const prev = (before ?? {}) as unknown as Record<string, unknown>;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const coerced: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (eq(prev[key], u[key])) unchanged.push(key);
    else changed.push(key);
    // Surface a coercion only when the store landed on a concrete value
    // that differs from what was asked (skip undefined — e.g. `supersedes`
    // is an action, not a stored field). Bodies (text) never go here.
    if (u[key] !== undefined && key !== "text" && !eq(patch[key], u[key])) {
      coerced[key] = u[key];
    }
  }
  return {
    id: updated.id,
    status: updated.status,
    changed,
    unchanged,
    ...(Object.keys(coerced).length > 0 ? { coerced } : {}),
    ...(changed.includes("text") && typeof u.text === "string"
      ? { text_chars: (u.text as string).length }
      : {}),
  };
};

export const set_memory: Handler = async (args, ctx) => {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError("no_persona", "set_memory requires a claimed persona.");
  }
  const text = asStringRequired(args.text, "text");
  const summary = asString(args.summary_max240);
  return setMemory(ctx.paths, claimed, {
    text,
    ...(summary !== undefined ? { summary } : {}),
  });
};

export const recall_memory: Handler = async (args, ctx) => {
  const username = selfUsername(ctx.session.claimedUsername);
  const id = asStringRequired(args.id, "id");
  // `sources` is never auto-returned — surface `has_source` and let the
  // agent fetch provenance via `get_memory_source(id)` when needed.
  return withSourceFlag(recallEntry(ctx.paths, username, id));
};

/** Cross-persona full-text read (deniable by tool name). Unlike
 * self-`recall_memory`, this is strictly READ-ONLY: it must NOT flip a
 * peer's faded entry to active (recallEntry mutates — getEntry does
 * not). Returns the entry's full body as-stored, any tier/status. */
export const recall_memory_any: Handler = async (args, ctx) => {
  const username = asStringRequired(args.username, "username");
  const id = asStringRequired(args.id, "id");
  const entry = getEntry(ctx.paths, username, id);
  if (!entry) {
    throw new ToolError("entry_not_found", `No memory entry '${id}' for '${username}'.`);
  }
  // Same projection as self-recall: provenance via `get_memory_source_any`.
  return withSourceFlag(entry);
};

export const fade_memory: Handler = async (args, ctx) => {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError("no_persona", "fade_memory requires a claimed persona.");
  }
  const id = asStringRequired(args.id, "id");
  return fadeEntry(ctx.paths, claimed, id);
};

/** §4 lifecycle rule: core entries and active reference-kind entries
 * never forget directly — both coerce to `fade`. The data layer
 * enforces the rule regardless of caller (persona, librarian, any
 * future cleanup tool) so the invariant holds without relying on
 * planning-side discipline. Returns `{ entry, coerced, reason? }` so
 * callers see when the action was downgraded. */
export const forget_memory: Handler = async (args, ctx) => {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError("no_persona", "forget_memory requires a claimed persona.");
  }
  const id = asStringRequired(args.id, "id");
  return forgetEntryWithLifecycleCoercion(ctx.paths, claimed, id);
};

function listMemoryFor(
  ctx: HandlerContext,
  username: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const filter: ListIndexFilter = {};
  if (asString(args.status) !== undefined) filter.status = asString(args.status) as never;
  if (asBoolean(args.core) !== undefined) filter.core = asBoolean(args.core)!;
  if (asString(args.kind) !== undefined) filter.kind = asString(args.kind)!;
  if (asString(args.since) !== undefined) filter.since = asString(args.since)!;
  if (asString(args.filter) !== undefined) filter.filter = asString(args.filter)!;
  const entries = listIndex(ctx.paths, username, filter);
  return { username, count: entries.length, entries };
}

export const list_memory: Handler = async (args, ctx) => {
  return listMemoryFor(ctx, selfUsername(ctx.session.claimedUsername), args);
};

/** Cross-persona index listing (deniable by tool name). */
export const list_memory_any: Handler = async (args, ctx) => {
  return listMemoryFor(ctx, asStringRequired(args.username, "username"), args);
};

/** §6 LOW — build a `findMemory` filter from the common query args. */
function findFilterFrom(args: Record<string, unknown>): FindMemoryFilter {
  const filter: FindMemoryFilter = { query: asStringRequired(args.query, "query") };
  if (asString(args.kind) !== undefined) filter.kind = asString(args.kind)!;
  if (asString(args.since) !== undefined) filter.since = asString(args.since)!;
  if (asString(args.status) !== undefined) filter.status = asString(args.status) as never;
  if (asBoolean(args.core) !== undefined) filter.core = asBoolean(args.core)!;
  if (asNumber(args.limit) !== undefined) filter.limit = asNumber(args.limit)!;
  return filter;
}

/** Search the CALLER's own memory for entries matching `query`. Cross-
 * persona search lives in `find_memory_any` (deniable by tool name). */
export const find_memory: Handler = async (args, ctx) => {
  const username = selfUsername(ctx.session.claimedUsername);
  const filter = findFilterFrom(args);
  const hits = findMemory(ctx.paths, [username], filter);
  return { scope: "self", query: filter.query, count: hits.length, hits };
};

/** Search across EVERY registered persona's memory (deniable by tool
 * name). Hits carry `username` so follow-ups route via the `_any`
 * read tools. */
export const find_memory_any: Handler = async (args, ctx) => {
  const filter = findFilterFrom(args);
  const usernames = listPersonas(ctx.paths).map((p) => p.username);
  const hits = findMemory(ctx.paths, usernames, filter);
  return { scope: "all", query: filter.query, count: hits.length, hits };
};

function detailsFor(
  ctx: HandlerContext,
  username: string,
  id: string,
): Record<string, unknown> {
  // Verify the entry exists so we surface a friendlier error than "null".
  const entry = getEntry(ctx.paths, username, id);
  if (!entry) {
    throw new ToolError("entry_not_found", `No memory entry '${id}' for '${username}'.`);
  }
  return { id, username, details: getDetails(ctx.paths, username, id) };
}

export const get_memory_details: Handler = async (args, ctx) => {
  return detailsFor(ctx, selfUsername(ctx.session.claimedUsername), asStringRequired(args.id, "id"));
};

/** Cross-persona details read (deniable by tool name). */
export const get_memory_details_any: Handler = async (args, ctx) => {
  return detailsFor(
    ctx,
    asStringRequired(args.username, "username"),
    asStringRequired(args.id, "id"),
  );
};

/** Provenance read — returns the entry's stored `sources` snapshots (the
 * write-time text + the coordinates for re-verifying via `get_message` /
 * `get_history_message` / `validate_user_quote`). Mirrors
 * `get_memory_details`: the heavy/optional field has its own read path so
 * it's never bundled into the default render or `recall_memory`. */
function sourcesFor(
  ctx: HandlerContext,
  username: string,
  id: string,
): Record<string, unknown> {
  const entry = getEntry(ctx.paths, username, id);
  if (!entry) {
    throw new ToolError("entry_not_found", `No memory entry '${id}' for '${username}'.`);
  }
  return { id, username, sources: entry.sources ?? [] };
}

export const get_memory_source: Handler = async (args, ctx) => {
  return sourcesFor(ctx, selfUsername(ctx.session.claimedUsername), asStringRequired(args.id, "id"));
};

/** Cross-persona provenance read (deniable by tool name) — the audit
 * path for verifying where a peer's memory came from. */
export const get_memory_source_any: Handler = async (args, ctx) => {
  return sourcesFor(
    ctx,
    asStringRequired(args.username, "username"),
    asStringRequired(args.id, "id"),
  );
};

// --- §6 LOW memory snapshots ---

export const snapshot_memory: Handler = async (args, ctx) => {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError("no_persona", "snapshot_memory requires a claimed persona.");
  }
  const label = asStringRequired(args.label, "label");
  return snapshotMemory(ctx.paths, claimed, label);
};

export const restore_memory: Handler = async (args, ctx) => {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError("no_persona", "restore_memory requires a claimed persona.");
  }
  const label = asStringRequired(args.label, "label");
  return restoreMemory(ctx.paths, claimed, label);
};

export const list_snapshots: Handler = async (_args, ctx) => {
  const username = selfUsername(ctx.session.claimedUsername);
  const snapshots = listSnapshots(ctx.paths, username);
  return { username, count: snapshots.length, snapshots };
};

export const delete_snapshot: Handler = async (args, ctx) => {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError("no_persona", "delete_snapshot requires a claimed persona.");
  }
  const label = asStringRequired(args.label, "label");
  const existed = deleteSnapshot(ctx.paths, claimed, label);
  return { label, deleted: existed };
};
