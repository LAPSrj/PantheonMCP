import {
  ChatError,
  promoteInPlace,
  type PromoteFields,
} from "../../chat/index.ts";
import { listPersonas } from "../../identity/index.ts";
import { getResponseTemplate } from "../../responses/templates.ts";
import {
  asBoolean,
  asNumber,
  asObject,
  asString,
  asStringArray,
  asStringRequired,
  type Handler,
  ToolError,
} from "../types.ts";

function requireRouter(ctx: Parameters<Handler>[1]) {
  if (!ctx.chat) {
    throw new ToolError(
      "chat_unavailable",
      "Chat router is not attached to this context. Did the MCP server boot fail to wire it?",
    );
  }
  return ctx.chat;
}

export const login: Handler = async (args, ctx) => {
  const username = asStringRequired(args.username, "username");
  const project = asStringRequired(args.project, "project");
  const status = asString(args.status) ?? "";
  const transient = asBoolean(args.transient) ?? false;
  const promote = asObject(args.promote);
  const router = requireRouter(ctx);

  // §10 / §11c persona-owner-allowed: when the caller has already
  // claimed this handle as a persona, the chat-add must accept it
  // (otherwise registered personas can never join chat under their
  // own name — the original bug E2E surfaced).
  const claimedPersona = ctx.session.claimedUsername;
  // The MCP server's request handler injects `supports_channels`
  // into args after detecting `claude/channel` experimental
  // capability on the client. Plumb to the subscriber so the
  // dispatch path can branch between channel push and the Monitor
  // watcher fallback.
  const supportsChannels = asBoolean(args.supports_channels) ?? false;
  let subscriber;
  try {
    subscriber = router.add({
      username,
      project,
      transient,
      status,
      supports_channels: supportsChannels,
      ...(claimedPersona === username ? { claimed_persona: claimedPersona } : {}),
    });
  } catch (err) {
    // Enrich `username_taken` (and the related `already_registered` /
    // `username_prefix_collision`) with structured remediation
    // options so the caller (a spawned agent's bootstrap, typically)
    // has a clear next-step instead of being a zombie pane.
    //
    // We DO NOT auto-evict the existing session — that other session
    // may be load-bearing. Three options:
    //   1. close the OTHER session
    //   2. close THIS pane
    //   3. re-summon with --chat-username-suffix to pick a numbered alias
    //
    // `suggested_suffix` is the next free `<base><N>` so the caller
    // can act on option 3 without a probe round trip.
    const e = err as { code?: string; message?: string; extra?: Record<string, unknown> };
    const code = e.code ?? "";
    if (
      code === "username_taken" ||
      code === "already_registered" ||
      code === "username_prefix_collision"
    ) {
      const baseForSuffix = (e.extra?.["conflicting"] as string | undefined) ?? username;
      const suggestedSuffix = router.nextAvailableIncarnation(baseForSuffix, {
        ...(claimedPersona ? { claimed_persona: claimedPersona } : {}),
      });
      throw new ToolError(
        code,
        `Cannot log into chat as '${username}': ${e.message}`,
        {
          ...(e.extra ?? {}),
          options: [
            `Close the OTHER session (the one already chatting as '${username}'), then retry login from this pane.`,
            "Close THIS pane if the other session is the intended one.",
            suggestedSuffix
              ? `Re-summon this persona with \`--chat-username-suffix ${suggestedSuffix.slice(baseForSuffix.length)}\` (or \`--chat-username-suffix auto\`) to chat as '${suggestedSuffix}' — your persona identity stays canonical.`
              : "Re-summon this persona with `--chat-username-suffix <N>` to chat under a numbered alias.",
          ],
          ...(suggestedSuffix ? { suggested_suffix: suggestedSuffix } : {}),
          do_not_auto_logout:
            "DO NOT call `logout` — that would evict the other session, which may be doing real work.",
        },
      );
    }
    throw err;
  }
  // Bind this MCP session to the new chat subscriber so subsequent
  // chat handlers (send_message, ask, set_mode, …) can resolve it
  // without re-authenticating.
  ctx.setChatAgentId(subscriber.agent_id);

  // Tombstone reclaim broadcast (§10 / §11c).
  router.consumeTombstoneAndBroadcast(username, subscriber.agent_id);

  // Broadcast `join` system event to project scope.
  router.addMessage({
    from_agent_id: "system",
    scope: "project",
    project,
    text: `${username}${transient ? "*" : ""} joined ${project}.`,
    system: true,
    system_kind: "join",
    system_actor: "system",
  });

  let promoted = false;
  if (promote && transient) {
    const fields: PromoteFields = {
      project: asStringRequired(promote.project, "promote.project"),
      description: asStringRequired(promote.description, "promote.description"),
      expertise: asStringArray(promote.expertise) ?? [],
      owns: asStringArray(promote.owns) ?? [],
      ...(asString(promote.cwd) !== undefined ? { cwd: asString(promote.cwd)! } : {}),
    };
    promoteInPlace({
      paths: ctx.paths,
      router,
      agent_id: subscriber.agent_id,
      fields,
      default_cwd: process.cwd(),
      platform: ctx.platform,
    });
    promoted = true;
  }

  // §6 HIGH stale-MCP-proxy mitigation: pull the login note from
  // daemon-resolved templates so a daemon restart picks up edits.
  // When channels are enabled, swap to the channels-enabled template
  // so the agent doesn't pointlessly start a Monitor watcher.
  let note: string;
  const noteTemplate = supportsChannels ? "login-note-channels" : "login-note";
  try {
    note = getResponseTemplate(noteTemplate, {
      agent_id: subscriber.agent_id,
      username: subscriber.username,
      project: subscriber.project,
    });
  } catch {
    note = supportsChannels
      ? `Logged in as ${subscriber.username}. Channels ARE enabled — peer messages arrive inline as <channel source="pantheon" ...>...</channel> tags. No watcher needed.`
      : `Logged in as ${subscriber.username}. ` +
        `Run pantheon-fetch --agent-id ${subscriber.agent_id} --loop to start the watcher.`;
  }
  return {
    ok: true,
    agent_id: subscriber.agent_id,
    username: subscriber.username,
    project: subscriber.project,
    transient: subscriber.transient,
    channels_enabled: supportsChannels,
    promoted,
    note,
  };
};

