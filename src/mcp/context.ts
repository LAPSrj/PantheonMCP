import os from "node:os";
import { Session } from "../identity/index.ts";
import { resolvePaths, type Paths } from "../storage/index.ts";
import { Watchdog, realScheduler } from "../watchdog/index.ts";
import { realSpawnExecutor, type SpawnExecutor } from "../launcher/index.ts";
import type { ChatRouter } from "../chat/index.ts";
import type { HandlerContext, SpawnMetadata } from "./types.ts";

export interface CreateContextOptions {
  /** Override for tests / sandboxed runs. Defaults to env-resolved paths. */
  paths?: Paths;
  /** Pre-existing session (e.g. summoned, identity already known). */
  session?: Session;
  /** Pre-existing watchdog. The MCP server constructs one when none is
   * provided; tests inject a `Watchdog(fakeScheduler)` for determinism. */
  watchdog?: Watchdog;
  /** Set when SUMMON_USERNAME (or pantheon equivalent) is in env. */
  summoner_username?: string | null;
  parent_pid?: number;
  platform?: "wsl" | "windows" | "mac" | "linux";
  /** Default no-op; the stdio server wires the real SIGTERM-based exit. */
  scheduleExit?: (delaySeconds: number, reason: string) => void;
  pushNotification?: (text: string) => Promise<void>;
  spawn_executor?: SpawnExecutor;
  stderr_probe_ms?: number;
  spawn_env?: NodeJS.ProcessEnv;
  spawn_metadata?: SpawnMetadata | null;
  chat?: ChatRouter | null;
  /** Override the path to `~/.claude.json` (for tests). Defaults to
   * `path.join(os.homedir(), ".claude.json")`. */
  claude_config_path?: string;
}

/** Build a runtime context around the four foundation layers. The MCP
 * server calls this at boot; tests call it with overrides for paths,
 * watchdog, and exit handlers. */
export function createContext(options: CreateContextOptions = {}): HandlerContext {
  const paths = options.paths ?? resolvePaths();
  const session = options.session ?? new Session(`session-${process.ppid}`);
  const watchdog = options.watchdog ?? new Watchdog(realScheduler);
  let allowRestAuthorized = false;
  let chatAgentId: string | null = null;
  // §6 HIGH context-pressure surrogate: tool-call counter + last-save
  // timestamp. Dispatcher updates these; memory-save tools reset.
  const pressure = {
    toolCallsSinceLastSave: 0,
    lastSaveAt: Date.now(),
  };
  return {
    paths,
    session,
    watchdog,
    summoner_username: options.summoner_username ?? null,
    parent_pid: options.parent_pid ?? process.ppid,
    platform: options.platform ?? detectPlatform(),
    scheduleExit:
      options.scheduleExit ??
      ((_delay, _reason) => {
        // No-op default; MCP server wires the real exit at boot.
      }),
    pushNotification:
      options.pushNotification ??
      (async (_text) => {
        // No-op default for non-MCP-attached contexts (tests, scripts).
      }),
    spawn_executor: options.spawn_executor ?? realSpawnExecutor,
    stderr_probe_ms: options.stderr_probe_ms ?? 200,
    spawn_env: options.spawn_env ?? process.env,
    spawn_metadata: options.spawn_metadata ?? null,
    chat: options.chat ?? null,
    claude_config_path: options.claude_config_path ?? paths.claudeConfigPath,
    get chat_agent_id(): string | null {
      return chatAgentId;
    },
    setChatAgentId(id: string | null): void {
      chatAgentId = id;
    },
    get allow_rest_authorized(): boolean {
      return allowRestAuthorized;
    },
    setAllowRest(next: boolean): void {
      allowRestAuthorized = next;
    },
    markActivity(_toolName: string): void {
      pressure.toolCallsSinceLastSave += 1;
    },
    markMemorySave(): void {
      pressure.toolCallsSinceLastSave = 0;
      pressure.lastSaveAt = Date.now();
    },
    getPressureState() {
      return {
        toolCallsSinceLastSave: pressure.toolCallsSinceLastSave,
        lastSaveAt: pressure.lastSaveAt,
      };
    },
  } as HandlerContext;
}

function detectPlatform(): "wsl" | "windows" | "mac" | "linux" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "mac";
  if (process.platform === "linux") {
    // WSL detection: kernel release contains "microsoft".
    try {
      const release = os.release().toLowerCase();
      if (release.includes("microsoft")) return "wsl";
    } catch {
      // fall through
    }
    return "linux";
  }
  return "linux";
}
