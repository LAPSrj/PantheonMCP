import type {
  Adapter,
  Capability,
  SpawnArgs,
  SpawnPlan,
} from "../types.ts";

const CAPS: ReadonlySet<Capability> = new Set(["new-window"]);

/** alacritty adapter. Only OS-level new-window; no IPC for tabs/splits.
 * The `-e` flag passes the exec command as the terminal's command. */
export const alacritty: Adapter = {
  name: "alacritty",
  detect(env) {
    return Boolean(env.ALACRITTY_LOG || env.ALACRITTY_SOCKET);
  },
  capabilities() {
    return CAPS;
  },
  buildSpawnPlan(args: SpawnArgs): SpawnPlan {
    const argv = ["--working-directory", args.cwd, "-e", args.exec_command, ...args.exec_args];
    return {
      command: "alacritty",
      args: argv,
      env: args.exec_env,
      description: `alacritty --working-directory ${args.cwd} -e ${args.exec_command}`,
      tab_title: args.tab_title,
      resolved_mode: "new-window",
      adapter: "alacritty",
    };
  },
};
