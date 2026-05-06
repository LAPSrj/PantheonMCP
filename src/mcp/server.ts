import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_REST_TIMEOUT_SECONDS,
  defaultOnDeadline,
} from "../watchdog/index.ts";
import { stampRested, transitionClaim } from "../identity/index.ts";
import { ChatRouter, pruneStale } from "../chat/index.ts";
import { expireHandoffs } from "../memory/index.ts";
import { openChatDb, resolvePaths } from "../storage/index.ts";
import {
  isContextCheckDisabled,
  parseThresholdsFromEnv,
} from "../cli/context-thresholds.ts";
import {
  deleteRuntimeFiles,
  ensureStopHookWrapper,
  readClaudeSessionId,
  writeRuntimeEnv,
} from "../cli/runtime-bridge.ts";
import { createContext } from "./context.ts";
import { dispatch } from "./dispatch.ts";
import { HookPoller, sweepStaleSessionDirs } from "./hook-poller.ts";
import { TOOLS } from "./tools.ts";

export interface ServerOptions {
  /** Override at boot for tests or sandboxed runs. */
  context?: ReturnType<typeof createContext>;
}

/** Vanilla MCP entry point. Spawned per-conversation by Claude Code (or
 * any MCP client) over stdio. */
export async function runMcpServer(options: ServerOptions = {}): Promise<void> {
  const summoner = process.env.PANTHEON_SUMMONER ?? null;
  const spawnMetadata = readSpawnMetadataFromEnv();
  const paths = resolvePaths();
  // Capture the real CC session UUID at boot so `rest` can stamp
  // `persona.resume_session_id` without the agent passing it
  // manually, and the watchdog auto-rest path can do the same.
  // `null` when pantheon is launched outside a CC session — resume
  // features silently no-op in that case.
  const claudeSessionAtBoot = readClaudeSessionId(process.ppid);

  // Stop-hook plumbing: write the per-CC-session runtime env file so
  // `pantheon context-check` can match this session and read the
  // configured thresholds. Best-effort — when CC's session file isn't
  // readable (pantheon launched outside a CC session), the Stop hook
  // silently no-ops. Also (re)generates the bash wrapper script that
  // settings.json's Stop hook invokes; idempotent.
  try {
    const claudePid = process.ppid;
    const claudeSessionId = readClaudeSessionId(claudePid);
    if (claudeSessionId) {
      if (isContextCheckDisabled()) {
        // Kill-switch: clear any stale runtime file from a prior run
        // so the wrapper's fast-path returns `{}` without spawning bun.
        deleteRuntimeFiles(claudeSessionId);
      } else {
        const windowOverrideRaw = process.env.PANTHEON_CONTEXT_WINDOW;
        const windowOverride = windowOverrideRaw && Number.isFinite(Number(windowOverrideRaw))
          ? Number(windowOverrideRaw)
          : null;
        writeRuntimeEnv({
          claude_session_id: claudeSessionId,
          claude_pid: claudePid,
          cwd_at_boot: process.cwd(),
          context_thresholds: parseThresholdsFromEnv(),
          context_window_override: windowOverride,
          written_at: Date.now(),
        });
      }
    }
    ensureStopHookWrapper();
  } catch {
    // best-effort — context-check feature is non-critical at boot
  }

  // Open the chat DB lazily — it's the same connection the router
  // persists into. Per §15, the daemon owns this; for now the per-MCP
  // process opens its own (one daemon per MCP server, per the
  // single-process model).
  let chatDb: ReturnType<typeof openChatDb> | null = null;
  try {
    chatDb = openChatDb(paths.chatDbPath);
  } catch {
    // best-effort — chat persistence is not strictly required for the
    // tools to function (in-memory dispatch still works).
  }

  const router = new ChatRouter({ paths, db: chatDb });

  const ctx =
    options.context ??
    createContext({
      paths,
      summoner_username: summoner,
      scheduleExit: makeRealExitScheduler(process.ppid),
      spawn_metadata: spawnMetadata,
      chat: router,
      claude_session_id: claudeSessionAtBoot,
    });

  // Summoned agents arrive with `PANTHEON_USERNAME` set by the spawn
  // handler. Claim that persona at MCP boot so the session is in
  // `claimed_persona` from the very first tool call — agents don't
  // need to manually run `manifest`/`claim`, and a cold `login`
  // doesn't trip the `registered_persona` rejection.
  //
  // Skipped when the test harness pre-injected an `options.context`
  // (it owns the session lifecycle) or when no PANTHEON_USERNAME is
  // set (cold `pantheon serve` outside a summon). Best-effort —
  // never crash the daemon if the env-named persona is missing.
  if (!options.context) {
    const summonedUsername = process.env.PANTHEON_USERNAME;
    if (summonedUsername && !ctx.session.claimedUsername) {
      try {
        transitionClaim(ctx.paths, ctx.session, summonedUsername);
      } catch {
        // Persona may have been unregistered between summon and boot,
        // or the env var is stale. Login's auto-claim path will
        // handle the cwd-match case at chat-login time.
      }
    }
  }

  // Arm the watchdog with the per-summon rest_timeout if our spawner
  // set PANTHEON_REST_TIMEOUT (the env contract from §14 / spawn handler);
  // otherwise the 60-min default per §14.
  const restTimeout = readRestTimeoutFromEnv();
  ctx.watchdog.register({
    session: ctx.session,
    rest_timeout: restTimeout,
    onDeadline: (s) => {
      defaultOnDeadline(s);
      if (s.claimedUsername) {
        try {
          // Stamp the real CC session UUID (when known) so a future
          // `summon --resume` lands on the same conversation. Falls
          // through to null when pantheon was launched outside a CC
          // session — `--resume` simply won't fire that summon.
          stampRested(
            ctx.paths,
            s.claimedUsername,
            "auto_rest_timeout",
            ctx.claude_session_id,
          );
        } catch {
          // best-effort — never let the watchdog crash the daemon
        }
      }
    },
  });

  const server = new Server(
    { name: "pantheon", version: "0.0.1" },
    {
      capabilities: {
        tools: {},
        // Declare the `claude/channel` experimental capability so CC
        // mirrors it in `getClientCapabilities()`. The dispatch path
        // below pushes deliverable chat messages as
        // `notifications/claude/channel` events when both sides
        // support it. Without channels, agents fall back to the
        // Monitor watcher reading chat.db.
        experimental: { "claude/channel": {} },
      },
    },
  );

  const pushNotification = async (text: string): Promise<void> => {
    try {
      await server.notification({
        method: "notifications/message",
        params: { level: "info", data: text },
      });
    } catch {
      // best effort
    }
  };
  // Replace the no-op pushNotification on the context so handlers can use it.
  Object.assign(ctx, { pushNotification });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS as unknown as Array<(typeof TOOLS)[number]>,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    // §14 vanilla-MCP rule: every incoming MCP request from this session
    // is activity. The dispatcher applies the per-tool reset filter on
    // top, but this is the broader belt-and-braces signal.
    try {
      ctx.watchdog.touch(ctx.session.id);
    } catch {
      // best-effort
    }
    // Inject `supports_channels` into login so the chat handler can
    // record it on the subscriber + branch the response note. CC
    // mirrors the server-declared capability back via
    // `getClientCapabilities()` when it accepts.
    if (name === "login") {
      args.supports_channels = detectChannels(server);
    }
    const result = (await dispatch(name, args, ctx)) as unknown as Awaited<
      ReturnType<Parameters<typeof server.setRequestHandler>[1]>
    >;
    // Subscribe THIS process to the agent's channel push stream after
    // a successful login. Subscription is one-per-MCP-process so the
    // listener captures the right `server` instance for the
    // notification call.
    if (name === "login" && ctx.chat_agent_id && ctx.chat) {
      maybeSubscribeChannel(server, ctx.chat, ctx.chat_agent_id);
    }
    if (name === "logout") {
      teardownChannelSubscription(ctx.chat_agent_id);
    }
    return result;
  });

  // §14 plugin-mode watchdog wiring: at boot, sweep stale per-CC-
  // session marker dirs from previous runs.
  try {
    sweepStaleSessionDirs(paths);
  } catch {
    // best-effort
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // §11c presence cross-process: heartbeat this MCP's chat
  // subscriber every 5s so other processes' `list_agents` sees us.
  // The 5s cadence is well under the 30s stale-threshold default;
  // a missed heartbeat or two won't evict.
  const heartbeatTimer = setInterval(() => {
    const id = ctx.chat_agent_id;
    if (id) ctx.chat?.heartbeat(id);
  }, 5_000);
  // §14 plugin-mode watchdog reset: poll the per-CC-session marker
  // file the PreToolUse hook touches. When mtime advances, reset
  // this session's watchdog. Same 5s cadence as the heartbeat.
  const hookPoller = new HookPoller({
    paths: ctx.paths,
    watchdog: ctx.watchdog,
    session_id: ctx.session.id,
    ppid: process.ppid,
  });
  const hookPollTimer = setInterval(() => {
    hookPoller.poll();
  }, 5_000);
  // Daemon-tick: prune stale subscriber rows every 30s, prune the
  // in-memory tombstone map, auto-fade expired handoff memory entries
  // (§6 MEDIUM idle-handoff slot), AND batch-emit status_digest every
  // PANTHEON_STATUS_DIGEST_MINUTES (default 10). One timer drives
  // every recurrent sweep.
  const statusDigestMs = resolveStatusDigestMs();
  let lastStatusDigestAt = Date.now();
  const keepaliveMs = resolveKeepaliveMs();
  const pruneTimer = setInterval(() => {
    if (chatDb) {
      try {
        pruneStale(chatDb);
      } catch {
        // best-effort
      }
    }
    // In-memory orphan sweep: drop router.subscribers entries whose
    // SQLite presence row has been pruned. Belt-and-braces with the
    // same-session re-login idempotence guard in the chat handler:
    // the guard prevents new orphans, this sweep cleans up any that
    // exist (pre-fix leftovers, or future leak paths). Runs on the
    // same 30s cadence as the SQLite prune so the two stay in lockstep.
    try {
      ctx.chat?.sweepInMemoryOrphans();
    } catch {
      // best-effort — never let a sweep crash the daemon
    }
    try {
      ctx.chat?.tombstones.prune();
    } catch {
      // best-effort
    }
    try {
      expireHandoffs(ctx.paths);
    } catch {
      // best-effort — memory sweep failures shouldn't crash the daemon
    }
    // Status-digest sweep: gated by time-since-last so the 30s tick
    // doesn't over-fire. Per Yapsmith's chat-mcp revamp: replaces
    // per-event status_update broadcasts with a periodic batched DM.
    if (ctx.chat && Date.now() - lastStatusDigestAt >= statusDigestMs) {
      try {
        ctx.chat.sweepStatusDigest();
      } catch {
        // best-effort — never let a digest hiccup crash the daemon
      }
      lastStatusDigestAt = Date.now();
    }
    // Per-agent keepalive sweep: pings only subscribers whose
    // last_event_at is older than keepaliveMs. Gating lives inside
    // sweepKeepalive — calling on every 30s tick is cheap when
    // nothing's eligible. Disabled when the env override is 0.
    if (ctx.chat && keepaliveMs > 0) {
      try {
        ctx.chat.sweepKeepalive(keepaliveMs);
      } catch {
        // best-effort — keepalive failure must not crash the daemon
      }
    }
  }, 30_000);

  const cleanup = () => {
    ctx.watchdog.shutdown();
    clearInterval(heartbeatTimer);
    clearInterval(hookPollTimer);
    clearInterval(pruneTimer);
    teardownChannelSubscription(ctx.chat_agent_id);
    try {
      chatDb?.close();
    } catch {
      // best-effort
    }
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
}

function readSpawnMetadataFromEnv() {
  const windowName = process.env.PANTHEON_WINDOW_NAME;
  if (!windowName) return null;
  const tabIndexRaw = process.env.PANTHEON_TAB_INDEX;
  const tabIndex = tabIndexRaw ? Number(tabIndexRaw) : NaN;
  return {
    window_name: windowName,
    ...(Number.isFinite(tabIndex) ? { tab_index: tabIndex } : {}),
  };
}

/** Resolve the status-digest sweep interval in ms. Honors
 * `PANTHEON_STATUS_DIGEST_MINUTES` (positive number); falls back to
 * the 10-minute default per Yapsmith's revamp. */
const DEFAULT_STATUS_DIGEST_MINUTES = 10;
function resolveStatusDigestMs(): number {
  const raw = process.env.PANTHEON_STATUS_DIGEST_MINUTES;
  if (!raw) return DEFAULT_STATUS_DIGEST_MINUTES * 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STATUS_DIGEST_MINUTES * 60_000;
  return n * 60_000;
}

/** Cache-warming keepalive cadence. Pings every online subscriber
 * whose stream has been silent longer than this threshold. The
 * Anthropic 1-hour prompt cache TTL means a 60-min idle agent pays
 * a fresh-cache cost on its next turn; 15 min default gives a 4×
 * safety margin without flooding active rooms (per-recipient gate
 * suppresses the ping if any other event recently landed).
 *
 * Override via `PANTHEON_KEEPALIVE_MINUTES` (positive number). Set
 * to 0 to disable. */
const DEFAULT_KEEPALIVE_MINUTES = 15;
function resolveKeepaliveMs(): number {
  const raw = process.env.PANTHEON_KEEPALIVE_MINUTES;
  if (!raw) return DEFAULT_KEEPALIVE_MINUTES * 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_KEEPALIVE_MINUTES * 60_000;
  return n * 60_000;
}

/** Read the client's `claude/channel` experimental capability. CC
 * mirrors the server-declared experimental capabilities back via
 * `getClientCapabilities()` when it accepts. Untyped on the SDK side;
 * cast through `unknown` to a narrow shape. */
function detectChannels(server: Server): boolean {
  try {
    const caps = (server as unknown as {
      getClientCapabilities?: () => { experimental?: Record<string, unknown> } | undefined;
    }).getClientCapabilities?.();
    return Boolean(caps?.experimental?.["claude/channel"]);
  } catch {
    return false;
  }
}

/** Per-process map of `agent_id → unsubscribe-callback`. Each MCP
 * process holds exactly one channel subscription per logged-in agent
 * (in practice, exactly one — pantheon's stdio model is one MCP
 * process per CC session). On `logout` (or process exit) the
 * unsubscribe runs. */
const channelUnsubscribes = new Map<string, () => void>();

function maybeSubscribeChannel(
  server: Server,
  chat: ChatRouter,
  agent_id: string,
): void {
  const sub = chat.getByAgentId(agent_id);
  if (!sub || !sub.supports_channels) return;
  // Replace any prior subscription for this agent (e.g., re-login).
  teardownChannelSubscription(agent_id);
  const unsubscribe = chat.subscribe(agent_id, (msg) => {
    const meta: Record<string, unknown> = {
      from: msg.from_username_inline ?? msg.from_agent_id,
      scope: msg.scope,
      message_id: msg.id,
      seq: msg.seq,
      ts: msg.ts,
    };
    if (msg.target !== undefined) meta.target = msg.target;
    if (msg.from_project) meta.from_project = msg.from_project;
    if (msg.reply_to !== undefined) meta.reply_to = msg.reply_to;
    if (msg.ask_id !== undefined) meta.ask_id = msg.ask_id;
    if (msg.in_reply_to_ask !== undefined) meta.in_reply_to_ask = msg.in_reply_to_ask;
    if (msg.mentions.length > 0) meta.mentions = msg.mentions;
    if (msg.system) meta.system = true;
    if (msg.system_kind !== undefined) meta.system_kind = msg.system_kind;
    server
      .notification({
        method: "notifications/claude/channel",
        params: { content: msg.text, meta },
      })
      .catch(() => {
        // Best-effort: drop on transport hiccup; the watcher fallback
        // can still pick up via chat.db if the agent re-spawns it.
      });
    // Per channels-enabled semantics: the channel push IS the
    // delivery; advance the agent's cursor so check_messages doesn't
    // re-surface the same row.
    chat.advanceCursor(agent_id, msg.seq);
  });
  channelUnsubscribes.set(agent_id, unsubscribe);
}

function teardownChannelSubscription(agent_id: string | null): void {
  if (!agent_id) return;
  const unsubscribe = channelUnsubscribes.get(agent_id);
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      // best-effort
    }
    channelUnsubscribes.delete(agent_id);
  }
}

function readRestTimeoutFromEnv(): number | "never" {
  const raw = process.env.PANTHEON_REST_TIMEOUT;
  if (!raw) return DEFAULT_REST_TIMEOUT_SECONDS;
  if (raw === "never") return "never";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < DEFAULT_REST_TIMEOUT_SECONDS) {
    return DEFAULT_REST_TIMEOUT_SECONDS;
  }
  return n;
}

function makeRealExitScheduler(parentPid: number) {
  return (delaySeconds: number, _reason: string): void => {
    setTimeout(() => {
      const sentinel = process.env.PANTHEON_EXIT_SENTINEL;
      if (sentinel) {
        try {
          fs.writeFileSync(sentinel, "1");
        } catch {
          // best-effort
        }
      }
      try {
        process.kill(parentPid, "SIGTERM");
      } catch {
        process.exit(0);
      }
    }, Math.max(0, delaySeconds * 1000));
  };
}
