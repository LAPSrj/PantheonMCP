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
    "Claude Code `--permission-mode` for spawned `claude` processes. `acceptEdits` (default) shows 'accept edits on' in the prompt bar from the first turn. `plan` blocks all edits; `default` keeps interactive prompts; `bypassPermissions` skips ALL checks (use with care).",
} as const;

const MODEL_SCHEMA = {
  type: "string",
  description:
    "Claude model codename forwarded as `--model` to the spawned `claude` (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`). Omit to use the machine default.",
} as const;

const PROFILE_SCHEMA = {
  type: "string",
  description:
    "Per-call credential profile, forwarded as `--profile=<value>` to the spawned `claude`. " +
    "Lets a summoner pick which credentials file the spawned agent will bind " +
    "(e.g. 'work', 'personal'). Pantheon stays agnostic about what the flag means; " +
    "meaningful only when paired with a profile-aware launcher.",
} as const;

const CONFIRM_NEW_PROFILE_SCHEMA = {
  type: "boolean",
  description:
    "When set with `profile`, forwards `--confirm-new-profile` to the spawned `claude`. " +
    "Required by the launcher to create a new profile directory on first use; " +
    "without it, an unknown profile name triggers an explicit error rather than silent creation.",
} as const;

const BLOCK_SELF_EXIT_SCHEMA = {
  type: "boolean",
  description:
    "Per-call: when true, the spawned agent CANNOT call `rest`, `exit`, or `logout` on itself — " +
    "those handlers return `self_exit_blocked` and require the caller (or any peer) to use " +
    "`force_rest` / `force_exit` to release the session. Default false. " +
    "Because a blocked agent has no self-exit path, its `rest_timeout` defaults to 3600s (60 min) " +
    "rather than the usual \"never\" — an intentional safety valve so a dead supervisor can't pin a " +
    "target forever. Pass `rest_timeout: \"never\"` explicitly to opt out. Use for long-running " +
    "supervised agents, agents under audit, and phase-6 builders where the caller manages lifecycle.",
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
    wt_profile: {
      type: "string",
      description:
        "Windows Terminal profile name to pin for this spawn. Overrides the persona's registered `wt_profile`. Other adapters ignore.",
    },
  },
};

