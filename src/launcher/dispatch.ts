import { pickAdapter } from "./detect.ts";
import {
  AdapterError,
  DOWNGRADE_LADDER,
  type Adapter,
  type SpawnArgs,
  type SpawnMode,
  type SpawnPlan,
} from "./types.ts";

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** Pre-picked adapter override — used in tests and by the §14
   * watchdog wiring layer. Defaults to env-driven `pickAdapter`. */
  adapter?: Adapter;
}

/** §11a / §5 dispatch entry point. Picks the host adapter, applies the
 * tmux-escape rule when requested, then resolves the spawn target via
 * the graceful-downgrade ladder (or strict-mode error). */
export function resolveSpawnPlan(args: SpawnArgs, opts: ResolveOptions = {}): SpawnPlan {
  const env = opts.env ?? process.env;
  const target = args.target ?? {};

  let adapter = opts.adapter ?? pickAdapter(env);

  if (target.escape_tmux && adapter.name === "tmux") {
    // Drop tmux from the priority walk; pick the next-priority adapter.
    adapter = pickAdapter(env, { skip: ["tmux"] });
  }

  const requestedMode: SpawnMode = target.mode ?? defaultModeFor(adapter, env);
  const requestedNote = `${requestedMode} requested`;

  const requested = tryBuild(adapter, args, requestedMode);
  if (requested.ok) return requested.plan;

  if (target.strict) {
    throw new AdapterError(
      "unsupported_capability",
      `${requestedNote}; adapter '${adapter.name}' does not support it.`,
      { adapter: adapter.name, requested_mode: requestedMode },
    );
  }

  // Downgrade ladder. Walk modes in DOWNGRADE_LADDER order, starting
  // AT the requested mode (so anything <= it counts as a downgrade
  // candidate). Skip the requested mode itself since we already tried.
  const requestedIdx = DOWNGRADE_LADDER.indexOf(requestedMode);
  const candidates =
    requestedIdx === -1
      ? DOWNGRADE_LADDER.slice()
      : DOWNGRADE_LADDER.slice(requestedIdx + 1);

  for (const fallback of candidates) {
    const attempt = tryBuild(adapter, args, fallback);
    if (attempt.ok) {
      const note = `${requestedNote}; adapter '${adapter.name}' lacks it; downgraded to '${fallback}'.`;
      return { ...attempt.plan, downgrade_note: note };
    }
  }

  // Adapter has zero capability for the request even after downgrade —
  // fall through to `generic` (always implemented). Surfaces a strong
  // downgrade note so callers know they got a degraded shape.
  const generic = pickAdapter(env, { skip: ADAPTERS_EXCLUDING_GENERIC });
  const lastResort = generic.buildSpawnPlan({
    ...args,
    target: { ...args.target, mode: "new-window" },
  });
  return {
    ...lastResort,
    downgrade_note: `${requestedNote}; adapter '${adapter.name}' had no supported mode; fell through to generic 'new-window'.`,
  };
}

interface BuildResult {
  ok: boolean;
  plan: SpawnPlan;
}

function tryBuild(
  adapter: Adapter,
  args: SpawnArgs,
  mode: SpawnMode,
): BuildResult {
  if (!adapter.capabilities().has(mode)) {
    return { ok: false, plan: {} as SpawnPlan };
  }
  try {
    const plan = adapter.buildSpawnPlan({
      ...args,
      target: { ...args.target, mode },
    });
    return { ok: true, plan };
  } catch (err) {
    if (err instanceof AdapterError && err.code === "adapter_not_implemented") {
      return { ok: false, plan: {} as SpawnPlan };
    }
    throw err;
  }
}

/** Default mode resolution honors the legacy env-knob shim per §11a:
 *
 *   - `PANTHEON_TAB_TARGET` (preferred)
 *   - `SUMMON_MCP_TAB_TARGET` (deprecated; one-release compat)
 *
 * Values:
 *   - `same` / `current`     → `new-tab-here`
 *   - `new` / `window`       → `new-window`
 *   - `per-summoner`         → `new-tab-window`
 *   - any other string       → treated as a window name + new-tab-window
 *
 * If neither env var is set, fall back to `new-tab-window` (the
 * widest-capability default that most adapters support). When the
 * adapter doesn't support the resolved mode, the downgrade ladder
 * takes over.
 */
function defaultModeFor(_adapter: Adapter, env: NodeJS.ProcessEnv): SpawnMode {
  const raw = env.PANTHEON_TAB_TARGET ?? env.SUMMON_MCP_TAB_TARGET;
  if (!raw) return "new-tab-window";
  switch (raw) {
    case "same":
    case "current":
      return "new-tab-here";
    case "new":
    case "window":
      return "new-window";
    case "per-summoner":
      return "new-tab-window";
    default:
      return "new-tab-window";
  }
}

const ADAPTERS_EXCLUDING_GENERIC = [
  "wt",
  "kitty",
  "wezterm",
  "iterm2",
  "tmux",
  "gnome",
  "terminal_app",
  "alacritty",
];
