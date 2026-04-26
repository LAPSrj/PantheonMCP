import { IdentityError, readPersona } from "../identity/index.ts";
import { openChatDb, resolvePaths, type Paths } from "../storage/index.ts";
import {
  AdapterError,
  realSpawnExecutor,
  type SpawnExecutor,
  type SpawnMode,
  type SpawnTarget,
} from "../launcher/index.ts";
import { listActive } from "../chat/presence.ts";
import { spawnPersona } from "../mcp/handlers/spawn.ts";
import { ToolError } from "../mcp/types.ts";
import { createContext } from "../mcp/context.ts";

/** §11b CLI summon — shell-invocable equivalent of the MCP `summon`
 * tool. Reads the persona from the registry, builds a HandlerContext
 * around the real spawn executor + env, and calls `spawnPersona`
 * (the same function the MCP handler uses). Output is JSON.
 *
 * Exit codes per semaphoremole's spec:
 *   0 — success
 *   1 — user error (unknown persona, bad target, missing args)
 *   2 — spawn failed (200ms stderr probe captured output) */
export interface RunSummonOptions {
  args: string[];
  paths?: Paths;
  spawn_executor?: SpawnExecutor;
  spawn_env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

const SUMMON_EXIT = {
  SUCCESS: 0,
  USER_ERROR: 1,
  SPAWN_FAILED: 2,
} as const;

interface ParsedArgs {
  username: string;
  target: SpawnTarget;
  rest_timeout?: number | "never";
  resume: boolean;
  prompt?: string;
  /** Per-call --channels overrides; each value forwards to claude
   * as `--channels <value>`. Empty array means no override (uses
   * persona.channels). */
  channels?: string[];
  /** Per-call --remote-control / --rc override. `true` uses
   * persona.project as the RC name; a string is the explicit name. */
  remote_control?: boolean | string;
  /** Per-call --chat-username-suffix override. Numeric suffix string
   * (e.g. "2", "3") OR the literal "auto" — the CLI walks 2..99 in
   * the chat presence DB and picks the first available number. The
   * persona's REGISTRY identity stays canonical; only the bootstrap-
   * embedded chat login uses `<base><N>`. */
  chat_username_suffix?: string | "auto";
}

export async function runSummon(options: RunSummonOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseArgs(options.args, stderr);
  if (parsed === "help") return SUMMON_EXIT.SUCCESS;
  if (parsed === "error") return SUMMON_EXIT.USER_ERROR;

  const paths = options.paths ?? resolvePaths();
  const persona = readPersona(paths, parsed.username);
  if (!persona) {
    stderr.write(`pantheon-summon: persona '${parsed.username}' not registered.\n`);
    return SUMMON_EXIT.USER_ERROR;
  }

  // Build a thin HandlerContext for the spawn call. No chat router,
  // no claimed session — just the pieces spawnPersona reads.
  const ctx = createContext({
    paths,
    spawn_executor: options.spawn_executor ?? realSpawnExecutor,
    spawn_env: options.spawn_env ?? process.env,
    summoner_username: process.env.PANTHEON_SUMMONER ?? null,
  });

  const handlerArgs: Record<string, unknown> = { username: persona.username };
  if (Object.keys(parsed.target).length > 0) handlerArgs.target = parsed.target;
  if (parsed.rest_timeout !== undefined) handlerArgs.rest_timeout = parsed.rest_timeout;
  if (parsed.resume) handlerArgs.resume = parsed.resume;
  if (parsed.prompt !== undefined) handlerArgs.prompt = parsed.prompt;
  if (parsed.channels !== undefined) handlerArgs.channels = parsed.channels;
  if (parsed.remote_control !== undefined) handlerArgs.remote_control = parsed.remote_control;

  // Resolve --chat-username-suffix BEFORE spawning so the bootstrap
  // text embeds the right chat handle. `auto` walks the presence DB
  // for the first free `<base><N>`.
  if (parsed.chat_username_suffix !== undefined) {
    const resolved = resolveChatSuffix(paths, persona.username, parsed.chat_username_suffix, stderr);
    if (resolved === null) return SUMMON_EXIT.USER_ERROR;
    handlerArgs.chat_username_suffix = resolved;
  }

  try {
    const result = await spawnPersona(handlerArgs, ctx, persona);
    stdout.write(JSON.stringify(result, null, 2) + "\n");
    return SUMMON_EXIT.SUCCESS;
  } catch (err) {
    if (err instanceof ToolError && err.code === "spawn_failed") {
      stderr.write(`pantheon-summon: spawn_failed: ${err.message}\n`);
      const extra = err.extra as { stderr?: string };
      if (extra.stderr) stderr.write(`  captured stderr: ${extra.stderr}\n`);
      return SUMMON_EXIT.SPAWN_FAILED;
    }
    if (err instanceof IdentityError) {
      stderr.write(`pantheon-summon: ${err.code}: ${err.message}\n`);
      return SUMMON_EXIT.USER_ERROR;
    }
    if (err instanceof AdapterError) {
      // unsupported_capability under --target-strict, etc.
      stderr.write(`pantheon-summon: ${err.code}: ${err.message}\n`);
      return SUMMON_EXIT.USER_ERROR;
    }
    if (err instanceof ToolError) {
      stderr.write(`pantheon-summon: ${err.code}: ${err.message}\n`);
      return SUMMON_EXIT.USER_ERROR;
    }
    stderr.write(`pantheon-summon: unexpected: ${(err as Error).message}\n`);
    return SUMMON_EXIT.USER_ERROR;
  }
}

function parseArgs(argv: string[], stderr: NodeJS.WritableStream): ParsedArgs | "help" | "error" {
  let username = "";
  const target: SpawnTarget = {};
  let rest_timeout: number | "never" | undefined;
  let resume = false;
  let prompt: string | undefined;
  const channels: string[] = [];
  let remote_control: boolean | string | undefined;
  let chat_username_suffix: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--help":
      case "-h":
        printHelp(stderr);
        return "help";
      case "--target-mode": {
        const m = argv[++i];
        if (
          m !== "new-window" &&
          m !== "new-tab-here" &&
          m !== "new-tab-window" &&
          m !== "split-pane"
        ) {
          stderr.write(
            `pantheon-summon: --target-mode must be one of new-window/new-tab-here/new-tab-window/split-pane; got '${m}'\n`,
          );
          return "error";
        }
        target.mode = m as SpawnMode;
        break;
      }
      case "--target-window":
        target.window = argv[++i] ?? "";
        if (!target.window) {
          stderr.write("pantheon-summon: --target-window requires a value\n");
          return "error";
        }
        break;
      case "--target-split": {
        const s = argv[++i];
        if (s === "h" || s === "horizontal") target.split = "horizontal";
        else if (s === "v" || s === "vertical") target.split = "vertical";
        else {
          stderr.write(`pantheon-summon: --target-split must be h|horizontal|v|vertical; got '${s}'\n`);
          return "error";
        }
        break;
      }
      case "--target-tab-index": {
        const n = Number(argv[++i] ?? "");
        if (!Number.isFinite(n) || n < 0) {
          stderr.write("pantheon-summon: --target-tab-index must be a non-negative integer\n");
          return "error";
        }
        target.tab_index = n;
        break;
      }
      case "--target-strict":
        target.strict = true;
        break;
      case "--target-escape-tmux":
        target.escape_tmux = true;
        break;
      case "--rest-timeout": {
        const v = argv[++i] ?? "";
        if (v === "never") {
          rest_timeout = "never";
        } else {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 60) {
            stderr.write("pantheon-summon: --rest-timeout must be 'never' or a positive number of seconds (≥60)\n");
            return "error";
          }
          rest_timeout = n;
        }
        break;
      }
      case "--resume":
        resume = true;
        break;
      case "--prompt":
        prompt = argv[++i] ?? "";
        if (prompt === "") {
          stderr.write("pantheon-summon: --prompt requires a value\n");
          return "error";
        }
        break;
      case "--channels": {
        const v = argv[++i];
        if (v === undefined || v === "" || v.startsWith("--")) {
          stderr.write("pantheon-summon: --channels requires a value (e.g. plugin:name@marketplace)\n");
          return "error";
        }
        channels.push(v);
        break;
      }
      case "--remote-control":
      case "--rc": {
        // Optional value: consume next arg only if it isn't a flag.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          remote_control = next;
          i++;
        } else {
          remote_control = true;
        }
        break;
      }
      case "--chat-username-suffix": {
        const v = argv[++i] ?? "";
        if (v === "" || v.startsWith("--")) {
          stderr.write(
            "pantheon-summon: --chat-username-suffix requires a value (positive integer or 'auto')\n",
          );
          return "error";
        }
        if (v !== "auto") {
          const n = Number(v);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n < 2) {
            stderr.write(
              `pantheon-summon: --chat-username-suffix must be 'auto' or a positive integer ≥ 2; got '${v}'\n`,
            );
            return "error";
          }
        }
        chat_username_suffix = v;
        break;
      }
      default:
        if (a.startsWith("--")) {
          stderr.write(`pantheon-summon: unknown flag '${a}'\n`);
          return "error";
        }
        if (!username) {
          username = a;
        } else {
          stderr.write(`pantheon-summon: unexpected positional argument '${a}'\n`);
          return "error";
        }
    }
  }

  if (!username) {
    stderr.write("pantheon-summon: <username> is required\n");
    return "error";
  }
  const result: ParsedArgs = { username, target, resume };
  if (rest_timeout !== undefined) result.rest_timeout = rest_timeout;
  if (prompt !== undefined) result.prompt = prompt;
  if (channels.length > 0) result.channels = channels;
  if (remote_control !== undefined) result.remote_control = remote_control;
  if (chat_username_suffix !== undefined) result.chat_username_suffix = chat_username_suffix;
  return result;
}

