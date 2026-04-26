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
import { stampRested } from "../identity/index.ts";
import { createContext } from "./context.ts";
import { dispatch } from "./dispatch.ts";
import { TOOLS } from "./tools.ts";

export interface ServerOptions {
  /** Override at boot for tests or sandboxed runs. */
  context?: ReturnType<typeof createContext>;
}

/** Vanilla MCP entry point. Spawned per-conversation by Claude Code (or
 * any MCP client) over stdio. */
export async function runMcpServer(options: ServerOptions = {}): Promise<void> {
  const summoner = process.env.PANTHEON_SUMMONER ?? null;

  const ctx =
    options.context ??
    createContext({
      summoner_username: summoner,
      scheduleExit: makeRealExitScheduler(process.ppid),
    });

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
          stampRested(ctx.paths, s.claimedUsername, "auto_rest_timeout", null);
        } catch {
          // best-effort — never let the watchdog crash the daemon
        }
      }
    },
  });

  const server = new Server(
    { name: "pantheon", version: "0.0.1" },
    { capabilities: { tools: {} } },
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
    // The MCP SDK's CallToolResult type spans several discriminated
    // variants (some include a `task` field for managed-agents flows).
    // dispatch returns the basic content+isError shape, which is valid
    // wire output; cast through unknown to satisfy the SDK's wider
    // union without restating it here.
    return (await dispatch(name, args, ctx)) as unknown as Awaited<
      ReturnType<Parameters<typeof server.setRequestHandler>[1]>
    >;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const cleanup = () => {
    ctx.watchdog.shutdown();
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
