import {
  appendEntry,
  deleteSnapshot,
  fadeEntry,
  findMemory,
  forgetEntry,
  getDetails,
  getEntry,
  listIndex,
  listSnapshots,
  recallEntry,
  renderForPrompt,
  restoreMemory,
  setMemory,
  snapshotMemory,
  updateEntry,
  type FindMemoryFilter,
  type ListIndexFilter,
} from "../../memory/index.ts";
import { listPersonas } from "../../identity/index.ts";
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
  const rendered = renderForPrompt(ctx.paths, username, {
    include_forgotten: includeForgotten,
    only_core: onlyCore,
  });
  return {
    username,
    text: rendered.text,
    ...(rendered.warning ? { warning: rendered.warning } : {}),
  };
};

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
  const summonerOverride = asString(args.summoner_username);
  const summoner = summonerOverride ?? ctx.summoner_username ?? undefined;
  const repliesTo = asString(args.replies_to);
  const seeAlso = Array.isArray(args.see_also)
    ? (args.see_also.filter((v) => typeof v === "string") as string[])
    : undefined;
  return appendEntry(ctx.paths, claimed, {
    text,
    ...(summary !== undefined ? { summary } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(core !== undefined ? { core } : {}),
    ...(summoner !== undefined ? { summoner_username: summoner } : {}),
    ...(repliesTo !== undefined ? { replies_to: repliesTo } : {}),
    ...(seeAlso !== undefined ? { see_also: seeAlso } : {}),
  });
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

export const forget_memory: Handler = async (args, ctx) => {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError("no_persona", "forget_memory requires a claimed persona.");
  }
  const id = asStringRequired(args.id, "id");
  return forgetEntry(ctx.paths, claimed, id);
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
