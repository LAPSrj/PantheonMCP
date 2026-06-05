import { execFileSync } from "node:child_process";

/** WSL distro resolution + validation.
 *
 * Pantheon spawns `platform: "wsl"` personas by wrapping exec in
 * `wsl.exe -d <distro> -- bash ...` (see `adapters/wt.ts`). A persona
 * pinned to a distro that isn't installed (e.g. `"Ubuntu"` on a machine
 * whose only Ubuntu is `"Ubuntu-22.04"`) makes wsl.exe die with
 * `WSL_E_DISTRO_NOT_FOUND` — a tab that opens then immediately fails.
 *
 * This module enumerates the installed distros so callers can (a) reject
 * a bad distro at WRITE time (register / conjure / update_profile) and
 * (b) self-heal at SPAWN time by falling back to the summoner's running
 * distro. Enumeration is best-effort: when `wsl.exe` is unavailable it
 * returns `null` and callers treat that as "can't verify — don't block".
 */

/** Decode `wsl.exe -l -q` output into a list of installed distro names.
 *
 * The command emits UTF-16LE with CRLF line endings (verified live:
 * each ASCII char is followed by a NUL byte, lines end CR LF). The
 * `utf16le` decode consumes the NUL pairs, so only `\r` / `\n` remain to
 * split on; internal spaces in a distro name (e.g. "Ubuntu Dev") are
 * preserved. Exported so the parser can be unit-tested against a
 * captured buffer. */
export function parseWslDistroList(buf: Buffer): string[] {
  return buf
    .toString("utf16le")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Enumerate installed WSL distros on this machine.
 *
 * Test/CI seam: when `PANTHEON_WSL_DISTROS` is set in `env`, its
 * comma-separated value is the authoritative installed set (empty string
 * → no distros) and no subprocess runs — mirrors `PANTHEON_WT_SCRIPT_DIR`
 * in the wt adapter. Otherwise shells out to `wsl.exe -l -q`.
 *
 * Returns `null` when enumeration is unavailable (wsl.exe missing /
 * errors / not a WSL host) — callers MUST treat null as "can't verify,
 * proceed without blocking" so non-WSL machines and odd environments are
 * never falsely failed. */
export function installedWslDistros(
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  const override = env.PANTHEON_WSL_DISTROS;
  if (override !== undefined) {
    return override
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  try {
    const buf = execFileSync("wsl.exe", ["-l", "-q"], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return parseWslDistroList(buf);
  } catch {
    return null;
  }
}

/** Case-insensitive membership of `name` in `installed`. WSL matches
 * distro names case-insensitively, so the check is too. */
export function isWslDistroInstalled(name: string, installed: string[]): boolean {
  const lower = name.toLowerCase();
  return installed.some((d) => d.toLowerCase() === lower);
}

export interface WslDistroResolution {
  /** Distro to spawn with. `undefined` → native path (no `-d`). */
  distro: string | undefined;
  /** Non-fatal note set when we fell back off a pinned-but-missing
   * distro to the summoner's running distro. */
  warning?: string;
  /** Set when a PINNED distro is missing AND no valid fallback exists —
   * the caller should fail the spawn loudly. Carries the installed list
   * for the error message. */
  unresolved?: { configured: string; installed: string[] };
}

/** Pure spawn-time resolver (the B1 guard). Decides the effective WSL
 * distro from the persona's pinned value, the summoner's running distro,
 * and the installed set:
 *
 *   - not pinned                       -> inherit `envDistro` verbatim
 *                                        (can't be more correct than the
 *                                        live running distro; never blocks)
 *   - installed === null (no enumerate)-> use pinned as-is (passthrough)
 *   - pinned + installed               -> use it
 *   - pinned missing, envDistro valid  -> fall back to envDistro + warn
 *   - pinned missing, no valid fallback-> `unresolved` (caller throws)
 */
export function resolveSpawnWslDistro(opts: {
  configured: string | null | undefined;
  envDistro: string | undefined;
  installed: string[] | null;
}): WslDistroResolution {
  const configured = opts.configured ?? undefined;
  // No persona-pinned distro: inherit the summoner's running distro
  // verbatim. This is the documented happy path — leaving wsl_distro
  // unset is what makes a persona portable across machines.
  if (!configured) return { distro: opts.envDistro };
  // Can't enumerate (non-WSL host / wsl.exe missing): don't block.
  if (opts.installed === null) return { distro: configured };
  if (isWslDistroInstalled(configured, opts.installed)) {
    return { distro: configured };
  }
  // Pinned distro is missing — try the summoner's running distro.
  const env = opts.envDistro;
  if (env && env !== configured && isWslDistroInstalled(env, opts.installed)) {
    return {
      distro: env,
      warning:
        `wsl_distro '${configured}' is not installed on this machine; ` +
        `fell back to the summoner's running distro '${env}'. ` +
        `Fix the persona with update_profile({ wsl_distro }) or clear it ` +
        `(wsl_distro: null) to inherit automatically.`,
    };
  }
  return { distro: configured, unresolved: { configured, installed: opts.installed } };
}
