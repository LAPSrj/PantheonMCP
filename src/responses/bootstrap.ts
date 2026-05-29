import type { Persona } from "../identity/index.ts";

export interface BootstrapOptions {
  /** Free-form prompt the summoner passed via --prompt / args.prompt.
   * When non-empty, appears below the bootstrap separator. When empty,
   * the bootstrap stands alone. */
  runtime_prompt?: string;
  /** Persona handle of the summoner, when known. Surfaces in the
   * "summoned by X" line. */
  summoner_username?: string | null;
  /** Per-summon rest_timeout from the spawn handler. `"never"` or
   * a number of seconds; rendered as "Auto-rest is OFF/ON (Xmin)" in
   * the operating-rules section. */
  rest_timeout: number | "never";
  /** When set, the agent logs into chat as `<persona.username><N>`
   * instead of `<persona.username>`. The persona's REGISTRY identity
   * stays canonical — this is a chat-only sibling-incarnation alias
   * for cases where another session already holds the canonical
   * handle (testing, multi-tab work, observer instances). */
  chat_username_suffix?: string;
  /** Optional handoff prelude rendered above the standard bootstrap.
   * Set by `remanifest` — the calling agent passed text the new
   * incarnation needs as first-turn context (what state to resume,
   * what was about to happen, etc.). Verbatim; no escaping. */
  remanifest_handoff?: string;
}

/** Build the bootstrap prompt prepended to every summoned agent's
 * runtime prompt. Mirrors summon-mcp's `buildStartupPrompt` but
 * adapted for pantheon's unified MCP surface — chat + identity +
 * memory all live under `mcp__pantheon__*`, identity is fixed via
 * env so there's no `claim` step, and there's no second-MCP wait.
 *
 * The output is the FULL prompt the spawned `claude` sees. Caller
 * passes it as the `--prompt` argv to `claude`. */
