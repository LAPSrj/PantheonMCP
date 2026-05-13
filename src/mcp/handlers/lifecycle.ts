import { listActive } from "../../chat/index.ts";
import { stampRested, transitionRestEnter } from "../../identity/index.ts";
import { recordExit } from "../../launcher/index.ts";
import {
  consumePendingRestRequests,
  writeRestRequest,
  type RestRequestKind,
} from "../../lifecycle/index.ts";
import { appendEntry, buildHandoffSeed } from "../../memory/index.ts";
import {
  DEFAULT_REST_TIMEOUT_SECONDS,
  MIN_REST_TIMEOUT_SECONDS,
  WatchdogError,
} from "../../watchdog/index.ts";
import {
  asNumber,
  asObject,
  asString,
  asStringRequired,
  type Handler,
  type HandlerContext,
  ToolError,
} from "../types.ts";

/** Self-exit gate. Returns the structured rejection payload when the
 * spawning summoner set `block_self_exit: true` (delivered as
 * `PANTHEON_BLOCK_SELF_EXIT=1` in the spawned process's env, captured
 * onto ctx at boot). When the gate is open, returns null and the
 * caller proceeds.
 *
 * Watchdog-driven rest still fires (deadline callback bypasses this
 * — it's the runtime, not the agent). Peer `force_rest` /
 * `force_exit` write to the rest_requests table and the prune-tick
 * consumer also bypasses this gate. */
function selfExitBlocked(
  ctx: HandlerContext,
  who: "rest" | "exit" | "logout",
): Record<string, unknown> | null {
  if (!ctx.block_self_exit) return null;
  const summoner = ctx.summoner_username ?? "your summoner";
  return {
    error: "self_exit_blocked",
    message:
      `\`${who}\` blocked: this session was summoned with block_self_exit=true. ` +
      `Only ${summoner} (or any peer via force_${who === "logout" ? "rest" : who}) can release you. ` +
      `Coordinate via chat. The watchdog rest_timeout will still fire if you go fully idle.`,
    summoner_username: ctx.summoner_username,
  };
}

export const allow_rest: Handler = async (_args, ctx) => {
  ctx.setAllowRest(true);
  return {
    ok: true,
    message:
      "Rest authorized for this non-summoned session. You may now call `rest()` when finished. Save anything future-you needs via `append_memory` first.",
  };
};

export const rest: Handler = async (args, ctx) => {
  const blocked = selfExitBlocked(ctx, "rest");
  if (blocked) return blocked;
  const summoned = ctx.summoner_username !== null;
  if (!summoned && !ctx.allow_rest_authorized) {
    throw new ToolError(
      "rest_not_authorized",
      "Non-summoned sessions must call `allow_rest()` first (the user should have authorized it).",
    );
  }
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError("no_persona", "rest requires a claimed persona.");
  }
  const reason = asString(args.reason) ?? "explicit_rest";
  // session_id cascade: explicit caller arg > MCP-boot-captured CC
  // session UUID > null. Stamping the id is what makes a later
  // `summon --resume` actually resume this conversation; the
  // ctx-fallback means agents don't have to know their own UUID.
  const sessionId =
    asString(args.session_id) ?? ctx.claude_session_id ?? null;

  // §6 MEDIUM idle-handoff slot — write a `kind: "handoff"` memory
  // entry with a 7-day TTL, optionally DM the target. Best-effort
  // atomicity: write the memory entry first; if the optional DM
  // fails, surface a `handoff_warnings` field but leave the memory
  // entry in place (it's the durable record the future agent
  // recall_memory's). The handoff entry is always written before
  // session state flips so a recall after this call sees it.
  const handoff = asObject(args.handoff);
  let handoff_entry_id: string | null = null;
  let handoff_dm_message_id: string | null = null;
  const handoff_warnings: string[] = [];
  if (handoff) {
    const handoffFor = asStringRequired(handoff.for, "handoff.for");
    const handoffText = asStringRequired(handoff.text, "handoff.text");
    try {
      const seed = buildHandoffSeed(handoffFor, handoffText);
      const entry = appendEntry(ctx.paths, claimed, seed);
      handoff_entry_id = entry.id;
    } catch (err) {
      handoff_warnings.push(`handoff_memory: ${(err as Error).message}`);
    }

    // Optional DM. Skipped when no chat session is bound (the
    // current MCP session hasn't logged in to chat). When ctx.chat
    // is wired, attempt the DM; surface failure as a warning.
    if (ctx.chat && ctx.chat_agent_id) {
      try {
        const msg = ctx.chat.addMessage({
          from_agent_id: ctx.chat_agent_id,
          scope: "dm",
          target: handoffFor,
          text: handoffText,
        });
        handoff_dm_message_id = msg.id;
      } catch (err) {
        handoff_warnings.push(`handoff_dm: ${(err as Error).message}`);
      }
    } else if (ctx.chat) {
      handoff_warnings.push(
        `handoff_dm: no chat session bound (call \`login\` to enable DMs).`,
      );
    }
  }

  transitionRestEnter(ctx.session);
  stampRested(ctx.paths, claimed, reason, sessionId);
  return {
    ok: true,
    rest_reason: reason,
    persona: claimed,
    note: "Session state flipped to resting. Call `exit()` to close the tab.",
    ...(handoff_entry_id !== null ? { handoff_entry_id } : {}),
    ...(handoff_dm_message_id !== null ? { handoff_dm_message_id } : {}),
    ...(handoff_warnings.length > 0 ? { handoff_warnings } : {}),
  };
};

