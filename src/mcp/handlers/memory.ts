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
} from "../../memory/index.ts";
import { listPersonas } from "../../identity/index.ts";
import { getInstructions, INSTRUCTION_TOPICS } from "../../responses/instructions.ts";
import {
  asBoolean,
  asNumber,
  asString,
  asStringRequired,
  type Handler,
  ToolError,
} from "../types.ts";

function targetUsername(args: Record<string, unknown>, claimed: string | null): string {
  const explicit = asString(args.username);
  if (explicit) return explicit;
  if (!claimed) {
    throw new ToolError("no_persona", "No claimed persona; pass `username` or call `claim` first.");
  }
  return claimed;
}

export const get_memory: Handler = async (args, ctx) => {
  const username = targetUsername(args, ctx.session.claimedUsername);
  const includeForgotten = asBoolean(args.include_forgotten) ?? false;
  const onlyCore = asBoolean(args.only_core) ?? false;
  // Render scoped to the topics declared this session (via load_memory).
  // Peer-inspection (`username` of another persona) renders their
  // always-loaded surface only unless topics are passed explicitly.
  const isSelf = username === ctx.session.claimedUsername;
  const rendered = renderForPrompt(ctx.paths, username, {
    include_forgotten: includeForgotten,
    only_core: onlyCore,
    ...(isSelf ? { loaded_topics: ctx.loaded_topics } : {}),
    ...(isSelf && ctx.session_seq !== null ? { session_seq: ctx.session_seq } : {}),
  });
  return {
    username,
    text: rendered.text,
    ...(rendered.warning ? { warning: rendered.warning } : {}),
  };
};

/** §9 / §13 — the topic menu: clustered topics + counts + due-reminder
 * count. Gate-exempt: this is the first call after manifest, before
 * `load_memory`. A fresh persona returns an empty topic list (the
 * dispatcher then skips the load gate). */
