#!/usr/bin/env bun
import {
  DEFAULT_COALESCE_WINDOW_MS,
  DEFAULT_WAIT_MS,
  tailLoop,
  tailOnce,
  type LoopOptions,
  type ReceiverState,
} from "../src/chat/index.ts";
import { listActive, type PresenceRow } from "../src/chat/index.ts";
import { openChatDb, resolvePaths } from "../src/storage/index.ts";
import { getResponseTemplate } from "../src/responses/templates.ts";

interface ParsedArgs {
  agent_id: string;
  loop: boolean;
  wait_ms: number;
  mode_override?: "all" | "quiet" | "project" | "dm";
  coalesce_window_ms: number;
}

function parseArgs(argv: string[]): ParsedArgs {
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
          die(`--mode must be one of all/quiet/project/dm; got '${m}'`);
        }
        break;
      }
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        die(`Unknown argument: ${a}`);
    }
  }
  if (!out.agent_id) die("--agent-id is required");
  if (!Number.isFinite(out.wait_ms) || out.wait_ms < 50) {
    die("--wait must be a number ≥50 (ms)");
  }
  if (!Number.isFinite(out.coalesce_window_ms) || out.coalesce_window_ms < 0) {
    die("--coalesce must be a non-negative number (ms)");
  }
  return out;
}

function printHelp(): void {
  process.stderr.write(
    `Usage: pantheon-fetch --agent-id <id> [--loop] [--wait <ms>] [--mode <m>] [--coalesce <ms>]

Streams chat events for the given subscriber from pantheon's chat.db.

Options:
  --agent-id <id>     Subscriber id to receive events for. Required.
  --loop              Long-poll; default is one-shot read.
  --wait <ms>         Poll interval when no new rows (default 500, min 50).
  --mode <m>          Override receiver mode: all|quiet|project|dm.
  --coalesce <ms>     Silent-event coalesce window (default 1000).
  --help              This message.

Reads ~/.local/share/pantheon/chat.db (XDG / PANTHEON_HOME aware).
`,
  );
}

function die(msg: string): never {
  process.stderr.write(`pantheon-fetch: ${msg}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolvePaths();
  const db = openChatDb(paths.chatDbPath);

  const receiver = lookupReceiver(db, args.agent_id);
  if (!receiver) {
    die(
      `agent_id '${args.agent_id}' has no active presence row. ` +
        `Did you 'login' first? Or did your presence heartbeat lapse?`,
    );
  }
  if (args.mode_override) receiver.mode = args.mode_override;

  // Startup banner: tag legend + receiver state. Goes to stderr so
  // stdout stays a pure event stream the Monitor tool can consume.
  printBanner(receiver);

  if (!args.loop) {
    const events = tailOnce({ db, receiver, since_seq: 0 });
    for (const e of events) process.stdout.write(e.line + "\n");
    db.close();
    return;
  }

  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());

  const options: LoopOptions = {
    db,
    agent_id: args.agent_id,
    wait_ms: args.wait_ms,
    coalesce_window_ms: args.coalesce_window_ms,
    signal: controller.signal,
    ...(args.mode_override !== undefined ? { mode_override: args.mode_override } : {}),
  };

  try {
    for await (const event of tailLoop(options)) {
      process.stdout.write(event.line + "\n");
    }
  } catch (err) {
    const { SessionExpiredError } = await import("../src/chat/index.ts");
    if (err instanceof SessionExpiredError) {
      process.stderr.write(
        `pantheon-fetch: ${err.message}\n` +
          `Action: call \`login\` again, then re-spawn the watcher with the new agent_id.\n`,
      );
      db.close();
      process.exit(3);
    }
    throw err;
  }
  db.close();
}

function lookupReceiver(db: ReturnType<typeof openChatDb>, agent_id: string): ReceiverState | null {
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

function printBanner(receiver: ReceiverState): void {
  // §6 HIGH stale-MCP-proxy mitigation: load from the
  // daemon-resolved templates so banner edits don't require a
  // restart of every running pantheon-fetch process.
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
  process.stderr.write(banner + "\n");
}

main().catch((err) => {
  process.stderr.write(`pantheon-fetch: fatal: ${(err as Error).message ?? String(err)}\n`);
  process.exit(1);
});