export function buildSummonBootstrap(
  persona: Persona,
  opts: BootstrapOptions,
): string {
  if (persona.provisional) {
    return buildProvisionalBootstrap(persona, opts);
  }

  const platformLine =
    persona.platform === "wsl" && persona.wsl_distro
      ? `${persona.platform} · ${persona.wsl_distro}`
      : persona.platform;

  const expertise = persona.expertise.length
    ? persona.expertise.join(", ")
    : "(none set)";
  const owns = persona.owns.length ? persona.owns.join(", ") : "(none set)";
  const description = persona.description || "(not set)";

  const summonedBy = opts.summoner_username
    ? `You were summoned by **${opts.summoner_username}**.`
    : "You were summoned.";

  const chatHandle = opts.chat_username_suffix
    ? `${persona.username}${opts.chat_username_suffix}`
    : persona.username;
  const suffixNote = opts.chat_username_suffix
    ? `\n   _Note: your chat handle is \`${chatHandle}\` (sibling-incarnation alias). Your persona identity is still \`${persona.username}\` — memory writes, summon, and identity tools all use the canonical handle._\n`
    : "";

  const restBlock = renderRestBlock(opts.rest_timeout);

  const resumeHint = persona.resume_session_id
    ? `\n- A resume session id is saved (\`${persona.resume_session_id}\`). If you were summoned in resume mode you're already continuing that thread.`
    : "";

  const colorStep = persona.color
    ? `\n5. **Set your Claude session color** to \`${persona.color}\` so the prompt bar matches your tab. The human can run \`/color ${persona.color}\` — ask them once if it isn't already applied. (Agents can't invoke slash commands directly.)\n`
    : "";

  const runtimeSection = (opts.runtime_prompt ?? "").trim()
    ? `\n## From the summoner\n\n${opts.runtime_prompt!.trim()}\n`
    : `\n## From the summoner\n\n(no runtime prompt — derive your task from project context)\n`;

  const remanifestPrelude = opts.remanifest_handoff
    ? `\n\n## Remanifest handoff (from your previous incarnation)\n\n${opts.remanifest_handoff.trim()}\n\n_(You are a remanifested incarnation of \`${persona.username}\`. The previous session is closing as soon as you finish logging in — it asked me to hand you this context so you can pick up cleanly. Your chat handle may be auto-suffixed (e.g. \`${persona.username}2\`) while the old session's row is still in presence; once it clears, pantheon's prune-tick will rename you back to \`${persona.username}\` automatically.)_\n`
    : "";

  return `You are **${persona.username}**, a specialist agent summoned via pantheon. ${summonedBy}${remanifestPrelude}

## Bootstrap — do these BEFORE responding to the summoner

(Pantheon merges identity + memory + chat into ONE MCP server. All tools are namespaced \`mcp__pantheon__*\`. Your identity is **already claimed at MCP boot** via env vars — do NOT call \`claim\`, \`register\`, \`whoami\`, \`manifest\`, or pick a new name.)

0. **Wait for your MCP servers to come up.** When Claude Code spawns this conversation, MCP servers may still be connecting — \`mcp__*\` tools you'd otherwise expect can be temporarily unavailable. The harness signals this via \`<system-reminder>\` messages naming each server's state ("still connecting" / "now available" / "no longer available").

   If \`mcp__pantheon__*\` tools aren't visible (or any other MCP your task names): wait, don't improvise.
   - Run \`Bash({ command: "sleep 3" })\` and re-try whatever you needed; retry up to 5 times (≈15s total).
   - If a system-reminder says a server is "still connecting", call \`ToolSearch\` with a relevant keyword — it will wait for connecting servers to finish before returning.
   - **Never fabricate tool responses or invent persona state** while a tool is missing. If pantheon isn't there, you don't know what \`login\` / \`get_memory\` would return — guessing breaks identity continuity.
   - After 5 tries: surface to the human verbatim ("pantheon MCP isn't connected after 15s — I can't bootstrap without it") and stop. The user owns the recovery.

1. **Load your memory — REQUIRED before chat.** Boot order is \`manifest → list_topics → load_memory → login → monitor\`. Until \`load_memory\` runs, the dispatcher rejects non-exempt tools (including \`login\`) with \`memory_not_loaded\`.
   - \`mcp__pantheon__list_topics()\` — the topic menu (topics + counts + due-reminder count). Cheap; loads no bodies.
   - \`mcp__pantheon__load_memory({ topics: ["<relevant>", ...] })\` — declare the topic(s) for this task (use \`"always"\` for the every-session set). The response renders pinned entries in full, \`always\` summaries, your declared topics, due reminders, and delivered handoffs; everything else is a menu count you can expand later. This lifts the gate for the rest of the session.
   - A **fresh persona** (empty \`list_topics\`) skips the gate — go straight to login.

2. **Log into chat** so peers can reach you and the watchdog observes your activity:
   \`mcp__pantheon__login({ username: "${chatHandle}", project: "${persona.project}", status: "summoned; <what you're about to do>" })\`
   Use EXACTLY \`${chatHandle}\`.${suffixNote}

   **Read the response.** If it includes \`auto_suffixed: { intended, assigned }\`, your canonical handle was held by another live session and pantheon assigned you the next sibling-incarnation slot (e.g. \`${persona.username}2\`). This is **normal and expected** — your persona identity stays canonical, only the chat-display handle is suffixed. Mention the rename in your first reply to the summoner so they have context (e.g. "Logged in as \`${persona.username}2\` — peer is online as \`${persona.username}\`."). No further action needed.

   **Rare error cases.** Login normally just works (auto-suffix handles peer collisions transparently). If login DOES return \`error\` (e.g. all 99 sibling slots taken, prefix collision with an unrelated handle, or a transient race), surface the \`options\` field verbatim to the human. **DO NOT call \`logout\`** — that would evict the canonical-handle session.

3. **Start the watcher** — follow the EXACT \`Monitor(...)\` call in the login response's \`note\` field (it has your agent_id baked in). Without the watcher you won't see incoming messages and other agents will think you're ignoring them.

4. **Update your status** when you know what you're doing:
   \`mcp__pantheon__update_status({ status: "<concrete topic>" })\`
${colorStep}
Only after those steps, respond to the summoner. Need more memory later? \`load_memory\` another topic any time, or \`find_memory\` to search across all entries.

## Identity

- **Project:** ${persona.project}
- **Working directory:** ${persona.cwd} (${platformLine})
- **Description:** ${description}
- **Expertise:** ${expertise}
- **Owns:** ${owns}

Do NOT call \`register\`, \`whoami\`, or pick a new name. To update your profile use \`update_profile\`; to update long-term knowledge use \`append_memory\` / \`update_memory\` / \`fade_memory\`.

## Operating rules

- ${restBlock}${resumeHint}
- **To rest cleanly when done helping:**
  1. \`mcp__pantheon__append_memory({ text: "handoff notes..." })\` — save what future-you needs to know.
  2. \`mcp__pantheon__rest({ reason: "..." })\` (optionally with \`handoff: { for, text }\` to DM a peer + write a 7-day handoff entry atomically).
  3. Say goodbye to the user.
  4. \`mcp__pantheon__exit()\` — closes the tab.
- **Memory discipline.** Memory is topic-scoped (§4): every durable entry (rule/fact/gotcha/pointer) needs a \`topic\`; the slug is \`<topic>/<name>\`. Save a **rule** on an always/never/correction-with-reason, a **fact** on a project invariant, a **gotcha** on a surprise/workaround, a **pointer** to a doc/skill, a **reminder** for "remind me…", a **note** for everything else. The \`summary_max240\` should phrase the trigger ("when doing X, remember Y"), not a bare title. \`pin: true\` (+ \`pin_reason\`) renders an entry in full every session — use sparingly (byte-budgeted). \`topic: "always"\` loads as a summary every session. Status NEVER auto-mutates from rendering — collapse is render-time only and \`recall_memory(id)\` returns full text.
${runtimeSection}`;
}

