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

  const subscriber = router.add({ username, project, transient, status });
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
  let note: string;
  try {
    note = getResponseTemplate("login-note", {
      agent_id: subscriber.agent_id,
      username: subscriber.username,
      project: subscriber.project,
    });
  } catch {
    note =
      `Logged in as ${subscriber.username}. ` +
      `Run pantheon-fetch --agent-id ${subscriber.agent_id} --loop to start the watcher.`;
  }
  return {
    ok: true,
    agent_id: subscriber.agent_id,
    username: subscriber.username,
    project: subscriber.project,
    transient: subscriber.transient,
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
  return {
    ok: true,
    message_id: msg.id,
    seq: msg.seq,
    mentions: msg.mentions,
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
  if (result === null) {
    return {
      status: "timeout",
      reason: "respondent_disconnected_or_no_response",
      target,
    };
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

export const update_status: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const patch: { status?: string; project?: string; username?: string } = {};
  const status = asString(args.status);
  const project = asString(args.project);
  const username = asString(args.username);
  if (status !== undefined) patch.status = status;
  if (project !== undefined) patch.project = project;
  if (username !== undefined) patch.username = username;
  const sub = router.update(agentId, patch);
  if (patch.status !== undefined) {
    router.addMessage({
      from_agent_id: "system",
      scope: "project",
      project: sub.project,
      text: `${sub.username}: ${sub.status}`,
      system: true,
      system_kind: "status_update",
      system_actor: sub.username,
    });
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
  const result = router.takeMessages(agentId, limit);
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