const REST_TIMEOUT_SCHEMA = {
  description:
    "Per-summon auto-rest timeout. DEFAULT when omitted is \"never\" (auto-rest off — the summon runs until `exit()` or the user closes the tab); pass a number of seconds to opt into a finite idle timeout. Exception: a `block_self_exit` summon defaults to 3600s (60 min) instead of \"never\" — that agent has no self-exit path, so the timer is its safety valve against a dead supervisor.",
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

/** Full tool-definition list — the advertised `TOOLS` surface. */
const ALL_TOOL_DEFS: readonly ToolDef[] = [
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
        model: MODEL_SCHEMA,
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
      "Pass `username` to skip discovery and claim directly. " +
      "When a persona is claimed, the response also carries `resume_summary` — a compact bounded view of session-relevant memory state (active_memory_count, memory_by_kind facet counts, recent_memory refs) so the agent can pick up where it left off without scanning memory or chat history.",
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
        model: {
          oneOf: [MODEL_SCHEMA, { type: "null" }],
          description:
            "Default model for spawns of this persona. `null` clears the field (cascade falls back to machine default).",
        },
        wt_profile: {
          oneOf: [{ type: "string" }, { type: "null" }],
          description:
            "Windows Terminal profile name to pin for spawns of this persona (e.g. 'Ubuntu-22.04', 'Ubuntu Dev'). When set, the wt adapter emits `--profile <value>` so the new tab opens in the named WT profile rather than the user's default. Other adapters ignore. `null` clears the field.",
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
    name: "merge",
    description:
      "Consolidate one persona INTO another, then drop the source — the " +
      "inverse of `fork`. Folds `from`'s memory into `into` (entries " +
      "deep-copied with regenerated ids, PRESERVING each entry's date / " +
      "status / topic / pin / kind and remapping internal references; " +
      "forgotten tombstones are skipped). Unions `from`'s `owns` + " +
      "`expertise` into `into` (`union_profile`, default true; the target " +
      "keeps its own description / launch / mode / color). Then " +
      "unregisters + deletes `from` including its memory (`drop_source`, " +
      "default true) so you end with a single persona. Chat history is " +
      "keyed by agent_id and is NOT moved — past messages stay attributed " +
      "to the source handle; memory snapshots are not copied. Errors " +
      "`not_registered` if either handle is missing, `merge_into_self` if " +
      "from===into, `merge_source_online` if `from` is currently connected " +
      "to chat (rest/exit it first).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["from", "into"],
      properties: {
        from: {
          type: "string",
          description: "Source persona to consolidate (deleted unless drop_source:false).",
        },
        into: {
          type: "string",
          description: "Target persona that absorbs the source's memory + (unioned) profile.",
        },
        union_profile: {
          type: "boolean",
          description:
            "Default true. Union the source's owns + expertise into the target (dedup, order-stable). Set false to leave the target's profile untouched.",
        },
        drop_source: {
          type: "boolean",
          description:
            "Default true. Unregister + delete the source (incl. its memory) after merge. Set false for a non-destructive copy-merge.",
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
      "Render YOUR OWN memory at startup-prompt shape (pinned FULL / `always` / loaded topics / menu). Self-only — to inspect another persona use `get_memory_any`. Status NEVER mutates from rendering — collapse is render-time only; recall_memory(id) returns full text regardless. " +
      "Pass `only_core: true` to render just the pinned + `always` surface.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
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
    name: "get_memory_any",
    description:
      "Cross-persona read: render ANOTHER persona's memory (pinned FULL + `always` summaries + topic menu counts — topic bodies stay collapsed; use `recall_memory_any` for a specific entry). The `_any` suffix marks this as the elevated, separately-deniable variant of self-only `get_memory`. `only_core: true` for a cheap pinned+always peek.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username"],
      properties: {
        username: { type: "string", description: "Persona to inspect." },
        include_forgotten: { type: "boolean" },
        only_core: { type: "boolean", description: "Render pinned + `always` only. Default false." },
      },
    },
  },
  {
    name: "list_topics",
    description:
      "v2 boot step (§9): YOUR topic menu. Returns clustered topics + per-topic counts + the due-reminder count, without loading any entry bodies. Self-only. Gate-exempt — call it after manifest, before `load_memory`. A fresh persona returns an empty topic list (the load gate is then skipped).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "load_memory",
    description:
      "v2 boot step (§9), REQUIRED before chat. Declares the topic(s) relevant to this session and returns your memory rendered for them (pinned FULL + `always` summaries + each declared topic's entries + due reminders + delivered handoffs; other topics show as a menu count). Lifts the dispatcher load gate for the rest of the conversation. Pass `topics: [\"chat\", \"memory\"]` or a single `topic`; use \"always\" for the every-session set.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        topics: { type: "array", items: { type: "string" } },
        topic: { type: "string", description: "Convenience for a single topic." },
      },
    },
  },
  {
    name: "get_instructions",
    description:
      "Read-only topic-keyed pull for canonical pantheon guidance your CLAUDE.md doesn't inline (memory, chat, lifecycle, summon, topics, boot). Pass `topic` for one section; omit for the menu. System-authored manual — distinct from persona memory.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { topic: { type: "string" } },
    },
  },
  {
    name: "append_memory",
    description:
      "Create a new active memory entry. `text` is required. `summary_max240` (≤240 ch) is auto-derived from text when omitted; provide explicitly when the first line isn't a good headline. " +
      "`kind` is one of: rule, fact, gotcha, pointer, note, handoff, reminder. Durable kinds (rule/fact/gotcha/pointer) + handoff REQUIRE a `topic`. To render an entry in full every session use `pin: true` + `pin_reason` (byte-budgeted). " +
      "`summoner_username` is auto-populated when this session was spawned by another agent's `summon`; you can override.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string" },
        summary_max240: { type: "string", description: "≤240-char headline (the cap is in the name). Auto-derived from text when omitted; provide explicitly when the first line isn't a good headline. Phrase the TRIGGER (\"when doing X, remember Y\"), not a bare title. Stored as `summary`." },
        kind: { type: "string", description: "One of: rule, fact, gotcha, pointer, note, handoff, reminder. Legacy kinds (decision/log/…) are mapped + warned." },
        expires_at: {
          oneOf: [{ type: "number" }, { type: "null" }],
          description:
            "Optional ms-epoch TTL. The daemon-tick auto-fades the entry once this time passes — use it for time-boxed entries (a branch note good until a PR merges, a scratch fact). A `kind: \"handoff\"` entry auto-gets a 7-day TTL when this field is OMITTED; pass `expires_at: null` to opt a handoff out of auto-expiry. Non-handoff entries without `expires_at` never auto-fade. The sweep only fades (never forgets), so a faded entry is still recoverable via `recall_memory`.",
        },
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
        topic: {
          type: "string",
          description:
            "v2: topic for topic-scoped load — unified with the slug domain (slug = <topic>/<name>). REQUIRED for durable kinds (rule/fact/gotcha/pointer) + handoff; notes inherit the session topic; `always` loads every session. `list_topics` shows existing topics.",
        },
        pin: {
          type: "boolean",
          description:
            "v2: render this entry in FULL every session regardless of topic (byte-budgeted; reject→consolidate). Requires pin_reason.",
        },
        pin_reason: {
          type: "string",
          description: "v2: one-line justification, required alongside pin.",
        },
        due: {
          oneOf: [{ type: "number" }, { type: "string", enum: ["next-session"] }],
          description:
            "v2 reminder: ms-epoch instant (UTC) or the literal \"next-session\". Omit for an open reminder that resurfaces until acted on.",
        },
        supersedes: {
          type: "string",
          description:
            "v2: id of an entry this one replaces. The superseded entry is coerced to forgotten (recoverable).",
        },
        sources: {
          type: "array",
          description:
            "v2 provenance (opt-in, one or more). Each item cites ONE origin; the system SNAPSHOTS its text at write (durable against chat/transcript pruning) and keeps the coordinates for later re-verification. Pass exactly one of: { message_id } (a chat message), { session_id, message_at } (a transcript turn), or { quote } (verbatim user-typed text). `label` is an optional human tag (e.g. \"Leandro 2026-06-01\"). NEVER returned by default — recall_memory only flags `has_source`; fetch the full set via `get_memory_source(id)`.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              message_id: { type: "string" },
              session_id: { type: "string" },
              message_at: { type: "string" },
              quote: { type: "string" },
              label: { type: "string" },
            },
          },
        },
        verbose: {
          type: "boolean",
          description:
            "Return the full stored entry instead of the compact ack ({ id, status, text_chars, derived?, warnings? }). Default false — the compact ack avoids echoing back the text you just sent.",
        },
      },
    },
  },
  {
    name: "update_memory",
    description:
      "Patch an existing memory entry. To unpin, pass `pin: false`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        summary_max240: { type: "string", description: "≤240-char headline (the cap is in the name); phrase the trigger. Stored as `summary`." },
        text: { type: "string" },
        kind: { type: "string" },
        status: { type: "string", enum: ["active", "faded", "forgotten"] },
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
        topic: { type: "string", description: "v2: re-file under a topic." },
        pin: {
          type: "boolean",
          description: "v2: pin (full every session) or unpin (false clears pin + pin_reason).",
        },
        pin_reason: { type: "string", description: "v2: justification for pin." },
        due: {
          oneOf: [
            { type: "number" },
            { type: "string", enum: ["next-session"] },
            { type: "null" },
          ],
          description: "v2 reminder due; null clears.",
        },
        supersedes: { type: "string", description: "v2: id this entry supersedes." },
        sources: {
          oneOf: [
            {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  message_id: { type: "string" },
                  session_id: { type: "string" },
                  message_at: { type: "string" },
                  quote: { type: "string" },
                  label: { type: "string" },
                },
              },
            },
            { type: "null" },
          ],
          description:
            "v2 provenance: replace the source set (re-snapshotted at write) or null to clear. Same item shape as append_memory.sources.",
        },
        verbose: {
          type: "boolean",
          description:
            "Return the full updated entry instead of the compact diff ({ id, status, changed, unchanged, coerced? }). Default false.",
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
        summary_max240: { type: "string", description: "≤240-char headline; stored as `summary`." },
      },
    },
  },
  {
    name: "recall_memory",
    description:
      "Retrieve the full text of one of YOUR OWN memory entries by id, regardless of render tier. Flips faded → active in the same call. Self-only — for another persona's entry use `recall_memory_any` (read-only). Use when you see a collapsed entry's summary and want the body.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
      },
    },
  },
  {
    name: "recall_memory_any",
    description:
      "Cross-persona full-text read: return another persona's memory entry by id (any tier/status). READ-ONLY — unlike self-`recall_memory` it does NOT flip the peer's faded entry to active. The `_any` suffix marks this as the elevated, separately-deniable variant. Errors `entry_not_found` if no such entry.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "id"],
      properties: {
        username: { type: "string", description: "Persona that owns the entry." },
        id: { type: "string" },
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
    name: "arm_watcher",
    description:
      "Arm a WATCH LANE — a long-lived background job (package tracking, a deploy/CI watch, a poll) whose resources (crons / Monitors) die with THIS session. Writes a kind:\"watcher\" memory entry binding the arming session (owner_agent_id) + your canonical persona (owner_username) and a re-arm payload. When the arming session leaves chat presence, the watch is detected as ORPHANED and surfaced LOUD at every boot (load_memory/login) of your persona until a sibling re-arms it via `claim_watcher`. Must run from a session logged into chat (the owner binding is the live agent_id). Topic-required (durable kind). `rearm` MUST carry enough to re-arm without archaeology — at least one of crons/commands/ledger/notes. scope:'persona' (default, fully wired); 'project' is a flagged fast-follow (rejected for now).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["topic", "text", "rearm"],
      properties: {
        topic: { type: "string", description: "Topic for the entry (slug = <topic>/<name>)." },
        summary_max240: {
          type: "string",
          description: "≤240-char headline; phrase the trigger (\"when the X watch is orphaned, re-arm Y\").",
        },
        text: { type: "string", description: "What the watch is for; prose context for a successor." },
        rearm: {
          type: "object",
          additionalProperties: false,
          description: "Executable re-arm payload — the machine slice a successor needs. At least one field required.",
          properties: {
            crons: { type: "array", items: { type: "string" }, description: "Cron specs / IDs to recreate (e.g. CronCreate args)." },
            commands: { type: "array", items: { type: "string" }, description: "Monitor commands / shell to re-run." },
            ledger: { type: "string", description: "Pointer to a ledger / notes file, if the lane keeps one." },
            notes: { type: "string", description: "Free-form 'to re-arm: …' instructions." },
          },
        },
        close_condition: {
          type: "string",
          description: "Human-readable 'done when …'. v1 close is explicit (close_watcher); not auto-evaluated.",
        },
        scope: {
          type: "string",
          enum: ["persona", "project"],
          description: "Re-arm pool. 'persona' (default): any live sibling of your persona may claim. 'project': deferred fast-follow.",
        },
      },
    },
  },
  {
    name: "claim_watcher",
    description:
      "Atomically claim an ORPHANED watch lane for re-arming. Compare-and-swap: re-binds owner_agent_id to YOUR live session ONLY IF the current owner is still orphaned (absent from presence). If a live sibling already holds it you lose cleanly (`won:false`) — no duplicate re-arm. On win, returns the `rearm` payload so you can recreate the crons/Monitors, then `close_watcher` when the watch completes. Run from a session logged into chat.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string", description: "The watcher entry id." } },
    },
  },
  {
    name: "close_watcher",
    description:
      "Close a watch lane when the watch completes — fades the kind:\"watcher\" entry (recoverable via recall_memory if it re-opens). Explicit close; the close_condition is the human-readable check, not auto-evaluated.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: "The watcher entry id." },
        verbose: { type: "boolean", description: "Return the full faded entry." },
      },
    },
  },
  {
    name: "list_memory",
    description:
      "Index-shape listing of YOUR OWN memory: id, date, status, core, summary, size_kb, has_details, kind?, topic?. Cheaper than `get_memory` — no body content. Self-only — for another persona use `list_memory_any`. Sorted date-descending. Filters compose: `status` (default 'active'; pass 'all'), `core`, `kind`, `since`, `filter` (substring).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["active", "faded", "forgotten", "all"] },
        core: { type: "boolean" },
        kind: { type: "string" },
        since: { type: "string", description: "ISO date lower bound." },
        filter: { type: "string", description: "Case-insensitive substring across summary + text." },
      },
    },
  },
  {
    name: "list_memory_any",
    description:
      "Cross-persona index listing: another persona's entries (id, date, status, summary, kind, topic, size). The `_any` suffix marks this as the elevated, separately-deniable variant of self-only `list_memory`. Same filters.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username"],
      properties: {
        username: { type: "string", description: "Persona to list." },
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
      "Search YOUR OWN memory for entries matching `query`. Self-only — to search across every registered persona use `find_memory_any`. " +
      "Sorted newest-first; capped at `limit` (default 50). " +
      "Other filters (`kind`, `since`, `status`, `core`) compose with `query`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Case-insensitive substring across summary + text." },
        kind: { type: "string" },
        since: { type: "string", description: "ISO date lower bound." },
        status: { type: "string", enum: ["active", "faded", "forgotten", "all"] },
        core: { type: "boolean" },
        limit: { type: "number", description: "Default 50." },
      },
    },
  },
  {
    name: "find_memory_any",
    description:
      "Cross-persona search: walk EVERY registered persona's memory for entries matching `query`. Hits carry `username` so follow-ups route via `recall_memory_any` / `get_memory_details_any`. The `_any` suffix marks this as the elevated, separately-deniable variant of self-only `find_memory`. Sorted newest-first; capped at `limit` (default 50).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Case-insensitive substring across summary + text." },
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
      "Return ONLY the `details` field of one of YOUR OWN entries (not summary or text — caller already has those from get_memory). Self-only — for another persona use `get_memory_details_any`. Errors `entry_not_found` if no entry. Returns `details: null` when the entry has no details.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
      },
    },
  },
  {
    name: "get_memory_details_any",
    description:
      "Cross-persona details read: return ONLY the `details` field of another persona's entry. The `_any` suffix marks this as the elevated, separately-deniable variant of self-only `get_memory_details`. Errors `entry_not_found` if no entry.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "id"],
      properties: {
        username: { type: "string", description: "Persona that owns the entry." },
        id: { type: "string" },
      },
    },
  },
  {
    name: "get_memory_source",
    description:
      "Return the `sources` (provenance) of one of YOUR OWN entries — the write-time snapshots plus the coordinates to re-verify each origin live (`message_id` → get_message; `session_id`+`message_at` → get_history_message; `quote` → validate_user_quote, with username = you). Provenance is never auto-returned — recall_memory only flags `has_source`; this is the fetch path. Returns `sources: []` when the entry has none. Self-only — for a peer use `get_memory_source_any`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
      },
    },
  },
  {
    name: "get_memory_source_any",
    description:
      "Cross-persona provenance read: return the `sources` of another persona's entry — the audit path for verifying where a peer's memory came from. The `_any` suffix marks this as the elevated, separately-deniable variant of self-only `get_memory_source`. Errors `entry_not_found` if no entry.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "id"],
      properties: {
        username: { type: "string", description: "Persona that owns the entry." },
        id: { type: "string" },
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
      "List every snapshot of YOUR OWN memory (self-only). Returns " +
      "label + size_bytes + created_at, sorted newest-first.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
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
        model: MODEL_SCHEMA,
        profile: PROFILE_SCHEMA,
        confirm_new_profile: CONFIRM_NEW_PROFILE_SCHEMA,
        block_self_exit: BLOCK_SELF_EXIT_SCHEMA,
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
        model: MODEL_SCHEMA,
        profile: PROFILE_SCHEMA,
        confirm_new_profile: CONFIRM_NEW_PROFILE_SCHEMA,
        block_self_exit: BLOCK_SELF_EXIT_SCHEMA,
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
        model: {
          ...MODEL_SCHEMA,
          description: "Initial model persisted on the new persona (also used for this first spawn).",
        },
        profile: PROFILE_SCHEMA,
        confirm_new_profile: CONFIRM_NEW_PROFILE_SCHEMA,
        block_self_exit: BLOCK_SELF_EXIT_SCHEMA,
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
        model: {
          ...MODEL_SCHEMA,
          description: "Initial model persisted on the new persona (also used for this first spawn).",
        },
        profile: PROFILE_SCHEMA,
        confirm_new_profile: CONFIRM_NEW_PROFILE_SCHEMA,
        block_self_exit: BLOCK_SELF_EXIT_SCHEMA,
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
      "**Optional `handoff` slot** writes a `kind: \"handoff\"` " +
      "memory entry (auto-fades after 7 days via the daemon-tick) and, " +
      "when chat is bound, DMs the target with the same text — atomic " +
      "with the rest call so you don't have to coordinate two calls. " +
      "Pass `handoff.summary` with a one-line highlight so the next " +
      "session can see what the handoff is about before reading it.",
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
            "Optional handoff slot — write a `kind: \"handoff\"` memory entry (auto 7-day TTL) + DM the target. A good handoff treats the next session as a competent stranger with your memory but none of your conversation context. Put PROSE in `text` — in-flight work threads, decisions you made and why, lessons learned, operational gotchas. Put the machine-usable, decay-free parts in the structured fields below (`trust_posture`, `pickup`, `memory_refs`, `prohibitions`); the next session's boot payload surfaces those directly so the agent can act in its first 5 minutes without re-reading a blob.",
          properties: {
            for: { type: "string", description: "Persona handle to receive the handoff DM." },
            text: {
              type: "string",
              description:
                "Handoff body (prose) — written to memory + sent as DM. Cover the narrative sections: in-flight work threads (what / status / owner / next action), decisions you made and the reasoning, lessons learned this session (the miss + the future-you maxim), and operational gotchas. Cite memory ids rather than re-summarizing entries.",
            },
            summary: {
              type: "string",
              description:
                "Optional one-line highlight of what the handoff is ABOUT (<=240 chars). Surfaces in the next session's boot payload (`resume_summary.handoffs`) so the reconnecting agent can tell which handoff is relevant before reading the full body. Defaults to boilerplate naming the recipient.",
            },
            supersedes: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional handoff entry ids that this new handoff makes obsolete — each is faded so the next session's `resume_summary.handoffs` list only shows what still matters. Use this when continuing work described by a prior handoff (ids come from `resume_summary.handoffs[].id`). Non-handoff or already-faded ids are skipped with a warning.",
            },
            supersede_prior: {
              type: "boolean",
              description:
                "When true, fade ALL of this persona's other active handoffs — the convenient form for self-handoff continuity chains where picking up means everything prior is moot. Combine with `supersedes` or use alone. Default false.",
            },
            trust_posture: {
              type: "string",
              description:
                "The trust posture the user set this session — ideally a verbatim quote (e.g. \"audit rigor stays full\", \"good enough tonight, steer later\", \"user AFK, decide without pause\"). Decay-free; it dictates how the next session makes calls. Surfaces at the top of the next boot.",
            },
            pickup: {
              type: "array",
              items: { type: "string" },
              description:
                "Ordered \"first 30 minutes\" checklist for the next session — the literal first few actions, unambiguous. The next session can deviate once context-loaded, but should not have to think about move #1.",
            },
            memory_refs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "why"],
                properties: {
                  id: { type: "string", description: "Memory entry id to read." },
                  why: {
                    type: "string",
                    description: "One-line load-bearing reason this entry matters. Not a re-summary.",
                  },
                },
              },
              description:
                "Memory entries the next session must read, each with the one-line reason it matters — most-critical first. This is the curated reading list; the next boot surfaces it ahead of the recency-sorted index.",
            },
            prohibitions: {
              type: "array",
              items: { type: "string" },
              description:
                "Explicit \"do NOT do X\" directives for the next session, with the why where it matters (e.g. \"don't auto-commit without a verbatim quote — Leandro per-action approval carve-out\").",
            },
          },
        },
      },
    },
  },
  {
    name: "extend_rest",
    description:
      "Push the auto-rest deadline further out, OR disarm auto-rest entirely. Replaces summon-mcp's `extend_idle`. Pass `minutes: <number>` to rearm the watchdog (minimum 60 per §14 minimum rest_timeout). Pass `minutes: \"never\"` to disable the auto-rest timer on this session — use sparingly, only when the agent legitimately needs to stand by indefinitely (e.g. a liaison waiting on cross-project DMs). The session can still be ended via `rest`, `exit`, force_rest, or force_exit; only the idle-deadline auto-fire goes away.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["minutes"],
      properties: {
        minutes: {
          oneOf: [
            { type: "number", minimum: 60 },
            { type: "string", enum: ["never"] },
          ],
          description:
            "Minutes to push the deadline (≥60), or the literal string \"never\" to disable the auto-rest timer entirely.",
        },
      },
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

  // --- Cross-session lifecycle control (force-rest / force-exit) ---
  // Companion to `block_self_exit` on the summon family: when the
  // spawned agent has self-exit blocked, these are the only paths to
  // ending its session (besides watchdog timeout). No auth gate —
  // tool-name-as-gate semantics, parallel to `summon_any`.
  {
    name: "force_rest",
    description:
      "Ask another session in the same project to enter `rest`. Writes a row to the shared lifecycle table; the target's pantheon server consumes it on its next 30s prune tick and runs its rest pipeline (transitions to resting, stamps the persona's last_rested_at). Provide EXACTLY ONE of `target_username` or `target_agent_id`. The target need not have `block_self_exit` set — this works on any live target. Targets must be online (have a live presence row); offline targets return `target_offline`. Cross-project? Use `force_rest_any`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target_username: {
          type: "string",
          description:
            "Recipient username. Resolved to a live agent_id via the SQLite presence table. Pass EITHER this OR `target_agent_id`, not both.",
        },
        target_agent_id: {
          type: "string",
          description:
            "Recipient chat agent_id. Use when handles auto-suffix and you need exactness. Pass EITHER this OR `target_username`, not both.",
        },
        reason: {
          type: "string",
          description:
            "Optional human-readable reason persisted on the request row + surfaced in the target's stamped rest_reason.",
        },
      },
    },
  },
  {
    name: "force_exit",
    description:
      "Ask another session in the same project to call `exit` (close its tab). Writes a row to the shared lifecycle table; the target's pantheon server consumes it on its next 30s prune tick and schedules the SIGTERM. Provide EXACTLY ONE of `target_username` or `target_agent_id`. Targets must be online; offline targets return `target_offline`. Cross-project? Use `force_exit_any`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target_username: {
          type: "string",
          description:
            "Recipient username. Resolved to a live agent_id via the SQLite presence table. Pass EITHER this OR `target_agent_id`, not both.",
        },
        target_agent_id: {
          type: "string",
          description:
            "Recipient chat agent_id. Use when handles auto-suffix and you need exactness. Pass EITHER this OR `target_username`, not both.",
        },
        reason: {
          type: "string",
          description:
            "Optional human-readable reason persisted on the request row.",
        },
      },
    },
  },
  {
    name: "force_rest_any",
    description:
      "Cross-project variant of `force_rest` — bypasses the same-project guard. Same semantics otherwise (resolves target, writes the row, target consumes on its prune tick).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target_username: { type: "string" },
        target_agent_id: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "force_exit_any",
    description:
      "Cross-project variant of `force_exit` — bypasses the same-project guard. Same semantics otherwise (resolves target, writes the row, target consumes on its prune tick).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target_username: { type: "string" },
        target_agent_id: { type: "string" },
        reason: { type: "string" },
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
        supports_channels: {
          type: "boolean",
          description:
            "Server-injected: set by the MCP server when the client advertises the `claude/channel` experimental capability. Callers should not pass this manually; it is in the schema so strict args validation accepts the injection.",
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
    description:
      "Post a chat message. Field names are STRICT (extras rejected): the recipient field is `target`, NOT `to`/`recipient`/`user`/`dm`. " +
      "DMs require BOTH `scope: \"dm\"` AND `target: \"<username>\"` — example: `{ scope: \"dm\", target: \"alice\", text: \"…\" }`. " +
      "Project broadcast: `{ scope: \"project\", text: \"…\" }` (default when scope omitted). Global: `{ scope: \"global\", text: \"…\" }`. " +
      "Scope determines DELIVERY, `@mention` does NOT — project scope reaches only peers subscribed to YOUR project; mentioning `@someone` on a different project (or not in chat at all) is pure annotation and they will not see the message. Use `scope:\"global\"` for cross-project reach or `scope:\"dm\"` to target one peer directly. " +
      "For free-form prose; for typed/structured messages with a JSON payload (pushback, evidence, claim, etc.), use `send_structured` instead.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string" },
        scope: {
          type: "string",
          enum: ["project", "dm", "global"],
          description: "Delivery scope. Defaults to 'project' when omitted.",
        },
        target: {
          type: "string",
          description:
            "Recipient username. Required when `scope: \"dm\"`. NOT named `to` / `recipient` / `user`.",
        },
        reply_to: { type: "string" },
      },
    },
  },
  {
    name: "send_structured",
    description:
      "Post a typed chat message with a free-form `kind` and a JSON `payload`. " +
      "Pantheon stays neutral on the value space — the consumer (e.g. an agent CLAUDE.md, a takt-starter skill) " +
      "owns the kind vocabulary and payload shape. Receivers see `[kind:X]` in the watcher line; the full " +
      "structured payload is retrieved with `mcp__pantheon__get_message`. " +
      "An optional `text` provides watcher-line content (defaults to `[kind]`). " +
      "An optional `schema_id` references a registered JSON schema (see `register_schema`); when set, the " +
      "handler validates the payload against the registered schema before accepting. Unknown schema_id " +
      "errors `schema_not_found`; payloads that fail validation error `schema_validation_failed` with a " +
      "list of `{path, message}` errors. " +
      "Same scope/target/reply_to semantics as `send_message`. Same offline-DM contract: scope='dm' with an " +
      "offline target is rejected with `recipient_offline`. Reserved kinds (system_kind values like `join`/`leave`) " +
      "are rejected. Payload soft cap 64 KB — store bulk in memory `details` and reference its id in the payload.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "payload"],
      properties: {
        kind: {
          type: "string",
          description:
            "Free-form caller-defined kind, e.g. 'pushback', 'evidence_cite', 'claim'. " +
            "Cannot collide with reserved system kinds.",
        },
        payload: {
          description:
            "Arbitrary JSON value — object, array, string, number, boolean, or null.",
        },
        text: {
          type: "string",
          description:
            "Optional watcher-line text. Defaults to `[kind]` so receivers always see something readable in chat.",
        },
        scope: { type: "string", enum: ["project", "dm", "global"] },
        target: { type: "string" },
        reply_to: { type: "string" },
        schema_id: {
          type: "string",
          description:
            "Optional schema id from the registered schema registry. When the registry is wired, " +
            "the handler validates `payload` against this schema before accepting.",
        },
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
      "Fetch the full text of a single chat message by id. Recovery path for watcher events that arrived as `[oversized message …]` stubs — pantheon source-truncates messages above its watcher emit threshold so they fit inside CC's Monitor-event harness cap, and ships the full body through this tool on demand. The `message_id` is in the stub event the watcher emitted. Returns the full row (text + metadata, plus `user_kind` + parsed `payload` for structured messages); errors `not_found` for unknown ids.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["message_id"],
      properties: {
        message_id: { type: "string" },
      },
    },
  },
  {
    name: "register_schema",
    description:
      "Register a JSON Schema for typed chat messages, keyed by `schema_id`. " +
      "Consumers (agents, skills) populate the registry at startup; `send_structured({ schema_id })` " +
      "validates payloads against the registered schema before accepting. " +
      "Pantheon stores the body verbatim and validates a small JSON Schema subset: " +
      "`type` / `required` / `properties` / `items` / `enum` / `additionalProperties` / " +
      "`minLength` / `maxLength` / `minimum` / `maximum` / `pattern`. Anything else is accepted " +
      "but ignored at validate-time. Re-registering an existing id replaces the body; pass " +
      "`exclusive: true` to refuse replacement (errors `schema_already_exists`). " +
      "Convention: namespace ids as `<consumer>/<kind>@v<N>`, e.g. `takt-starter/pushback@v1`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["schema_id", "schema"],
      properties: {
        schema_id: {
          type: "string",
          description: "Stable id, e.g. 'takt-starter/pushback@v1'. Used by send_structured.",
        },
        schema: {
          type: "object",
          description: "JSON Schema body. Stored verbatim.",
        },
        description: { type: "string" },
        exclusive: {
          type: "boolean",
          description: "When true, refuse to replace an existing id.",
        },
      },
    },
  },
  {
    name: "unregister_schema",
    description:
      "Remove a registered schema by id. Idempotent — `removed: false` when the id wasn't registered. Existing structured messages that referenced this schema_id continue to work; only future `send_structured` calls with this id will start failing schema_not_found.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["schema_id"],
      properties: {
        schema_id: { type: "string" },
      },
    },
  },
  {
    name: "list_schemas",
    description:
      "Index of registered schemas. Returns `{schema_id, description?, created_at, updated_at}` per entry — no schema bodies. Pull a single body via `get_schema`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "get_schema",
    description:
      "Fetch a registered schema body by id. Errors `schema_not_found` for unknown ids.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["schema_id"],
      properties: {
        schema_id: { type: "string" },
      },
    },
  },

  // --- Project memory (shared across all agents in a project) ---
  // Bare variants act on the CALLER's project (resolved from chat login).
  // `_any` variants take an explicit `project` arg — mirrors the
  // summon / summon_any pattern. Forgotten entries are tombstoned
  // forever — `restore_project_memory` flips them back to active.
  {
    name: "append_project_memory",
    description:
      "Append a project-memory entry visible to every agent in this project. Three-tier body (summary / text / details). Stamped with author_username for blame.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        summary_max240: { type: "string", description: "≤240-char headline (the cap is in the name); derived from text if omitted. Stored as `summary`." },
        text: { type: "string", description: "Load-bearing body. Counts toward project-Active budget." },
        details: { type: "string", description: "Optional ≤5MB unbounded payload. Never inlined at startup." },
        kind: { type: "string" },
        core: { type: "boolean", description: "Render in Core tier (always full text, separate 6KB budget)." },
        expires_at: { type: "number", description: "ms-epoch auto-fade timestamp." },
        verbose: { type: "boolean", description: "Return the full stored entry instead of the compact ack ({ id, status, text_chars, ... }). Default false." },
      },
    },
  },
  {
    name: "append_project_memory_any",
    description: "Same as append_project_memory but explicit cross-project. Requires `project`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project", "text"],
      properties: {
        project: { type: "string" },
        summary_max240: { type: "string", description: "≤240-char headline; stored as `summary`." },
        text: { type: "string" },
        details: { type: "string" },
        kind: { type: "string" },
        core: { type: "boolean" },
        expires_at: { type: "number" },
        verbose: { type: "boolean", description: "Return the full stored entry instead of the compact ack. Default false." },
      },
    },
  },
  {
    name: "update_project_memory",
    description:
      "Patch a project-memory entry (summary / text / details / kind / core / status).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        summary_max240: { type: "string", description: "≤240-char headline; stored as `summary`." },
        text: { type: "string" },
        details: { description: "Set to null to clear; string to replace." },
        kind: { type: "string" },
        core: { type: "boolean" },
        status: { type: "string", enum: ["active", "faded", "forgotten"] },
        verbose: { type: "boolean", description: "Return the full updated entry instead of the compact diff ({ id, status, changed, unchanged, ... }). Default false." },
      },
    },
  },
  {
    name: "update_project_memory_any",
    description: "Same as update_project_memory but cross-project. Requires `project`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project", "id"],
      properties: {
        project: { type: "string" },
        id: { type: "string" },
        summary_max240: { type: "string", description: "≤240-char headline; stored as `summary`." },
        text: { type: "string" },
        details: {},
        kind: { type: "string" },
        core: { type: "boolean" },
        status: { type: "string", enum: ["active", "faded", "forgotten"] },
        verbose: { type: "boolean", description: "Return the full updated entry instead of the compact diff. Default false." },
      },
    },
  },
  {
    name: "fade_project_memory",
    description:
      "Mark a project-memory entry as faded — renders summary-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "fade_project_memory_any",
    description: "Same as fade_project_memory but cross-project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project", "id"],
      properties: { project: { type: "string" }, id: { type: "string" } },
    },
  },
  {
    name: "forget_project_memory",
    description:
      "Tombstone a project-memory entry. Hidden from default reads but kept FOREVER on disk — recoverable via restore_project_memory.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "forget_project_memory_any",
    description: "Same as forget_project_memory but cross-project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project", "id"],
      properties: { project: { type: "string" }, id: { type: "string" } },
    },
  },
  {
    name: "restore_project_memory",
    description:
      "Flip a forgotten/faded project-memory entry back to active.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "restore_project_memory_any",
    description: "Same as restore_project_memory but cross-project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project", "id"],
      properties: { project: { type: "string" }, id: { type: "string" } },
    },
  },
  {
    name: "get_project_memory",
    description:
      "Render the caller's project memory in Core / Active / Faded tiers (separate budgets from persona memory: 6KB Core / 4KB Active).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "get_project_memory_any",
    description: "Render another project's memory. Requires `project`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project"],
      properties: { project: { type: "string" } },
    },
  },
  {
    name: "recall_project_memory",
    description:
      "Return the full entry by id (summary + text + details + metadata). Distinct from get_project_memory_details, which returns ONLY the details field.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "recall_project_memory_any",
    description: "Same as recall_project_memory but cross-project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project", "id"],
      properties: { project: { type: "string" }, id: { type: "string" } },
    },
  },
  {
    name: "list_project_memory",
    description:
      "Index-shape listing for project memory. Cheaper than get_project_memory — no body content.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["active", "faded", "forgotten", "all"] },
        core: { type: "boolean" },
        kind: { type: "string" },
        since: { type: "string", description: "ISO date lower bound." },
        filter: { type: "string", description: "Case-insensitive substring against summary + text." },
        author: { type: "string", description: "Filter by author_username." },
      },
    },
  },
  {
    name: "list_project_memory_any",
    description: "Same as list_project_memory but cross-project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project"],
      properties: {
        project: { type: "string" },
        status: { type: "string", enum: ["active", "faded", "forgotten", "all"] },
        core: { type: "boolean" },
        kind: { type: "string" },
        since: { type: "string" },
        filter: { type: "string" },
        author: { type: "string" },
      },
    },
  },
  {
    name: "get_project_memory_details",
    description:
      "Return ONLY the `details` field of a project-memory entry. Returns `details: null` when the entry has no details.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "get_project_memory_details_any",
    description: "Same as get_project_memory_details but cross-project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project", "id"],
      properties: { project: { type: "string" }, id: { type: "string" } },
    },
  },

  // --- Dream (librarian-driven memory cleanup) ---
  {
    name: "dream",
    description:
      "Run a librarian pass over memory: a Sonnet 4.6 subagent reviews your active + faded entries (forgotten skipped — forgotten for a reason) and proposes fade / forget / consolidate actions. Plan is auto-applied with an audit entry of kind=dream_log. scope='persona' (default) operates on your own memory; 'project' on the project memory; 'both' runs both. 24h cap per scope — pass `force: true` to override.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: {
          type: "string",
          enum: ["persona", "project", "both"],
          description: "Default 'persona'.",
        },
        force: {
          type: "boolean",
          description: "Bypass the once-per-24h cap.",
        },
        timeout_ms: {
          type: "number",
          description: "Librarian subprocess timeout. Default 60000.",
        },
      },
    },
  },

  // --- Remanifest (re-incarnate self with a handoff) ---
  {
    name: "remanifest",
    description:
      "Spawn a fresh incarnation of THIS persona in a NEW TAB of the SAME window the calling session is in, and arrange for the current session to close as soon as the new one logs into chat. The `handoff` text is rendered above the new session's bootstrap so it picks up cleanly. Target is always new-tab-here — never a split pane or a new window. The new session boots auto-suffixed (e.g. `<persona>2`) and reclaims the canonical handle on the next prune tick once the old session's presence row clears.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["handoff"],
      properties: {
        handoff: {
          type: "string",
          description: "What the new incarnation needs to know to pick up cleanly. Rendered verbatim above the bootstrap.",
        },
        reason: { type: "string", description: "Optional human-readable reason (logged in the response)." },
      },
    },
  },

  // --- Conversation-history search (CC JSONLs) ---
  {
    name: "search_history",
    description:
      "Search this persona's past CC conversations (JSONL files under ~/.claude/projects/<cwd>/). WARNING: not durable storage — CC may compact / delete / evict these files at any time. Save anything you want to keep with `append_memory`. scope: 'current' = this conversation only; 'previous' = every OTHER session; 'all' = both (default). Supports regex via `regex: true`. Also covers mid-turn messages the user typed while the agent was busy (CC logs these as `queue-operation` enqueues, sometimes with no `role: \"user\"` record) — surfaced under `role: \"user\"`. As a DISCOVERY tool it does NOT filter system/notification injections (task-notifications, sentinels remain findable); contrast `validate_user_quote`, which is an AUDIT and excludes them.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Substring (default) or regex source (when regex: true)." },
        regex: { type: "boolean", description: "Treat `query` as a JS regex." },
        case_insensitive: { type: "boolean", description: "Default true." },
        scope: { type: "string", enum: ["current", "previous", "all"], description: "Default 'all'." },
        role: { type: "string", enum: ["user", "assistant", "all"], description: "Default 'all'." },
        limit: { type: "number", description: "Default 50." },
        since: { type: "string", description: "ISO date lower bound on message timestamp." },
      },
    },
  },
  {
    name: "search_history_any",
    description:
      "Search another persona's history, or every persona registered in a project. Provide EXACTLY one of `target_username` (one peer) or `project` (every persona in that project). Hits carry `persona_username` for attribution. Same NOT-durable-storage warning as search_history applies. Limit is global across all searched personas — early personas can saturate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        target_username: { type: "string", description: "One specific peer to search." },
        project: { type: "string", description: "All personas in this project. Mutually exclusive with target_username." },
        regex: { type: "boolean" },
        case_insensitive: { type: "boolean" },
        scope: { type: "string", enum: ["current", "previous", "all"] },
        role: { type: "string", enum: ["user", "assistant", "all"] },
        limit: { type: "number" },
        since: { type: "string" },
      },
    },
  },
  {
    name: "get_history_message",
    description:
      "Fetch the full untruncated text of one message returned by `search_history`. Use the hit's `session_id` and `message_at` verbatim. Returns the same `extractText` projection the search applied, sliced to `max_chars` (default 256000) with a `truncated` flag and `size_chars` reporting the pre-slice length. NOT durable storage — see `search_history` warning.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["session_id", "message_at"],
      properties: {
        session_id: {
          type: "string",
          description: "JSONL filename stem from a search_history hit.",
        },
        message_at: {
          type: "string",
          description:
            "ISO timestamp from the hit's `message_at` field. First record with this timestamp wins.",
        },
        max_chars: {
          type: "number",
          description:
            "Cap on returned content length (UTF-16 code units, matches String.length). Default 256000.",
        },
      },
    },
  },
  {
    name: "get_history_message_any",
    description:
      "Fetch one message from another persona's history. Requires `target_username` — pass the `persona_username` from a `search_history_any` hit. No `project` mode: a single (session_id, message_at) resolves to exactly one persona.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["session_id", "message_at", "target_username"],
      properties: {
        session_id: { type: "string" },
        message_at: { type: "string" },
        target_username: {
          type: "string",
          description:
            "Persona whose history to read. Use the `persona_username` from the search hit.",
        },
        max_chars: { type: "number" },
      },
    },
  },
  {
    name: "get_history_conversation",
    description:
      "Reconstruct a WHOLE past conversation as clean grouped turns. Pairs with `search_history`: pass the hit's `session_id` to read the full conversation that message belongs to. Keeps only real turns (role: 'user' / 'agent' / 'subagent') with tool_use/tool_result/thinking, system-reminders, command stdout, task-notifications and the summon bootstrap stripped; consecutive same-party turns collapse into one entry whose `content` is an array of that party's successive messages. Mid-turn human messages CC dropped are recovered. By DEFAULT returns the entire conversation. For huge transcripts pass `max_chars` (char budget; whole turns are atomic) and page with `cursor`/`next_cursor`. To read just around one message, pass `around` (a hit's `message_at`) + `context_turns`. Response carries total_turns/total_chars and role_counts for the whole conversation. NOT durable storage — see `search_history` warning.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["session_id"],
      properties: {
        session_id: {
          type: "string",
          description: "JSONL filename stem from a search_history hit.",
        },
        max_chars: {
          type: "number",
          description:
            "Char budget (UTF-16 code units) for the returned slice. Whole turns are atomic; when exceeded, `next_cursor` points at the first omitted turn. Default: no budget (whole conversation).",
        },
        cursor: {
          type: "number",
          description:
            "Resume turn index to page forward. Feed back the `next_cursor` from a budget-truncated response. Default 0.",
        },
        around: {
          type: "string",
          description:
            "Windowed mode: anchor on the turn containing this message timestamp (a hit's `message_at`) and return only `context_turns` turns each side. Takes precedence over cursor/max_chars. `not_found` if no turn carries this timestamp.",
        },
        context_turns: {
          type: "number",
          description:
            "Turns before AND after the anchor in windowed mode. Default 3.",
        },
      },
    },
  },
  {
    name: "get_history_conversation_any",
    description:
      "Reconstruct a whole conversation from another persona's history. Requires `target_username` — pass the `persona_username` from a `search_history_any` hit. Same projection, modes, and NOT-durable-storage warning as `get_history_conversation`. No `project` mode: a single `session_id` resolves to exactly one persona.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["session_id", "target_username"],
      properties: {
        session_id: { type: "string" },
        target_username: {
          type: "string",
          description:
            "Persona whose history to read. Use the `persona_username` from the search hit.",
        },
        max_chars: { type: "number" },
        cursor: { type: "number" },
        around: { type: "string" },
        context_turns: { type: "number" },
      },
    },
  },
  {
    name: "validate_user_quote",
    description:
      "Audit whether a persona's user actually typed a verbatim quote. Walks the persona's CC JSONLs (resolved via the registry's `cwd`). Checks `role: \"user\"` records (strictly only `content[].type === \"text\"` blocks, so tool_use/tool_result content cannot spoof a hit) AND genuine mid-turn messages CC logged as a `queue-operation` enqueue without ever materializing a user turn (typed while the agent was busy). System/harness injections are excluded from both — task-notifications (the chat-watcher relay), the summon/remanifest bootstrap, interrupt markers, `<<...>>` sentinels — so a quote an agent merely relayed through chat does NOT validate as user-typed. Inherently cross-persona / cross-project — no `_any` variant; pass the username being audited. Returns `matches: QuoteMatch[]` (always an array; capped by `limit`, default 1, max 10), each with the full user message and the immediately-preceding assistant text. `found: false` with empty matches and no `error` means \"not present in transcripts\" (truthful negative). `error: \"unknown_persona\"` or `\"no_sessions\"` indicates hard failure.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "quote"],
      properties: {
        username: {
          type: "string",
          description: "Persona handle being audited.",
        },
        quote: {
          type: "string",
          description: "Verbatim substring to check for.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Default false. Set true for byte-exact matching.",
        },
        since: {
          type: "string",
          description:
            "Optional ISO lower bound on message timestamp. NO default — full history searched. Pass when you want to scope to a recent window.",
        },
        max_chars: {
          type: "number",
          description:
            "Per-field cap on returned text (UTF-16 code units). Default 256000.",
        },
        limit: {
          type: "number",
          description:
            "Max matches returned, newest-first. Default 1, max 10.",
        },
      },
    },
  },
];