export const list_topics: Handler = async (args, ctx) => {
  const username = targetUsername(args, ctx.session.claimedUsername);
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
  const username = targetUsername(args, ctx.session.claimedUsername);
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
  const summary = asString(args.summary);
  const details = asString(args.details);
  const kind = asString(args.kind);
  const core = asBoolean(args.core);
  // `expires_at`: a number sets an explicit TTL. When the field is
  // OMITTED entirely, a `kind: "handoff"` entry auto-gets the 7-day
  // handoff TTL — so a hand-written handoff still fades like one made
  // via `rest({ handoff })`. Passing `expires_at: null` explicitly
  // opts out (no TTL even for a handoff).
  let expiresAt = asNumber(args.expires_at);
  if (
    expiresAt === undefined &&
    !("expires_at" in args) &&
    kind === HANDOFF_KIND
  ) {
    expiresAt = defaultHandoffExpiresAt();
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

  // §12/§17 write-time validation. Warn-only by default; enforcement
  // flips on via PANTHEON_MEMORY_ENFORCE=1 (the P3 "then enforce" step).
  const enforce = process.env.PANTHEON_MEMORY_ENFORCE === "1";
  const warnings = validateWrite(
    {
      text,
      ...(summary !== undefined ? { summary } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(topic !== undefined ? { topic } : {}),
      ...(pin !== undefined ? { pin } : {}),
    },
    { existing: loadStore(ctx.paths, claimed).entries, enforce },
  );

  const created = appendEntry(ctx.paths, claimed, {
    text,
    ...(summary !== undefined ? { summary } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(core !== undefined ? { core } : {}),
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
  if (kind === HANDOFF_KIND) {
    const others = loadStore(ctx.paths, claimed).entries.filter(
      (e) =>
        e.kind === HANDOFF_KIND &&
        e.status === "active" &&
        e.id !== created.id,
    );
    if (others.length > 0) {
      return {
        ...created,
        ...warningFields,
        hint:
          `${others.length} other active handoff${others.length === 1 ? "" : "s"} on file. ` +
          `Handoffs are continuity notes, not durable memory — fade stale ones with ` +
          `\`fade_memory\`, or write handoffs via \`rest({ handoff })\` and pass ` +
          `\`supersedes\` / \`supersede_prior\` to fade superseded ones automatically.`,
      };
    }
  }
  return { ...created, ...warningFields };
};

export const update_memory: Handler = async (args, ctx) => {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError("no_persona", "update_memory requires a claimed persona.");
  }
  const id = asStringRequired(args.id, "id");
  const patch: Record<string, unknown> = {};
  if (asString(args.summary) !== undefined) patch.summary = asString(args.summary);
  if (asString(args.text) !== undefined) patch.text = asString(args.text);
  if ("details" in args) patch.details = args.details === null ? null : asString(args.details);
  if (asString(args.kind) !== undefined) patch.kind = asString(args.kind);
  if (asString(args.status) !== undefined) patch.status = asString(args.status);
  if (asBoolean(args.core) !== undefined) patch.core = asBoolean(args.core);
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
  return updateEntry(ctx.paths, claimed, id, patch);
};

export const set_memory: Handler = async (args, ctx) => {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError("no_persona", "set_memory requires a claimed persona.");
  }
  const text = asStringRequired(args.text, "text");
  const summary = asString(args.summary);
  return setMemory(ctx.paths, claimed, {
    text,
    ...(summary !== undefined ? { summary } : {}),
  });
};

export const recall_memory: Handler = async (args, ctx) => {
  const username = targetUsername(args, ctx.session.claimedUsername);
  const id = asStringRequired(args.id, "id");
  return recallEntry(ctx.paths, username, id);
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

export const list_memory: Handler = async (args, ctx) => {
  const username = targetUsername(args, ctx.session.claimedUsername);
  const filter: ListIndexFilter = {};
  if (asString(args.status) !== undefined) filter.status = asString(args.status) as never;
  if (asBoolean(args.core) !== undefined) filter.core = asBoolean(args.core)!;
  if (asString(args.kind) !== undefined) filter.kind = asString(args.kind)!;
  if (asString(args.since) !== undefined) filter.since = asString(args.since)!;
  if (asString(args.filter) !== undefined) filter.filter = asString(args.filter)!;
  const entries = listIndex(ctx.paths, username, filter);
  return { username, count: entries.length, entries };
};

/** §6 LOW — `find_memory({ query, scope: "self"|"all" })`. Wraps
 * `findMemory` with scope resolution: self uses the caller's
 * claimed persona; all walks every registered persona. Returns
 * union sorted newest-first, capped at `limit` (default 50). */
export const find_memory: Handler = async (args, ctx) => {
  const query = asStringRequired(args.query, "query");
  const scope = (asString(args.scope) ?? "self") as "self" | "all";
  if (scope !== "self" && scope !== "all") {
    throw new ToolError(
      "invalid_argument",
      `find_memory: scope must be 'self' or 'all'; got '${scope}'.`,
    );
  }
  let usernames: string[];
  if (scope === "all") {
    usernames = listPersonas(ctx.paths).map((p) => p.username);
  } else {
    const claimed = ctx.session.claimedUsername;
    if (!claimed) {
      throw new ToolError(
        "no_persona",
        "find_memory({ scope: 'self' }) requires a claimed persona — call `claim` or `manifest` first, or pass scope: 'all'.",
      );
    }
    usernames = [claimed];
  }
  const filter: FindMemoryFilter = { query };
  if (asString(args.kind) !== undefined) filter.kind = asString(args.kind)!;
  if (asString(args.since) !== undefined) filter.since = asString(args.since)!;
  if (asString(args.status) !== undefined) filter.status = asString(args.status) as never;
  if (asBoolean(args.core) !== undefined) filter.core = asBoolean(args.core)!;
  if (asNumber(args.limit) !== undefined) filter.limit = asNumber(args.limit)!;
  const hits = findMemory(ctx.paths, usernames, filter);
  return { scope, query, count: hits.length, hits };
};

export const get_memory_details: Handler = async (args, ctx) => {
  const username = targetUsername(args, ctx.session.claimedUsername);
  const id = asStringRequired(args.id, "id");
  // Verify the entry exists so we surface a friendlier error than "null".
  const entry = getEntry(ctx.paths, username, id);
  if (!entry) {
    throw new ToolError("entry_not_found", `No memory entry '${id}' for '${username}'.`);
  }
  return { id, username, details: getDetails(ctx.paths, username, id) };
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

export const list_snapshots: Handler = async (args, ctx) => {
  const username = targetUsername(args, ctx.session.claimedUsername);
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
