import { stampRested, transitionRestEnter } from "../../identity/index.ts";
import {
  DEFAULT_REST_TIMEOUT_SECONDS,
  MIN_REST_TIMEOUT_SECONDS,
  WatchdogError,
} from "../../watchdog/index.ts";
import {
  asNumber,
  asString,
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
  const sessionId = asString(args.session_id) ?? null;
  transitionRestEnter(ctx.session);
  stampRested(ctx.paths, claimed, reason, sessionId);
  return {
    ok: true,
    rest_reason: reason,
    persona: claimed,
    note: "Session state flipped to resting. Call `exit()` to close the tab.",
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
  ctx.scheduleExit(Math.max(0, delay), "explicit_exit");
  return {
    ok: true,
    delay_seconds: delay,
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
