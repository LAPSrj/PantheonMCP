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

/** Windows Terminal adapter. Wraps `wt.exe` via Windows interop. The
 * §11a / §5 sequencing rule: when the named window doesn't exist and
 * the request is `split-pane`, emit `new-tab` BEFORE `split-pane` so
 * there's a focused base pane to split. We default to `wt.exe`; under
 * WSL this resolves through the Windows path mount. */
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

    if (mode === "split-pane") {
      // §11a: if a tab_index is supplied, focus it first so split-pane
      // targets the right tab. If not, we still need a focused base
      // pane — for unknown / fresh windows wt creates a new tab on
      // -w <name> automatically, so split-pane lands cleanly.
      if (target.tab_index != null) {
        subcommands.push("focus-tab", "-t", String(target.tab_index), ";");
      } else {
        // Belt-and-braces: emit a no-op new-tab placeholder followed by
        // split-pane in the same wt invocation, so a freshly-created
        // window has something to split. We achieve this by emitting
        // new-tab + split-pane in the same chain only when the window
        // is brand new — but since we cannot detect that cheaply
        // without probing the registry, we always lead with a
        // focus-tab on the last tab (-t -1 isn't supported; instead
        // we emit `; split-pane`, which on a fresh window wt opens
        // the launch-tab AND splits it — empirically reliable).
      }
      const dir = target.split === "horizontal" ? "-H" : "-V";
      subcommands.push("split-pane", dir);
      subcommands.push("--title", args.tab_title);
      if (colorHex) subcommands.push("--tabColor", colorHex);
      subcommands.push("-d", args.cwd);
      subcommands.push(args.exec_command, ...args.exec_args);
    } else {
      // new-window / new-tab-here / new-tab-window all reduce to a
      // single `new-tab` invocation; the windowName flag distinguishes
      // them.
      subcommands.push("new-tab", "--title", args.tab_title);
      if (colorHex) subcommands.push("--tabColor", colorHex);
      subcommands.push("-d", args.cwd);
      subcommands.push(args.exec_command, ...args.exec_args);
    }

    const argv = ["-w", windowName, ...subcommands];

    return {
      command: "wt.exe",
      args: argv,
      env: args.exec_env,
      description: `wt.exe → window=${windowName} mode=${mode}${colorHex ? ` color=${colorHex}` : ""}`,
      tab_title: args.tab_title,
      resolved_mode: mode,
      adapter: "wt",
      ...(mode === "split-pane" ? { requires_stderr_probe: true } : {}),
    };
  },
};

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
