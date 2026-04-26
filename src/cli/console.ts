import readline from "node:readline";
import { openChatDb, resolvePaths, type Paths } from "../storage/index.ts";
import { randomUUID } from "node:crypto";
import {
  ChatRouter,
  formatBatch,
  listActive,
  type PresenceRow,
  type ReceiverState,
} from "../chat/index.ts";
import { tailLoop } from "../chat/watcher.ts";
import type { MessageRow } from "../chat/persistence.ts";
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
 * concurrent writes from running MCP processes.
 *
 * The console DOES register a synthetic presence row so peers see it
 * in `list_agents` while connected — `username:"console"`,
 * `project:"admin"`, `transient:true`. The transient flag drives the
 * asterisk render (`console*`); pairing with project="admin" gives
 * the `console* (admin)` form yapsmith specced. Row is upserted
 * silently (no `router.add` → no `join` event) and removed silently
 * on shutdown (no `router.remove` → no `leave` event).
 *
 * Outbound messages set `from_agent_id: "system"` + `system_actor:
 * "admin"` so the watcher gives them the `[likely reply]` priority
 * tag (per `priorityTagForRow`) and the body is prefixed with
 * `[ADMIN]` for visual clarity in the tail. */

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
  /g <text>                Same as above.  Alias: /global
  /dm <user> <text>        DM to <user> as admin.
  /proj <project> <text>   Broadcast to project <project>.  Alias: /p
  /who                     Refresh the pinned roster.
  /status                  Print connected agents with their status lines.
  /help                    Show this.  Alias: /?
  /quit                    Exit.  Aliases: /exit, /q  (Ctrl-C also works.)
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

function modeMarkerForRow(mode: PresenceRow["mode"]): string {
  switch (mode) {
    case "quiet":
      return "[Q]";
    case "project":
      return "[P]";
    case "dm":
      return "[D]";
    default:
      return "";
  }
}

