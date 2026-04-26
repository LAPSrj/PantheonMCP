import type { Adapter, Capability } from "../types.ts";
import { AdapterError } from "../types.ts";

/** Stub adapters — detect their host terminal by env var, but
 * `buildSpawnPlan` errors `adapter_not_implemented`. The dispatcher's
 * downgrade ladder will fall through to a less-capable adapter that
 * IS implemented (typically `generic`). When wiring of these adapters
 * lands, swap their import in `adapters/index.ts` for the real
 * implementation; the rest of the dispatcher needs no changes. */
function makeStub(
  name: string,
  detect: (env: NodeJS.ProcessEnv) => boolean,
  caps: Capability[],
): Adapter {
  return {
    name,
    detect,
    capabilities: () => new Set(caps),
    buildSpawnPlan() {
      throw new AdapterError(
        "adapter_not_implemented",
        `Adapter '${name}' is not implemented yet. Falling back via downgrade ladder.`,
        { adapter: name },
      );
    },
  };
}

export const wezterm = makeStub(
  "wezterm",
  (env) => Boolean(env.WEZTERM_PANE),
  ["new-window", "new-tab-here", "new-tab-window", "split-pane", "named-windows", "color", "tab-title"],
);

export const iterm2 = makeStub(
  "iterm2",
  (env) => Boolean(env.ITERM_SESSION_ID),
  ["new-window", "new-tab-here", "new-tab-window", "split-pane", "named-windows", "color", "tab-title"],
);

export const gnome = makeStub(
  "gnome",
  (env) => Boolean(env.GNOME_TERMINAL_SCREEN),
  ["new-window", "new-tab-here", "tab-title"],
);

export const terminal_app = makeStub(
  "terminal_app",
  (env) => env.TERM_PROGRAM === "Apple_Terminal",
  ["new-window", "new-tab-here", "tab-title"],
);

