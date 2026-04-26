import type {
  Adapter,
  Capability,
  SpawnArgs,
  SpawnPlan,
} from "../types.ts";

// tmux's "new-window" semantics differ from OS-level new-window — it
// opens a new tmux *window* (i.e. tab) inside the current session.
// We surface that as `new-tab-here`. OS-level new-window only happens
// when the caller asks for it via `escape_tmux`, which the dispatcher
// handles by picking the next-priority adapter.
const CAPS: ReadonlySet<Capability> = new Set([
  "new-tab-here",
  "new-tab-window",
  "split-pane",
  "named-windows",
  "tab-title",
]);

/** tmux adapter. Universal across host terminals — works whenever
 * `TMUX` is set. For OS-level `new-window`, callers pass
 * `target.escape_tmux: true` so the dispatcher escapes to the host
 * terminal's adapter. */
export const tmux: Adapter = {
  name: "tmux",
  detect(env) {
    return Boolean(env.TMUX);
  },
  capabilities() {
    return CAPS;
  },
  buildSpawnPlan(args: SpawnArgs): SpawnPlan {
    const target = args.target ?? {};
    const mode = target.mode ?? "new-tab-here";
    const session = target.window;
    const subcommand = mode === "split-pane" ? "split-window" : "new-window";

    const argv: string[] = [subcommand];

    if (mode === "split-pane") {
      argv.push(target.split === "horizontal" ? "-h" : "-v");
      if (target.tab_index != null && session) {
        argv.push("-t", `${session}:${target.tab_index}`);
      } else if (target.tab_index != null) {
        argv.push("-t", String(target.tab_index));
      }
    } else if (session) {
      // `new-tab-window` → switch / create the named tmux session.
      // Use `new-window -t <session>` so an existing session gains a tab.
      argv.push("-t", session);
    }

    argv.push("-c", args.cwd);
    argv.push("-n", args.tab_title);

    // tmux exec must be quoted into a single command string.
    const execLine = [args.exec_command, ...args.exec_args]
      .map(shellQuote)
      .join(" ");
    argv.push(execLine);

    return {
      command: "tmux",
      args: argv,
      env: args.exec_env,
      description: `tmux ${argv.join(" ")}`,
      tab_title: args.tab_title,
      resolved_mode: mode,
      adapter: "tmux",
      ...(mode === "split-pane" ? { requires_stderr_probe: true } : {}),
    };
  },
};

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:=+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
