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
    name: "session_info",
    description:
      "Inspect the current session: id, parent pid, platform, claim/guest state, resting flag, summoner, and whether `allow_rest` has been authorized.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },

  // -------- Memory --------
  {
    name: "get_memory",
    description:
      "Render your memory at startup-prompt shape (Core / Active / Index / Hidden tiers). Status NEVER mutates from rendering — collapse is render-time only; recall_memory(id) returns full text regardless. Defaults to your own.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        username: { type: "string" },
        include_forgotten: { type: "boolean" },
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

  // -------- Spawn (stubs until §11a launcher adapters land) --------
  {
    name: "summon",
    description:
      "Spawn an agent in your OWN project. Stub in this build — handler returns `not_implemented` until §11a launcher adapters land. The schema (incl. `target` and `rest_timeout`) is final.",
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
      },
    },
  },
  {
    name: "summon_any",
    description:
      "Cross-project variant of `summon`. Stub until §11a lands.",
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
      },
    },
  },
  {
    name: "conjure",
    description:
      "Create a NEW persona and summon it in one call. Same project. Stub until §11a lands.",
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
        target: SPAWN_TARGET_SCHEMA,
        rest_timeout: REST_TIMEOUT_SCHEMA,
      },
    },
  },
  {
    name: "conjure_any",
    description:
      "Cross-project variant of `conjure`. Stub until §11a lands.",
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
      "Save state and prepare to shut down. Before calling, save anything future-you needs via `append_memory`. Does NOT kill the process — call `exit()` last. Replaces summon-mcp's `idle`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string" },
        session_id: {
          type: "string",
          description: "Claude session id, lets future summon use resume mode.",
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
    description: "Update your chat status line. Stub until §11c.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string" },
        username: { type: "string" },
        project: { type: "string" },
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
      "Search registry + connected-agent list by `owns` / `expertise` / `online`. Stub until §11c (joins registry with chat router state).",
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
];