/** Resolve `--chat-username-suffix N|auto` to the literal suffix
 * string the bootstrap embeds. `auto` walks the chat presence DB
 * (active subscribers) for the first available `<base><N>` (n=2..99).
 * Returns null and writes an error to stderr on failure (DB unreadable
 * or no slot found within the search window). */
function resolveChatSuffix(
  paths: Paths,
  base: string,
  raw: string,
  stderr: NodeJS.WritableStream,
): string | null {
  if (raw !== "auto") return raw;
  let db: ReturnType<typeof openChatDb> | null = null;
  try {
    db = openChatDb(paths.chatDbPath);
  } catch (err) {
    stderr.write(
      `pantheon-summon: --chat-username-suffix auto: failed to open chat db (${(err as Error).message}). Pass an explicit number instead.\n`,
    );
    return null;
  }
  try {
    const active = listActive(db);
    const taken = new Set(active.map((s) => s.username.toLowerCase()));
    for (let n = 2; n <= 99; n++) {
      const candidate = `${base}${n}`;
      if (!taken.has(candidate.toLowerCase())) return String(n);
    }
    stderr.write(
      `pantheon-summon: --chat-username-suffix auto: no free '${base}<N>' in [2..99]. Pass a higher explicit number.\n`,
    );
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // best-effort
    }
  }
}

