import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Adapter,
  Capability,
  SpawnArgs,
  SpawnPlan,
} from "../types.ts";

const CAPS: ReadonlySet<Capability> = new Set([
  "new-window",
  "new-tab-here",
  "new-tab-window",
  "split-pane",
  "named-windows",
  "color",
  "tab-title",
]);

/** Windows Terminal adapter. Wraps `wt.exe` via Windows interop.
 *
 * §11a sequencing rule: when the named window doesn't exist and the
 * request is `split-pane`, emit `new-tab` BEFORE `split-pane` so
 * there's a focused base pane to split. We default to `wt.exe`; under
 * WSL this resolves through the Windows path mount.
 *
 * **WSL exec handling** (matches summon-mcp's working pattern; fixes
 * BOTH wt.exe error 0x8007010b "directory name is invalid" on WSL
 * paths passed via `-d` AND wt.exe error 0x80070002 from `;` in the
 * `bash -lc` payload):
 *
 * When `args.wsl_distro` is set, the wt adapter writes a temporary
 * `.sh` script to `os.tmpdir()` containing the env exports + cd +
 * exec, then invokes `wsl.exe -d <distro> -- bash -l <script_path>`.
 * The script self-deletes as its first line so /tmp doesn't accumulate.
 *
 * Why a script file (not `bash -lc '<inline>'`):
 *   - wt.exe parses literal `;` in argv as its own subcommand
 *     separator, splitting `export A=1; export B=2; ...` into multiple
 *     wt subcommands and emitting `0x80070002 file not found` for each
 *     fragment.
 *   - Switching `;` → `&&` inside the bash payload would help today
 *     but leaves a fragile escape contract (any future special char
 *     in argv could re-trip the same class of bug).
 *   - A temp script puts ALL the bash content in a file wt.exe never
 *     parses; argv is just `bash -l <path>`, no shell metacharacters.
 *   - Same pattern summon-mcp uses across many production summons.
 *
 * **Default split direction** policy (when `target.split` is omitted
 * AND the registry's pane count is supplied via
 * `args.existing_pane_count`):
 *   - 0–1 existing panes → vertical (side by side, two columns)
 *   - 2+ existing panes  → horizontal (grows to 2×N grid as agents
 *                          join the same tab)
 * Caller-explicit `target.split` always wins. The pane-count tracking
 * is best-effort — manually-closed panes drift the registry and
 * pantheon doesn't try to be a window server.
 */
