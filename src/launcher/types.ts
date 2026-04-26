/** §5 / §11a launcher types. */

import type { ClaudeColor } from "../identity/index.ts";

export type SpawnMode =
  | "new-window"
  | "new-tab-here"
  | "new-tab-window"
  | "split-pane";

export type Capability =
  | SpawnMode
  | "named-windows"
  | "color"
  | "tab-title";

export interface SpawnTarget {
  mode?: SpawnMode;
  /** Named window (durable identity for WT, kitty workspace, etc.). */
  window?: string;
  /** 0-based; for `split-pane` to pick which tab to split. */
  tab_index?: number;
  split?: "horizontal" | "vertical";
  /** Override the persona's registered color for this spawn only. */
  color?: ClaudeColor;
  /** When true, an unsupported capability errors `unsupported_capability`
   * instead of triggering the graceful-downgrade ladder. */
  strict?: boolean;
  /** When true and the detected adapter is tmux, dispatch picks the
   * next-priority adapter (the host terminal tmux runs inside). */
  escape_tmux?: boolean;
}

export interface SpawnArgs {
  /** Binary to launch inside the new tab/pane (e.g. `claude`, `wsl.exe`). */
  exec_command: string;
  exec_args: string[];
  /** Env vars to set on the spawned process (merged with the inherited env). */
  exec_env: Record<string, string>;
  /** Working directory of the spawned process. */
  cwd: string;
  /** Initial tab/pane title shown in the terminal. */
  tab_title: string;
  /** Persona color, falls back to `target.color`. */
  color?: ClaudeColor;
  target?: SpawnTarget;
  /** Set when the target persona is on WSL. The wt adapter wraps the
   * exec invocation in `wsl.exe -d <distro> -- bash -lc 'cd <cwd> &&
   * exec ...'` and DROPS the wt.exe `-d <cwd>` flag (Windows wt.exe
   * can't access WSL paths via `-d` without UNC translation; the cwd
   * belongs in the inner shell instead). Mirrors summon-mcp's working
   * pattern. */
  wsl_distro?: string;
  /** Best-effort hint of the existing pane count in the target tab,
   * used by the wt adapter's default split-direction policy when the
   * caller didn't specify `target.split` explicitly. The dispatcher
   * (or spawn handler) sets this from the window registry; absent
   * means "treat as fresh window/tab." */
  existing_pane_count?: number;
}

export interface SpawnPlan {
  /** Binary the dispatcher should `spawn`. Either the terminal CLI
   * (e.g. `wt.exe`, `kitty`, `tmux`) or the exec_command itself for
   * the generic adapter. */
  command: string;
  /** argv for `command`. */
  args: string[];
  /** Env vars to set on the dispatcher's spawn (merged with process.env). */
  env: Record<string, string>;
  /** Optional cwd for the dispatcher's spawn. Different from `SpawnArgs.cwd`
   * — that's the spawned process's cwd; this is the spawner's. */
  cwd?: string;
  description: string;
  tab_title: string;
  resolved_mode: SpawnMode;
  /** Adapter that built the plan. */
  adapter: string;
  /** Surfaced to the caller when the requested mode was downgraded. */
  downgrade_note?: string;
  /** When true, the dispatcher should capture stderr for ~200ms after
   * spawn (before `unref`) so silent split-pane failures surface. */
  requires_stderr_probe?: boolean;
}

export interface Adapter {
  /** Stable identifier. Used in plan.adapter, capability matrix, and
   * tests. Lower-case, no whitespace. */
  readonly name: string;
  /** Returns true when this adapter recognises the host terminal from
   * `env`. Detection MUST be cheap (env-var checks only). */
  detect(env: NodeJS.ProcessEnv): boolean;
  /** Capabilities this adapter offers. The dispatcher consults this to
   * pick whether a requested mode is supported. */
  capabilities(): ReadonlySet<Capability>;
  /** Build the spawn plan for the requested args. The dispatcher has
   * already gated `args.target.mode` against `capabilities()` so the
   * adapter can assume the requested mode is supported. */
  buildSpawnPlan(args: SpawnArgs): SpawnPlan;
}

export class AdapterError extends Error {
  code: AdapterErrorCode;
  extra: Record<string, unknown>;
  constructor(
    code: AdapterErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "AdapterError";
  }
}

export type AdapterErrorCode =
  | "unsupported_capability"
  | "missing_dependency"
  | "adapter_not_implemented";

/** Default downgrade ladder per §5: try the request first, then fall
 * to less-capable modes in order until one is supported. */
export const DOWNGRADE_LADDER: ReadonlyArray<SpawnMode> = [
  "split-pane",
  "new-tab-window",
  "new-tab-here",
  "new-window",
];
