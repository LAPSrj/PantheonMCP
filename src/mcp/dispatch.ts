import { IdentityError } from "../identity/index.ts";
import { MemoryError } from "../memory/index.ts";
import { WatchdogError, isResetTrigger } from "../watchdog/index.ts";
import { HANDLERS } from "./handlers/index.ts";
import { ToolError, type HandlerContext, type MCPCallResult } from "./types.ts";

/** Central tool dispatcher. Resolves the handler, runs it, maps domain
 * errors into MCP error payloads, and (per §14) touches the watchdog
 * for any tool name that counts as activity.
 *
 * Vanilla MCP mode also touches the watchdog on every request before
 * the handler runs — that's the responsibility of the MCP server's
 * request handler (`server.ts`); this dispatcher does the per-tool
 * gating after the handler succeeds, mirroring summon-mcp's pattern.
 */
export async function dispatch(
  toolName: string,
  args: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<MCPCallResult> {
  const handler = HANDLERS[toolName];
  if (!handler) {
    return errorResult({
      error: "unknown_tool",
      message: `Unknown tool: '${toolName}'.`,
    });
  }
  try {
    const data = await handler(args, ctx);
    if (isResetTrigger(toolName)) {
      // Belt-and-braces: every qualifying tool resets the watchdog. The
      // server's per-request touch is the broader signal; this is the
      // explicit-list signal that matters for the plugin / when the
      // server forgets to wire the per-request touch.
      try {
        ctx.watchdog.touch(ctx.session.id);
      } catch {
        // Watchdog touch is best-effort — never fail a tool call on it.
      }
    }
    return okResult(data);
  } catch (err) {
    return errorResult(mapError(err));
  }
}

interface ErrorPayload {
  error: string;
  message: string;
  [extra: string]: unknown;
}

function mapError(err: unknown): ErrorPayload {
  if (err instanceof IdentityError) {
    return { error: err.code, message: err.message, ...err.extra };
  }
  if (err instanceof MemoryError) {
    return { error: err.code, message: err.message, ...err.extra };
  }
  if (err instanceof WatchdogError) {
    return { error: err.code, message: err.message };
  }
  if (err instanceof ToolError) {
    return { error: err.code, message: err.message, ...err.extra };
  }
  if (err instanceof Error) {
    return { error: "internal_error", message: err.message };
  }
  return { error: "internal_error", message: String(err) };
}

function okResult(data: unknown): MCPCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(payload: ErrorPayload): MCPCallResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}
