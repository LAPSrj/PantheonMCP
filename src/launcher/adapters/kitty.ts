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

/** kitty adapter. Uses `kitty @ launch` when the remote-control socket
 * is set (`KITTY_LISTEN_ON`); falls back to `kitten @ launch` otherwise.
 * The single-call shape covers all four modes via the `--type` flag. */
export const kitty: Adapter = {
  name: "kitty",
  detect(env) {
    return Boolean(env.KITTY_PID || env.KITTY_WINDOW_ID);
  },
  capabilities() {
    return CAPS;
  },
  buildSpawnPlan(args: SpawnArgs): SpawnPlan {
    const target = args.target ?? {};
    const mode = target.mode ?? "new-tab-window";
    const command = process.env.KITTY_LISTEN_ON ? "kitty" : "kitten";
    const argv: string[] = ["@", "launch"];

    const launchType =
      mode === "split-pane"
        ? "window"
        : mode === "new-tab-here" || mode === "new-tab-window"
          ? "tab"
          : "os-window";
    argv.push("--type", launchType);

    if (target.window) {
      // kitty workspaces are matched via `--match`.
      argv.push("--match", `title:${target.window}`);
    }

    if (mode === "split-pane") {
      argv.push("--location", target.split === "horizontal" ? "hsplit" : "vsplit");
    }

    argv.push("--cwd", args.cwd);
    argv.push("--title", args.tab_title);

    if (args.color || target.color) {
      // kitty doesn't natively color tabs from the launch CLI; skip
      // silently. Caller can override per-window via remote control.
    }

    argv.push(args.exec_command, ...args.exec_args);

    return {
      command,
      args: argv,
      env: args.exec_env,
      description: `${command} @ launch (--type ${launchType})`,
      tab_title: args.tab_title,
      resolved_mode: mode,
      adapter: "kitty",
      ...(mode === "split-pane" ? { requires_stderr_probe: true } : {}),
    };
  },
};
