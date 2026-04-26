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
  wsl_distro?: string;
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

/** Input shape for `createPersona`. Server-managed fields
 * (`registered_at`, `registered_by_pid`, `last_*`, `summon_count`,
 * `provisional`) are filled in by the registry. */
export interface PersonaCreate {
  username: string;
  project: string;
  cwd: string;
  platform: Platform;
  wsl_distro?: string;
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
  | "no_persona";
