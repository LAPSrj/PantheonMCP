import readline from "node:readline";
import { openChatDb, resolvePaths, type Paths } from "../storage/index.ts";
import { ChatRouter, listActive, type PresenceRow } from "../chat/index.ts";
import type { MessageRow } from "../chat/persistence.ts";
import { EXIT_CODES } from "./exit-codes.ts";
import {
  buildPresenceIndex,
  createFormatter,
  normalizeRow,
  paintWith,
} from "./console-format.ts";

/** §11b CLI `pantheon console` — interactive admin REPL.
 *
 * Watch every chat event in real time + broadcast as `admin` (DM,
 * project, or global). Behavior + visuals mirror chat-mcp/src/console.ts:
 * the same `[admin] >` prompt, slash commands, pinned roster strip,
 * per-message separator, and the chat-mcp formatter (rich headers +
 * markdown body wrap). The only special-cased actor in pantheon is
 * the console — there is no general role attribute.
 *
 * Architectural note: pantheon doesn't have a daemon-client model
 * (one MCP process per CC session, per §15). The console writes
 * straight to `chat.db` via a transient `ChatRouter` and reads via
 * a SQLite-tail loop scoped to the console (no priority-tag prefix,
 * no silent-event coalescing — those are watcher concerns for AI
 * agents, not the human admin).
 *
 * The console does NOT register a presence row — chat-mcp's admin
 * console is invisible to peers and pantheon mirrors that. Peers
 * see only real agents in `list_agents`.
 *
 * Outbound messages set `from_agent_id: "system"` +
 * `from_username_inline: "admin"`. That pair is the canonical admin
 * discriminator (both fields persist in SQLite, so cross-process
 * consumers — watcher, audit replay — detect admin without a separate
 * field). */

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
  --tail N       Print last N messages on start (default 20, max 500)
  --no-tail      Skip backfill, only show new messages
  --color        Force ANSI colors
  --no-color     Disable ANSI colors
  --no-roster    Skip the pinned roster strip above the prompt

