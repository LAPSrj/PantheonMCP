/** Watcher-kind tool surface (A1 — dedicated verb trio, confirmed by
 * Leandro 2026-06-01). See `docs/memory-redesign/6-watcher-kind.md`.
 *
 *   arm_watcher   — write a `kind:"watcher"` entry, binding the arming
 *                   session (owner_agent_id) + canonical persona
 *                   (owner_username) and the re-arm payload.
 *   claim_watcher — atomic CAS re-arm: rebind to the caller iff the
 *                   current owner is orphaned; returns the re-arm payload
 *                   to the winner.
 *   close_watcher — fade the entry when the watch completes (explicit;
 *                   v1 has no auto-eval of the close condition).
 */

import {
  appendEntry,
  claimWatcher,
  fadeEntry,
  getEntry,
  loadStore,
  validateWrite,
  type WatcherMeta,
} from "../../memory/index.ts";
import {
  asBoolean,
  asString,
  asStringRequired,
  type Handler,
  type HandlerContext,
  ToolError,
} from "../types.ts";

function requirePersona(ctx: HandlerContext, tool: string): string {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError(
      "no_persona",
      `${tool} requires a claimed persona — call \`claim\` or \`manifest\` first.`,
    );
  }
  return claimed;
}

/** The arming/claiming session's live chat agent_id. A watcher's whole
 * point is liveness-binding, so it MUST be armed/claimed from a session
 * that is logged into chat (otherwise there's no owner_agent_id to track
 * and no live presence row to compare against). */
function requireAgentId(ctx: HandlerContext, tool: string): string {
  if (!ctx.chat_agent_id) {
    throw new ToolError(
      "not_logged_in",
      `${tool} must run from a session logged into chat — the owner binding is the live session agent_id. Call \`login\` first.`,
    );
  }
  return ctx.chat_agent_id;
}

function asStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? out : undefined;
}

/** Parse + validate the re-arm payload. A watcher must carry enough for a
 * successor to re-arm without archaeology — reject an empty payload. */
function parseRearm(raw: unknown, tool: string): WatcherMeta["rearm"] {
  const out: WatcherMeta["rearm"] = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const crons = asStringArray(o.crons);
    const commands = asStringArray(o.commands);
    const ledger = asString(o.ledger);
    const notes = asString(o.notes);
    if (crons) out.crons = crons;
    if (commands) out.commands = commands;
    if (ledger !== undefined) out.ledger = ledger;
    if (notes !== undefined) out.notes = notes;
  }
  if (
    out.crons === undefined &&
    out.commands === undefined &&
    out.ledger === undefined &&
    out.notes === undefined
  ) {
    throw new ToolError(
      "rearm_empty",
      `${tool}: \`rearm\` must carry enough to re-arm the watch without archaeology — supply at least one of crons / commands / ledger / notes.`,
    );
  }
  return out;
}

function liveSet(ctx: HandlerContext, fallbackAgentId: string): Set<string> {
  const live = ctx.chat?.liveAgentIds();
  if (live && live.size > 0) return live;
  // No chat router wired (in-process tests) — treat the caller as the
  // only live session.
  return new Set([fallbackAgentId]);
}

export const arm_watcher: Handler = async (args, ctx) => {
  const claimed = requirePersona(ctx, "arm_watcher");
  const agentId = requireAgentId(ctx, "arm_watcher");

  const topic = asStringRequired(args.topic, "topic");
  const text = asStringRequired(args.text, "text");
  const summary = asString(args.summary_max240);
  const closeCondition = asString(args.close_condition);

  // Scope: persona (default) is fully wired; project-tier detection is a
  // flagged fast-follow (§4), so reject it explicitly rather than store a
  // binding that won't be enforced.
  const scopeArg = asString(args.scope) ?? "persona";
  if (scopeArg !== "persona" && scopeArg !== "project") {
    throw new ToolError("invalid_scope", "scope must be 'persona' or 'project'.");
  }
  if (scopeArg === "project") {
    throw new ToolError(
      "scope_not_wired",
      "scope:'project' is not wired yet (persona-scoped watchers ship first; project-tier is a flagged fast-follow). Use scope:'persona' or omit.",
    );
  }

  const rearm = parseRearm(args.rearm, "arm_watcher");

  // Reuse the v2 write-time validation (enforced): kind enum, topic
  // required, summary-not-header. Watcher is topic-required, so a missing
  // topic throws here exactly like rule/fact.
  const warnings = validateWrite(
    {
      text,
      kind: "watcher",
      topic,
      ...(summary !== undefined ? { summary } : {}),
    },
    { existing: loadStore(ctx.paths, claimed).entries, enforce: true },
  );

  const watcher: WatcherMeta = {
    owner_agent_id: agentId,
    owner_username: claimed,
    scope: "persona",
    rearm,
    ...(closeCondition !== undefined ? { close_condition: closeCondition } : {}),
    armed_at: Date.now(),
  };

  const created = appendEntry(ctx.paths, claimed, {
    text,
    kind: "watcher",
    topic,
    watcher,
    ...(summary !== undefined ? { summary } : {}),
    ...(ctx.session_seq !== null ? { session_seq: ctx.session_seq } : {}),
  });

  return {
    id: created.id,
    status: created.status,
    owner_agent_id: agentId,
    owner_username: claimed,
    scope: "persona",
    armed_at: watcher.armed_at,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};

export const claim_watcher: Handler = async (args, ctx) => {
  const claimed = requirePersona(ctx, "claim_watcher");
  const agentId = requireAgentId(ctx, "claim_watcher");
  const id = asStringRequired(args.id, "id");

  const res = claimWatcher(
    ctx.paths,
    claimed,
    id,
    agentId,
    liveSet(ctx, agentId),
    Date.now(),
  );

  if (!res.won) {
    if (res.reason === "not_found") {
      throw new ToolError("entry_not_found", `No watcher entry '${id}'.`);
    }
    if (res.reason === "not_watcher") {
      throw new ToolError("not_a_watcher", `Entry '${id}' is not a kind:watcher entry.`);
    }
    // not_orphaned — a sibling already holds it, or it was never orphaned.
    return {
      won: false,
      reason: res.reason,
      id,
      owner_agent_id: res.owner_agent_id,
      note: "A live owner already holds this watch — nothing to re-arm.",
    };
  }

  const w = res.entry!.watcher!;
  return {
    won: true,
    id,
    owner_agent_id: agentId,
    last_rearmed_at: w.last_rearmed_at,
    rearm: w.rearm,
    ...(w.close_condition !== undefined ? { close_condition: w.close_condition } : {}),
    note: "You hold this watch. Recreate the resources in `rearm`, then `close_watcher` when done.",
  };
};

export const close_watcher: Handler = async (args, ctx) => {
  const claimed = requirePersona(ctx, "close_watcher");
  const id = asStringRequired(args.id, "id");
  const entry = getEntry(ctx.paths, claimed, id);
  if (!entry) {
    throw new ToolError("entry_not_found", `No watcher entry '${id}'.`);
  }
  if (entry.kind !== "watcher") {
    throw new ToolError(
      "not_a_watcher",
      `Entry '${id}' is not a kind:watcher entry — use fade_memory for ordinary entries.`,
    );
  }
  const faded = fadeEntry(ctx.paths, claimed, id);
  return {
    id,
    status: faded.status,
    verbose: asBoolean(args.verbose) === true ? faded : undefined,
    note: "Watch closed (faded). recall_memory(id) restores it if it re-opens.",
  };
};
