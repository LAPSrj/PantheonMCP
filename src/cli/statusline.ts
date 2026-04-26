import { listActive, type PresenceRow } from "../chat/index.ts";
import { openChatDb, resolvePaths, type Paths } from "../storage/index.ts";

/** §9b plugin statusline. CC invokes `pantheon statusline` for
 * every status refresh; we read the SQLite presence table and emit
 * a one-liner suitable for the prompt bar. Stdin carries CC's
 * session JSON (per CC's statusline contract) but we don't strictly
 * need it — connected-agents data lives in pantheon's own state.
 *
 * Output is a single line on stdout. Errors go to stderr (CC
 * surfaces nothing for a stderr-only run, which is the desired
 * silent-failure mode). Exit code is always 0; the prompt bar
 * shouldn't break a CC session over a missing chat.db. */
export interface StatuslineOptions {
  paths?: Paths;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Optional override of "now" for tests so listActive's threshold
   * is deterministic. */
  now?: number;
}

export async function runStatusline(options: StatuslineOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  // Drain stdin even though we don't currently consume it — CC pipes
  // session JSON in. Avoids blocking the parent.
  if (options.stdin) {
    try {
      for await (const _chunk of options.stdin) void _chunk;
    } catch {
      // ignore
    }
  }

  const paths = options.paths ?? resolvePaths();
  let line: string;
  try {
    const db = openChatDb(paths.chatDbPath);
    try {
      const listActiveOpts =
        options.now !== undefined ? { now: options.now } : undefined;
      const active = listActive(db, listActiveOpts);
      line = formatStatusLine(active);
    } finally {
      db.close();
    }
  } catch (err) {
    stderr.write(
      `pantheon-statusline: chat.db read failed: ${(err as Error).message}\n`,
    );
    line = "[pantheon] —";
  }
  stdout.write(line);
  return 0;
}

export function formatStatusLine(active: PresenceRow[]): string {
  if (active.length === 0) return "[pantheon] no agents online";
  // Group by project for legibility.
  const byProject = new Map<string, PresenceRow[]>();
  for (const a of active) {
    const list = byProject.get(a.project);
    if (list) list.push(a);
    else byProject.set(a.project, [a]);
  }
  const groups: string[] = [];
  for (const [project, members] of byProject) {
    const rendered = members
      .map((m) => (m.transient ? `${m.username}*` : m.username))
      .join(",");
    groups.push(`${project}:${rendered}`);
  }
  return `[pantheon ${active.length}] ${groups.join(" | ")}`;
}
