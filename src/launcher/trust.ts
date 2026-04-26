import os from "node:os";
import path from "node:path";
import { mutateJsonAtomic } from "../storage/index.ts";

/** Result of an `ensureCwdTrusted` call.
 *
 * The auto-trust step is **best-effort**: the spawn succeeds whether
 * or not we managed to write `~/.claude.json`. Failures land in
 * `warning` so the summon-handler can surface them in
 * `stamp_warnings` without blocking the tab. */
export interface TrustResult {
  /** Path of the config file we touched (or tried to). */
  path: string;
  /** True when this call wrote `hasTrustDialogAccepted: true` for `cwd`. */
  trusted_now: boolean;
  /** True when the cwd was already trusted in the file before this call. */
  trusted_already: boolean;
  /** Set when read/write failed — the spawn proceeds anyway. */
  warning?: string;
}

interface ClaudeProjectEntry {
  allowedTools?: unknown[];
  hasTrustDialogAccepted?: boolean;
  hasCompletedOnboarding?: boolean;
  [k: string]: unknown;
}

interface ClaudeConfig {
  projects?: Record<string, ClaudeProjectEntry>;
  [k: string]: unknown;
}

/** Mark `cwd` as trusted in the user's `~/.claude.json` so a fresh
 * `claude` launch into that folder doesn't block on the first-time
 * trust prompt.
 *
 * Idempotent — when the project entry already has
 * `hasTrustDialogAccepted: true`, we return `trusted_already: true`
 * without writing. Otherwise we ensure the entry exists with both
 * `hasTrustDialogAccepted: true` and `hasCompletedOnboarding: true`
 * (the minimum schema CC reads on first project load), preserving any
 * other keys in place.
 *
 * Writes go through `mutateJsonAtomic` (fingerprint-guarded
 * mutate-then-rename) so concurrent claude sessions reading the same
 * file never see a partial JSON document. The atomic-rename matters
 * here because `~/.claude.json` is ALSO written by every running CC
 * instance — clobbering it mid-write would torch other sessions'
 * state.
 *
 * `opts.claudeJsonPath` lets tests redirect the write to a tmp path. */
export function ensureCwdTrusted(
  cwd: string,
  opts: { claudeJsonPath?: string } = {},
): TrustResult {
  const target = opts.claudeJsonPath ?? path.join(os.homedir(), ".claude.json");
  let trusted_already = false;
  let trusted_now = false;
  try {
    mutateJsonAtomic<ClaudeConfig>(target, (current) => {
      const config: ClaudeConfig = (current ?? {}) as ClaudeConfig;
      const projects: Record<string, ClaudeProjectEntry> =
        (config.projects ?? {}) as Record<string, ClaudeProjectEntry>;
      const existing = projects[cwd];
      if (existing && existing.hasTrustDialogAccepted === true) {
        trusted_already = true;
        return undefined; // no-op
      }
      const nextEntry: ClaudeProjectEntry = {
        allowedTools: [],
        ...(existing ?? {}),
        hasTrustDialogAccepted: true,
        hasCompletedOnboarding: true,
      };
      trusted_now = true;
      return {
        ...config,
        projects: { ...projects, [cwd]: nextEntry },
      };
    });
  } catch (err) {
    return {
      path: target,
      trusted_now: false,
      trusted_already: false,
      warning: `claude_trust: ${(err as Error).message}`,
    };
  }
  return { path: target, trusted_now, trusted_already };
}
