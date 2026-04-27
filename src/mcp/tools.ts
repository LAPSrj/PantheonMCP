import type { ToolDef } from "./types.ts";

const PLATFORM_ENUM = ["wsl", "windows", "mac", "linux"] as const;
const COLOR_ENUM = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const;

const PERMISSION_MODE_ENUM = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
] as const;

const PERMISSION_MODE_SCHEMA = {
  type: "string",
  enum: PERMISSION_MODE_ENUM as unknown as string[],
  description:
    "Claude Code `--permission-mode` for spawned `claude` processes. `acceptEdits` (default) shows '⏵⏵ accept edits on' from the first turn. `plan` blocks all edits; `default` keeps interactive prompts; `bypassPermissions` skips ALL checks (use with care).",
} as const;

const SPAWN_TARGET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    "Per-call console spawn target (§5). Adapter detected from env at spawn time; graceful downgrade by default. Pass `strict: true` to error out instead of downgrading. Pass `escape_tmux: true` to spawn in the host terminal instead of the tmux session.",
  properties: {
    mode: {
      type: "string",
      enum: ["new-window", "new-tab-here", "new-tab-window", "split-pane"],
    },
    window: {
      type: "string",
      description: "Named window (durable identity for WT and friends).",
    },
    tab_index: { type: "number" },
    split: { type: "string", enum: ["horizontal", "vertical"] },
    color: { type: "string", enum: COLOR_ENUM as unknown as string[] },
    strict: { type: "boolean" },
    escape_tmux: { type: "boolean" },
  },
};

const REST_TIMEOUT_SCHEMA = {
  oneOf: [
    {
      type: "number",
      description: "Seconds; minimum 3600 (60 min) per §14.",
      minimum: 3600,
    },
    {
      type: "string",
      enum: ["never"],
      description: "Disable auto-rest entirely; no timer is armed.",
    },
  ],
};

