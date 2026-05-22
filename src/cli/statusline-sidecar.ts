/** Statusline sidecar writer.
 *
 * Pantheon writes a tiny per-CC-session JSON file that the Claude
 * Code statusline command can `cat` directly — no bun spawn, no
 * chat.db read from bash. The file carries the agent that owns the
 * tab (its canonical persona + live chat handle) plus its current
 * status, so the statusline can render a dedicated bottom row.
 *
 * Keyed by the CC session UUID (context.ts `claude_session_id`,
 * read from `~/.claude/sessions/<ppid>.json` at MCP boot). That UUID
 * is the same string CC pipes to the statusline command on stdin as
 * `.session_id`, so the reader resolves the file by
 * `<runtimeDir>/statusline/<session_id>`. Same keying contract as
 * the Stop-hook runtime env file (see runtime-bridge.ts).
 *
 * Lifecycle:
 *   - written on `login` (persona / chat / status all known)
 *   - refreshed on every `update_status` (status changes; the
 *     persona / chat handle stay put)
 *   - removed on `logout` / `rest` / `exit` and the force-lifecycle
 *     teardown paths, so stale sidecars don't accumulate in runtime/.
 *
 * Every operation is best-effort: a null/absent session id is a
 * silent no-op (the reader falls back to the PANTHEON_USERNAME env
 * var), and IO errors never propagate — a decoration file must not
 * break a tool call or a CC session. Callers pass the resolved
 * `Paths` (the handler context already carries `ctx.paths`) so the
 * sidecar always lands under the same storage root as the rest of
 * pantheon's state — including test sandboxes. */

import fs from "node:fs";
import path from "node:path";
import type { Paths } from "../storage/paths.ts";

export interface StatuslineSidecar {
  /** Canonical persona username (registry identity). */
  persona: string;
  /** Live chat handle — equals `persona` unless the canonical handle
   * was held by a peer and login auto-suffixed to a sibling slot. */
  chat: string;
  /** Current chat status string. */
  status: string;
}

function sidecarDir(paths: Paths): string {
  return path.join(paths.runtimeDir, "statusline");
}

/** Absolute path of the sidecar file for a given CC session UUID. */
export function statuslineSidecarPath(
  paths: Paths,
  claudeSessionId: string,
): string {
  return path.join(sidecarDir(paths), claudeSessionId);
}

/** Atomically write the sidecar for this CC session. No-op when the
 * session UUID is null/empty (pantheon launched outside a CC
 * session). */
export function writeStatuslineSidecar(
  paths: Paths,
  claudeSessionId: string | null | undefined,
  data: StatuslineSidecar,
): void {
  if (!claudeSessionId) return;
  try {
    const dir = sidecarDir(paths);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dir, claudeSessionId);
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        persona: data.persona,
        chat: data.chat,
        status: data.status,
      }),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, filePath);
  } catch {
    // best-effort — the statusline is decoration, never fail a call
  }
}

/** Remove the sidecar for this CC session. No-op when the session
 * UUID is null/empty or the file is already gone. */
export function deleteStatuslineSidecar(
  paths: Paths,
  claudeSessionId: string | null | undefined,
): void {
  if (!claudeSessionId) return;
  try {
    fs.unlinkSync(statuslineSidecarPath(paths, claudeSessionId));
  } catch {
    // best-effort — already gone is the expected steady state
  }
}