export const logout: Handler = async (_args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = ctx.chat_agent_id;
  if (!agentId) {
    return { ok: false, error: "not_logged_in" };
  }
  const removed = router.remove(agentId);
  if (removed) {
    router.addMessage({
      from_agent_id: "system",
      scope: "project",
      project: removed.project,
      text: `${removed.username}${removed.transient ? "*" : ""} left ${removed.project}.`,
      system: true,
      system_kind: "leave",
      system_actor: "system",
    });
  }
  ctx.setChatAgentId(null);
  return { ok: true, removed: removed?.username ?? null };
};

/** Bumped from 15→60min per Yapsmith's revamp: the staleness nudge
 * was the engine of the over-broadcast pattern (52 status updates
 * from one agent in ~31h, ~5min cadence). Lengthening the threshold
 * + softening the copy is the lever — peers see current status via
 * `list_agents` so the nudge isn't load-bearing for visibility. */
export const STATUS_STALE_MS = 60 * 60 * 1000;

export const send_message: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const text = asStringRequired(args.text, "text");
  const scope = (asString(args.scope) ?? "project") as "project" | "dm" | "global";
  const target = asString(args.target);
  const replyTo = asString(args.reply_to);
  if (scope === "dm" && !target) {
    throw new ChatError("missing_target", "scope='dm' requires a target username.");
  }
  const msg = router.addMessage({
    from_agent_id: agentId,
    scope,
    text,
    ...(target !== undefined ? { target } : {}),
    ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
  });
  // Optional staleness nudge — surfaces in the response `hints` field
  // when the sender's status hasn't changed in STATUS_STALE_MS. Copy
  // is intentionally TOPIC-vs-sub-task framing so it doesn't pull
  // agents into the per-step changelog anti-pattern the original
  // 15-min nudge produced.
  const hints: string[] = [];
  const me = router.getByAgentId(agentId);
  if (me) {
    const elapsed = Date.now() - me.status_updated_at;
    if (elapsed >= STATUS_STALE_MS) {
      const minutes = Math.round(elapsed / 60_000);
      hints.push(
        `Status unchanged for ${minutes}m. Update only if your TOPIC has shifted ` +
          `('Building auth' → 'Reviewing infra'), not for sub-tasks within the same topic. ` +
          `Otherwise leave it; peers see it via list_agents.`,
      );
    }
  }
  return {
    ok: true,
    message_id: msg.id,
    seq: msg.seq,
    mentions: msg.mentions,
    ...(hints.length > 0 ? { hints } : {}),
  };
};

export const ask: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const target = asStringRequired(args.target, "target");
  const text = asStringRequired(args.text, "text");
  const timeoutMs = asNumber(args.timeout_ms) ?? 30_000;
  const result = await router.ask({
    from_agent_id: agentId,
    target_username: target,
    text,
    timeout_ms: timeoutMs,
  });
  // AskResult is already a discriminated union — answered vs timeout
  // (with reason). Surface the shape directly so callers can branch
  // on `status` + `reason`.
  if (result.status === "timeout") {
    return { status: "timeout", reason: result.reason, target };
  }
  return result;
};

export const answer: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const correlationId = asStringRequired(args.correlation_id, "correlation_id");
  const text = asStringRequired(args.text, "text");
  const msg = router.answer({
    from_agent_id: agentId,
    correlation_id: correlationId,
    text,
  });
  return { ok: true, message_id: msg.id };
};

export const set_mode: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const mode = asStringRequired(args.mode, "mode") as "all" | "quiet" | "project" | "dm";
  router.setMode(agentId, mode);
  return { mode };
};

