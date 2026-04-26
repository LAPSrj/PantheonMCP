import readline from "node:readline";
import { openChatDb, resolvePaths, type Paths } from "../storage/index.ts";
import { randomUUID } from "node:crypto";
import { ChatRouter, listActive } from "../chat/index.ts";
import { tailLoop } from "../chat/watcher.ts";
import { heartbeat, upsertSubscriber, removeSubscriber } from "../chat/presence.ts";
import type { Subscriber } from "../chat/types.ts";
import { EXIT_CODES } from "./exit-codes.ts";

/** §11b CLI `pantheon console` — interactive admin REPL.
 *
 * Watch every chat event in real time + broadcast as `admin` (DM,
 * project, or global). Models the same `[admin] >` prompt + slash
 * command surface as chat-mcp's console.ts.
 *
 * Architectural note: pantheon doesn't have a daemon-client model
 * (one MCP process per CC session, per §15). The console writes
 * straight to `chat.db` via a transient `ChatRouter` and reads via
 * the same `tailLoop` the per-agent watcher uses. SQLite WAL handles
 * concurrent writes from running MCP processes; the console doesn't
 * register as a subscriber (no presence row, no heartbeat) so it
 * never appears in `list_agents`.
 *
 * The "admin" identity is synthetic. Outbound messages set
 * `from_agent_id: "system"` + `system_actor: "admin"` so the watcher
 * gives them the `[likely reply]` priority tag (per
 * `priorityTagForRow`) and the body is prefixed with `[ADMIN]` for
 * visual clarity in the tail. */

export interface RunConsoleOptions {
  args: string[];
  paths?: Paths;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
}

interface ParsedArgs {
  tail: number;
  color: boolean;
  roster: boolean;
}

const HELP = `pantheon console — interactive admin chat (watch + broadcast)

Options:
  --tail N       Print last N messages on start (default 20, max 500).
  --no-tail      Skip backfill, only show new messages.
  --color        Force ANSI colors.
  --no-color     Disable ANSI colors.
  --no-roster    Skip the pinned roster strip above the prompt.
  --help, -h     This message.

Prompt commands (type at the [admin] > prompt):
  <text>                   Broadcast as admin to scope=global (default).
  /g <text>                Same as above.
  /dm <user> <text>        DM to <user> as admin.
  /proj <project> <text>   Broadcast to project <project>. Short: /p
  /who                     Print currently connected agents (names only).
  /status                  Print connected agents with their status lines.
  /help                    Show this.
  /quit                    Exit (Ctrl-C also works).
`;

function parseArgs(
  argv: string[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): ParsedArgs | "help" | "error" {
  const out: ParsedArgs = {
    tail: 20,
    color: process.stdout.isTTY ?? false,
    roster: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--help":
      case "-h":
        stdout.write(HELP);
        return "help";
      case "--no-color":
        out.color = false;
        break;
      case "--color":
        out.color = true;
        break;
      case "--no-tail":
        out.tail = 0;
        break;
      case "--no-roster":
        out.roster = false;
        break;
      case "--tail": {
        const n = Number(argv[++i] ?? "");
        if (!Number.isFinite(n) || n < 0) {
          stderr.write("pantheon-console: --tail expects a non-negative integer\n");
          return "error";
        }
        out.tail = Math.min(Math.floor(n), 500);
        break;
      }
      default:
        stderr.write(`pantheon-console: unknown argument '${a}'\n`);
        return "error";
    }
  }
  return out;
}

const ANSI: Record<string, string> = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  grey: "\x1b[90m",
  dim: "\x1b[2m",
};