export const extend_rest: Handler = async (args, ctx) => {
  const minutes = asNumber(args.minutes);
  if (minutes === undefined || minutes <= 0) {
    throw new ToolError("invalid_argument", "`minutes` must be a positive number.");
  }
  const seconds = Math.max(MIN_REST_TIMEOUT_SECONDS, Math.floor(minutes * 60));
  try {
    ctx.watchdog.setTimeout(ctx.session.id, seconds);
  } catch (err) {
    if (err instanceof WatchdogError) {
      throw new ToolError(err.code, err.message);
    }
    throw err;
  }
  return {
    ok: true,
    rest_timeout_seconds: seconds,
    note:
      seconds === DEFAULT_REST_TIMEOUT_SECONDS
        ? "Watchdog rearmed at the 60-minute default."
        : `Watchdog rearmed; next deadline ${seconds}s from now.`,
  };
};

export const exit: Handler = async (args, ctx) => {
  const blocked = selfExitBlocked(ctx, "exit");
  if (blocked) return blocked;
  const delay = asNumber(args.delay_seconds) ?? 2;
  // Teardown: clear the watchdog timer for this session so the daemon
  // doesn't fire onDeadline mid-shutdown.
  try {
    ctx.watchdog.unregister(ctx.session.id);
  } catch {
    // best-effort
  }
  // Window registry decrement: when this MCP server was spawned by a
  // `summon`, drop the tabCount so the registry reflects reality. No-op
  // for non-summoned sessions (spawn_metadata is null).
  let registry_decremented = false;
  if (ctx.spawn_metadata) {
    try {
      recordExit(ctx.paths, ctx.spawn_metadata.window_name);
      registry_decremented = true;
    } catch {
      // best-effort
    }
  }
  ctx.scheduleExit(Math.max(0, delay), "explicit_exit");
  return {
    ok: true,
    delay_seconds: delay,
    registry_decremented,
    note: "SIGTERM scheduled. Watchdog cleared. Goodbye.",
  };
};

// --- Cross-session force_rest / force_exit ---

interface ForceLifecycleResolved {
  agent_id: string;
  username: string;
  project: string;
}

/** Resolve target_username OR target_agent_id to a live presence row.
 * Throws ToolError on bad args / offline target. */
function resolveForceTarget(
  args: Record<string, unknown>,
  ctx: HandlerContext,
): { resolved: ForceLifecycleResolved; chatDb: NonNullable<ReturnType<NonNullable<HandlerContext["chat"]>["chatDb"]>> } {
  const target_username = asString(args.target_username);
  const target_agent_id = asString(args.target_agent_id);
  // Exactly-one check: XOR.
  const haveUsername = target_username !== undefined && target_username.length > 0;
  const haveAgentId = target_agent_id !== undefined && target_agent_id.length > 0;
  if (haveUsername === haveAgentId) {
    throw new ToolError(
      "invalid_argument",
      "Provide exactly one of `target_username` or `target_agent_id` (not both, not neither).",
    );
  }
  if (!ctx.chat) {
    throw new ToolError(
      "chat_unavailable",
      "force_rest / force_exit require a chat router (no router wired in this context).",
    );
  }
  const chatDb = ctx.chat.chatDb();
  if (!chatDb) {
    throw new ToolError(
      "chat_unavailable",
      "force_rest / force_exit require a SQLite-backed chat router (in-memory router has no IPC channel).",
    );
  }
  const rows = listActive(chatDb);
  let row: ForceLifecycleResolved | undefined;
  if (haveAgentId) {
    const found = rows.find((r) => r.agent_id === target_agent_id);
    if (found) {
      row = { agent_id: found.agent_id, username: found.username, project: found.project };
    }
  } else {
    const found = rows.find((r) => r.username === target_username);
    if (found) {
      row = { agent_id: found.agent_id, username: found.username, project: found.project };
    }
  }
  if (!row) {
    throw new ToolError(
      "target_offline",
      haveAgentId
        ? `No live agent with agent_id '${target_agent_id}'. Targets must be online to receive a force_${"rest" /* placeholder */} request.`
        : `No live agent with username '${target_username}'. Targets must be online to receive a force-lifecycle request.`,
    );
  }
  return { resolved: row, chatDb };
}