/** 10-minute topic cooldown — per Yapsmith's chat-mcp revamp,
 * back-to-back status changes are rejected unless `confirmed: true`.
 * The rejection is the prompt to re-evaluate ("topic shift or
 * sub-task?") rather than a hard ban. */
export const STATUS_TOPIC_COOLDOWN_MS = 10 * 60 * 1000;

export const update_status: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const patch: { status?: string; project?: string; username?: string } = {};
  const status = asString(args.status);
  const project = asString(args.project);
  const username = asString(args.username);
  const confirmed = asBoolean(args.confirmed) ?? false;
  if (status !== undefined) patch.status = status;
  if (project !== undefined) patch.project = project;
  if (username !== undefined) patch.username = username;

  // Topic-cooldown gate: when the caller is changing status (not just
  // renaming/switching project, not idempotent, and there was a prior
  // user-set status to begin with), reject if the prior status was
  // set within the cooldown window. `confirmed: true` bypasses
  // ("I read the rejection and this really IS a topic shift").
  // Empty prev.status (login-default) skips — the first real status
  // is never a "rapid re-update."
  if (status !== undefined && !confirmed) {
    const prev = router.getByAgentId(agentId);
    if (prev && prev.status !== "" && prev.status !== status) {
      const elapsed = Date.now() - prev.status_updated_at;
      if (elapsed < STATUS_TOPIC_COOLDOWN_MS) {
        const remaining = STATUS_TOPIC_COOLDOWN_MS - elapsed;
        const elapsedMin = Math.round(elapsed / 60_000);
        const remainingSec = Math.round(remaining / 1000);
        throw new ToolError(
          "topic_cooldown_active",
          `topic_cooldown_active: status was last updated ${elapsedMin}m ago. ` +
            `update_status is for TOPIC shifts (e.g., "Building auth" → "Reviewing infra"), ` +
            `not for sub-tasks within the same topic. If this really is a new topic, ` +
            `re-call with confirmed:true. Otherwise leave the previous status — peers see it ` +
            `via list_agents. Cooldown ends in ~${remainingSec}s.`,
          {
            previous_status: prev.status,
            previous_status_updated_at: prev.status_updated_at,
            cooldown_remaining_ms: remaining,
          },
        );
      }
    }
  }

  const sub = router.update(agentId, patch);
  // Per Yapsmith's revamp: do NOT addMessage(system_kind: "status_update")
  // here. Status changes accumulate via markStatusChanged and get
  // batched into the periodic status_digest sweep (daemon-tick).
  if (patch.status !== undefined) {
    router.markStatusChanged(agentId);
  }
  return {
    username: sub.username,
    project: sub.project,
    status: sub.status,
  };
};

export const check_messages: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const limit = asNumber(args.limit) ?? 50;
  // §11c cross-process: checkMessages reads SQLite via the persisted
  // chat_cursor when a db is wired; falls back to the in-memory
  // recent buffer for in-process-only test routers.
  const result = router.checkMessages(agentId, limit);
  return {
    count: result.messages.length,
    more: result.more,
    messages: result.messages.map((m) => ({
      id: m.id,
      ts: m.ts,
      scope: m.scope,
      from_agent_id: m.from_agent_id,
      from_username_inline: m.from_username_inline ?? null,
      target: m.target ?? null,
      text: m.text,
      mentions: m.mentions,
      system_kind: m.system_kind ?? null,
      ask_id: m.ask_id ?? null,
      in_reply_to_ask: m.in_reply_to_ask ?? null,
    })),
  };
};

export const list_agents: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const project = asString(args.project);
  const list = router.publicList(project);
  return {
    count: list.length,
    agents: list,
  };
};

export const find_role: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const owns = asString(args.owns)?.toLowerCase();
  const expertise = asString(args.expertise)?.toLowerCase();
  const onlineOnly = asBoolean(args.online) ?? false;

  const personas = listPersonas(ctx.paths);
  // Use the cross-process presence snapshot; falls back to the
  // in-memory router map when no SQLite db is wired (test harnesses).
  const onlineUsernames = router.onlineUsernames();

  const filtered = personas.filter((p) => {
    if (onlineOnly && !onlineUsernames.has(p.username.toLowerCase())) return false;
    if (owns && !p.owns.some((o) => o.toLowerCase().includes(owns))) return false;
    if (expertise && !p.expertise.some((e) => e.toLowerCase().includes(expertise))) {
      return false;
    }
    return true;
  });

  return {
    count: filtered.length,
    personas: filtered.map((p) => ({
      username: p.username,
      project: p.project,
      description: p.description,
      expertise: p.expertise,
      owns: p.owns,
      online: onlineUsernames.has(p.username.toLowerCase()),
    })),
  };
};

function requireAgentId(ctx: Parameters<Handler>[1]): string {
  if (!ctx.chat_agent_id) {
    throw new ToolError(
      "not_logged_in",
      "This call requires a chat session — `login` first.",
    );
  }
  return ctx.chat_agent_id;
}