export const wt: Adapter = {
  name: "wt",
  detect(env) {
    return Boolean(env.WT_SESSION);
  },
  capabilities() {
    return CAPS;
  },
  buildSpawnPlan(args: SpawnArgs): SpawnPlan {
    const target = args.target ?? {};
    const mode = target.mode ?? "new-tab-window";
    const windowName = resolveWindowArg(target.window);
    // Profile resolution cascade: per-call target override > persona
    // default > nothing (use WT's user-default profile). When set, the
    // adapter emits `--profile <value>` so the new tab opens in the
    // named WT profile rather than the user's default. Lets WSL
    // personas land in a WSL profile tab instead of a default-profile
    // (often PowerShell) tab that happens to be running wsl.exe.
    const wtProfile = target.wt_profile ?? args.wt_profile;
    // Tab-color cascade: an explicit per-call `target.color` always
    // renders `--tabColor`; the persona-DEFAULT color is suppressed
    // when a wt_profile is pinned. Rationale: pinning a WT profile
    // means that profile owns the tab's look (its own tabColor /
    // scheme / icon — wt.exe lets a command-line --tabColor override
    // the profile's), while the persona color keeps serving identity
    // surfaces (statusline PANTHEON_COLOR, session_info echo).
    const colorHex = colorToHex(
      target.color ?? (wtProfile ? undefined : args.color),
    );
    const subcommands: string[] = [];

    const splitDirection = resolveSplitDirection(args, target.split);

    if (mode === "split-pane") {
      if (target.tab_index != null) {
        subcommands.push("focus-tab", "-t", String(target.tab_index), ";");
      }
      // Geometry policy: focus the target pane BEFORE split-pane so the
      // new pane lands where the policy chose. Without this, wt splits
      // whichever pane is currently focused, which yields the
      // column-narrowing pattern Leandro hit. The spawn handler computes
      // `focus_pane_id` from the per-tab geometry; callers can override
      // direction via `target.split` but the focus pane stays policy-
      // chosen. (Caller-explicit focus_pane_id, if any, takes precedence.)
      if (target.focus_pane_id !== undefined) {
        subcommands.push("focus-pane", "-t", String(target.focus_pane_id), ";");
      }
      const dir = splitDirection === "horizontal" ? "-H" : "-V";
      subcommands.push("split-pane", dir);
      subcommands.push("--title", args.tab_title);
      if (colorHex) subcommands.push("--tabColor", colorHex);
      if (wtProfile) subcommands.push("--profile", wtProfile);
      // Per WSL cwd rule: cwd lives in the inner bash, not in -d.
      if (!args.wsl_distro) subcommands.push("-d", args.cwd);
      subcommands.push(...buildExecCommand(args));
    } else {
      // new-window / new-tab-here / new-tab-window all reduce to a
      // single `new-tab` invocation; the windowName flag distinguishes
      // them.
      subcommands.push("new-tab", "--title", args.tab_title);
      if (colorHex) subcommands.push("--tabColor", colorHex);
      if (wtProfile) subcommands.push("--profile", wtProfile);
      if (!args.wsl_distro) subcommands.push("-d", args.cwd);
      subcommands.push(...buildExecCommand(args));
    }

    const argv = ["-w", windowName, ...subcommands];

    return {
      command: "wt.exe",
      args: argv,
      env: args.exec_env,
      description: `wt.exe → window=${windowName} mode=${mode}${colorHex ? ` color=${colorHex}` : ""}${wtProfile ? ` profile=${wtProfile}` : ""}${args.wsl_distro ? ` wsl=${args.wsl_distro}` : ""}${mode === "split-pane" ? ` split=${splitDirection}` : ""}`,
      tab_title: args.tab_title,
      resolved_mode: mode,
      adapter: "wt",
      ...(mode === "split-pane" ? { requires_stderr_probe: true } : {}),
    };
  },
};

/** Build the trailing argv that goes after wt.exe's subcommand.
 *
 * For WSL targets: write a self-deleting `.sh` script with env
 * exports + cd + exec, then invoke
 *   `wsl.exe -d <distro> -- bash -l <script_path>`.
 * Script-file approach (not `bash -lc '<inline>'`) so wt.exe never
 * parses bash metacharacters in argv.
 *
 * For native targets: the exec command + args go directly. */
function buildExecCommand(args: SpawnArgs): string[] {
  if (!args.wsl_distro) {
    return [args.exec_command, ...args.exec_args];
  }
  const scriptPath = writeWslLaunchScript(args);
  return ["wsl.exe", "-d", args.wsl_distro, "--", "bash", "-l", scriptPath];
}

/** Write a temp `.sh` launch script containing env exports + cd +
 * exec. Returns the absolute path. The script self-deletes on its
 * first line; bash holds the file descriptor open so the script
 * keeps executing after unlink. Mode 0o700 keeps it user-private.
 *
 * Test seam: when `PANTHEON_WT_SCRIPT_DIR` is set in env, scripts
 * land in that dir instead of `os.tmpdir()` so test suites can
 * inspect the produced content without crawling /tmp. */
