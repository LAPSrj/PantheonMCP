import { IdentityError, readPersona } from "../identity/index.ts";
import { resolvePaths, type Paths } from "../storage/index.ts";
import {
  AdapterError,
  realSpawnExecutor,
  type SpawnExecutor,
  type SpawnMode,
  type SpawnTarget,
} from "../launcher/index.ts";
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
  return result;
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
  --help                        This message

Exit codes:
  0  success
  1  user error (unknown persona / bad target / missing args)
  2  spawn failed (200ms stderr probe captured output)
`,
  );
}
