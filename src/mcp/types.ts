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
  /** When `true`, the spawned agent CANNOT call `rest` / `exit` /
   * `logout` on itself — those handlers return `self_exit_blocked`.
   * Set from the `PANTHEON_BLOCK_SELF_EXIT` env var at boot, which
   * the summoner sets via `summon({ block_self_exit: true })`.
   * Watchdog timeouts and peer `force_rest` / `force_exit` still
   * fire (intentional safety valves). */
  block_self_exit: boolean;
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
  /** Path to the user's `~/.claude.json` config. Used by the summon
   * handler to auto-trust the persona's cwd before spawn. Defaults to
   * `path.join(os.homedir(), ".claude.json")`; tests inject a tmp path. */
  claude_config_path: string;
  /** Real Claude Code session UUID for the parent process, read at
   * MCP boot from `~/.claude/sessions/<ppid>.json`. Used by `rest` to
   * stamp `persona.resume_session_id` automatically (so `summon
   * --resume` works without the caller manually passing the id) and
   * by the auto-rest watchdog deadline callback. `null` when pantheon
   * was launched outside a CC session — resume features silently
   * no-op in that case. */
  claude_session_id: string | null;
  /** Chat router instance. `null` when no router is attached to this
   * context (e.g. early bootstrap, identity-only test harnesses). */
  chat: ChatRouter | null;
  /** This session's chat subscriber id. Set on `login`, cleared on
   * `logout`. */
  chat_agent_id: string | null;
  /** Mutator for `chat_agent_id` — `login` calls this to record the
   * subscriber id, `logout` clears it. */
  setChatAgentId(id: string | null): void;
  /** §6 HIGH context-pressure tracking. Per-session state used by the
   * dispatcher to decide whether to surface a pressure hint in the
   * tool response. `markActivity` increments the counter; memory-
   * save tools call `markMemorySave` which resets the counter and
   * stamps `lastSaveAt`. `getPressureState` returns the current
   * snapshot for `computePressure`. */
  markActivity(toolName: string): void;
  markMemorySave(): void;
  getPressureState(): { toolCallsSinceLastSave: number; lastSaveAt: number };
  /** Redesign-v2 load gate (§9). When `true`, the dispatcher rejects
   * non-exempt pantheon tools with `memory_not_loaded` until
   * `load_memory` runs. Enabled only by the real MCP server boot;
   * defaults `false` so programmatic / test / e2e-harness contexts
   * (which drive handlers directly) are unaffected. */
  memory_gate_enabled: boolean;
  /** True once `load_memory` has run this conversation. Per-conversation
   * (per-process), survives re-login. */
  memory_loaded: boolean;
  /** Topics declared via `load_memory` this conversation — passed to the
   * render so declared topics show full detail. */
  loaded_topics: string[];
  /** Record a `load_memory` call: lift the gate and union the topics. */
  loadMemory(topics: string[]): void;
  /** v2 (§16) per-persona session ordinal for THIS conversation, set on
   * the first `load_memory` (via `beginSession`). Stamped on entries
   * written this session; drives handoff fade + next-session reminders.
   * `null` until load_memory runs. */
  session_seq: number | null;
  /** Set the session ordinal — called once by `load_memory`. */
  setSessionSeq(seq: number): void;
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
