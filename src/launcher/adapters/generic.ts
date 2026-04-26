import type {
  Adapter,
  Capability,
  SpawnArgs,
  SpawnPlan,
} from "../types.ts";

const CAPS: ReadonlySet<Capability> = new Set(["new-window"]);

/** Catch-all fallback. Always detects true so the dispatcher never
 * fails to pick an adapter. Spawns the exec command directly; the
 * caller's terminal emulator decides how to display it. No tabs, no
 * splits, no color. */
export const generic: Adapter = {
  name: "generic",
  detect(_env) {
    return true;
  },
  capabilities() {
    return CAPS;
  },
  buildSpawnPlan(args: SpawnArgs): SpawnPlan {
    return {
      command: args.exec_command,
      args: args.exec_args,
      env: args.exec_env,
      cwd: args.cwd,
      description: `generic spawn: ${args.exec_command} ${args.exec_args.join(" ")}`,
      tab_title: args.tab_title,
      resolved_mode: "new-window",
      adapter: "generic",
    };
  },
};
