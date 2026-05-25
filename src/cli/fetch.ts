import {
  DEFAULT_COALESCE_WINDOW_MS,
  DEFAULT_WAIT_MS,
  SessionExpiredError,
  listActive,
  tailLoop,
  tailOnce,
  type LoopOptions,
  type PresenceRow,
  type ReceiverState,
} from "../chat/index.ts";
import { openChatDb, resolvePaths, type Paths } from "../storage/index.ts";
import { getResponseTemplate } from "../responses/templates.ts";
import { EXIT_CODES } from "./exit-codes.ts";

/** Stream + diagnostic surfaces are injectable so the dispatcher
 * (`bin/pantheon.ts`) and the standalone entry
 * (`bin/pantheon-fetch.ts`) can both call this without re-exec.
 * Tests can pass mocks. */
export interface RunFetchOptions {
  args: string[];
  /** Optional override for the env-driven path resolver. */
  paths?: Paths;
  signal?: AbortSignal;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Run the fetch CLI logic to completion. Returns the intended exit
 * code; the caller decides whether to actually `process.exit(...)`. */
export async function runFetch(options: RunFetchOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseArgs(options.args, stderr);
  if (parsed === "help") return EXIT_CODES.SUCCESS;
  if (parsed === "error") return EXIT_CODES.USER_ERROR;

  const paths = options.paths ?? resolvePaths();
  const db = openChatDb(paths.chatDbPath);

  const receiver = lookupReceiver(db, parsed.agent_id);
  if (!receiver) {
    writePresenceLapsedStderr(stderr, parsed.agent_id);
    db.close();
    return EXIT_CODES.PRESENCE_LAPSED;
  }
  if (parsed.mode_override) receiver.mode = parsed.mode_override;
  printBanner(receiver, stderr);

  if (!parsed.loop) {
    const events = tailOnce({ db, receiver, since_seq: 0 });
    for (const e of events) stdout.write(e.line + "\n");
    db.close();
    return EXIT_CODES.SUCCESS;
  }

  // Build the loop signal — combine the caller's optional signal
  // with SIGTERM/SIGINT handlers when running standalone.
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const onSig = () => controller.abort();
  process.on("SIGTERM", onSig);
  process.on("SIGINT", onSig);

  const loopOptions: LoopOptions = {
    db,
    agent_id: parsed.agent_id,
    wait_ms: parsed.wait_ms,
    coalesce_window_ms: parsed.coalesce_window_ms,
    signal: controller.signal,
    ...(parsed.mode_override !== undefined ? { mode_override: parsed.mode_override } : {}),
  };

  try {
    for await (const event of tailLoop(loopOptions)) {
      stdout.write(event.line + "\n");
    }
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      writePresenceLapsedStderr(stderr, parsed.agent_id);
      db.close();
      process.off("SIGTERM", onSig);
      process.off("SIGINT", onSig);
      return EXIT_CODES.PRESENCE_LAPSED;
    }
    db.close();
    process.off("SIGTERM", onSig);
    process.off("SIGINT", onSig);
    throw err;
  }
  db.close();
  process.off("SIGTERM", onSig);
  process.off("SIGINT", onSig);
  return EXIT_CODES.SUCCESS;
}

interface ParsedArgs {
  agent_id: string;
  loop: boolean;
  wait_ms: number;
  mode_override?: "all" | "quiet" | "project" | "dm";
  coalesce_window_ms: number;
}

function parseArgs(argv: string[], stderr: NodeJS.WritableStream): ParsedArgs | "help" | "error" {
  const out: ParsedArgs = {
    agent_id: "",
    loop: false,
    wait_ms: DEFAULT_WAIT_MS,
    coalesce_window_ms: DEFAULT_COALESCE_WINDOW_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--agent-id":
        out.agent_id = argv[++i] ?? "";
        break;
      case "--loop":
        out.loop = true;
        break;
      case "--wait":
        out.wait_ms = Number(argv[++i] ?? "");
        break;
      case "--coalesce":
        out.coalesce_window_ms = Number(argv[++i] ?? "");
        break;
      case "--mode": {
        const m = argv[++i];
        if (m === "all" || m === "quiet" || m === "project" || m === "dm") {
          out.mode_override = m;
        } else {
          stderr.write(`pantheon-fetch: --mode must be one of all/quiet/project/dm; got '${m}'\n`);
          return "error";
        }
        break;
      }
      case "--help":
      case "-h":
        printHelp(stderr);
        return "help";
      default:
        stderr.write(`pantheon-fetch: Unknown argument: ${a}\n`);
        return "error";
    }
  }
  if (!out.agent_id) {
    stderr.write("pantheon-fetch: --agent-id is required\n");
    return "error";
  }
  if (!Number.isFinite(out.wait_ms) || out.wait_ms < 50) {
    stderr.write("pantheon-fetch: --wait must be a number ≥50 (ms)\n");
    return "error";
  }
  if (!Number.isFinite(out.coalesce_window_ms) || out.coalesce_window_ms < 0) {
    stderr.write("pantheon-fetch: --coalesce must be a non-negative number (ms)\n");
    return "error";
  }
  return out;
}

function printHelp(stderr: NodeJS.WritableStream): void {
  stderr.write(
    `Usage: pantheon-fetch --agent-id <id> [--loop] [--wait <ms>] [--mode <m>] [--coalesce <ms>]

Streams chat events for the given subscriber from pantheon's chat.db.

Options:
  --agent-id <id>     Subscriber id to receive events for. Required.
  --loop              Long-poll; default is one-shot read.
  --wait <ms>         Poll interval when no new rows (default 500, min 50).
  --mode <m>          Override receiver mode: all|quiet|project|dm.
  --coalesce <ms>     Silent-event coalesce window (default 1000).
  --help              This message.

Reads ~/.pantheon/chat.db (PANTHEON_HOME-aware for test sandboxes).
`,
  );
}

/** Emit the unified `presence_lapsed` stderr message. The leading
 * token (`pantheon-fetch: presence_lapsed agent_id=<id>`) is stable
 * and parseable so callers (agent harnesses, shell wrappers) can
 * detect the lapse deterministically without scraping prose. Used
 * from both the startup-lookup-fail path and the mid-loop
 * SessionExpiredError path so the two converge on a single contract. */
function writePresenceLapsedStderr(
  stderr: NodeJS.WritableStream,
  agent_id: string,
): void {
  stderr.write(
    `pantheon-fetch: presence_lapsed agent_id=${agent_id}\n` +
      `Recovery: call mcp__pantheon__login({...}) with the same username/project. ` +
      `Pantheon will issue a fresh agent_id; use the new Monitor command from ` +
      `the response's \`note\` field. This watcher cannot resume.\n`,
  );
}

function lookupReceiver(
  db: ReturnType<typeof openChatDb>,
  agent_id: string,
): ReceiverState | null {
  const rows = listActive(db);
  const me = rows.find((r: PresenceRow) => r.agent_id === agent_id);
  if (!me) return null;
  return {
    agent_id,
    username: me.username,
    project: me.project,
    mode: me.mode,
  };
}

function printBanner(receiver: ReceiverState, stderr: NodeJS.WritableStream): void {
  let banner: string;
  try {
    banner = getResponseTemplate("watcher-banner", {
      username: receiver.username,
      project: receiver.project,
      mode: receiver.mode,
    });
  } catch {
    banner =
      `[pantheon-fetch] streaming for ${receiver.username} ` +
      `(project: ${receiver.project}) [mode=${receiver.mode}]`;
  }
  stderr.write(banner + "\n");
}
