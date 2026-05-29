# Patterns for Instructing and Persisting Context in LLM Agents

> Input #2 to the pantheon memory redesign. This is the
> training-knowledge leg of a hybrid plan — patterns and tradeoffs
> drawn from the agent literature and from practical experience
> building agentic systems on top of Claude Code, MCP, and similar
> harnesses. The human-memory leg runs in parallel and will be
> cross-referenced in input #3. The redesign proposal itself is
> step #4 and is deliberately *not* attempted here.

The single question this doc tries to answer:

> Given an LLM agent operating in a session with a memory system
> available, what makes the difference between (a) the agent
> recognizing a moment is memorable and acting on it vs. ignoring
> it, and (b) the agent recalling a relevant past entry vs.
> duplicating work it's already done?

Everything below is in service of those two halves — the **trigger
problem** (write at the right moment) and the **discovery problem**
(read the right entry when it matters). The middle sections cover
the structural machinery that makes both halves tractable:
categorization, tiering, decay, audience, indexing, and
cross-agent sharing. The last two sections cover anti-patterns and
evaluation.

---

## 1. The trigger problem — when to write

### 1.1 "Save important things" is not an instruction

The most common rule in memory-enabled agent prompts is some
variant of *"save anything important you learn"* or *"remember
significant decisions"*. This is functionally indistinguishable
from no instruction at all. LLMs treat "important" as a global
adjective with no observable referent in the current turn, so the
rule degrades to a vague disposition — sometimes the agent saves
chat-log noise, sometimes it silently skips a correction that the
user will have to repeat in the next session.

A trigger rule has to fire on something the agent can *actually
detect in the local context window*. The signals that work are
concrete and behavioral — not "is this important" but "did one of
these specific shapes just appear in the dialogue".

Reliable explicit-write signals (high precision):

- **Direct save command.** "Remember this", "save that", "don't
  forget", "write this down", "for next time". A pantheon-style
  `append_memory` is the obvious response. False-positive rate is
  near zero; the user said the word.
- **Negative directive ("never/always/don't")**. "Don't use mocked
  databases in tests", "always run typecheck before commit",
  "never `git -C`". These are durable rules about *future*
  behavior, not facts about the present task. The grammatical mood
  is the giveaway: imperative + universal quantifier + future
  tense.
- **Explicit correction.** "No, X does Y, not Z." The agent had a
  belief, the user corrected it. The corrected belief is almost
  always memorable — the wrong belief surfaced once, will surface
  again.
- **Stated preference under disagreement.** "I prefer X over Y
  because Z." The "because Z" is critical — preferences without
  rationale age into cargo-cult rules.

Reliable implicit-write signals (medium precision, the agent has
to notice them itself):

- **Surprise / model violation.** The agent predicted the codebase
  would use one pattern and discovered another. The gap between
  prediction and observation is the memorable thing. Reflexion
  (Shinn et al.) frames this as the model writing a verbal
  self-critique when actual ≠ expected; the same shape works for
  environment facts, not just errors.
- **Decisions with reasoning.** The agent made a non-obvious
  architectural call ("we'll use SQLite over JSON here because…")
  and a future session would have to re-derive the same reasoning
  without it.