function rosterKey(rows: PresenceRow[]): string {
  // Stable signature for diff-detection. Only the fields the roster
  // actually renders: agent_id, username, project, mode, transient,
  // status. Heartbeat changes don't affect the rendered roster, so
  // they don't trigger a redraw.
  return rows
    .map((r) =>
      [r.agent_id, r.username, r.project, r.mode, r.transient ? "1" : "0", r.status].join("␟"),
    )
    .join("␞");
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
  const router = new ChatRouter({ paths, db });

  const interactive = Boolean((stdin as NodeJS.ReadStream).isTTY);
  const prompt = paint(parsed.color, "bold", paint(parsed.color, "red", "[admin] > "));
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt,
    terminal: interactive,
  });

  const widthOf = (): number => (stdout as NodeJS.WriteStream).columns ?? 80;

  const separator = (): string =>
    paint(parsed.color, "grey", "─".repeat(Math.min(widthOf(), 80)));

  // ---- Pinned roster + status area --------------------------------
  let statusLines: string[] = [];
  const rosterEnabled = parsed.roster && interactive;

  const statusHeight = (): number => {
    if (!rosterEnabled) return 0;
    const cols = widthOf();
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

  // ---- Roster rendering ------------------------------------------
  // Group by project, sort projects alphabetically, sort users
  // case-insensitive within each project. Transient subscribers
  // render with an asterisk suffix (`console*`) — matches §10's
  // guest marker. Mode tag ([Q]/[P]/[D]) appended after the name.
  const renderRoster = (rows: PresenceRow[]): string[] => {
    if (rows.length === 0) return [paint(parsed.color, "grey", "(no connected agents)")];
    const byProject = new Map<string, PresenceRow[]>();
    for (const r of rows) {
      const list = byProject.get(r.project);
      if (list) list.push(r);
      else byProject.set(r.project, [r]);
    }
    const projects = Array.from(byProject.keys()).sort();
    const lines: string[] = [
      paint(parsed.color, "grey", "─".repeat(Math.min(widthOf(), 80))),
      paint(parsed.color, "grey", `${rows.length} agent(s) connected:`),
    ];
    const sep = paint(parsed.color, "grey", ", ");
    for (const proj of projects) {
      const users = byProject
        .get(proj)!
        .slice()
        .sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" }))
        .map((r) => {
          const name = paint(parsed.color, "cyan", r.transient ? `${r.username}*` : r.username);
          const tag = modeMarkerForRow(r.mode);
          return tag ? `${name} ${paint(parsed.color, "yellow", tag)}` : name;
        })
        .join(sep);
      lines.push(`  ${paint(parsed.color, "grey", `[${proj}]`)} ${users}`);
    }
    return lines;
  };

  const renderStatusList = (rows: PresenceRow[]): string[] => {
    if (rows.length === 0) return [paint(parsed.color, "grey", "(no connected agents)")];
    const byProject = new Map<string, PresenceRow[]>();
    for (const r of rows) {
      const list = byProject.get(r.project);
      if (list) list.push(r);
      else byProject.set(r.project, [r]);
    }
    const projects = Array.from(byProject.keys()).sort();
    const lines: string[] = [
      paint(parsed.color, "grey", `${rows.length} agent(s) connected:`),
    ];
    for (const proj of projects) {
      lines.push(paint(parsed.color, "grey", `  [${proj}]`));
      const users = byProject
        .get(proj)!
        .slice()
        .sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" }));
      for (const r of users) {
        const name = paint(
          parsed.color,
          "cyan",
          r.transient ? `${r.username}*` : r.username,
        );
        const tag = modeMarkerForRow(r.mode);
        const head = tag ? `${name} ${paint(parsed.color, "yellow", tag)}` : name;
        const status = r.status ? paint(parsed.color, "dim", ` — ${r.status}`) : "";
        lines.push(`    ${head}${status}`);
      }
    }
    return lines;
  };

  let lastRosterKey = "";

  const refreshRoster = (force: boolean = false): void => {
    if (!rosterEnabled) return;
    const rows = listActive(db);
    const key = rosterKey(rows);
    if (!force && key === lastRosterKey) return;
    lastRosterKey = key;
    statusLines = renderRoster(rows);
    clearStatusArea();
    drawStatusArea();
  };

  const printMessage = (line: string): void => {
    // Same as printLine but with a per-message separator (UX parity
    // with chat-mcp). The separator visually delimits each message
    // so multi-line bodies (status_digest, pasted text) don't blur.
    clearStatusArea();
    stdout.write(line + "\n" + separator() + "\n");
    drawStatusArea();
  };

  // ---- Synthetic console subscriber ------------------------------
  // Bypass `router.add` (would validate the username + emit a `join`
  // system event into the chat — both wrong for an admin console).
  // Instead, write directly to the presence table via
  // upsertSubscriber. The reserved-looking handle can't collide with
  // real agents; the row is removed on shutdown via removeSubscriber
  // (NOT router.remove — same reason: no `leave` event).
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

  // ---- Tail-on-start ---------------------------------------------
  // Read the last N raw rows directly and run them through
  // `formatBatch` with the synthetic admin receiver — same renderer
  // the live stream uses, so cold backfill and live tail share one
  // grammar. We deliberately skip the visibility/deliverability
  // filter for backfill so admin can browse the full history.
  if (parsed.tail > 0) {
    const rows = db
      .query("SELECT * FROM messages ORDER BY seq DESC LIMIT ?")
      .all(parsed.tail) as MessageRow[];
    const ascending = rows.reverse();
    const receiver: ReceiverState = {
      agent_id: consoleSubscriber.agent_id,
      username: consoleSubscriber.username,
      project: consoleSubscriber.project,
      mode: "all",
    };
    const events = formatBatch(ascending, receiver);
    for (const e of events) {
      stdout.write(e.line + "\n" + separator() + "\n");
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
        printMessage(event.line);
        // Event-driven roster refresh: any presence change (join,
        // leave, rename, project_change, status_update, profile_update,
        // handle_recycled) updates the subscribers table. Diff against
        // the last rendered key — if the visible roster changed,
        // refresh. Avoids parsing the silent-event body. Status-only
        // updates DO show in /status output, so we refresh on those
        // too — yapsmith's verdict said skip status, but pantheon's
        // /status output is the same data the pinned roster could
        // surface and admins need it live.
        refreshRoster();
      }
    } catch (err) {
      stderr.write(`pantheon-console: tail error: ${(err as Error).message}\n`);
    }
  })();

  // Heartbeat the synthetic presence row every 5s so pruneStale
  // (30s threshold) doesn't evict the console mid-session. Roster
  // refresh is event-driven now, not timer-driven.
  const heartbeatTimer = setInterval(() => {
    try {
      heartbeat(db, consoleSubscriber.agent_id);
    } catch {
      // best-effort
    }
  }, 5_000);

  refreshRoster(true);
  if (interactive) {
    stdout.write(
      paint(parsed.color, "grey", "pantheon console — type /help for commands, /quit to exit.") +
        "\n",
    );
  }

  // ---- Resize handler --------------------------------------------
  // Without this, the pinned roster corrupts on terminal resize until
  // the next refresh. Re-prompt forces readline to redraw the input
  // buffer at the current width.
  const onResize = () => {
    if (interactive && rosterEnabled) {
      // Re-render at the new width.
      const rows = listActive(db);
      statusLines = renderRoster(rows);
      lastRosterKey = rosterKey(rows);
      clearStatusArea();
      drawStatusArea();
    } else if (interactive) {
      rl.prompt(true);
    }
  };
  if (interactive) {
    (stdout as NodeJS.WriteStream).on("resize", onResize);
  }

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
    if (line === "/quit" || line === "/q" || line === "/exit") return false;
    if (line === "/help" || line === "/?") {
      stdout.write(HELP);
      return true;
    }
    if (line === "/who") {
      // Refresh the pinned roster (don't print into the message
      // stream — that's double-rendering with a pinned roster).
      refreshRoster(true);
      return true;
    }
    if (line === "/status") {
      const rows = listActive(db);
      const block = renderStatusList(rows).join("\n");
      printMessage(block);
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
    if (line.startsWith("/g ") || line.startsWith("/global ")) {
      const text = line.startsWith("/g ") ? line.slice(3).trim() : line.slice(8).trim();
      broadcast("global", text);
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
    rl.prompt();
    rl.on("line", (line) => {
      const cont = handleLine(line);
      if (!cont) {
        controller.abort();
        rl.close();
      } else {
        // rl.prompt(true) preserves any mid-typed buffer; covers the
        // race where a system event lands between line completion and
        // the next render pass.
        clearStatusArea();
        drawStatusArea();
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
  clearInterval(heartbeatTimer);
  if (interactive) {
    (stdout as NodeJS.WriteStream).off("resize", onResize);
  }
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
