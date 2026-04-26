import type { Session } from "../identity/index.ts";
import type { Watchdog } from "../watchdog/index.ts";
import type { Paths } from "../storage/index.ts";
import type { SpawnExecutor } from "../launcher/index.ts";
import type { ChatRouter } from "../chat/index.ts";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface HandlerContext {
  paths: Paths;
  session: Session;
  watchdog: Watchdog;
  /** When `true`, this session was spawned by another agent's `summon` —
   * surfaces in `summoner_username` for memory entries appended here. */
  summoner_username: string | null;
  /** Platform detected at MCP boot. Used as a default for `register` /
   * `conjure` if the caller doesn't provide one. */
  platform: "wsl" | "windows" | "mac" | "linux";
  /** Process pid of the parent (Claude Code) — exposed via `session_info`. */
  parent_pid: number;
  /** Optional exit scheduler. The lifecycle `exit` tool calls this; the
   * MCP server wires a real scheduler at boot, tests pass a no-op. */
  scheduleExit: (delaySeconds: number, reason: string) => void;
  /** True when the user has explicitly authorized rest in a non-summoned
   * session via `allow_rest`. Mirrors summon-mcp's `allow_idle` gate. */
  allow_rest_authorized: boolean;
  /** Toggled by lifecycle.allow_rest; consulted by lifecycle.rest. */
  setAllowRest: (next: boolean) => void;
  /** Push notification surface (MCP `notifications/message`). The
   * server wires a real push; tests use a recorder. */
  pushNotification: (text: string) => Promise<void>;
  /** Spawn shim — defaults to `realSpawnExecutor` (Node's
   * child_process.spawn). Tests inject a fake to capture argv without
   * launching real subprocesses. */
  spawn_executor: SpawnExecutor;
  /** Stderr probe duration in ms. Default 200 per §11a. Tests pass
   * 0 or a smaller value for speed. */
  stderr_probe_ms: number;
  /** Env used by the launcher dispatcher for adapter detection.
   * Defaults to `process.env`; tests pass a controlled subset so
   * detection is deterministic regardless of the test runner's
   * inherited terminal. */
  spawn_env: NodeJS.ProcessEnv;
  /** Set when this MCP process was spawned by another agent's
   * `summon`. The MCP server reads `PANTHEON_WINDOW_NAME` /
   * `PANTHEON_TAB_INDEX` from env at boot and stores them here so
   * the `exit` handler can decrement the window registry. */
  spawn_metadata: SpawnMetadata | null;
  /** Chat router instance. `null` when no router is attached to this
   * context (e.g. early bootstrap, identity-only test harnesses). */
  chat: ChatRouter | null;
  /** This session's chat subscriber id. Set on `login`, cleared on
   * `logout`. */
  chat_agent_id: string | null;
  /** Mutator for `chat_agent_id` — `login` calls this to record the
   * subscriber id, `logout` clears it. */
  setChatAgentId(id: string | null): void;
}

export interface SpawnMetadata {
  window_name: string;
  tab_index?: number;
}

/** Chat-router accessors mirror the persona-claim half: `chat` is the
 * router instance the daemon owns; `chat_agent_id` is this session's
 * subscriber id (set on login, cleared on logout). The MCP server
 * wires both at boot when a router is attached. */
declare module "./types.ts" {
  // (Augmentation handled inline below; left here for grep discoverability.)
}

export type HandlerResult = unknown;

export type Handler = (
  args: Record<string, unknown>,
  ctx: HandlerContext,
) => Promise<HandlerResult>;

/** MCP tool result content block, JSON-encoded payload. */
export interface MCPCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export class ToolError extends Error {
  code: string;
  extra: Record<string, unknown>;
  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "ToolError";
  }
}

// Argument coercion helpers used by handlers.
export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
export function asStringRequired(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ToolError("invalid_argument", `'${name}' must be a non-empty string.`);
  }
  return v;
}
export function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}
export function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
export function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
