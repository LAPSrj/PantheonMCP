import { IdentityError } from "../identity/index.ts";
import { MemoryError, clusterTopics, loadStore } from "../memory/index.ts";
import { WatchdogError, isResetTrigger } from "../watchdog/index.ts";
import { ChatError } from "../chat/index.ts";
import { validatePayload, type JsonSchema } from "../schemas/index.ts";
import { computePressure, isSaveTool, pressureHint } from "./context-pressure.ts";
import { HANDLERS } from "./handlers/index.ts";
import { SINGLE_AGENT_HIDDEN, TOOLS } from "./tools.ts";
import { ToolError, type HandlerContext, type MCPCallResult } from "./types.ts";

const TOOL_SCHEMAS: Record<string, JsonSchema> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t.inputSchema as JsonSchema]),
);

/** §9 load gate — tools callable BEFORE `load_memory`. Everything else
 * (including `login`, `send_message`, `answer`, `rest`) is gated when
 * the gate is enabled. The Monitor watcher is harness-side, not a
 * pantheon tool, so it's unaffected. */
const GATE_EXEMPT = new Set([
  "manifest",
  "list_topics",
  "load_memory",
  "get_instructions",
  "session_info",
  "whoami",
]);

/** Decide whether to reject `toolName` with `memory_not_loaded`. Returns
 * null to allow. Side-effect: a fresh/empty persona (no topics) lifts
 * the gate in place so it never blocks — §9 "fresh persona skips". */
function checkLoadGate(toolName: string, ctx: HandlerContext): ErrorPayload | null {
  if (!ctx.memory_gate_enabled || ctx.memory_loaded) return null;
  if (GATE_EXEMPT.has(toolName)) return null;
  // No claimed persona → no memory to load; don't gate (identity
  // bootstrap / guest flows handle their own errors).
  const username = ctx.session.claimedUsername;
  if (!username) return null;
  // Fresh / empty persona → skip the gate permanently for this session.
  try {
    if (clusterTopics(loadStore(ctx.paths, username).entries).length === 0) {
      ctx.loadMemory([]);
      return null;
    }
  } catch {
    // If we can't read the store, fail open rather than wedge the agent.
    return null;
  }
  return {
    error: "memory_not_loaded",
    message:
      "Load your memory first. Boot order: manifest → list_topics → load_memory(topic) → login → monitor. " +
      "Call `list_topics` to see the menu, then `load_memory({ topics: [...] })` (or load_memory({ topic: \"always\" })).",
  };
}

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
  // Single-agent project: these tools are omitted from `tools/list`, but
  // a model that "remembers" the name could still call one. Reject here
  // so hiding is authoritative, not cosmetic.
  if (ctx.single_agent && SINGLE_AGENT_HIDDEN.has(toolName)) {
    return errorResult({
      error: "tool_unavailable_single_agent",
      message:
        `Tool '${toolName}' is unavailable: this is a single-agent project ` +
        `(one persona shared across sessions). Persona-creation, shared ` +
        `project-memory, and cross-persona reads are disabled here.`,
    });
  }
  // Reject unknown args + missing required fields against the tool's
  // declared inputSchema. Catches typo classes like `to` vs `target`
  // on send_message at the boundary instead of falling through to a
  // silent default. Schema is the same source the MCP client sees in
  // tools/list — strict at the contract level. The validator subset
  // only enforces type / required / properties / additionalProperties /
  // enum / min-max length / pattern; oneOf and other non-subset
  // keywords are silently ignored (no false-rejections).
  const schema = TOOL_SCHEMAS[toolName];
  if (schema) {
    const errs = validatePayload(args, schema);
    if (errs.length > 0) {
      return errorResult({
        error: "invalid_args",
        message: `Tool '${toolName}' rejected: ${errs
          .slice(0, 5)
          .map((e) => `${e.path || "/"} — ${e.message}`)
          .join("; ")}${errs.length > 5 ? ` (+${errs.length - 5} more)` : ""}`,
        path_errors: errs,
      });
    }
  }
  // §9 load gate — reject non-exempt tools until `load_memory` runs.
  const gateError = checkLoadGate(toolName, ctx);
  if (gateError) return errorResult(gateError);
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
    // §6 HIGH context-pressure tracking. Every successful tool call
    // bumps the activity counter; memory-save tools reset it. After
    // the reset/bump, compute the pressure level and surface a hint
    // in the response when at or above soft_hint.
    try {
      if (isSaveTool(toolName)) {
        ctx.markMemorySave();
      } else {
        ctx.markActivity(toolName);
      }
    } catch {
      // best-effort
    }
    const finalData = injectPressureHint(data, ctx);
    return okResult(finalData);
  } catch (err) {
    return errorResult(mapError(err));
  }
}

/** Append a context-pressure hint to the response's `hints` array
 * when the surrogate signals soft_hint or higher. Preserves any
 * existing `hints` (e.g., the staleness nudge from `send_message`).
 *
 * Gated on having a claimed persona — the hint tells the agent to
 * call `append_memory` / `rest`, which only persona-claimed sessions
 * can do. Surfacing it on guests / unclaimed sessions is pure noise
 * (no memory store, no persona to rest). */
function injectPressureHint(data: unknown, ctx: HandlerContext): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return data;
  }
  if (!ctx.session.claimedUsername) return data;
  let level: ReturnType<typeof computePressure>;
  let state: ReturnType<typeof ctx.getPressureState>;
  try {
    state = ctx.getPressureState();
    level = computePressure(state);
  } catch {
    return data;
  }
  if (level === "low") return data;
  const hint = pressureHint(level, state);
  if (!hint) return data;
  const obj = data as Record<string, unknown>;
  const existing = Array.isArray(obj.hints) ? (obj.hints as unknown[]) : [];
  return { ...obj, hints: [...existing, hint] };
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
  if (err instanceof ChatError) {
    return { error: err.code, message: err.message, ...err.extra };
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

/** §11/§13 JIT — auto-surface `get_instructions` from error codes so a
 * tool doesn't strand an agent that hit an error it can't interpret. Maps
 * the error code to the instruction topic that explains it; the agent can
 * pull the section without knowing it exists. */
const ERROR_INSTRUCTION_TOPIC: Record<string, string> = {
  memory_not_loaded: "boot",
  topic_required: "topics",
  new_topic: "topics",
  invalid_kind: "memory",
  summary_is_header: "memory",
  pin_budget_exceeded: "memory",
  always_budget_exceeded: "memory",
  chat_unavailable: "chat",
  recipient_offline: "chat",
  self_exit_blocked: "lifecycle",
};

function errorResult(payload: ErrorPayload): MCPCallResult {
  const topic = ERROR_INSTRUCTION_TOPIC[payload.error];
  const enriched: ErrorPayload =
    topic && payload.see_instructions === undefined
      ? {
          ...payload,
          see_instructions: {
            topic,
            hint: `Run \`get_instructions({ topic: "${topic}" })\` for guidance.`,
          },
        }
      : payload;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }],
  };
}