function writeWslLaunchScript(args: SpawnArgs): string {
  const dir = process.env.PANTHEON_WT_SCRIPT_DIR ?? os.tmpdir();
  const id = `${process.pid}-${crypto.randomUUID()}`;
  const scriptPath = path.join(dir, `pantheon-summon-${id}.sh`);

  const lines: string[] = ["#!/usr/bin/env bash"];
  // Self-delete first. bash keeps the fd open across unlink, so the
  // rest of the script runs normally and /tmp doesn't accumulate.
  lines.push(`rm -f -- "$0"`);
  // Carry forward the summoner's PATH. Ubuntu's default .bashrc bails
  // out early on non-interactive shells, so `bash -l` does NOT
  // initialize nvm/pnpm/asdf shims — without this, the spawned tab
  // opens then immediately fails with "claude: command not found".
  // (Per quibblethorn, summon-mcp's load-bearing fix for the same
  // bug class. See summon-mcp/src/launcher.ts:192-195.) User-supplied
  // PATH in `exec_env` still overrides — it's exported below.
  if (process.env.PATH) {
    lines.push(`export PATH=${quoteBash(process.env.PATH)}`);
  }
  for (const [k, v] of Object.entries(args.exec_env)) {
    lines.push(`export ${k}=${quoteBash(v)}`);
  }
  // Visible failure when cwd is missing — sleep 5 keeps the tab open
  // long enough for the human to read the error before WT closes it.
  lines.push(
    `cd ${quoteBash(args.cwd)} || { echo "pantheon: cwd missing: ${args.cwd}" >&2; sleep 5; exit 1; }`,
  );
  // Run claude as a child (NOT `exec`) so bash sticks around to read
  // its exit code. SIGTERM from pantheon's `exit()` scheduler kills
  // claude with 143; wt.exe's `closeOnExit: graceful` (the default)
  // only auto-closes the tab on exit 0, so without this remap the
  // tab stays open with "process exited with code 143 — press Enter
  // to restart". The sentinel gate (PANTHEON_EXIT_SENTINEL written
  // by server.ts's exit scheduler immediately before the SIGTERM)
  // ensures we ONLY remap pantheon-initiated SIGTERMs — external
  // OOM/manual-kill SIGTERMs leave the sentinel absent and the tab
  // stays open with the visible 143, which is the intended
  // diagnostic. The trailing rm cleans up the sentinel on the
  // happy path so /tmp doesn't accumulate.
  const execLine = [args.exec_command, ...args.exec_args]
    .map(quoteBash)
    .join(" ");
  lines.push(execLine);
  lines.push(`__pantheon_ec=$?`);
  lines.push(
    `if [ "$__pantheon_ec" -eq 143 ] && [ -n "\${PANTHEON_EXIT_SENTINEL:-}" ] && [ -f "$PANTHEON_EXIT_SENTINEL" ]; then`,
  );
  lines.push(`  rm -f -- "$PANTHEON_EXIT_SENTINEL"`);
  lines.push(`  exit 0`);
  lines.push(`fi`);
  lines.push(
    `[ -n "\${PANTHEON_EXIT_SENTINEL:-}" ] && rm -f -- "$PANTHEON_EXIT_SENTINEL"`,
  );
  lines.push(`exit "$__pantheon_ec"`);
  const body = lines.join("\n") + "\n";

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(scriptPath, body, { mode: 0o700 });
  return scriptPath;
}

/** Per the §11a default-split-direction policy. Caller-explicit wins;
 * otherwise vertical for fresh + 1-pane tabs, horizontal once 2+
 * panes already exist. */
function resolveSplitDirection(
  args: SpawnArgs,
  explicit: "horizontal" | "vertical" | undefined,
): "horizontal" | "vertical" {
  if (explicit) return explicit;
  const existing = args.existing_pane_count ?? 0;
  if (existing < 2) return "vertical";
  return "horizontal";
}

/** Map a `target.window` value to the `-w` argument:
 *   undefined / "current" / "same" → `0` (the current window)
 *   "new" / "window"               → `new`
 *   any other string               → that string (named window, durable). */
function resolveWindowArg(window?: string): string {
  if (!window) return "0";
  if (window === "current" || window === "same") return "0";
  if (window === "new" || window === "window") return "new";
  return window;
}

const NAMED_TO_HEX: Record<string, string> = {
  red: "#cd5c5c",
  blue: "#5e81ac",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  purple: "#b48ead",
  orange: "#d08770",
  pink: "#bf616a",
  cyan: "#88c0d0",
};

function colorToHex(color?: string): string | undefined {
  if (!color) return undefined;
  return NAMED_TO_HEX[color];
}

/** POSIX single-quote bash quoting. Embeds literal single quotes via
 * the standard `'\''` escape sequence. */
function quoteBash(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