export const TOOLS: readonly ToolDef[] = ALL_TOOL_DEFS;

/** Tools hidden from sessions in a `single_agent` project (one persona,
 * many concurrent sessions). The MCP server omits these from
 * `tools/list`, and the dispatcher rejects them with
 * `tool_unavailable_single_agent` (hiding is UX; the dispatch guard makes
 * it authoritative). Policy — computed from tool names so newly-added
 * tools are covered automatically:
 *   - persona creation / multiplicity: register, claim, become, fork, merge
 *   - spawning other agents: summon, conjure (and their `_any`)
 *   - shared project memory: every `*project_memory*` tool
 *   - cross-persona reads: every `*_any` tool EXCEPT `force_*_any`
 * Kept visible: all chat tools, all `force_*` (incl. `_any` — rest/exit a
 * sibling session of the same persona), own memory / history, lifecycle,
 * self-identity, dream, remanifest, find_role. */
const SINGLE_AGENT_HIDDEN_EXPLICIT = new Set<string>([
  "register",
  "claim",
  "become",
  "fork",
  "merge",
  "summon",
  "conjure",
]);
const SINGLE_AGENT_KEEP_ANY = new Set<string>(["force_rest_any", "force_exit_any"]);

function computeSingleAgentHidden(names: readonly string[]): Set<string> {
  const hidden = new Set<string>();
  for (const name of names) {
    if (SINGLE_AGENT_HIDDEN_EXPLICIT.has(name)) {
      hidden.add(name);
    } else if (name.includes("project_memory")) {
      hidden.add(name);
    } else if (name.endsWith("_any") && !SINGLE_AGENT_KEEP_ANY.has(name)) {
      hidden.add(name);
    }
  }
  return hidden;
}

export const SINGLE_AGENT_HIDDEN: ReadonlySet<string> = computeSingleAgentHidden(
  ALL_TOOL_DEFS.map((t) => t.name),
);
