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
 * **WSL cwd handling** (mirrors summon-mcp's working pattern, fixes
 * wt.exe error 0x8007010b "directory name is invalid" on WSL paths
 * passed via `-d`): when `args.wsl_distro` is set, DROP wt.exe's
 * `-d <cwd>` and instead wrap the inner exec as
 * `wsl.exe -d <distro> -- bash -lc 'cd <cwd> && exec <cmd> <args>'`.
 * The cwd belongs in the inner shell, not in the outer wt.exe.
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
    const colorHex = colorToHex(target.color ?? args.color);
    const subcommands: string[] = [];

    const splitDirection = resolveSplitDirection(args, target.split);

    if (mode === "split-pane") {
      if (target.tab_index != null) {
        subcommands.push("focus-tab", "-t", String(target.tab_index), ";");
      }
      const dir = splitDirection === "horizontal" ? "-H" : "-V";
      subcommands.push("split-pane", dir);
      subcommands.push("--title", args.tab_title);
      if (colorHex) subcommands.push("--tabColor", colorHex);
      // Per WSL cwd rule: cwd lives in the inner bash, not in -d.
      if (!args.wsl_distro) subcommands.push("-d", args.cwd);
      subcommands.push(...buildExecCommand(args));
    } else {
      // new-window / new-tab-here / new-tab-window all reduce to a
      // single `new-tab` invocation; the windowName flag distinguishes
      // them.
      subcommands.push("new-tab", "--title", args.tab_title);
      if (colorHex) subcommands.push("--tabColor", colorHex);
      if (!args.wsl_distro) subcommands.push("-d", args.cwd);
      subcommands.push(...buildExecCommand(args));
    }

    const argv = ["-w", windowName, ...subcommands];

    return {
      command: "wt.exe",
      args: argv,
      env: args.exec_env,
      description: `wt.exe → window=${windowName} mode=${mode}${colorHex ? ` color=${colorHex}` : ""}${args.wsl_distro ? ` wsl=${args.wsl_distro}` : ""}${mode === "split-pane" ? ` split=${splitDirection}` : ""}`,
      tab_title: args.tab_title,
      resolved_mode: mode,
      adapter: "wt",
      ...(mode === "split-pane" ? { requires_stderr_probe: true } : {}),
    };
  },
};

/** Build the trailing argv that goes after wt.exe's subcommand.
 *
 * For WSL targets:
 *   wsl.exe -d <distro> -- bash -lc 'export X=Y; cd <cwd> && exec <cmd> <args>'
 * For native targets:
 *   <exec_command> <exec_args...>
 *
 * Env vars are exported INSIDE the bash -lc string for WSL targets so
 * they reach the spawned process even though wt.exe doesn't forward
 * its own env to the wsl child. */
function buildExecCommand(args: SpawnArgs): string[] {
  if (!args.wsl_distro) {
    return [args.exec_command, ...args.exec_args];
  }
  const exports = Object.entries(args.exec_env)
    .map(([k, v]) => `export ${k}=${quoteBash(v)};`)
    .join(" ");
  const execLine = [args.exec_command, ...args.exec_args]
    .map(quoteBash)
    .join(" ");
  const inner = `${exports} cd ${quoteBash(args.cwd)} && exec ${execLine}`;
  return ["wsl.exe", "-d", args.wsl_distro, "--", "bash", "-lc", inner];
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