async function performForceLifecycle(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  kind: RestRequestKind,
  options: { any_project: boolean },
): Promise<Record<string, unknown>> {
  const { resolved, chatDb } = resolveForceTarget(args, ctx);

  // Same-project guard for the non-_any variants. The caller's project
  // comes from their own chat subscriber row; if they're not logged
  // in, refuse — same-project guard is undefined without a caller
  // project.
  if (!options.any_project) {
    const callerSub = ctx.chat_agent_id
      ? ctx.chat?.getByAgentId(ctx.chat_agent_id) ?? null
      : null;
    if (!callerSub) {
      throw new ToolError(
        "not_logged_in",
        "Caller must be logged in to chat (same-project guard needs caller's project). Login first or use the `_any` variant.",
      );
    }
    if (callerSub.project !== resolved.project) {
      throw new ToolError(
        "cross_project_blocked",
        `Target '${resolved.username}' is in project '${resolved.project}', caller is in '${callerSub.project}'. Use force_${kind}_any to bypass.`,
      );
    }
  }

  const reason = asString(args.reason) ?? null;
  const fromAgentId = ctx.chat_agent_id ?? null;
  const id = writeRestRequest(chatDb, {
    target_agent_id: resolved.agent_id,
    from_agent_id: fromAgentId,
    kind,
    reason,
  });

  return {
    ok: true,
    request_id: id,
    target_agent_id: resolved.agent_id,
    target_username: resolved.username,
    target_project: resolved.project,
    kind,
    note: `Wrote force-${kind} request for ${resolved.username} (${resolved.agent_id}). The target's pantheon server consumes pending rows on its next 30s prune tick.`,
  };
}

export const force_rest: Handler = async (args, ctx) =>
  performForceLifecycle(args, ctx, "rest", { any_project: false });

export const force_exit: Handler = async (args, ctx) =>
  performForceLifecycle(args, ctx, "exit", { any_project: false });

export const force_rest_any: Handler = async (args, ctx) =>
  performForceLifecycle(args, ctx, "rest", { any_project: true });

export const force_exit_any: Handler = async (args, ctx) =>
  performForceLifecycle(args, ctx, "exit", { any_project: true });

// --- Force-rest consumer (called from the prune tick) ---

/** Apply the rest pipeline directly — bypasses the self-rest
 * preconditions (block_self_exit, allow_rest_authorized, summoned).
 * The force-* request IS the authorization.
 *
 * Also drops the chat subscriber row so the target vanishes from
 * `list_agents`. Without this step the target's chat watcher would
 * keep heartbeating (it runs in a separate CC `Monitor` task, not in
 * this MCP process), `pruneStale`'s 60s TTL would never expire, and
 * `list_agents` would show the rested agent as live indefinitely.
 * Removing the subscriber row causes the watcher's next refresh to
 * surface `SessionExpiredError`, terminating the loop cleanly.
 * Self-`rest` deliberately does NOT do this — agents resting
 * themselves remain DM-able and can resume. Force-rest is asymmetric
 * because the peer/admin's intent is "make this agent go away."
 *
 * Symmetric with logout: emits a system "left" message into the
 * project so peers see the eviction in their chat. */
function applyForceRest(ctx: HandlerContext, reason: string): void {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) return; // can't rest without a claimed persona
  try {
    transitionRestEnter(ctx.session);
  } catch {
    // session already resting — idempotent no-op.
  }
  try {
    stampRested(ctx.paths, claimed, reason, ctx.claude_session_id ?? null);
  } catch {
    // best-effort
  }
  // Drop chat presence so the watcher terminates and list_agents
  // stops surfacing the rested agent.
  if (ctx.chat && ctx.chat_agent_id) {
    const agentId = ctx.chat_agent_id;
    try {
      const removed = ctx.chat.remove(agentId);
      if (removed) {
        try {
          ctx.chat.addMessage({
            from_agent_id: "system",
            scope: "project",
            project: removed.project,
            text: `${removed.username}${removed.transient ? "*" : ""} was force-rested.`,
            system: true,
            system_kind: "leave",
          });
        } catch {
          // best-effort — the eviction already happened.
        }
      }
    } catch {
      // best-effort
    }
    ctx.setChatAgentId(null);
  }
}

