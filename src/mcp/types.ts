import type { Session } from "../identity/index.ts";
import type { Watchdog } from "../watchdog/index.ts";
import type { Paths } from "../storage/index.ts";

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
