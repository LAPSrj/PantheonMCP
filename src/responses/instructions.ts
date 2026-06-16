/** §11 `get_instructions` — system-authored, topic-keyed agent manual.
 *
 * Distinct from memory: instructions are the shared, stable manual
 * (how pantheon works); memory is persona-authored experience (what
 * this agent learned). The content here is curated agent-facing
 * guidance the agent's CLAUDE.md doesn't inline — pulled on demand and
 * auto-surfaced from error messages / JIT hooks (the later milestone).
 *
 * Keep entries short and operational. This is the seed set; the JIT
 * injection + richer content land in the get_instructions milestone.
 */

const INSTRUCTIONS: Record<string, string> = {
  topics: `Topics organise memory (§4). The slug is \`<topic>/<name>\` — one
taxonomy, auto-clustered in the index. Durable kinds (rule/fact/gotcha/
pointer) and handoffs REQUIRE a topic; notes inherit the session topic;
reminders are due-gated. Reuse an existing topic when one fits (run
\`list_topics\`); a brand-new topic is flagged so the set doesn't sprawl.
The reserved topic \`always\` loads (as summaries) every session — choose
it explicitly, never as a default.`,

  memory: `Memory is topic-scoped + lazy (§1). Nothing is dumped at boot: you
see a topic menu (\`list_topics\`) and \`load_memory(topics)\` only what the
task needs. Save with \`append_memory\`: a rule on "always/never/correction
with a reason", a fact on a project invariant, a gotcha on a surprise /
workaround, a pointer to a doc/skill, a reminder for "remind me…", a note
for everything else (scratch / status / working context). The summary
(\`summary_max240\`) should phrase the TRIGGER — "when doing X, remember
Y" — not a bare title. Pin (\`pin: true\` + \`pin_reason\`) only the few
entries that must render in full every session.

Write CONCISELY — it's self-interest, not etiquette. The boot render
spends a shared byte budget (per-topic + a global full-text cap); a
bloated body draws it down faster and, when the budget is hit, collapses
to summary-only — pushing your OWN older entries out of the full render
too. Terse survives; verbose self-evicts. So: telegraphic in the body
(drop articles, fragments OK, no restated context, no per-step
changelog), one fact per entry, link don't quote (a pointer to the
source beats pasting it). Good gotcha: "wt adapter clobbers spawn PATH
with summoner's env (wt.ts:165) — bash -l .profile PATH lost; wrapper
only resolves if summoning CC had it first." Bad: three paragraphs
re-narrating the debugging session. If you're tempted to paste a log or
a file, store a pointer instead.`,

  chat: `Chat scopes are project / dm / global. A DM REQUIRES both
\`scope: "dm"\` AND \`target: "<username>"\`. Scope determines delivery —
\`@mention\` is annotation only and does not route across projects. Read
the per-message reply tag ([no reply] / [maybe reply] / [likely reply] /
[required reply]) and let it dictate your response. Silent ambient
events come wrapped in <silent-event> — reply with a single ".".

Keep messages SHORT — peers read them through a relay that only carries
the body inline up to a length cap (~400 chars, env
\`PANTHEON_WATCHER_TRUNCATE_AT\`). Past it the watcher relays an oversized
STUB, not your text — the recipient has to call \`get_message\` to read
it, which most won't. A long message is effectively an unread message.
Lead with the point, drop the preamble; if it genuinely needs length,
say the headline first so the stub still carries the gist.`,

  lifecycle: `Auto-rest is governed by the watchdog. \`extend_rest({ minutes })\`
pushes the deadline; \`extend_rest({ minutes: "never" })\` disarms it for a
stand-by session. Rest cleanly: \`append_memory\` a handoff →
\`rest({ reason, handoff? })\` → say goodbye → \`exit()\`. A handoff is an
ephemeral continuity note (topic-delivered, decays per §8), never durable
memory.`,

  summon: `Summon spawns another agent in its own terminal. The summoner's
identity is recorded on memory the spawned session writes
(\`summoner_username\`). Remanifest spawns a fresh incarnation of yourself
and hands it context; the old session exits once the new one logs in.`,

  boot: `Boot order (§9): manifest → list_topics → load_memory(topic) →
login → start the watcher (Monitor). \`load_memory\` is REQUIRED before
chat — the dispatcher rejects non-exempt tools with \`memory_not_loaded\`
until it runs. A fresh persona with no topics skips the gate. Exempt
tools: manifest, list_topics, load_memory, session_info, whoami.`,
};

export const INSTRUCTION_TOPICS = Object.keys(INSTRUCTIONS);

export function getInstructions(topic: string): string | null {
  return INSTRUCTIONS[topic] ?? null;
}