export const TOOLS: readonly ToolDef[] = [
  // -------- Identity --------
  {
    name: "whoami",
    description:
      "Look up registered personas at a cwd (defaults to process.cwd()). Returns 0, 1, or many matches plus a hint. " +
      "Call this FIRST on startup if you weren't summoned. " +
      "If exactly 1 match, call `claim({ username })`. " +
      "If 0 matches, invent a fresh creative handle and call `register`. " +
      "If 2+ matches, ask the human or pass a `hint` to `manifest`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "Working directory to search. Defaults to process.cwd()." },
      },
    },
  },
  {
    name: "register",
    description:
      "Create or update a persona registration at a specific cwd. The handle must validate: 1-48 chars, alphanumeric + _/-, no digit suffix (incarnation rule), not a reserved name. Same (handle, cwd) is idempotent. Same handle at a different cwd is rejected unless `force: true`. " +
      "**§13 identity-leak fix**: `claim_after` defaults to `false` — `register` only mutates the registry; the calling session's claim is left untouched. Set `claim_after: true` to opt into the historical conjure-style atomic create-and-claim.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "project"],
      properties: {
        username: { type: "string" },
        project: { type: "string" },
        cwd: { type: "string", description: "Absolute path. Defaults to process.cwd()." },
        platform: { type: "string", enum: PLATFORM_ENUM as unknown as string[] },
        wsl_distro: { type: "string", description: "Required when platform='wsl'." },
        launch_command: { type: "string", description: "Default 'claude'." },
        launch_args: { type: "array", items: { type: "string" } },
        description: { type: "string" },
        expertise: { type: "array", items: { type: "string" } },
        owns: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["fresh", "resume"] },
        color: { type: "string", enum: COLOR_ENUM as unknown as string[] },
        channels: {
          type: "array",
          items: { type: "string" },
          description:
            "Plugin channels forwarded to every summon as `--channels <value>`. CLI flag (`--channels`) overrides per-call.",
        },
        remote_control: {
          type: "boolean",
          description:
            "When true, every summon forwards `--remote-control \"<persona.project>\"`. CLI flag (`--remote-control` / `--rc`) overrides per-call.",
        },
        permission_mode: PERMISSION_MODE_SCHEMA,
        force: { type: "boolean", description: "Override cwd-mismatch + prefix-collision checks." },
        claim_after: {
          type: "boolean",
          description:
            "When true, also flip this session's claim to the new persona. DEFAULT FALSE — §13 identity-leak fix.",
        },
      },
    },
  },
  {
    name: "claim",
    description:
      "Adopt an existing registered persona for this session. Errors `not_registered` if no entry exists. Returns the persona + a memory-entry count.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username"],
      properties: { username: { type: "string" } },
    },
  },
  {
    name: "manifest",
    description:
      "Auto-discover and adopt the right persona for this cwd. Combines `whoami` + `claim`. " +
      "Behavior: (a) exactly 1 match → claim it; (b) 0 matches → returns `{none: true}` with a guidance string; (c) 2+ matches → if `hint` matches one persona's username/description/expertise/owns, claim it; otherwise return `{ambiguous: true, candidates}`. " +
      "Pass `username` to skip discovery and claim directly.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        hint: { type: "string", description: "Free-text clue used to disambiguate multiple matches." },
        username: { type: "string", description: "Skip discovery and claim this exact handle." },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "become",
    description:
      "Switch this session's identity to a different REGISTERED persona without opening a new tab. Errors `not_registered` if the target isn't registered (your session stays at its current identity — no rollback needed since no mutation happened).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username"],
      properties: { username: { type: "string" } },
    },
  },
  {
    name: "update_profile",
    description:
      "Patch your persona's metadata (description, expertise, owns, mode, color, launch_command, launch_args). Defaults to your claimed persona; pass `username` to target someone else (rare). Pass `color: null` to clear.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        username: { type: "string" },
        description: { type: "string" },
        expertise: { type: "array", items: { type: "string" } },
        owns: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["fresh", "resume"] },
        color: {
          oneOf: [
            { type: "string", enum: COLOR_ENUM as unknown as string[] },
            { type: "null" },
          ],
        },
        launch_command: { type: "string" },
        launch_args: { type: "array", items: { type: "string" } },
        channels: { type: "array", items: { type: "string" } },
        remote_control: { type: "boolean" },
        permission_mode: {
          oneOf: [PERMISSION_MODE_SCHEMA, { type: "null" }],
          description:
            "Default permission mode for spawns of this persona. `null` clears the field (cascade falls back to env / floor).",
        },
      },
    },
  },
  {
    name: "unregister",
    description:
      "Remove a persona registration. Defaults to your own claim; pass `username` for someone else. Drops the memory file unless `keep_memory: true`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        username: { type: "string" },
        keep_memory: { type: "boolean" },
      },
    },
  },
  {
    name: "list",
    description:
      "List registered personas. Optional `query` fuzzy-matches across username/description/expertise/owns/project. Optional `project` filters to that project. Use to find the right agent for a task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string" },
        query: { type: "string" },
      },
    },
  },
  {
    name: "fork",
    description:
      "Clone a registered persona into a fresh handle. The new persona " +
      "inherits the source's profile (description / expertise / owns / " +
      "launch_command / launch_args / mode / color / platform / project / " +
      "wsl_distro) but uses the caller-supplied `cwd`. Memory is deep-" +
      "copied with REGENERATED entry IDs by default (`copy_memory: true`); " +
      "set `false` for a clean-slate persona with the source's profile " +
      "only. Forks are snapshots, NOT live mirrors — original and fork " +
      "mutate independently. Chat history references the original " +
      "agent_id, so the fork starts with empty chat participation. " +
      "Errors `not_registered` if `from` doesn't exist; " +
      "`username_taken_other_cwd` / `username_prefix_collision` if `to` " +
      "collides; `username_taken` if `to` is currently online in chat.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to", "cwd"],
      properties: {
        from: { type: "string", description: "Source persona handle." },
        to: { type: "string", description: "New persona handle (must not collide)." },
        cwd: { type: "string", description: "Working directory for the fork. Required." },
        copy_memory: {
          type: "boolean",
          description: "Default true. Set false for a clean-slate persona with profile only.",
        },
      },
    },
  },
  {
    name: "session_info",
    description:
      "Inspect the current session: id, parent pid, platform, claim/guest state, resting flag, summoner, and whether `allow_rest` has been authorized.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },

  // -------- Memory --------
  {
    name: "get_memory",
    description:
      "Render your memory at startup-prompt shape (Core / Active / Index / Hidden tiers). Status NEVER mutates from rendering — collapse is render-time only; recall_memory(id) returns full text regardless. Defaults to your own. " +
      "Pass `only_core: true` to render the Core tier in isolation (useful for cheap peer-inspection: `get_memory({ username: someone-else, only_core: true })`).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        username: { type: "string" },
        include_forgotten: { type: "boolean" },
        only_core: {
          type: "boolean",
          description:
            "Render Core tier only — skip Active/Index/Hidden. Default false.",
        },
      },
    },
  },
  {
    name: "append_memory",
    description:
      "Create a new active memory entry. `text` is required. `summary` (≤240 ch) is auto-derived from text when omitted; provide explicitly when the first line isn't a good headline. `details` (≤5 MB) is the unbounded-payload field — never inlined at startup; only via `get_memory_details(id)`. " +
      "Common `kind` values: 'decision', 'gotcha', 'handoff', 'fact', 'log'. " +
      "Pass `core: true` for foundational entries (rendered in full at startup, subject to 10 KB middle-out cap). " +
      "`summoner_username` is auto-populated when this session was spawned by another agent's `summon`; you can override.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string" },
        summary: { type: "string", description: "≤240 chars; auto-derived from text when omitted." },
        details: { type: "string", description: "Unbounded payload, ≤5 MB. Never inlined at startup." },
        kind: { type: "string" },
        core: { type: "boolean" },
        summoner_username: { type: "string" },
        replies_to: {
          type: "string",
          description:
            "Entry id this entry replies to. Renderer indents replies under their parent in the Index. Referenced id must exist in this persona's memory; otherwise rejects `invalid_reference`.",
        },
        see_also: {
          type: "array",
          items: { type: "string" },
          description:
            "Entry ids cited inline at the end of the synopsis. Each must exist; otherwise rejects `invalid_reference`.",
        },
      },
    },
  },
  {
    name: "update_memory",
    description:
      "Patch an existing memory entry. Pass `details: null` to clear details. Pass `core: false` to demote a core entry.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        summary: { type: "string" },
        text: { type: "string" },
        details: {
          oneOf: [{ type: "string" }, { type: "null" }],
        },
        kind: { type: "string" },
        status: { type: "string", enum: ["active", "faded", "forgotten"] },
        core: { type: "boolean" },
        replies_to: {
          oneOf: [{ type: "string" }, { type: "null" }],
          description: "Set to a new id to replace; null to clear.",
        },
        see_also: {
          oneOf: [
            { type: "array", items: { type: "string" } },
            { type: "null" },
          ],
          description: "Set to a new array to replace; null to clear.",
        },
      },
    },
  },
  {
    name: "set_memory",
    description:
      "Replace ALL entries with a single new active entry. Nuclear — prefer `append_memory` and `fade_memory`/`forget_memory`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string" },
        summary: { type: "string" },
      },
    },
  },
  {
    name: "recall_memory",
    description:
      "Retrieve the full text of any memory entry by id, regardless of render tier. Flips faded → active in the same call. Use when you see a collapsed entry's summary and want the body.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        username: { type: "string" },
      },
    },
  },
  {
    name: "fade_memory",
    description:
      "Mark an entry as faded. Hidden from the Active tier; appears in the Index synopsis. Body preserved — `recall_memory(id)` expands.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "forget_memory",
    description:
      "Mark an entry as forgotten. Hidden from `get_memory` unless `include_forgotten: true`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "list_memory",
    description:
      "Index-shape listing for memory: id, date, status, core, summary, size_kb, has_details, kind?. Cheaper than `get_memory` — no body content. Sorted date-descending. Filters compose: `status` (default 'active'; pass 'all'), `core`, `kind`, `since`, `filter` (substring).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        username: { type: "string" },
        status: { type: "string", enum: ["active", "faded", "forgotten", "all"] },
        core: { type: "boolean" },
        kind: { type: "string" },
        since: { type: "string", description: "ISO date lower bound." },
        filter: { type: "string", description: "Case-insensitive substring across summary + text." },
      },
    },
  },
  {
    name: "find_memory",
    description:
      "Search across one or many personas' memory for entries matching `query`. " +
      "`scope: \"self\"` (default) searches your own; `scope: \"all\"` walks every registered persona. " +
      "Returns hits with `username` attached so you can route follow-ups (e.g. `recall_memory({ id, username })`). " +
      "Sorted newest-first across the union; capped at `limit` (default 50). " +
      "Other filters (`kind`, `since`, `status`, `core`) compose with `query`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Case-insensitive substring across summary + text." },
        scope: { type: "string", enum: ["self", "all"], description: "Default 'self'." },
        kind: { type: "string" },
        since: { type: "string", description: "ISO date lower bound." },
        status: { type: "string", enum: ["active", "faded", "forgotten", "all"] },
        core: { type: "boolean" },
        limit: { type: "number", description: "Default 50." },
      },
    },
  },
  {
    name: "get_memory_details",
    description:
      "Return ONLY the `details` field of an entry (not summary or text — caller already has those from get_memory). Errors `entry_not_found` if no entry. Returns `details: null` when the entry has no details.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        username: { type: "string" },
      },
    },
  },
  {
    name: "snapshot_memory",
    description:
      "Persist a labeled snapshot of your current memory store at " +
      "`personas/<handle>/memory.snapshots/<label>.json`. Snapshots are " +
      "atomic-rename JSON files, count toward disk usage, and have NO " +
      "auto-cleanup — call `delete_snapshot` to free space. Use before " +
      "a risky update_memory / set_memory you might want to roll back.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: {
        label: {
          type: "string",
          description:
            "Label for this snapshot. Alphanumeric + _ . -, ≤64 chars, leading alphanumeric.",
        },
      },
    },
  },
  {
    name: "restore_memory",
    description:
      "Restore your memory store from a labeled snapshot. Overwrites the " +
      "current main store; reversible only by another snapshot before " +
      "calling this. Errors `entry_not_found` when the label doesn't exist.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: { label: { type: "string" } },
    },
  },
  {
    name: "list_snapshots",
    description:
      "List every snapshot for a persona (default: your own). Returns " +
      "label + size_bytes + created_at, sorted newest-first.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { username: { type: "string" } },
    },
  },
  {
    name: "delete_snapshot",
    description:
      "Delete a labeled snapshot of your memory. Returns `deleted: false` " +
      "when the label didn't exist (idempotent).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: { label: { type: "string" } },
    },
  },

  // -------- Spawn --------
  {
    name: "summon",
    description:
      "Spawn an agent in your OWN project. Resolves the persona registration, applies cross-project guard, picks a host adapter (wt / kitty / tmux / alacritty / generic), opens a window/tab/pane per `target`, and arms a watchdog with `rest_timeout`. Pass `chat_username_suffix` to chat under `<persona>2` when the canonical handle is taken by a peer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username"],
      properties: {
        username: { type: "string" },
        prompt: { type: "string" },
        resume: { type: "boolean" },
        target: SPAWN_TARGET_SCHEMA,
        rest_timeout: REST_TIMEOUT_SCHEMA,
        channels: {
          type: "array",
          items: { type: "string" },
          description:
            "Per-call override for the persona's `channels` field. Each value forwards as `--channels <value>` to the spawned `claude`.",
        },
        remote_control: {
          oneOf: [
            { type: "boolean" },
            { type: "string", description: "Explicit RC name." },
          ],
          description:
            "Per-call override for the persona's `remote_control` field. `true` uses the persona's project as the RC name; pass a string for an explicit name.",
        },
        permission_mode: PERMISSION_MODE_SCHEMA,
        chat_username_suffix: {
          type: "string",
          description:
            "Chat as `<persona><N>` instead of `<persona>` (sibling-incarnation alias). Use when another session already holds the canonical handle. Persona identity stays canonical — only the bootstrap-embedded chat login uses the suffixed handle.",
        },
      },
    },
  },
  {
    name: "summon_any",
    description:
      "Cross-project variant of `summon` — bypasses the same-project guard. Same flow otherwise (adapter dispatch, watchdog, optional `chat_username_suffix`).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username"],
      properties: {
        username: { type: "string" },
        prompt: { type: "string" },
        resume: { type: "boolean" },
        target: SPAWN_TARGET_SCHEMA,
        rest_timeout: REST_TIMEOUT_SCHEMA,
        channels: {
          type: "array",
          items: { type: "string" },
          description:
            "Per-call override for the persona's `channels` field. Each value forwards as `--channels <value>` to the spawned `claude`.",
        },
        remote_control: {
          oneOf: [
            { type: "boolean" },
            { type: "string", description: "Explicit RC name." },
          ],
          description:
            "Per-call override for the persona's `remote_control` field. `true` uses the persona's project as the RC name; pass a string for an explicit name.",
        },
        permission_mode: PERMISSION_MODE_SCHEMA,
        chat_username_suffix: {
          type: "string",
          description:
            "Chat as `<persona><N>` instead of `<persona>` (sibling-incarnation alias). Use when another session already holds the canonical handle. Persona identity stays canonical — only the bootstrap-embedded chat login uses the suffixed handle.",
        },
      },
    },
  },
  {
    name: "conjure",
    description:
      "Create a NEW persona and summon it in one atomic call. Same project. Combines `register` + `summon` so the new agent is registered, the cwd is auto-trusted, the spawn target is opened, and the watchdog is armed without two round trips.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "cwd", "project", "prompt"],
      properties: {
        username: { type: "string" },
        cwd: { type: "string" },
        project: { type: "string" },
        prompt: { type: "string" },
        platform: { type: "string", enum: PLATFORM_ENUM as unknown as string[] },
        wsl_distro: { type: "string" },
        launch_command: { type: "string" },
        launch_args: { type: "array", items: { type: "string" } },
        color: { type: "string", enum: COLOR_ENUM as unknown as string[] },
        mode: { type: "string", enum: ["fresh", "resume"] },
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Initial channels[] persisted on the new persona.",
        },
        remote_control: {
          type: "boolean",
          description: "Initial remote_control flag persisted on the new persona.",
        },
        permission_mode: {
          ...PERMISSION_MODE_SCHEMA,
          description: "Initial permission_mode persisted on the new persona (also used for this first spawn).",
        },
        chat_username_suffix: {
          type: "string",
          description:
            "Chat as `<persona><N>` instead of `<persona>` for this spawn (sibling-incarnation alias). Persona identity stays canonical.",
        },
        target: SPAWN_TARGET_SCHEMA,
        rest_timeout: REST_TIMEOUT_SCHEMA,
      },
    },
  },
  {
    name: "conjure_any",
    description:
      "Cross-project variant of `conjure` — bypasses the caller-project guard so you can spawn a new persona for a different project than your own.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "cwd", "project", "prompt"],
      properties: {
        username: { type: "string" },
        cwd: { type: "string" },
        project: { type: "string" },
        prompt: { type: "string" },
        platform: { type: "string", enum: PLATFORM_ENUM as unknown as string[] },
        wsl_distro: { type: "string" },
        launch_command: { type: "string" },
        launch_args: { type: "array", items: { type: "string" } },
        color: { type: "string", enum: COLOR_ENUM as unknown as string[] },
        mode: { type: "string", enum: ["fresh", "resume"] },
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Initial channels[] persisted on the new persona.",
        },
        remote_control: {
          type: "boolean",
          description: "Initial remote_control flag persisted on the new persona.",
        },
        permission_mode: {
          ...PERMISSION_MODE_SCHEMA,
          description: "Initial permission_mode persisted on the new persona (also used for this first spawn).",
        },
        chat_username_suffix: {
          type: "string",
          description:
            "Chat as `<persona><N>` instead of `<persona>` for this spawn (sibling-incarnation alias). Persona identity stays canonical.",
        },
        target: SPAWN_TARGET_SCHEMA,
        rest_timeout: REST_TIMEOUT_SCHEMA,
      },
    },
  },

  // -------- Lifecycle (rest family + legacy idle aliases) --------
  {
    name: "allow_rest",
    description:
      "Record that the user has authorized this (non-summoned) session to rest when done. Only needed for human-started sessions — summoned sessions can rest without this. Replaces summon-mcp's `allow_idle`.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "rest",
    description:
      "Save state and prepare to shut down. Before calling, save anything " +
      "future-you needs via `append_memory`. Does NOT kill the process — " +
      "call `exit()` last. Replaces summon-mcp's `idle`. " +
      "**Optional `handoff` slot** writes a `kind: \"handoff\"` core " +
      "memory entry (auto-fades after 7 days via the daemon-tick) and, " +
      "when chat is bound, DMs the target with the same text — atomic " +
      "with the rest call so you don't have to coordinate two calls.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string" },
        session_id: {
          type: "string",
          description: "Claude session id, lets future summon use resume mode.",
        },
        handoff: {
          type: "object",
          additionalProperties: false,
          required: ["for", "text"],
          description:
            "Optional handoff slot — write a `kind: \"handoff\"` core memory entry + DM the target.",
          properties: {
            for: { type: "string", description: "Persona handle to receive the handoff DM." },
            text: { type: "string", description: "Handoff body — written to memory + sent as DM." },
          },
        },
      },
    },
  },
  {
    name: "extend_rest",
    description:
      "Push the auto-rest deadline further out. Replaces summon-mcp's `extend_idle`. `minutes` minimum is 60 (per §14 minimum rest_timeout).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["minutes"],
      properties: { minutes: { type: "number" } },
    },
  },
  {
    name: "exit",
    description:
      "Close this session. SIGTERMs the parent (Claude Code) so the terminal tab closes. Call AFTER `rest()` and after saying goodbye.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        delay_seconds: {
          type: "number",
          description: "Seconds to wait before SIGTERM. Default 2.",
        },
      },
    },
  },

  // Legacy aliases (deprecated; one-release window).
  {
    name: "allow_idle",
    description:
      "DEPRECATED: use `allow_rest`. Retained for one release; surfaces a `deprecation` field in the response.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "idle",
    description:
      "DEPRECATED: use `rest`. Retained for one release; surfaces a `deprecation` field in the response.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string" },
        session_id: { type: "string" },
      },
    },
  },
  {
    name: "extend_idle",
    description:
      "DEPRECATED: use `extend_rest`. Retained for one release; surfaces a `deprecation` field in the response.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["minutes"],
      properties: { minutes: { type: "number" } },
    },
  },

  // -------- Chat (stubs until §11c chat router lands) --------
  {
    name: "login",
    description:
      "Join the chat router. Stub until §11c. Schema: `username`, `project`, `status`, `transient` (chat-only guest mode per §10), `promote` (guest → persona promote-in-place).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "project"],
      properties: {
        username: { type: "string" },
        project: { type: "string" },
        status: { type: "string" },
        transient: { type: "boolean", description: "Chat-only guest mode (§10)." },
        promote: {
          type: "object",
          additionalProperties: false,
          properties: {
            project: { type: "string" },
            description: { type: "string" },
            expertise: { type: "array", items: { type: "string" } },
            owns: { type: "array", items: { type: "string" } },
            cwd: { type: "string" },
          },
        },
      },
    },
  },
  {
    name: "logout",
    description: "Leave the chat router. Stub until §11c.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "send_message",
    description: "Post a chat message (project / dm / global scope). Stub until §11c.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string" },
        scope: { type: "string", enum: ["project", "dm", "global"] },
        target: { type: "string" },
        reply_to: { type: "string" },
      },
    },
  },
  {
    name: "ask",
    description: "Ask a peer with correlation_id; awaits answer or times out. Stub until §11c.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["target", "text"],
      properties: {
        target: { type: "string" },
        text: { type: "string" },
        timeout_ms: { type: "number" },
      },
    },
  },
  {
    name: "answer",
    description: "Respond to an `ask` by correlation_id. Stub until §11c.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["correlation_id", "text"],
      properties: {
        correlation_id: { type: "string" },
        text: { type: "string" },
      },
    },
  },
  {
    name: "set_mode",
    description: "Change watcher delivery mode (all / quiet / project / dm). Stub until §11c.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { type: "string", enum: ["all", "quiet", "project", "dm"] },
      },
    },
  },
  {
    name: "update_status",
    description:
      "Update your chat status line. Use SPARINGLY — TOPIC-LEVEL signal, not per-step changelog. " +
      "Daemon enforces a 10-minute topic cooldown: a `topic_cooldown_active` rejection means re-evaluate (probably it's a sub-task within the same topic, not a real shift). `confirmed: true` bypasses, but read the rejection first. " +
      "Status changes are NOT broadcast per-event — a periodic `status_digest` (default 10 min, env: PANTHEON_STATUS_DIGEST_MINUTES) batches them and DMs each non-dm/non-quiet peer. Anyone can pull current status anytime via `list_agents`. " +
      "Idempotent calls (same status text) and rename/project-only calls bypass the cooldown.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string" },
        username: { type: "string" },
        project: { type: "string" },
        confirmed: {
          type: "boolean",
          description:
            "Bypass the 10-minute topic cooldown. Set true ONLY after reading a `topic_cooldown_active` rejection and confirming this really is a topic shift (not a sub-task).",
        },
        meta: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                task: { type: "string", description: "Concrete task you're on right now." },
                blocker: { type: "string", description: "What's blocking you, if anything." },
                eta: { type: "string", description: "Free-form ETA ('2pm', 'EOD', 'after lunch')." },
              },
              description:
                "Optional structured status metadata for dashboards. Only the supplied fields update; existing meta is preserved when meta is omitted. Free-form `status` line stays the canonical signal.",
            },
            { type: "null", description: "Pass null to clear all metadata fields." },
          ],
        },
      },
    },
  },
  {
    name: "check_messages",
    description: "Pull pending messages without subscribing to the watcher stream. Stub until §11c.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "number" } },
    },
  },
  {
    name: "list_agents",
    description: "List currently-connected chat agents. Stub until §11c.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { project: { type: "string" } },
    },
  },
  {
    name: "find_role",
    description:
      "Search registry + connected-agent list by `owns` / `expertise` / `online`. Joins registry with chat router state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        owns: { type: "string" },
        expertise: { type: "string" },
        online: { type: "boolean" },
      },
    },
  },
  {
    name: "get_message",
    description:
      "Fetch the full text of a single chat message by id. Recovery path for watcher events that arrived as `[oversized message …]` stubs — pantheon source-truncates messages above its watcher emit threshold so they fit inside CC's Monitor-event harness cap, and ships the full body through this tool on demand. The `message_id` is in the stub event the watcher emitted. Returns the full row (text + metadata); errors `not_found` for unknown ids.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["message_id"],
      properties: {
        message_id: { type: "string" },
      },
    },
  },
];
