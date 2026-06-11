/** Persona record stored at `personas/<handle>.json`.
 *
 * Pantheon's equivalent of summon-mcp's `AgentEntry`. Field rename per
 * §3c verb table: lifecycle is `rest` not `idle`, so storage fields
 * follow (`last_rested_at` / `rest_reason`). Pantheon code reads
 * `core` only on memory entries — no `pinned` fallback (legacy data
 * is migrated by Leandro's private one-shot before launch).
 */
export interface Persona {
  username: string;
  project: string;
  cwd: string;
  platform: Platform;
  /** WSL distro to spawn into (`wsl.exe -d <distro>`), platform="wsl"
   * only. Absent / `null` → summons inherit the summoner's running
   * distro (`$WSL_DISTRO_NAME`) at spawn time. A pinned value is
   * validated against the machine's installed distros at write time and
   * re-checked (with self-healing fallback) at spawn time. */
  wsl_distro?: string | null;
  launch_command: string;
  launch_args: string[];
  description: string;
  expertise: string[];
  owns: string[];
  mode: SummonMode;
  color: ClaudeColor | null;
  registered_at: number;
  registered_by_pid: number;
  last_summoned_at: number | null;
  last_rested_at: number | null;
  rest_reason: string | null;
  resume_session_id: string | null;
  /** Base name from the agent's last `/rename` (counter suffix
   * stripped). Null means the agent has never been renamed; summons
   * fall back to `username`. Inherited from summon-mcp. */
  session_name: string | null;
  /** Monotonic counter tracking sessions under the current
   * `session_name`. Starts at 1 at rename time and increments on
   * every summon. Reset when `session_name` changes. */
  summon_count: number;
  /** Set true when this entry was created by `conjure` — the summoner
   * provided location + project, but description/expertise/owns are
   * unset and the new agent must fill them in via `update_profile`
   * before any other tool is allowed. Cleared once the agent's first
   * `update_profile` provides all three fields. */
  provisional: boolean;
  /** Plugin channels to enable for every summon of this persona. Each
   * value is forwarded to the spawned `claude` as `--channels <value>`.
   * The CLI flag (`--channels`, repeatable) overrides per-call. */
  channels?: string[];
  /** When true, every summon of this persona forwards
   * `--remote-control "<persona.project>"` to the spawned `claude`.
   * The CLI flag (`--remote-control` / `--rc [name]`) overrides
   * per-call. */
  remote_control?: boolean;
  /** Default Claude Code permission mode for spawns of this persona.
   * Forwarded as `--permission-mode <value>` to the spawned `claude`.
   * Cascade (highest priority first):
   *   1. per-call `summon({ permission_mode })` arg
   *   2. this field
   *   3. `PANTHEON_DEFAULT_PERMISSION_MODE` env on the spawning MCP
   *   4. hardcoded floor: `"acceptEdits"`
   * `null` (or absent) means "fall through to the cascade". */
  permission_mode?: PermissionMode | null;
  /** Default Claude model for spawns of this persona. Forwarded as
   * `--model <value>` to the spawned `claude`. Omitted means the
   * machine default. Cascade: per-call arg > this field > no flag. */
  model?: string | null;
  /** Default reasoning effort for spawns of this persona. Forwarded as
   * `--effort <value>` to the spawned `claude`. Omitted means the
   * model/machine default. Cascade: per-call arg > this field > no flag. */
  effort?: Effort | null;
  /** Windows Terminal profile name to pin when wt is the spawn
   * adapter. When set, the wt adapter emits `--profile <value>` so
   * the new tab opens in the named WT profile (icon, color scheme,
   * default shell). When unset, WT uses the user's default profile —
   * which for WSL personas often renders as "PowerShell" in the tab
   * strip even though wsl.exe is the running command. WT profile
   * names are user-customized (e.g. "Ubuntu", "Ubuntu-22.04",
   * "Ubuntu Dev"); they don't always match the WSL distro name, so
   * this field stays opt-in. Forwarded only by the wt adapter; other
   * adapters ignore it. `null` means "cleared" (same shape as
   * permission_mode / model). */
  wt_profile?: string | null;
}

export interface PersonaPatch {
  description?: string;
  expertise?: string[];
  owns?: string[];
  launch_command?: string;
  launch_args?: string[];
  mode?: SummonMode;
  color?: ClaudeColor | null;
  session_name?: string | null;
  summon_count?: number;
  provisional?: boolean;
  channels?: string[];
  remote_control?: boolean;
  permission_mode?: PermissionMode | null;
  model?: string | null;
  effort?: Effort | null;
  wt_profile?: string | null;
  /** Correct or clear the persona's WSL spawn distro. A string must
   * name an installed distro (validated); `null` clears the field so
   * summons inherit the summoner's running distro. */
  wsl_distro?: string | null;
}

export type Platform = "wsl" | "windows" | "mac" | "linux";

export type SummonMode = "fresh" | "resume";

export type ClaudeColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";

/** Claude Code's `--permission-mode` values. `acceptEdits` is the
 * "accept edits on" mode in CC's prompt bar — auto-accepts edit /
 * write tool calls. `default` keeps prompts; `plan` blocks all
 * edits; `bypassPermissions` skips ALL checks (handle with care). */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export const PERMISSION_MODES: ReadonlyArray<PermissionMode> = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

/** Claude Code's `--effort` levels — the reasoning-effort knob for the
 * spawned session. Forwarded verbatim; no pantheon-side default (omit
 * the flag → the model/machine default applies). */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORTS: ReadonlyArray<Effort> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Cascade floor — what summoned agents land on when nothing else
 * overrides. `acceptEdits` makes the prompt bar show "accept edits
 * on" from the first turn. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "acceptEdits";

/** Input shape for `createPersona`. Server-managed fields
 * (`registered_at`, `registered_by_pid`, `last_*`, `summon_count`,
 * `provisional`) are filled in by the registry. */
export interface PersonaCreate {
  username: string;
  project: string;
  cwd: string;
  platform: Platform;
  wsl_distro?: string | null;
  launch_command?: string;
  launch_args?: string[];
  description?: string;
  expertise?: string[];
  owns?: string[];
  mode?: SummonMode;
  color?: ClaudeColor | null;
  /** When `provisional: true`, the registry persists the entry but
   * does not require description/expertise/owns. Used by `conjure`. */
  provisional?: boolean;
  channels?: string[];
  remote_control?: boolean;
  permission_mode?: PermissionMode | null;
  model?: string | null;
  effort?: Effort | null;
  wt_profile?: string;
}

export class IdentityError extends Error {
  code: IdentityErrorCode;
  extra: Record<string, unknown>;
  constructor(
    code: IdentityErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "IdentityError";
  }
}

export type IdentityErrorCode =
  | "invalid_username"
  | "digit_suffix_reserved"
  | "reserved_username"
  | "username_taken_other_cwd"
  | "username_prefix_collision"
  | "not_registered"
  | "already_registered"
  | "merge_into_self"
  | "no_persona"
  | "project_single_agent"
  | "project_single_agent_conflict";
