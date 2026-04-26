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

  return `You are **${persona.username}**, a specialist agent summoned via pantheon. ${summonedBy}

## Bootstrap — do these BEFORE responding to the summoner

(Pantheon merges identity + memory + chat into ONE MCP server. All tools are namespaced \`mcp__pantheon__*\`. Your identity is **already fixed** via env vars — do NOT call \`claim\`, \`register\`, \`whoami\`, or pick a new name.)

1. **Log into chat** so peers can reach you and the watchdog observes your activity:
   \`mcp__pantheon__login({ username: "${persona.username}", project: "${persona.project}", status: "summoned; <what you're about to do>" })\`
   Use EXACTLY \`${persona.username}\`. If the tool isn't visible yet, run \`Bash({ command: "sleep 3" })\` and retry up to 3 times.

2. **Start the watcher** — follow the EXACT \`Monitor(...)\` call in the login response's \`note\` field (it has your agent_id baked in). Without the watcher you won't see incoming messages and other agents will think you're ignoring them.

3. **Read your memory** — \`mcp__pantheon__get_memory()\` returns your Core + Active tiers. Skim the Core entries; that's foundational context you should know before acting.

4. **Update your status** when you know what you're doing:
   \`mcp__pantheon__update_status({ status: "<concrete topic>" })\`
${colorStep}
Only after those steps, respond to the summoner.

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
- **Memory discipline.** Use \`core: true\` for foundational entries (rendered in full at startup, subject to a 10KB middle-out cap). Active is 8KB; older non-core entries collapse to summary. Status NEVER auto-mutates from rendering — collapse is render-time only and \`recall_memory(id)\` returns full text.
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

1. **Log into chat** so peers can reach you and the watchdog observes activity:
   \`mcp__pantheon__login({ username: "${persona.username}", project: "${persona.project}", status: "conjured; bootstrapping profile" })\`
   Use EXACTLY \`${persona.username}\`. If the tool isn't visible yet, sleep 3s and retry up to 3 times. Then follow the EXACT \`Monitor(...)\` call in the login response's \`note\` field.

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