function paint(color: boolean, kind: keyof typeof ANSI, text: string): string {
  if (!color) return text;
  return `${ANSI[kind]}${text}${ANSI.reset}`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export async function runConsole(options: RunConsoleOptions): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseArgs(options.args, stdout, stderr);
  if (parsed === "help") return EXIT_CODES.SUCCESS;
  if (parsed === "error") return EXIT_CODES.USER_ERROR;

  const paths = options.paths ?? resolvePaths();
  const db = openChatDb(paths.chatDbPath);
  // Transient router — re-exposes the same SQLite handle for writes.
  // No presence row registered (the console doesn't `add` itself).
  const router = new ChatRouter({ paths, db });

  const interactive = Boolean((stdin as NodeJS.ReadStream).isTTY);
  const prompt = paint(parsed.color, "bold", paint(parsed.color, "red", "[admin] > "));
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt,
    terminal: interactive,
  });

  // ---- Pinned roster + status area --------------------------------
  let statusLines: string[] = [];
  const rosterEnabled = parsed.roster && interactive;

  const statusHeight = (): number => {
    if (!rosterEnabled) return 0;
    const cols = (stdout as NodeJS.WriteStream).columns ?? 80;
    let rows = 0;
    for (const l of statusLines) {
      const visLen = stripAnsi(l).length;
      rows += Math.max(1, Math.ceil(visLen / cols));
    }
    return rows;
  };

  const clearStatusArea = (): void => {
    if (!rosterEnabled) return;
    readline.cursorTo(stdout as NodeJS.WriteStream, 0);
    readline.clearLine(stdout as NodeJS.WriteStream, 0);
    const h = statusHeight();
    if (h > 0) {
      readline.moveCursor(stdout as NodeJS.WriteStream, 0, -h);
      readline.clearScreenDown(stdout as NodeJS.WriteStream);
    }
  };

  const drawStatusArea = (): void => {
    if (rosterEnabled && statusLines.length > 0) {
      stdout.write(statusLines.join("\n") + "\n");
    }
    if (interactive) rl.prompt(true);
  };

  const refreshRoster = (): void => {
    if (!rosterEnabled) return;
    const rows = listActive(db);
    if (rows.length === 0) {
      statusLines = [paint(parsed.color, "grey", "(no connected agents)")];
      return;
    }
    const lines: string[] = [
      paint(parsed.color, "grey", "─".repeat(Math.min((stdout as NodeJS.WriteStream).columns ?? 80, 80))),
      paint(parsed.color, "bold", `${rows.length} connected:`),
    ];
    for (const r of rows) {
      const tag =
        r.mode === "quiet" ? "[Q]" : r.mode === "project" ? "[P]" : r.mode === "dm" ? "[D]" : "";
      const status = r.status ? paint(parsed.color, "dim", ` — ${r.status}`) : "";
      lines.push(`  ${paint(parsed.color, "cyan", r.username)}${tag} (${r.project})${status}`);
    }
    statusLines = lines;
  };

  const printLine = (line: string): void => {
    clearStatusArea();
    stdout.write(line + "\n");
    drawStatusArea();
  };

  // ---- Tail-on-start ---------------------------------------------
  if (parsed.tail > 0) {
    const rows = db
      .query(
        "SELECT * FROM messages ORDER BY seq DESC LIMIT ?",
      )
      .all(parsed.tail) as Array<{ id: string; seq: number; ts: number; text: string; scope: string; from_agent_id: string; target_username: string | null; project: string | null; kind: string | null; from_username_inline: string | null }>;
    for (const r of rows.reverse()) {
      const sender = r.from_username_inline ?? (r.from_agent_id === "system" ? "system" : `agent:${r.from_agent_id.slice(0, 8)}`);
      const time = new Date(r.ts).toISOString().slice(11, 19);
      const targetSuffix = r.scope === "dm" && r.target_username ? ` →${r.target_username}` : "";
      stdout.write(`${paint(parsed.color, "grey", time)} ${paint(parsed.color, "cyan", sender)}${targetSuffix}: ${r.text}\n`);
    }
  }

  // ---- Live tail --------------------------------------------------
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const onSig = () => controller.abort();
  if (interactive) {
    process.on("SIGTERM", onSig);
    process.on("SIGINT", onSig);
  }
  // Synthesize a presence row so tailLoop's loadReceiver can find us.
  // We bypass `router.add` (which would validate the username and
  // emit a `join` system event into the chat — both wrong for an
  // admin console). Instead, write directly to the presence table
  // via upsertSubscriber. The synthetic handle is reserved-looking
  // so it can't collide with real agents, and the row is removed on
  // shutdown. Status appears in `list_agents` while the console is
  // up — labeled so peers know it's not a real participant.
  const consoleSubscriber: Subscriber = {
    agent_id: `console-${randomUUID()}`,
    username: "console",
    project: "admin",
    transient: true,
    status: "(admin REPL)",
    mode: "all",
    connected_at: Date.now(),
    last_seen: Date.now(),
    status_updated_at: Date.now(),
    promoted_at: null,
  };
  upsertSubscriber(db, consoleSubscriber);

  const tailPromise = (async () => {
    try {
      for await (const event of tailLoop({
        db,
        agent_id: consoleSubscriber.agent_id,
        wait_ms: 500,
        coalesce_window_ms: 500,
        receiver_refresh_ms: 60 * 60 * 1000,
        signal: controller.signal,
        mode_override: "all",
      })) {
        printLine(event.line);
      }
    } catch (err) {
      stderr.write(`pantheon-console: tail error: ${(err as Error).message}\n`);
    }
  })();

  // Roster refresh + heartbeat every 5s. Heartbeat keeps the
  // synthetic presence row alive so pruneStale (30s threshold)
  // doesn't evict it mid-session.
  const rosterTimer = setInterval(() => {
    try {
      heartbeat(db, consoleSubscriber.agent_id);
    } catch {
      // best-effort
    }
    refreshRoster();
    if (interactive) {
      clearStatusArea();
      drawStatusArea();
    }
  }, 5_000);

  refreshRoster();
  if (interactive) drawStatusArea();

  // ---- Slash-command dispatcher ----------------------------------
  const broadcast = (
    scope: "global" | "project" | "dm",
    text: string,
    extras: { project?: string; target?: string } = {},
  ): void => {
    if (!text || text.length === 0) return;
    router.addMessage({
      from_agent_id: "system",
      scope,
      text: `[ADMIN] ${text}`,
      system: true,
      system_actor: "admin",
      from_username_inline: "admin",
      ...(extras.project !== undefined ? { project: extras.project } : {}),
      ...(extras.target !== undefined ? { target: extras.target } : {}),
    });
  };

  const handleLine = (raw: string): boolean => {
    const line = raw.trim();
    if (line.length === 0) return true;
    if (line === "/quit" || line === "/q") return false;
    if (line === "/help") {
      stdout.write(HELP);
      return true;
    }
    if (line === "/who") {
      const rows = listActive(db);
      stdout.write(`${rows.length} connected:\n`);
      for (const r of rows) stdout.write(`  ${r.username} (${r.project})\n`);
      return true;
    }
    if (line === "/status") {
      const rows = listActive(db);
      stdout.write(`${rows.length} connected:\n`);
      for (const r of rows) stdout.write(`  ${r.username} — ${r.status || "(no status)"}\n`);
      return true;
    }
    if (line.startsWith("/dm ")) {
      const rest = line.slice(4).trim();
      const sp = rest.indexOf(" ");
      if (sp <= 0) {
        stderr.write("Usage: /dm <user> <text>\n");
        return true;
      }
      broadcast("dm", rest.slice(sp + 1).trim(), { target: rest.slice(0, sp) });
      return true;
    }
    if (line.startsWith("/proj ") || line.startsWith("/p ")) {
      const rest = line.slice(line.indexOf(" ") + 1).trim();
      const sp = rest.indexOf(" ");
      if (sp <= 0) {
        stderr.write("Usage: /proj <project> <text>\n");
        return true;
      }
      broadcast("project", rest.slice(sp + 1).trim(), { project: rest.slice(0, sp) });
      return true;
    }
    if (line.startsWith("/g ")) {
      broadcast("global", line.slice(3).trim());
      return true;
    }
    if (line.startsWith("/")) {
      stderr.write(`pantheon-console: unknown command '${line.split(" ")[0]}'. Try /help.\n`);
      return true;
    }
    // Bare text → global broadcast.
    broadcast("global", line);
    return true;
  };

  if (interactive) {
    stdout.write(
      paint(parsed.color, "grey", "pantheon console — type /help for commands, /quit to exit.") + "\n",
    );
    rl.prompt();
    rl.on("line", (line) => {
      const cont = handleLine(line);
      if (!cont) {
        controller.abort();
        rl.close();
      } else {
        if (rosterEnabled) {
          // Caller already typed at the prompt; redraw status + reprompt.
          clearStatusArea();
          drawStatusArea();
        } else {
          rl.prompt();
        }
      }
    });
  } else {
    // Non-TTY mode: read each line from stdin, dispatch, exit on EOF.
    rl.on("line", (line) => handleLine(line));
  }

  await new Promise<void>((resolve) => {
    rl.once("close", () => resolve());
  });
  controller.abort();
  clearInterval(rosterTimer);
  await tailPromise;
  // Best-effort: remove the synthetic console subscriber row so it
  // doesn't sit in the presence table forever.
  try {
    removeSubscriber(db, consoleSubscriber.agent_id);
  } catch {
    // best-effort
  }
  if (interactive) {
    process.off("SIGTERM", onSig);
    process.off("SIGINT", onSig);
  }
  db.close();
  return EXIT_CODES.SUCCESS;
}