/** Apply the exit pipeline directly. Schedules SIGTERM with the
 * default delay; bypasses the block_self_exit gate (force-exit IS
 * the override).
 *
 * Symmetric with `applyForceRest`: drops the chat presence row +
 * clears `ctx.chat_agent_id` BEFORE scheduling SIGTERM, so peers
 * see the target leave immediately rather than waiting ~60s for
 * the prune-grace to expire after the heartbeat stops. Closes the
 * canonical-handle reclaim race for remanifest (an auto-suffixed
 * NEW session can reclaim canonical on its next prune-tick instead
 * of waiting for OLD's row to age out of SQLite). */
function applyForceExit(ctx: HandlerContext): void {
  try {
    ctx.watchdog.unregister(ctx.session.id);
  } catch {
    // best-effort
  }
  if (ctx.spawn_metadata) {
    try {
      recordExit(ctx.paths, ctx.spawn_metadata.window_name);
    } catch {
      // best-effort
    }
  }
  // Drop chat presence synchronously so the target disappears from
  // peer views the moment force-exit is consumed, not 60s later when
  // pruneStale finally evicts the stale row. Heartbeat scheduler
  // checks `subscribers.has(id)` before upserting, so removing the
  // in-memory subscriber prevents the row from being re-inserted in
  // the ~2s window before SIGTERM lands.
  if (ctx.chat && ctx.chat_agent_id) {
    const agentId = ctx.chat_agent_id;
    try {
      const removed = ctx.chat.remove(agentId);
      if (removed) {
        try {
          ctx.chat.addMessage({
            from_agent_id: "system",
            scope: "project",
            project: removed.project,
            text: `${removed.username}${removed.transient ? "*" : ""} was force-exited.`,
            system: true,
            system_kind: "leave",
          });
        } catch {
          // best-effort — the eviction already happened.
        }
      }
    } catch {
      // best-effort
    }
    ctx.setChatAgentId(null);
  }
  ctx.scheduleExit(2, "force_exit");
}

/** Consume any pending force_rest / force_exit requests addressed to
 * this session's chat agent_id and apply them. Called from the
 * server's 30s prune tick. No-op when not logged in to chat or when
 * the chat router has no SQLite backing. */
export function consumeForceLifecycleRequests(ctx: HandlerContext): {
  consumed: number;
  rested: boolean;
  exiting: boolean;
} {
  const result = { consumed: 0, rested: false, exiting: false };
  const agentId = ctx.chat_agent_id;
  if (!agentId || !ctx.chat) return result;
  const db = ctx.chat.chatDb();
  if (!db) return result;
  const requests = consumePendingRestRequests(db, agentId);
  if (requests.length === 0) return result;
  result.consumed = requests.length;
  for (const req of requests) {
    const reasonText =
      `force_${req.kind}` +
      (req.from_agent_id ? `_from_${req.from_agent_id}` : "") +
      (req.reason ? `: ${req.reason}` : "");
    if (req.kind === "rest") {
      applyForceRest(ctx, reasonText);
      result.rested = true;
    } else if (req.kind === "exit") {
      applyForceExit(ctx);
      result.exiting = true;
      // Once we've scheduled an exit, further requests are moot.
      break;
    }
  }
  return result;
}

// --- Legacy `idle` aliases (deprecated; one-release migration window) ---

export const allow_idle: Handler = async (_args, ctx) => {
  const result = await allow_rest(_args, ctx);
  return {
    ...(result as object),
    deprecation:
      "`allow_idle` is deprecated; the canonical name is `allow_rest`. This alias is retained for one release.",
  };
};

export const idle: Handler = async (args, ctx) => {
  const result = await rest(args, ctx);
  return {
    ...(result as object),
    deprecation:
      "`idle` is deprecated; the canonical name is `rest`. This alias is retained for one release.",
  };
};

export const extend_idle: Handler = async (args, ctx) => {
  const result = await extend_rest(args, ctx);
  return {
    ...(result as object),
    deprecation:
      "`extend_idle` is deprecated; the canonical name is `extend_rest`. This alias is retained for one release.",
  };
};