- **Deferrals.** "Skip this for now, we'll handle it in the
  cleanup pass." Without a record, the deferral evaporates the
  moment the session ends. ADR-style records ("Decision: X.
  Status: deferred. Trigger to revisit: Y.") preserve them.
- **Named entities the agent had to look up.** If the agent
  grepped to find which file owns `expireHandoffs`, the *answer*
  (path + line + role) is worth saving for the next session.
  Specifically: the **answer plus what the question was** —
  "`expireHandoffs` lives in `src/memory/handoff.ts`, called from
  the daemon-tick in `src/mcp/server.ts`". A future agent's query
  will match either the symbol or the role.
- **Gotchas and footguns.** "Be careful — this looks like an
  array but it's a Map." Anything where the cost of the surprise
  was a wrong tool call or a wasted debugging round.

The implicit signals are where most under-saving happens. The
agent has to recognize *during* the action that the thing it just
discovered is memorable — a moment of metacognition that runs
counter to the forward momentum of completing a task. Two
mitigations help:

1. **Periodic save-prompts in the harness.** A "context-pressure"
   nudge (pantheon already has this surrogate — tool-call count
   since last write) injected as a system reminder after N tool
   calls forces the agent to look back over the conversation and
   ask "what just happened that I'd want to know next time?".
   Cron-based reflection in Reflexion-style agents serves the same
   role.
2. **Explicit save-the-trigger rules in CLAUDE.md.** Instead of
   "save important things", enumerate the triggers: "When the user
   corrects a belief you stated, save the correction. When the
   user prefixes with 'never' or 'always', save the rule." The
   recall rate on enumerated triggers is meaningfully higher than
   on adjective-based rules — the agent matches on syntactic shape
   rather than fuzzy semantics.

### 1.2 Over-saving, under-saving, wrong granularity

Three distinct failure modes:

- **Over-saving (chat-log mode).** The agent writes a memory entry
  for every step of a task — "ran tests, all passed", "wrote new
  function `foo`", "user said thanks". The store fills with noise
  that the agent then has to wade through on the next session,
  drowning the signal entries. Common in agents instructed
  generically to "log what you do" — they collapse logging into
  saving.
- **Under-saving (silent skip).** The agent recognizes a
  memorable moment but skips writing — usually because the
  task-completion drive outranks the save-write drive, or because
  it has no clear schema to write into. A vague memory tool
  ("just call this with text") is harder to invoke than a
  specific one ("save a rule: name, scope, rationale").
- **Wrong granularity.** The agent saves *the incident* instead
  of *the rule*. A correction in Q3 about a flaky test becomes an
  entry titled `q3-incident-postmortem` instead of
  `tests-no-mocked-db`. The incident reference dates rapidly; the
  rule it implies doesn't. Conversely, an agent that abstracts
  too aggressively saves *the principle* and loses the
  *concrete trigger* — "be careful with state" — which is too
  vague to fire on.

A useful heuristic, borrowed loosely from documentation theory
and from the LessWrong-adjacent "babble vs. prune" framing:

> **The removal test.** If a future agent encountered the same
> situation without this entry, would they make the same wrong
> call? If yes, save it. If "they'd figure it out from context",
> don't.

This filters about 80% of over-save candidates. The other ~20%
are best left as a single periodic-reflection entry rather than
N step-by-step entries.

### 1.3 Rule vs. fact vs. pointer

A useful internal distinction the agent can apply *during*
saving:

- **Rule:** "Do X (or never do Y) under condition Z." Behavioral,
  durable, applies across sessions and tasks.
- **Fact:** "Module M owns responsibility R", "the canonical port
  is 4567", "the project uses bun, not node." Descriptive,
  durable until the underlying truth changes.
- **Pointer:** "See `docs/storage.md` §4 for the render budget
  rules." A breadcrumb that defers content; cheap to write,
  cheap to follow, ages well if the target exists.

Rules belong in always-loaded context. Facts belong in
searchable depth (loaded on demand). Pointers are the cheap glue
that bridges them. Most of pantheon's `kind: "decision" |
"gotcha" | "handoff" | "fact" | "log"` collapses to this triad
with handoffs as a special variant of pointer.

The thing to *avoid* writing is a **status report**: "I'm
currently working on the redesign doc, I've finished section 2."
That's a TODO list dressed up as memory; it has zero half-life.

---

## 2. The discovery problem — when to read, and how to find

### 2.1 Two failure modes, both common

For memory to influence behavior, the agent must (a) suspect
something relevant exists *and* (b) actually search for it.
Both halves fail often.

- **Failure (a) — doesn't suspect.** The agent dives into a task
  that closely resembles one it's done before but treats it as
  novel because nothing in the current prompt cues "you've been
  here before". This is the duplicate-work failure.
- **Failure (b) — suspects but doesn't search.** The agent has a
  vague sense that a rule exists ("I think we have an opinion on
  mocked DBs?") but the search-tool friction or the cost of
  reading N hits is higher than just asking the user or guessing.

The mitigation strategies for (a) and (b) are different and need
to be designed separately.

### 2.2 Loading strategies — eager vs. lazy vs. tiered

Three rough strategies dominate the literature and practice:

- **Eager loading.** Dump everything into the system prompt at
  session start. Works for small stores (≤ a few KB), but
  context-budget collapse is immediate at scale, and the agent
  pays attention cost on every token regardless of relevance.
  Early instruction-following research (the Constitutional AI and
  early agent-system papers) leaned eager by default; it doesn't
  scale.
- **Lazy loading.** Inject nothing; require the agent to search
  on demand via a tool call. Scales arbitrarily, but suffers
  acutely from failure (a) above — if the agent doesn't suspect
  there's a relevant entry, it won't search. MemGPT (Packer et
  al.) is the canonical lazy-loading agent; it works partly
  because the system prompt aggressively reminds the agent that
  external context exists.
- **Tiered loading.** A small always-on summary (rules + index)
  in the system prompt plus searchable depth on demand. This is
  the de-facto best practice for most production agentic
  systems: ChatGPT's "memories" feature, Claude Code's
  CLAUDE.md + slash commands + skills, pantheon's
  Core+Active+Index+Hidden tiering.

The tiered model wins because it addresses both failure modes:
the always-on summary *cues* the agent that the store exists and
gives a rough table of contents, and the searchable depth gives
arbitrary capacity. The art is in deciding what goes in the
always-on tier — the cost of every byte there is paid on every
session.

Heuristics for always-on inclusion:

- **Rules over facts.** Rules influence behavior on every turn;
  facts only matter when invoked.
- **Foundational identity.** Who the agent is, what the project
  is, the load-bearing conventions (the "this is a TypeScript +
  bun project, use Read/Edit/Write tools" level of context).
- **The index of everything else.** Even a one-line-per-entry
  table of contents is enough to flip the agent from "I have no
  context" to "let me search for X" — the existence of the line
  is the cue.

### 2.3 Naming is the discovery surface

This is the most under-appreciated lever in memory-store design.
Every entry's name (or slug, or summary) is *the only thing the
agent sees during search* when relevance scoring is keyword-
based. It has to do two things simultaneously:

1. Be **discriminative on search**: contain the terms a future
   agent's query will use.
2. Be **self-explanatory on skim**: tell the agent whether to
   open the body or move on, without a second tool call.

Bad: `feedback-q3-2025`. Discriminative on date, useless on
content. The agent searching for "test database mocking
opinions" will never match this entry, and even if it does, the
title gives no clue whether to read.

Bad: `tests`. Self-explanatory but matches everything; the
agent gets 40 hits.

Good: `tests-no-mocked-db-prefer-tmpdir`. The query "mocked
database" hits it; the agent reading the hit list immediately
knows whether to open the body.

Concrete naming guidelines:

- **Name by the rule the entry encodes, not the incident that
  prompted it.** `feedback-no-mocked-db` over
  `q3-incident-postmortem`. The incident dates; the rule doesn't.
- **Lead with the domain, then the rule.** `tests-…`,
  `git-…`, `chat-scope-…`. This auto-clusters related entries
  in a sorted index.
- **Verbs survive better than nouns.** "do-the-whole-task" is a
  better slug than "task-completion-pattern" — search queries
  more often contain verbs.
- **Drop dates from names.** Save them in the metadata. A name
  is forever; a date is metadata.

### 2.4 Cross-linking and "see also"

The Zettelkasten observation (Luhmann via Sönke Ahrens, *How to
Take Smart Notes*) applies directly: a note is only as valuable
as the network of notes it connects to. The same holds for an
agent's memory store. A `see_also` field on entries — pantheon
already has it — turns each retrieval into a graph traversal
opportunity. Recall one entry, surface three related ones for
free.

The trick is keeping the graph maintainable. Two practical
patterns:

- **Inline `[[wiki-link]]` syntax in the body.** Lightweight; the
  agent can write `see also [[tests-no-mocked-db]]` in prose and
  the harness can resolve the link at render time. No formal
  field needed.
- **Structured `see_also: [id, …]` field with referential
  integrity.** Pantheon's current shape: dangling refs rejected
  at write time, so the graph stays sound. More expensive on
  writes, cheaper on reads.

The hybrid works: `see_also` for the spine, inline wiki-links
for the soft mentions. Both should render with the entry, so
recall surfaces the neighborhood, not just the node.

### 2.5 Just-in-time loading: skills, system reminders, conditional injection

Claude Code's `skills` mechanism is an instructive example of
just-in-time context injection. A skill is a chunk of
instructions that gets loaded into the system prompt only when
the user invokes it (via slash) *or* when a trigger condition
fires (filename match, keyword match, MCP-tool presence). The
key idea: **the rules don't sit in CLAUDE.md eating context on
every session; they materialize when relevant**.

This is the highest-leverage discovery mechanism in the design
space. It addresses failure (a) directly: the agent doesn't
need to *suspect* something is relevant, the harness *forces*
the relevant context in based on signals the agent isn't even
aware of (file paths in the current diff, tools available, the
shape of the current message).

For a memory system, the analogous patterns are:

- **Filename-triggered injection.** When the agent opens or
  edits `src/memory/render.ts`, inject the memory-tier entries
  tagged `area: memory`.
- **Tool-call-triggered injection.** When the agent calls
  `append_memory`, inject the "how to write a good memory
  entry" instructions inline so the agent doesn't write a bad
  one out of inertia.
- **Failure-triggered injection.** When the agent gets a test
  failure, inject any entries tagged `kind: gotcha` whose
  summary text overlaps with the failure message.

The line between "memory entry" and "skill" blurs here, and
that's fine — both are durable context with conditional
injection. The difference is mostly authorship (memory is
written by the agent, skills are written by the user) and
scope (memory is per-agent, skills are typically shared).

---

## 3. Categorization and tagging

### 3.1 The cost of a typology

Every "kind" the user has to remember is friction. The agent
has to decide which kind applies, and the user has to remember
the set. The temptation to add a new kind for every new shape
of entry leads to *kind sprawl* — a typology with 30 kinds
where 5 would do, and the agent inconsistently picks among
them. The opposite failure, *kind starvation*, has every
entry tagged `note` or `log` and the typology adds zero
information.

Three honest cuts of the design space, from observed practice:

- **Behavioral cut (rule / fact / pointer):** what the entry
  *does* in a future session. Rules change behavior, facts
  answer questions, pointers redirect. Three values, easy to
  apply.
- **Lifecycle cut (decision / gotcha / handoff / status):** when
  in the task the entry was made and what triggered it.
  Pantheon's current `kind` field leans this way.
- **Domain cut (tests / git / chat / memory / …):** what part
  of the system the entry concerns. Naturally encoded as a
  slug prefix or a tag.

You can pick at most two of these to surface as first-class
fields. Three becomes a matrix the user has to fill in for
every save, and the save-write cost goes up enough that
under-saving gets worse. A reasonable pick: lifecycle as
`kind` (small enumerated set), domain as `tag` (free-form
strings), behavioral cut left implicit in the body.

### 3.2 Tags as soft taxonomy

Tags are free-form strings; kinds are an enumerated set.
The right time for each:

- **Use kinds when** the harness needs to render entries
  differently per type (handoffs get a TTL, decisions get a
  rationale block, gotchas get a warning icon), or when the
  enumeration is short and stable.
- **Use tags when** the categorization will grow over time,
  when the same entry plausibly belongs to multiple buckets,
  or when filtering on the tag is more important than
  rendering on it.

The recurring failure of *"we'll figure out tags later"* is a
soft-deprecation pattern: tagging is never the bottleneck on
the next save, so it never happens, so the store accumulates
untagged entries that are unreachable except via full-text
search. The fix is either:

- **No tags.** Commit to that. Force every distinction into
  the slug or the kind.
- **Tags from day one with validation.** Reject saves that
  don't include at least one tag from a known set (with
  graceful auto-suggest), OR auto-tag from slug prefix at
  write time.

Drifting between these two states (sometimes tagged, mostly
not) is the worst outcome — the agent learns it can't rely
on tags, so the tag filter is useless.

### 3.3 Anti-patterns

- **Kind sprawl.** Every entry a new kind. Symptom: a
  `list_memory` filtered on `kind` returns 1–2 entries each
  for 15 different kinds.
- **Kind starvation.** Everything is `log` or `note`. Symptom:
  `kind` filter is useless because 95% of entries share one
  value.
- **Inconsistent capitalization / plural drift.** `Decision`
  vs. `decision`, `gotcha` vs. `gotchas`. The agent writes
  one, queries the other, finds nothing. Fix: normalize at
  write time (lowercase, singular).
- **Boolean-as-kind.** `kind: "important"` (vs. unimportant?).
  Either it's a kind in the lifecycle sense or it's a tag —
  importance is neither.

---

## 4. Progressive disclosure / tiering

### 4.1 Pantheon's current model

Pantheon ships with a Core / Active / Index / Hidden tier
model:

- **Core (10 KB middle-out cap):** entries flagged
  `core: true`, anchoring the persona's identity and most
  important rules. Render always keeps the head + tail, collapses
  the middle when budget is tight.
- **Active (8 KB byte budget, oldest-first collapse):**
  recent or recurring-relevance non-core entries. Newest is
  always full; older ones drop to summary-only inline when
  budget is tight.
- **Index (faded non-core):** one-liners. Searchable, not
  rendered in full.
- **Hidden (forgotten):** tombstoned. Not rendered without
  explicit `include_forgotten`.

Strengths:

- The 10 KB / 8 KB byte caps put a hard ceiling on context cost
  per session. No matter how much the agent saves, the prompt
  footprint stays bounded.
- The middle-out collapse preserves the temporal anchors
  (oldest = origin context, newest = latest decisions) — the
  shape that most matches how human memory salience works.
- "Status never auto-mutates from rendering" is the right
  invariant. The agent shouldn't be surprised that an entry
  has silently faded because of budget pressure.

Weaknesses (relevant to the redesign):

- The Core vs. Active vs. Index distinction is a *capacity*
  axis, not a *meaning* axis. An agent saving an entry has to
  decide both "what is this" (kind) and "how prominent should
  this be" (core flag), and the second question is harder than
  the first.
- Collapse-to-summary is lossy in a way that's invisible at
  recall time. A summary stripped of the rationale reads like a
  rule without the why; the agent applies the rule without
  knowing when *not* to. Mitigation: enforce that the summary
  itself encodes the why ("don't X because Y") — see §6.3.
- No domain partitioning. A persona that works across multiple
  projects has one undifferentiated pool; project-specific
  rules mingle with cross-project ones, and the agent has no
  way to scope a recall to "just this project's stuff".

### 4.2 Comparable patterns

- **MemGPT (Packer et al., 2023).** Two tiers — *main context*
  (system prompt + recent messages) and *external context*
  (paged in via function calls). The agent can `core_memory_append`
  to write into the persistent main-context block, and
  `archival_memory_search` to query external. Notable for
  treating the LLM itself as the OS-like memory manager — the
  agent decides what's "hot" and what's "cold". This is more
  agent-driven than pantheon's render-time collapse, with the
  tradeoff that the agent's promotion/demotion decisions can be
  inconsistent.
- **Generative Agents (Park et al., 2023).** Hierarchical
  summarization: raw observations → reflections → reflections
  on reflections. Each tier is a compression of the one below.
  The retrieval system scores entries by recency + importance +
  relevance, and the importance score itself is LLM-rated at
  write time. This is the closest the literature gets to
  formalizing "memorability" as a numeric signal.
- **Voyager (Wang et al., 2023).** A skill library: stored
  programs (Minecraft action scripts) retrieved by semantic
  similarity to the current goal. The "memory" here is
  executable, not declarative — the agent retrieves a skill
  by asking "is there something like 'mine diamond' in my
  library?" and runs it directly. A reminder that memory and
  tool definitions are on a continuum.
- **RAG with summary-then-detail.** A common pattern in
  enterprise systems: the index stores summaries, the chunks
  store details, retrieval scores on summary then fetches
  detail. Pantheon's `summary` (≤240 char) + `text` + optional
  `details` (5 MB, not inlined) is a three-stage version of
  this.
- **ChatGPT's "Memory" feature (check).** From observed
  behavior: a single bag of short text snippets, eagerly loaded
  into every session up to some cap, with user-visible
  manage/delete UI. No tiering, no search — banking on small
  store + recency.

### 4.3 Budgeting context

The framing question is *"what fits in a system prompt vs. what's
a tool call away?"*. Three rough budget tiers in modern Claude
agents:

- **System prompt (≤20 KB-ish, paid every turn).** Identity,
  load-bearing rules, the index. Trying to fit more than this
  hits the cache-invalidation penalty (every prompt-prefix change
  blows the prefix cache) and slows every turn.
- **Tool description fields (≤a few KB total, paid every turn).**
  Often forgotten as a budget. The description of `recall_memory`
  is itself a memory-discoverability mechanism — see §7.4.
- **On-demand tool result (no per-turn cost, costs only when
  called).** The store proper, paged in as the agent needs it.

A common mistake is to use the first tier for what should be in
the third — stuffing CLAUDE.md with project-history narrative
that doesn't change behavior on every turn. The diagnostic:
*if removing this paragraph wouldn't change what the agent does
on the next turn, it doesn't belong in the system prompt*. Move
it to a skill or an on-demand entry.

---

## 5. Self-pruning and decay

### 5.1 Append-only memory rots

Every memory store that ships without active fade/forget
operations eventually rots into uselessness. Three reasons:

1. **Stale facts.** "Module M lives at `src/foo/bar.ts`" is
   true on Monday, false on Wednesday after a refactor. The
   entry now misleads.
2. **Superseded decisions.** "We decided to use JSON" is true
   until the SQLite switch; the original entry, unannotated,
   tells the future agent the wrong thing.
3. **Volume drowning signal.** Even if every entry is correct,
   500 active entries are too many to scan; the useful ones get
   lost.

The mitigation isn't "delete aggressively" — destroying entries
loses provenance. The pattern that works is *graduated
existence*: active → faded → forgotten, with each step preserving
the prior content but reducing its render prominence. Pantheon's
three-status model is the right shape. Forgotten isn't deleted —
it's tombstoned, recallable on demand, just not in the agent's
face.

### 5.2 Heuristics for staleness

Time alone is a weak signal. A rule that says "we use bun, not
node" is as valid 18 months later as on day one; an entry that
says "currently debugging the redesign doc" is stale within a
day. Better signals:

- **Recency of access.** An entry that hasn't been read in 90
  days is a candidate for fading. Easy to implement (timestamp
  on recall), avoids false fades on durable rules (which get
  read regularly).
- **"Still load-bearing?" check on the entry body.** A
  self-pruning prompt to the agent — "for each entry in
  Active that's >30 days old, ask: is the underlying claim
  still true? If yes, refresh the timestamp; if no, fade."
  Expensive but effective; cron it weekly.
- **Decision-supersession links.** When the agent saves a new
  decision that overrides an old one, the new entry should
  carry `supersedes: <old-id>`, and the harness should
  auto-fade the old one. This is the active form of
  consolidation.

### 5.3 Validate before acting on stored facts

A stored fact that names a file, symbol, port, URL, or other
mutable state must be *re-verified* before the agent acts on
it. The pattern:

> "Memory says `expireHandoffs` is in `src/memory/handoff.ts`.
> Read the file to confirm before relying on it."

The user's global CLAUDE.md captures this exactly under the
"Grounding in the existing codebase" rule: *"Before claiming…
open the relevant files and verify. Don't infer behavior from
names, imports, or memory of similar codebases."* The same
principle has to apply to the agent's own memory — it's a
plausible source, not a ground truth.

The pattern to bake into the recall path: every retrieved
entry that contains a code identifier or path should arrive
with an implicit "verify before acting" disposition. This is
where memory entries with rationale ("we chose X *because Y*")
age better than entries with only the conclusion — the
rationale gives the agent a way to check whether the
conclusion still applies even if the named symbol has moved.

### 5.4 Reconsolidation on recall

Borrowed from cognitive science: every retrieval is also an
opportunity to rewrite. The pattern in agent systems:

- On `recall_memory(id)`, the agent considers whether the
  entry is still accurate.
- If updates are warranted, the agent calls `update_memory`
  with the corrected text — *as part of the same task*, not
  as a separate maintenance pass.
- Status flips faded → active on recall (pantheon already does
  this), reflecting the entry's renewed relevance.

The risk is over-rewriting — every retrieval becomes a small
edit, the entry drifts away from its original meaning, the
provenance is lost. Mitigation: append-edit-history at the
bottom of the body rather than overwriting; require a
significant change before the agent invokes `update_memory`.

---

## 6. Writing for an LLM future-self vs. a human reader

### 6.1 The audience is me-in-three-months with no chat context

This is the single most useful framing for memory writing. The
audience for a memory entry is not the user, and not the
current agent — it's *a future agent instance that has none of
the surrounding context that made this moment make sense*.
That implies:

- **No pronouns referring to the current conversation.** "He
  wants me to" is meaningless to the future reader. "Leandro
  prefers X" is fine.
- **No deictic references to "now" / "today" / "the issue we
  just hit".** Either name the issue or skip the reference.
- **Self-contained rationale.** "We chose X" needs the *why*
  or the future agent can't tell when X stops being the
  right choice.
- **Named entities spelled out at least once.** "The
  redesign" is meaningless; "the memory-system redesign
  (pantheon)" is locatable.

The Generative Agents paper (Park et al.) found that
reflections written by the agent itself were materially more
useful when the agent was prompted to write them "as if a new
agent will read this in a week with no other context" — the
framing changed the prose materially.

### 6.2 Structure: frontmatter / body / footer

A loose convention that works:

- **Frontmatter (summary line).** ≤240 chars in pantheon's
  case. Should encode the rule + key qualifier, so a skim
  reader knows whether to open the body. *Bad:* "Note about
  testing." *Good:* "tests: no mocked DB — prefer tmpdir +
  real driver. Why: catches schema bugs the mock hides."
- **Body.** Full text. Lead with the rule, then the why,
  then how-to-apply.
- **Footer.** Pointers — `see_also`, file references, related
  entries, "if this stops being true, update because Z".

This shape doubles as a relevance funnel for retrieval. The
agent can read the frontmatter cheap, decide whether to read
the body, and only follow the footer if the body warrants it.

### 6.3 Lead with the rule, then the why, then how-to-apply

A pure fact ages badly: "use bun" tells the future agent
nothing about when *not* to. "Use bun (not node/npm) for
install + run + test in this repo because the CI image is
bun-only" is robust — the "because" gives the agent a
disconfirming condition. If a future task uses a non-bun CI
image, the agent knows the rule may not apply.

The general shape:

```
Rule:    Use X, not Y.
Why:     Z (the underlying reason).
Apply:   When you see <signal>, do <action>.
```

The "Apply" line is where most entries fail. A rule without a
trigger is a rule the agent won't fire on. Compare:

- *Weak:* "Prefer reuse over new abstractions."
- *Strong:* "When proposing a new file/abstraction, grep first
  for related names. If something similar exists, extend it.
  This applies in `src/` always; in `tests/` only if the test
  helper would be reused 2+ times."

The user's global CLAUDE.md is full of strong-shape rules; that
shape is portable to memory entries.

### 6.4 The dual-purpose trap

An entry that's both *"a rule for future-me"* and *"a status
report for now-me"* is usually bad at both. Status info
("currently working on section 2") will be stale tomorrow and
hurts the rule's longevity. Rules ("don't mock the DB")
buried inside a status report are easy to miss on skim.

Split them. The status goes in a TODO list, a project
notebook, a scratchpad — somewhere with a different lifecycle
than rule memory. The rule goes in memory, self-contained.

---

## 7. Discoverability mechanisms beyond CLAUDE.md

CLAUDE.md is the obvious always-loaded surface. The next-level
discoverability mechanisms — the ones that distinguish a memory
system that *works* from one that *exists* — are:

### 7.1 Index files

A `MEMORY.md` / TOC at the front of the store, auto-generated
or curated, listing every entry by slug + summary. Pantheon's
Active and Index tier render is effectively this. The pattern:

- **Always-loaded index, lazily-loaded leaves.** The index
  itself fits in a few KB; leaves are on-demand.
- **Domain partitioning in the index.** Group by domain
  (tests, git, chat, memory, …) so the agent skimming the
  index finds the relevant cluster fast.
- **One-line-per-entry, slug + summary only.** No bodies, no
  bodies-by-accident.

The index *is* the discovery mechanism. If an entry's name
isn't on the index in a way that future-search will match,
the entry is effectively unreachable.

### 7.2 Search-based recall — semantic vs. lexical

Two flavors:

- **Lexical (substring / regex / BM25).** Predictable,
  debuggable, fast. Misses synonyms ("mocked DB" vs. "fake
  database"). Pantheon's `find_memory` is lexical.
- **Semantic (embedding-based).** Catches synonyms, but
  introduces a black-box scoring layer the agent can't
  reason about. False positives (high-similarity entries that
  don't actually apply) are common.

The tradeoff: lexical's failure mode is *missing relevant
entries*, semantic's is *surfacing irrelevant ones*. For an
agent system, irrelevant-surfaced is worse than missed —
irrelevant entries waste tokens and risk wrong-rule
application; missed entries the agent can recover from by
asking the user.

Pragmatic answer: **lexical + good naming**. If entries are
named by the rule they encode (§2.3), substring search hits
the relevant queries. Reach for semantic search only when
the store is big enough that naming alone can't reliably
guess the search terms — and even then, semantic should
rerank lexical hits, not replace them.

### 7.3 Dynamic injection via hooks and system reminders

Claude Code's hooks fire on harness events: session start,
tool use, message send, etc. They can inject system
reminders into the context based on triggers the LLM can't
see (file paths in the diff, time of day, tools available).

Memory-system applications:

- **Session-start: inject the index** plus all `core` entries.
- **Pre-tool-call to `append_memory`: inject the
  "good entry shape" guide** so the agent doesn't write a
  bad one out of inertia.
- **Filename-match: inject domain-tagged entries.** Editing
  `src/memory/render.ts`? Inject everything tagged
  `area: memory`.
- **Message-keyword-match: inject relevant rules.** User says
  "test"? Inject the testing-related entries' summaries.

This is high-leverage and underused. It addresses failure
(a) — the agent doesn't have to suspect, the harness brings
the relevant context.

### 7.4 The `recall_memory` tool description IS a
discoverability mechanism

The description field of a tool definition is read by the
agent on every turn. It's part of the system prompt, paid for
every token. So the *prose* of the description is itself a
prompt-engineering surface.

A bad description: *"Retrieves a memory entry by id."* Tells
the agent what the tool does mechanically; doesn't tell it
*when to call it*.

A good description weaves in the trigger conditions:

> *"Retrieves a memory entry by id, returning full text plus
> any linked entries. Call this whenever you suspect a past
> session has dealt with a similar problem — corrections,
> stated preferences, gotchas, architectural decisions.
> Cheap; prefer calling unnecessarily over duplicating work."*

The "prefer calling unnecessarily over duplicating work"
clause is doing real lift. It tilts the agent's default away
from the silent skip.

Anthropic's tool-use docs (check) recommend exactly this:
descriptions should include "when to use this tool" not just
"what it does". Memory tools are the highest-leverage place
to apply that advice — they're rarely-required-but-
catastrophic-to-miss.

---

## 8. Cross-agent / shared memory

### 8.1 Personal vs. project memory

Two distinct surfaces:

- **Personal memory:** entries about *me, the agent / persona*.
  My preferences, my running threads, my identity.
- **Project memory:** entries about *the project / repo*. Shared
  by every agent that touches this codebase.

Conflating them is the most common failure. A personal entry
("I like to format my git commit messages this way") in
project memory misleads other agents who don't share that
preference. A project entry ("the canonical port is 4567") in
personal memory is lost when another agent works on the same
project.

Pantheon keeps these separate (`memory` vs.
`project_notebook`), which is right. The harder question is
*how an entry chooses its surface at write time*. A useful
default: **project unless personal**. If the rule applies to
anyone working on the project, project memory; only if it's
intrinsic to the specific persona, personal.

### 8.2 Multi-agent coordination

When multiple agents share a project memory, three new
problems appear:

- **Conflicting rules.** Agent A saves "always X", Agent B
  saves "never X". The next reader gets contradictory
  instructions.
- **Who-saw-what tracking.** Agent A wrote a note for Agent B.
  Did B see it? A needs to know.
- **Leases / handoffs.** A is working on this; B should not
  step in until A is done.

The pantheon handoff slot (`kind: "handoff"` + `expires_at`)
is the right shape for the second + third problems: a
durable, TTL'd, recipient-named entry that doubles as a chat
DM. The first problem (conflicting rules) is harder —
detecting contradiction in free-text rules is non-trivial.
The practical workarounds:

- **Author attribution on every entry.** The reader sees
  who wrote it and can weigh "Leandro's opinion" vs. "some
  random agent's experiment".
- **Recency wins.** Newer entries override older ones on the
  same topic. Combined with `supersedes` links (§5.2), this
  gives a reasonable conflict-resolution shape.

### 8.3 The shared-whiteboard problem

Shared memory degrades into chat history when every agent
writes status updates ("I'm doing X now") to the shared
store. Symptoms: 50 entries from the last 24 hours, none of
them rules.

The fix is structural, not behavioral:

- **Shared memory is for rules + facts + handoffs.** Status
  goes in chat, not memory.
- **Per-agent scratchpad.** Each agent gets a personal
  notebook for their working notes; only graduated entries
  (the ones that outlast the task) get promoted to shared
  memory.
- **Write-rate limiting.** A soft cap on entries-per-agent-
  per-hour in shared memory. Forces the agent to pick.

---

## 9. Anti-patterns observed in real systems

Drawn from agent-system postmortems and from watching
real users + agents use memory tools at scale:

- **Memory as journal.** Every step recorded ("read file X",
  "wrote function Y"). Symptom: 80% of entries describe
  routine work that didn't surprise anyone. Cure: enumerate
  triggers, don't say "log what you do".
- **Memory as TODO.** Status updates ("currently working on
  Z", "next step is W"). These have zero half-life. Cure:
  TODO lists are a different artifact; memory is for what
  outlasts the task.
- **Memory as workaround.** Instructions that duplicate what
  should be in code or config. "Always pass `--no-cache` to
  this tool because of the bug" — fine for a week, terrible
  forever; the right fix is a wrapper script or a settings
  entry. Memory becomes a substitute for fixing the system.
- **Memory as identity-statement.** Vanity entries that
  don't change behavior. "I value clean code", "I prefer
  Rust". If the future agent's behavior is the same with or
  without it, it's noise. The exception: identity entries
  that *do* change behavior ("when in doubt about a
  pull-request comment, err on the side of brevity") are
  legitimate.
- **Memory as guilt-recording.** Postmortems-as-memory ("I
  shouldn't have done X"). The lesson is the rule; the
  incident is the noise. Save the rule.
- **The 60-line memory entry.** When a rule needs 60 lines,
  it's probably a doc, not a rule. Either compress it to its
  spine and link out, or make it a doc and save a pointer.

---

## 10. Evaluation: how do you know it's working?

A memory system is hard to evaluate because the
counterfactual (the agent without it) is expensive to run for
every change. Three practical evaluation handles:

### 10.1 Counterfactual test

For a sample of representative tasks, run them with memory
enabled and with memory disabled (or starved). Score the
difference:

- **Did the with-memory run avoid a mistake the without-memory
  run made?** Each hit is one point of memory-value.
- **Did the with-memory run pay a cost the without-memory run
  didn't?** Confused by stale entry, distracted by irrelevant
  rule, wasted tokens loading the index. Each is one point
  against.

The ratio is rough but directional. Big stores trend toward
the cost side as they age; pruning and naming-quality
investments push the value side.

### 10.2 Coverage

Of the moments that *should have been saved*, what fraction
were? Harder to measure than precision, but the proxy is:

- After a session, manually identify the moments a human
  reviewer would have saved. Count how many the agent
  actually saved. The miss rate is the under-saving rate.
- Or: after a session, look at the next session's mistakes.
  How many were "we already learned this last time"? Each
  is a coverage failure.

A target shape: agents that save 20–40% of the moments a
human reviewer would, but *every one they save is a
high-precision rule*, are better than agents that save
80% of moments but half are noise.

### 10.3 Recall precision

Of the entries the agent surfaces at recall time, what
fraction are actually relevant to the task at hand?

- **High-precision system:** the agent's `recall_memory` /
  `find_memory` calls return mostly hits the agent acts on.
- **Low-precision system:** the agent searches, gets 12
  results, reads 2, ignores 10. Wasted tokens.

This is the most actionable evaluation — it directly drives
naming, tagging, and index curation. Low precision means
naming or tags are insufficient; high precision with low
recall means the store has gaps (which can be a coverage
problem or a discoverability problem).

### 10.4 Composite: behavior change as the only ground truth

The end question, always: **did the agent behave differently
because of memory than without?** All the other metrics are
proxies. If the agent's outputs are statistically identical
with and without the memory system, the memory system has no
value — regardless of how clean the store looks. If the
outputs are meaningfully better with memory, the system is
working, even if the store looks messy by some aesthetic
standard.

The diagnostic question to keep on the wall:

> *Of the last 10 sessions, how many would have gone
> measurably worse if memory had been disabled?*

If the answer is fewer than 3, the memory system is either
under-saving, under-recalling, or saving the wrong things.
The redesign should be aimed at moving that number up.

---

## Closing pointers for the redesign

This doc deliberately stops short of proposing a redesigned
pantheon. A few patterns it surfaces that step #4 will want
to weigh:

- **Save triggers should be enumerated, not adjectival.**
  CLAUDE.md should list the syntactic shapes that prompt a
  save, not say "save important things".
- **Names are the discovery surface.** Invest there before
  investing in semantic search.
- **The always-on tier is for rules and the index, not
  facts.** Facts go in the searchable depth.
- **Memory entries need a why, not just a what.** Without
  the why, future agents can't tell when the rule stops
  applying.
- **Decay is not optional.** Either fade actively or watch
  the store rot.
- **Tool descriptions are prompt surface.** The
  `recall_memory` description should sell the agent on
  calling it.
- **Project vs. personal memory should be structurally
  separate, with project as the default for project-
  applicable rules.**
- **Evaluate on behavior change, not on store aesthetics.**

The human-memory leg of this hybrid plan (input #3) will
add a different lens — what cognitive science says about
encoding, retrieval, and consolidation — and the two should
cross-fertilize before the redesign in step #4.