function printHelp(stderr: NodeJS.WritableStream): void {
  stderr.write(
    `Usage: pantheon summon <username> [flags]

Spawn a registered persona into a terminal session. Reads the persona
from \`<personasDir>/<username>.json\` and calls the same handler path
the MCP \`summon\` tool uses.

Flags:
  --target-mode <mode>          new-window | new-tab-here | new-tab-window | split-pane
  --target-window <name>        Named window (durable identity for WT/etc.)
  --target-split <h|v>          Split direction for --target-mode split-pane (default v)
  --target-tab-index <n>        0-based tab index to focus before split-pane
  --target-strict               Error on unsupported capability instead of downgrading
  --target-escape-tmux          From inside tmux, dispatch to the host terminal adapter
  --rest-timeout <secs|never>   Per-summon auto-rest deadline (≥60s; default 3600)
  --resume                      Use the persona's saved resume_session_id (if any)
  --prompt <text>               Runtime prompt forwarded to the spawned agent
  --channels <plugin:name@mkt>  Forward as --channels to claude (repeatable; overrides persona.channels)
  --remote-control [name], --rc Forward as --remote-control to claude. Default name = persona.project.
  --chat-username-suffix <N|auto>
                                Chat as <persona><N> instead of <persona>. Use when another session
                                already holds the canonical handle. 'auto' picks the next free
                                number from the chat presence DB. Persona identity stays canonical.
  --help                        This message

Exit codes:
  0  success
  1  user error (unknown persona / bad target / missing args)
  2  spawn failed (200ms stderr probe captured output)
`,
  );
}