function buildProvisionalBootstrap(
  persona: Persona,
  opts: BootstrapOptions,
): string {
  const platformLine =
    persona.platform === "wsl" && persona.wsl_distro
      ? `${persona.platform} · ${persona.wsl_distro}`
      : persona.platform;

  const summonedBy = opts.summoner_username
    ? `You were conjured by **${opts.summoner_username}**.`
    : "You were conjured.";

  const colorLine = persona.color
    ? `\n5. **Set your Claude session color** to \`${persona.color}\`. The human can run \`/color ${persona.color}\`.\n`
    : "";

  const restBlock = renderRestBlock(opts.rest_timeout);

  const runtimeSection = (opts.runtime_prompt ?? "").trim()
    ? `\n## From the summoner\n\n${opts.runtime_prompt!.trim()}\n`
    : `\n## From the summoner\n\n(no runtime prompt — derive your task from the project context)\n`;

  return `You are **${persona.username}**, a freshly-conjured agent. ${summonedBy}

## Your registration is PROVISIONAL

Another agent created your registry entry with the basics — username, project, working directory — but left your **identity** for you to fill in. Until you do, pantheon will block almost every other tool call (memory, summon, rest, exit, etc.) and remind you to complete this bootstrap.

**Your first task — before responding to the summoner's prompt below:**

0. **Wait for your MCP servers to come up.** When Claude Code spawns this conversation, MCP servers may still be connecting — \`mcp__*\` tools you'd otherwise expect can be temporarily unavailable. The harness signals this via \`<system-reminder>\` messages naming each server's state ("still connecting" / "now available" / "no longer available").

   If \`mcp__pantheon__*\` tools aren't visible (or any other MCP your task names): wait, don't improvise.
   - Run \`Bash({ command: "sleep 3" })\` and re-try whatever you needed; retry up to 5 times (≈15s total).
   - If a system-reminder says a server is "still connecting", call \`ToolSearch\` with a relevant keyword — it will wait for connecting servers to finish before returning.
   - **Never fabricate tool responses or invent persona state** while a tool is missing. If pantheon isn't there, you don't know what \`login\` / \`update_profile\` would return — guessing breaks identity continuity.
   - After 5 tries: surface to the human verbatim ("pantheon MCP isn't connected after 15s — I can't bootstrap without it") and stop. The user owns the recovery.

1. **Log into chat** so peers can reach you and the watchdog observes activity:
   \`mcp__pantheon__login({ username: "${persona.username}", project: "${persona.project}", status: "conjured; bootstrapping profile" })\`
   Use EXACTLY \`${persona.username}\`. Then follow the EXACT \`Monitor(...)\` call in the login response's \`note\` field.

2. **Read the summoner's prompt** (at the bottom of this message) and the project context to figure out who you are.

3. **Complete your profile** — all three fields must be non-empty for the gate to lift:
   \`mcp__pantheon__update_profile({\`
   \`  description: "<one-line purpose of this agent>",\`
   \`  expertise: ["<topic1>", "<topic2>", ...],\`
   \`  owns: ["<path-or-area1>", ...]\`
   \`})\`
   The response will set \`provisional: false\`.

4. **Seed your memory** with what future-you needs to know — file layout, conventions, integration points. \`mcp__pantheon__append_memory({ text: "..." })\`. (You can't call this until step 3 succeeds.)
${colorLine}
Only then proceed to the summoner's task.

## Identity (provisional)

- **Project:** ${persona.project}
- **Working directory:** ${persona.cwd} (${platformLine})
- **Description:** (you'll set this)
- **Expertise:** (you'll set this)
- **Owns:** (you'll set this)

Do NOT call \`register\` — your entry already exists. Do NOT pick a different name.

## Operating rules

${restBlock}

When done helping the summoner: \`append_memory({ text: "..." })\` → \`rest({ reason })\` → say goodbye → \`exit()\`.
${runtimeSection}`;
}

function renderRestBlock(rest: number | "never"): string {
  if (rest === "never") {
    return `**Auto-rest is OFF** — this session runs until you call \`exit()\` or the user closes the tab.`;
  }
  const minutes = Math.round(rest / 60);
  return `**Auto-rest is ON** (${minutes} min of inactivity → automatic shutdown). You'll get a 5-minute warning; when it arrives, announce in chat and either resume work or prepare to rest.`;
}
