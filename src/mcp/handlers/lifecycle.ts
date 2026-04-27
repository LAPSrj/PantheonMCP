import { stampRested, transitionRestEnter } from "../../identity/index.ts";
import { recordExit } from "../../launcher/index.ts";
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
  ToolError,
} from "../types.ts";

export const allow_rest: Handler = async (_args, ctx) => {
  ctx.setAllowRest(true);
  return {
    ok: true,
    message:
      "Rest authorized for this non-summoned session. You may now call `rest()` when finished. Save anything future-you needs via `append_memory` first.",
  };
};

export const rest: Handler = async (args, ctx) => {
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