Prompt commands (type at the [admin] > prompt):
  <text>                   Broadcast as admin to scope=global (default).
  /g <text>                Same as above.
  /dm <user> <text>        DM to <user> as admin.
  /proj <project> <text>   Broadcast to project <project>. Short: /p
  /who                     Print currently connected agents (names only, pinned).
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
  const router = new ChatRouter({ paths, db });

  const interactive = Boolean((stdin as NodeJS.ReadStream).isTTY);
  const paint = paintWith(parsed.color);
  const { format } = createFormatter(parsed.color);
  const promptStr = paint("bold", paint("red", "[admin] > "));
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt: promptStr,
    terminal: interactive,
  });

  const widthOf = (): number => (stdout as NodeJS.WriteStream).columns ?? 80;

  const separator = (): string => {
    // Width-1 to avoid the phantom-wrap on cols-wide writes: a line
    // exactly cols chars long leaves the cursor at col=cols (off-screen)
    // and the trailing \n then advances another row, producing a
    // visually-empty extra row that statusHeight() doesn't count. With
    // width-1 the cursor stays in the visible region and \n advances
    // exactly one row.
    const cols = widthOf();
    const w = Math.max(1, (cols > 0 ? cols : 80) - 1);
    return paint("grey", "─".repeat(w));
  };

  // ---- Pinned roster + status area --------------------------------
  // Use ANSI cursor save/restore (DECSC/DECRC) to mark where the
  // status area begins. On clear, restore to that mark and clear from
  // there to end of screen — sidesteps height-calculation off-by-ones
  // (separator phantom-wraps, rl.prompt(true) cursor desync after raw
  // stdout.write, etc.) by relying on the terminal's own cursor
  // tracking.
  //
  // The save mark is placed just BEFORE writing statusLines, so a
  // restore lands at the row where status started — exactly where new
  // content should overwrite. WSL/Windows Terminal supports DECSC/DECRC.
  let statusLines: string[] = [];
  let statusDrawn = false;
  const rosterEnabled = parsed.roster && interactive;

  const SAVE_CURSOR = "\x1b7";
  const RESTORE_CURSOR = "\x1b8";
  const CLEAR_TO_END = "\x1b[J";

  const clearStatusArea = (): void => {
    if (!rosterEnabled || !statusDrawn) return;
    stdout.write(RESTORE_CURSOR);
    stdout.write(CLEAR_TO_END);
    statusDrawn = false;
  };

  const drawStatusArea = (): void => {
    if (rosterEnabled && statusLines.length > 0) {
      stdout.write(SAVE_CURSOR);
      stdout.write(statusLines.join("\n") + "\n");
      statusDrawn = true;
    }
    if (interactive) rl.prompt(true);
  };

  const printLine = (line: string): void => {
    clearStatusArea();
    stdout.write(line + "\n");
    drawStatusArea();
  };

  const printRow = (row: MessageRow, presence: ReadonlyMap<string, PresenceRow>): void => {
    const cm = normalizeRow(row, presence);
    printLine(format(cm) + "\n" + separator());
  };

  // ---- Keepalive coalescing (parity with chat-mcp) --------------
  // Keepalives fan out to every non-channels agent in the same daemon
  // sweep, so they arrive in a burst (microseconds apart on push, or
  // a single SQL batch on pull). Rendering each individually means
  // the admin sees the same roster dump N times in a row. Coalesce:
  // buffer targets for KEEPALIVE_COALESCE_MS, then emit one summary
  // line "HH:MM:SS · keepalive — pinged N: alice, bob, ...".
  const KEEPALIVE_COALESCE_MS = 500;
  let keepaliveBuf: { ts: number; targets: string[] } | null = null;
  let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

  const renderKeepaliveSummary = (ts: number, targets: string[]): string => {
    const when = new Date(ts).toLocaleTimeString("en-GB");
    const time = paint("grey", when);
    // Build each ANSI segment independently — nesting grey around an
    // already-bolded count would reset to default fg for the rest of
    // the line when the inner bold-reset fires.
    const intro = paint("grey", "keepalive — pinged ");
    const count = paint("bold", paint("grey", String(targets.length)));
    const tail = paint("grey", `: ${targets.join(", ")}`);
    return `${time} ${paint("grey", "·")} ${intro}${count}${tail}\n${separator()}`;
  };

  const flushKeepaliveBuf = (): void => {
    if (!keepaliveBuf) return;
    const { ts, targets } = keepaliveBuf;
    keepaliveBuf = null;
    if (keepaliveTimer) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }
    printLine(renderKeepaliveSummary(ts, targets));
  };

  const handleKeepaliveLive = (row: MessageRow): void => {
    const target = row.target_username ?? "?";
    if (!keepaliveBuf) keepaliveBuf = { ts: row.ts, targets: [] };
    if (!keepaliveBuf.targets.includes(target)) {
      keepaliveBuf.targets.push(target);
    }
    if (keepaliveTimer) clearTimeout(keepaliveTimer);
    keepaliveTimer = setTimeout(flushKeepaliveBuf, KEEPALIVE_COALESCE_MS);
  };

  // ---- Roster rendering (parity with chat-mcp) -------------------
  // Group by project, sort projects alphabetically, sort users
  // case-insensitive within each project. Transient subscribers
  // render with an asterisk suffix (`console*`) — matches the §10
  // guest marker. Mode tag ([Q]/[P]/[D]) appended after the name.
  const renderRoster = (rows: PresenceRow[]): string[] => {
    if (rows.length === 0) return [paint("grey", "(no agents connected)")];
    const byProject = new Map<string, PresenceRow[]>();
    for (const r of rows) {
      const list = byProject.get(r.project);
      if (list) list.push(r);
      else byProject.set(r.project, [r]);
    }
    const projects = Array.from(byProject.keys()).sort();
    const lines: string[] = [
      paint("grey", `${rows.length} agent(s) connected:`),
    ];
    const sep = paint("grey", ", ");
    for (const proj of projects) {
      const users = byProject
        .get(proj)!
        .slice()
        .sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" }))
        .map((r) => {
          const display = r.transient ? `${r.username}*` : r.username;
          const name = paint("bold", paint("cyan", display));
          const tag = modeMarkerForRow(r.mode);
          return tag ? `${name} ${paint("yellow", tag)}` : name;
        })
        .join(sep);
      lines.push(`  ${paint("grey", `[${proj}]`)} ${users}`);
    }
    return lines;
  };

  const renderStatusList = (rows: PresenceRow[]): string[] => {
    if (rows.length === 0) return [paint("grey", "(no agents connected)")];
    const byProject = new Map<string, PresenceRow[]>();
    for (const r of rows) {
      const list = byProject.get(r.project);
      if (list) list.push(r);
      else byProject.set(r.project, [r]);
    }
    const projects = Array.from(byProject.keys()).sort();
    const lines: string[] = [
      paint("grey", `${rows.length} agent(s) connected:`),
    ];
    for (const proj of projects) {
      lines.push(paint("grey", `  [${proj}]`));
      const users = byProject
        .get(proj)!
        .slice()
        .sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" }));
      for (const r of users) {
        const display = r.transient ? `${r.username}*` : r.username;
        const name = paint("bold", paint("cyan", display));
        const tag = modeMarkerForRow(r.mode);
        const head = tag ? `${name} ${paint("yellow", tag)}` : name;
        const status = r.status ? paint("grey", ` — ${r.status}`) : "";
        lines.push(`    ${head}${status}`);
      }
    }
    return lines;
  };

  let lastRosterKey = "";
  let presenceIndex = new Map<string, PresenceRow>();

  const refreshRoster = (force: boolean = false): void => {
    const rows = listActive(db);
    presenceIndex = buildPresenceIndex(rows);
    if (!rosterEnabled) return;
    const visibleRows = rows;
    const key = rosterKey(visibleRows);
    if (!force && key === lastRosterKey) return;
    lastRosterKey = key;
    const rendered = renderRoster(visibleRows);
    rendered.push(separator());
    // Clear with the OLD statusLines still in effect (statusHeight()
    // reads from statusLines), THEN swap to the new rendering, THEN
    // redraw. Doing this in the wrong order leaves leftover rows when
    // the roster grows/shrinks between refreshes.
    clearStatusArea();
    statusLines = rendered;
    drawStatusArea();
  };

  // ---- Tail-on-start ---------------------------------------------
  // Read raw rows directly and feed them through the same chat-mcp
  // formatter the live tail uses, so cold backfill and live tail
  // share one grammar. We deliberately skip the visibility filter
  // for backfill so admin can browse the full history.
  const initialPresence = listActive(db);
  presenceIndex = buildPresenceIndex(initialPresence);
  let lastSeenSeq = 0;
  if (parsed.tail > 0) {
    const rows = db
      .query("SELECT * FROM messages ORDER BY seq DESC LIMIT ?")
      .all(parsed.tail) as MessageRow[];
    const ascending = rows.reverse();
    // Same-second keepalive bucketing: a single daemon sweep fans out
    // to N agents all within the same ts, so the unfolded tail would
    // render N copies of the same roster dump. Group consecutive
    // keepalives sharing a 1-second bucket into one summary line.
    let pendingKa: { ts: number; targets: string[] } | null = null;
    const flushPendingKa = (): void => {
      if (!pendingKa) return;
      const { ts, targets } = pendingKa;
      pendingKa = null;
      stdout.write(renderKeepaliveSummary(ts, targets) + "\n");
    };
    for (const row of ascending) {
      lastSeenSeq = Math.max(lastSeenSeq, row.seq);
      if (row.kind === "keepalive") {
        const bucket = Math.floor(row.ts / 1000);
        const target = row.target_username ?? "?";
        if (pendingKa && Math.floor(pendingKa.ts / 1000) === bucket) {
          if (!pendingKa.targets.includes(target)) pendingKa.targets.push(target);
        } else {
          flushPendingKa();
          pendingKa = { ts: row.ts, targets: [target] };
        }
        continue;
      }
      flushPendingKa();
      const cm = normalizeRow(row, presenceIndex);
      stdout.write(format(cm) + "\n" + separator() + "\n");
    }
    flushPendingKa();
  } else {
    // Even with no backfill, anchor the live tail to "from now on" so
    // we don't replay old messages once the loop starts.
    const max = db.query("SELECT MAX(seq) AS s FROM messages").get() as { s: number | null };
    lastSeenSeq = max.s ?? 0;
  }

  // ---- Live tail --------------------------------------------------
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const onSig = () => controller.abort();
  if (interactive) {
    process.on("SIGTERM", onSig);
    process.on("SIGINT", onSig);
  }

  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });

  const tailPromise = (async () => {
    // Console is human-facing — keep the poll interval short so new
    // messages appear near-instantly. 100ms gives ~50ms perceived
    // latency on average; SQLite indexed `seq > ?` is cheap enough
    // that this costs nothing real even when chat.db is large.
    // (Agent-side watcher uses 500ms — that path is invisible to a
    // human and doesn't need the snappier cadence.)
    const waitMs = 100;
    const batch = 50;
    while (!controller.signal.aborted) {
      const rows = db
        .query("SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?")
        .all(lastSeenSeq, batch) as MessageRow[];
      if (rows.length === 0) {
        await sleep(waitMs, controller.signal);
        continue;
      }
      // Refresh presence once per batch — cheap and keeps sender /
      // target project tags accurate against churn.
      presenceIndex = buildPresenceIndex(listActive(db));
      let touchedPresenceKind = false;
      for (const row of rows) {
        lastSeenSeq = row.seq;
        if (row.kind === "keepalive") {
          handleKeepaliveLive(row);
          continue;
        }
        // Any non-keepalive row breaks the coalesce window — flush
        // immediately so the summary lands above the next message.
        flushKeepaliveBuf();
        if (
          row.kind &&
          row.kind !== "status_digest" &&
          row.kind !== "status_update" &&
          row.kind !== "status"
        ) {
          touchedPresenceKind = true;
        }
        printRow(row, presenceIndex);
      }
      if (touchedPresenceKind) refreshRoster();
    }
  })();

  refreshRoster(true);

  // ---- Resize handler --------------------------------------------
  // Without this, the pinned roster corrupts on terminal resize until
  // the next refresh. Re-prompt forces readline to redraw the input
  // buffer at the current width.
  const onResize = () => {
    if (interactive && rosterEnabled) {
      const rows = listActive(db);
      const rendered = renderRoster(rows);
      rendered.push(separator());
      clearStatusArea();
      statusLines = rendered;
      lastRosterKey = rosterKey(rows);
      drawStatusArea();
    } else if (interactive) {
      rl.prompt(true);
    }
  };
  if (interactive) {
    (stdout as NodeJS.WriteStream).on("resize", onResize);
  }

  // ---- Slash-command dispatcher ----------------------------------
  // The admin discriminator is the pair (from_agent_id="system",
  // from_username_inline="admin") — both survive SQLite persistence,
  // so isAdminConsoleMessage() works for cross-process consumers
  // (watcher tail, audit log) without needing a separate role field.
  const broadcast = (
    scope: "global" | "project" | "dm",
    text: string,
    extras: { project?: string; target?: string } = {},
  ): void => {
    if (!text || text.length === 0) return;
    router.addMessage({
      from_agent_id: "system",
      scope,
      text,
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
      // Print roster inline AND refresh the pinned strip — matches
      // chat-mcp's `/who` UX (it prints into scroll). The pinned
      // strip stays up-to-date for free.
      const rows = listActive(db);
      const block = renderRoster(rows).join("\n");
      printLine(block + "\n" + separator());
      refreshRoster(true);
      return true;
    }
    if (line === "/status") {
      const rows = listActive(db);
      const block = renderStatusList(rows).join("\n");
      printLine(block + "\n" + separator());
      return true;
    }
    if (line.startsWith("/dm ")) {
      const rest = line.slice(4).trim();
      const sp = rest.indexOf(" ");
      if (sp <= 0) {
        printLine(paint("red", "usage: /dm <user> <text>"));
        return true;
      }
      const target = rest.slice(0, sp);
      const text = rest.slice(sp + 1).trim();
      if (!text) {
        printLine(paint("red", "empty text"));
        return true;
      }
      // Soft-warn: chat router has no offline-DM queue. If the target
      // isn't currently connected, the message persists in chat.db
      // but the recipient won't see it on next login.
      if (!listActive(db).some((a) => a.username === target)) {
        printLine(
          paint("yellow", `warning: ${target} not currently connected — message stored but not delivered`),
        );
      }
      broadcast("dm", text, { target });
      return true;
    }
    if (line.startsWith("/proj ") || line.startsWith("/p ")) {
      const rest = line.slice(line.indexOf(" ") + 1).trim();
      const sp = rest.indexOf(" ");
      if (sp <= 0) {
        printLine(paint("red", "usage: /proj <project> <text>"));
        return true;
      }
      const proj = rest.slice(0, sp);
      const text = rest.slice(sp + 1).trim();
      if (!text) {
        printLine(paint("red", "empty text"));
        return true;
      }
      if (!listActive(db).some((a) => a.project === proj)) {
        printLine(
          paint("yellow", `warning: no agents currently in project '${proj}' — message stored but not delivered`),
        );
      }
      broadcast("project", text, { project: proj });
      return true;
    }
    if (line.startsWith("/g ") || line.startsWith("/global ")) {
      const text = line.startsWith("/g ") ? line.slice(3).trim() : line.slice(8).trim();
      if (!text) {
        printLine(paint("red", "empty text"));
        return true;
      }
      broadcast("global", text);
      return true;
    }
    if (line.startsWith("/")) {
      printLine(
        paint("red", `unknown command: ${line.split(" ")[0]} (try /help)`),
      );
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
  // Flush any pending keepalive summary so the user sees what landed
  // in the last debounce window before we exit.
  flushKeepaliveBuf();
  if (interactive) {
    (stdout as NodeJS.WriteStream).off("resize", onResize);
  }
  await tailPromise;
  if (interactive) {
    process.off("SIGTERM", onSig);
    process.off("SIGINT", onSig);
    // Leave the terminal on a clean line so the shell prompt lands
    // below — without this, the shell prompt (`leandro@host$ `) would
    // appear directly after `[admin] >` on the same row.
    clearStatusArea();
    stdout.write("\n");
  }
  db.close();
  return EXIT_CODES.SUCCESS;
}
