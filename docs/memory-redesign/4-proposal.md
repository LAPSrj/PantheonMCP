# Pantheon Memory — Proposed Redesign

> **SUPERSEDED (§4–§9) by `5-proposal-v2.md`** (2026-05-29 design session).
> The diagnosis (§1–§3) and the empirical findings (F1–F10) / principles
> (P1–P8) below still stand and v2 builds on them; the revised *model*
> (topic-scoped lazy load + per-kind relevance axes) lives in v2.
>
> Synthesis of inputs #1 (human memory), #2 (LLM instruction patterns),
> and #3 (empirical usage analysis of 66 personas / 836 entries / 2.9
> MB on disk). This is a **proposal**, not a spec. Some of the calls
> below are judgment calls; flagged where they are. Step 5 (not part
> of this doc) would be a per-phase implementation breakdown after
> Leandro signs off.
>
> Reading order: §1 is the TL;DR. §2 frames what's wrong. §3 distills
> the principles. §4 is the proposed model in detail. §5–§7 are
> instruction shape, migration plan, and open risks. §8 is how we'll
> know it worked.

---

## 1. Executive summary

The pantheon memory system works in the sense that agents use it,
write reasonably durable entries, and occasionally surface them
back across sessions. It does **not** work in the sense that:

- **It is write-only in practice.** Zero entries in 836 have ever
  been updated; `update_memory` has never been called. There is no
  reconsolidation loop.
- **Decay is not running.** 87.9 % of all entries are `status:
  active`; 81 handoffs older than the documented 7-day auto-fade are
  still active. The fade machinery is either gated on persona summon
  or simply not firing.
- **The "core" tier is meaningless.** 48 % of all entries are
  `core: true`; 77 % of handoffs are core. The priority signal has
  inflated to "I wrote this."
- **The kind taxonomy is overloaded.** `handoff` covers three
  semantically distinct things (templated relay, multi-KB session
  snapshot, cross-persona TODO). 23 % of entries have no kind at
  all.
- **Auxiliary surfaces are stranded.** `details` (1/836 used),
  notebooks (0 files on disk), `see_also` (8/836), `replies_to`
  (4/836), project memory (1 entry total). Tool surface exists; no
  one reaches for it.
- **Two roles dominate.** 96 % of summon attributions are
  `semaphoremole` + `righthand` — the liaison-of-the-day. Most
  personas are downstream of the orchestrator, not direct Leandro
  summons.

The redesign has three load-bearing moves:

1. **Two write surfaces, not one.** A short-lived `note` tier (3-day
   default fade, agent-write-cheap) takes the journal/status traffic
   off the long-term store. A `rule` / `fact` / `pointer` /
   `gotcha` / `handoff` set carries the durable knowledge.
   Inspired by the hippocampus / cortex division of labour from
   cognitive science: fast and lossy vs. slow and integrated.

2. **`core` is computed, not chosen.** Agents stop deciding
   prominence. The always-on tier is derived from kind + structure:
   `rule` and `fact` with a non-empty `apply` line become always-on;
   everything else lives in searchable depth. The 10 KB / 8 KB
   render budgets shrink to a single 6–8 KB always-on band.

3. **Decay actually runs.** TTLs fire on the daemon-tick, not on
   persona summon. Recency-of-access drives a second fade pressure.
   Reconsolidation becomes a first-class flow: `recall_memory`
   surfaces "still load-bearing?" as a question the agent can act
   on in the same turn.

Three things we **don't** propose:

- **Don't add a notebook layer.** It has zero adoption with a
  15-tool surface already wired. Adding a fourth surface when the
  third has no users is the wrong direction. Deprecate `notebook_*`
  (preserve the handlers for now; remove from the prompt).
- **Don't add semantic search.** Lexical + good naming covers the
  current corpus size (2.9 MB across 66 personas). Embeddings add
  a black-box scoring layer that surfaces irrelevant hits with
  confidence; the failure mode is worse than missed lexical hits.
- **Don't add new kinds.** Collapse the existing 6+ to a smaller
  set with strict write-time validation. Kind sprawl is the trap;
  starvation is the cure.

The migration plan in §6 is backwards-compatible at every phase:
the disk schema gets fields added but never broken; existing
entries are auto-mapped on read; tool surface is unchanged in shape
until the agent-side conventions have shifted.

---

## 2. What the data actually says

The empirical analysis (input #3) produced ten findings that
materially shape the design. Listed here in order of how much they
constrain the proposal:

**F1. The store is write-only.** Zero `updatedAt` field in 836
entries. The actual field name is `date`, never mutated. When
agents have a new version of a fact, they append a new entry
rather than edit the old one. The most extreme case: righthand's
standing-rule pile, where a 2026-05-13 19:25 entry explicitly says
"supersedes the broader framing in memory id `06-20-…`" and both
entries still sit active in the same persona. _Design implication:
reconsolidation needs to be cheaper and more visible than append.
The agent has to want to invoke it._

**F2. Fade is rare; forget is rarer.** 87.9 % active / 9.4 % faded
/ 2.6 % forgotten. Only one persona (filmstoat) has more forgotten
than active entries, and only because of an explicit `dream` pass.
The 7-day handoff auto-fade is *not the dominant outcome* — 81
templated handoffs older than 7 days are still in active state.
_Design implication: a decay system that depends on agent
discipline does not get exercised. It has to run on its own._

**F3. Core inflation.** 48 % of entries are core. The agent-side
heuristic for marking core is approximately "I think this matters",
which has the same problem as "save important things" — no
observable referent. The well-calibrated personas (archivedrake
20 %, docwarden 16 %) are outliers; the typical persona is at 50 %
or above. _Design implication: agents are not the right authority on
prominence. Compute it._

**F4. Kind overload.** `handoff` carries at least four distinct
shapes: templated short relays (~31 entries, 7-day fade target),
multi-KB session snapshots (~10+, never intended to fade),
cross-persona "PENDING X" TODO items (~5, queue-on-memory), and
inter-incarnation continuity notes. _Design implication: split the
kind or split the field. One tag for "what is this" and a separate
tag for "how should it decay" disambiguates._

**F5. Untyped legacy.** 192 entries (23 %) have no `kind` at all.
Older personas (amberhowl 75 % untyped, swoopfinch 49 %) predate
the typed-kind convention. _Design implication: the migration has to
handle "no kind" as a real existing state, not an edge case. Auto-
infer where possible; mark `unknown` where not._

**F6. Cross-linking is invisible.** 12 entries (1.4 %) use any
structured link (`see_also` 8, `replies_to` 4). When agents *do*
cross-reference, they do it in prose ("see memory id `06-20-…`")
because populating the structured field requires knowing the
auto-generated slug. _Design implication: discoverability of ids is
the bottleneck. Inline `[[slug]]` syntax in body text, resolved at
render, removes the round trip._

**F7. The notebook surface is a ghost.** 15 tools, 60-line handler
module, 21 KB plan doc; zero `notebook.json` files on disk across
66 personas and one project. _Design implication: a memory tier
without discovery hooks is invisible. This is exactly what the
existing memory system risks repeating if `update_memory` and
`see_also` stay un-prompted._

**F8. Summary-as-header.** 27 % of entries have a `text` body that
begins verbatim with the `summary` string. The summary slot is
being used as a title, not as a distillation. _Design implication:
the summary field's purpose has to be enforced by validation at
write time. Otherwise, half the discovery value is lost — a
non-distillative summary is a less-useful index entry._

**F9. Big entries break the budget.** 24 entries exceed the
documented 8 KB Active budget individually; the heaviest is 15.9 KB.
The rendering machinery quietly handles this (the 8 KB is a
collapse target, not a hard cap), but the doc-spec divergence is
itself a smell. _Design implication: explicit fast-paths for "large
artifact" memory — but only if the use case justifies a fourth
shape. See §4.8._

**F10. `details` is dead.** 1/836 entries populates the
≤5 MB `details` slot; that one was written by the `dream` tool,
not by an agent. _Design implication: remove the field from the
agent-facing schema. The dream-tool can use a dedicated
audit-trail slot, not the public `details`._

The empirical baseline: the agents are using a small, working
subset of the system (append, kind, core, summary, text, status)
and ignoring or under-using the rest. The redesign should
**collapse to what's used and reinforce it**, not add more surface.

---

## 3. Principles distilled from cognitive science and LLM-pattern work

Eight principles emerge from cross-referencing inputs #1 and #2.
Each maps to one or more design moves in §4.

**P1. Many systems, not one (from §1 of input #1).** Human memory
is not a uniform store; it is a federation of systems with
different timescales, codes, and lifecycles. Treating "memory" as
one bag with one TTL is a category error. → The note/rule/fact
split in §4.2. → Different decay rules per kind in §4.6.

**P2. Encoding depends on signal, not on intent (from §2 of input
#1; §1 of input #2).** Whether a moment is remembered depends on
attention, surprise, emotional/decision salience, and prediction
error. The most reliable save triggers are *external syntactic
shapes* the agent can detect, not internal judgments of
importance. → Enumerated triggers in CLAUDE.md (§5).

**P3. Working capacity is small (Cowan ~4 chunks; from §3 of
input #1).** The always-on context has to be tight. Loading
"everything important" into the system prompt does not work even
if budget exists — attention dilutes. → Always-on budget of ~6 KB
(§4.3).

**P4. Consolidation = transfer from sparse-fast to integrated-slow
(from §4 of input #1).** Recent traces in the hippocampus get
replayed and re-encoded into the cortex over time. The cortex is
NOT a copy of the hippocampus; it is a compression. → Two-tier
write surface (§4.1). → The dream pass as a real workflow (§4.7).

**P5. Forgetting is adaptive, not a bug (from §10 of input #1;
§5 of input #2).** A memory system that never forgets is a log
file. Active forget machinery is required, and it serves emotion
regulation, abstraction, and contextual updating — all relevant
analogs for agent memory (stale rules interfere, schema-extraction
needs episode loss, current state should be most accessible). →
Decay runs on a daemon (§4.6).

**P6. Retrieval is re-encoding (from §6 of input #1; §5.4 of
input #2).** Every read is an opportunity to rewrite, validate, or
fade. The pure read-only semantic of `recall_memory` misses this. →
Reconsolidation on recall (§4.6.3).

**P7. Names are the discovery surface (from §2.3 of input #2;
crossed with the schema/chunking findings in §9 of input #1).**
Expert chess masters retrieve chunks by recognizing patterns, not
by scanning. The slug is the agent's recognition surface. Invest
there before investing in semantic similarity. → Slug conventions
in §4.5.

**P8. Audience is future-self-with-no-chat-context (from §6.1 of
input #2).** The whole point of memory is to bridge across
incarnations that have nothing else to go on. Every entry should
be readable cold. → Write-time validation against deictic
references; rule-why-apply structure in §4.4.

A non-principle worth naming: **dreaming is not solved science.**
The function of dream content per se is contested (§7 of input
#1). The `dream` tool in pantheon today is metaphorically
defensible but should not be over-loaded with mystical weight —
it's an offline consolidation pass, and that's well-established;
extending it into "creative recombination" or "threat simulation"
goes past what the science supports.

---

## 4. The proposed model

### 4.1 Two write surfaces, not one

The largest single category of waste in the current corpus is the
**journal-shaped entry**: phase-N-done, session pause #2,
"currently working on X". These live forever in the active set
because they were written with `append_memory`, which has no fade
contract. Agents reach for `append_memory` because it's the only
write tool they know.

The fix is structural: give the agent a **cheap, fast-fading write
target** for ephemeral observations, and reserve the durable
surface for entries the agent has explicitly judged to be load-
bearing.

**Concrete shape:**

| Tier | Default kind | Default TTL | Always-on? | Cost to write |
|---|---|---|---|---|
| **Recent buffer** | `note` | 3 days (fade), 14 days (forget) | No | Cheap — single arg, free-form text |
| **Consolidated** | `rule` / `fact` / `pointer` / `gotcha` / `handoff` | None (unless `expires_at` set) or kind-specific (handoff: 7d) | Computed (§4.3) | Higher — requires `apply` line for rules, slug discipline |

Mechanically, both tiers live in the same `memory.json`. The
distinction is purely lifecycle policy keyed on `kind`. `note` is
**not** a new storage backend; it's a new contract: cheap to write,
fast to fade, never promoted to always-on, never `pin`-eligible.

**Tool surface:**

- `append_memory({ text, kind: "note" })` — the new default for
  "I want to write this down somewhere." The tool description
  should explicitly call this out: *"For quick observations,
  status, mid-task scratch — pass `kind: 'note'`. These fade in 3
  days. For durable rules or facts, see kind options below."*
- `append_memory({ text, kind: "rule"|"fact"|…, apply: "…" })` —
  the explicit durable write. Validation: rule and fact require a
  `summary` distinct from the first line of `text` (the
  anti-pattern in F8); rule requires an `apply` line in the body.

**What this fixes:**

- The "phase-6-done" / "session pause #3" entries that pollute
  swoopfinch and wombatfizz become `note`s and fade naturally.
- The journal-vs-rule confusion that produces wrong-granularity
  saves (input #2 §1.2) goes away because the tool itself
  partitions the lifecycle.
- Agents who don't know whether something is "important enough to
  save" can default to `note` — under-saving stops being the
  alternative to over-saving.

**What this doesn't fix:**

- A new lifecycle is one more thing to learn. Without CLAUDE.md
  reinforcement (§5), agents will continue using `append_memory`
  without `kind` and the system will have to infer.
- The boundary between "this is a fading note" and "this is a
  durable gotcha" is judgment-call territory. The dream-pass
  consolidation flow (§4.7) is the safety net.

### 4.2 Kinds reframed: a smaller, lifecycle-cut set

Today's six dominant kinds map to a smaller set with cleaner
semantics:

| Current | Proposed | Why |
|---|---|---|
| `decision` (116) | `rule` | Decisions are rules with a story. Drop the synonym. |
| `feedback` (23) | `rule` | Same shape; `feedback` is "rule from operator." |
| `fact` (36) | `fact` | Keep. Descriptive, durable until truth changes. |
| `gotcha` (58) | `gotcha` | Keep. A fact about a known pitfall — distinct enough to render with a warning. |
| `handoff` (271) | `handoff` | Keep, but **strictly templated short relays only**. |
| `log` (127) | `note` | Lowest core-rate (8 %) — agents already treat this as ephemeral. Rename to mark it. |
| _no kind_ (192) | `note` on migration | Default for legacy. Agent can promote on next touch. |
| `core` (4) | (dropped — was kind-as-bool collision) | |
| `project` (2) | (dropped — meant project memory, not a kind) | |
| `phase-6-state` (5) | `note` | Persona-specific ad-hoc; demote. |
| `audit` (1) | `gotcha` | One-off; absorb. |
| `dream_log` (1) | (system-only, not agent-written) | |

**The new kinds:**

- **`note`** — ephemeral observation, scratch, status. Auto-fades
  in 3 days; auto-forgets in 14. Never always-on. Cheapest to
  write. Default for `append_memory` without explicit kind.

- **`rule`** — durable behavioral instruction. Requires `apply`
  field describing the trigger ("when X happens, do Y").
  Always-on if `apply` is set and non-empty.

- **`fact`** — descriptive durable information. Always-on if
  `apply` field is set (e.g. "look here when X"); otherwise
  searchable depth.

- **`gotcha`** — a known pitfall. Renders with a warning marker.
  Always-on if recent or recently accessed.

- **`pointer`** — explicit breadcrumb to a doc or file. Cheap to
  write, cheap to follow. Always-on if `apply` is set.

- **`handoff`** — TTL'd targeted message. Auto-fades in 7 days,
  auto-forgets in 30. Reserved for the templated short-relay
  pattern. **Multi-KB session snapshots become `note`s** (they
  fade naturally in 3 days, which is correct: by then the next
  session has happened and the snapshot is obsolete).

What's _explicitly removed_:

- The `core` boolean as an agent-set field. It becomes
  `computed_core` (see §4.3) and is not part of the write API.
- The `details` field. 1/836 usage; the dream tool moves to a
  dedicated `audit` field on its own entry shape.
- The free-form kind field. The schema validates against the
  enum; legacy entries with unknown kinds render as `note` on
  read but the underlying value is preserved for grep-ability.

### 4.3 Always-on tier as computed, not chosen

This is the structural change with the highest behavioral impact.
Today, the agent decides `core: true` and rendering honors it.
Tomorrow, the render layer **computes** which entries are
always-on, using objective criteria:

```
is_always_on(entry) :=
  entry.status == "active" AND
  entry.kind IN { "rule", "fact", "gotcha", "pointer" } AND
  (entry.apply != "" OR entry.pin == true) AND
  ageDays(entry) < 90  // or lastReadDays < 90
```

The agent CAN set `pin: true` to force always-on for an entry
that doesn't have an `apply` line — but `pin` requires a
`pin_reason` field (single sentence), and `pin: true` itself ages:
after 30 days, the renderer emits a "pinned entries that haven't
been touched in a month — still load-bearing?" prompt at session
start, which the agent can resolve by re-pinning or fading.

**Budget:** ~6 KB always-on (down from the current 10 KB core + 8
KB active = 18 KB target). The Cowan-4-chunks principle (input #1
§3) argues that a smaller always-on tier is actually higher-signal
than a larger one; once the agent is reading >4 KB of pinned rules
per turn, attention dilutes.

When the always-on set exceeds 6 KB, the renderer collapses
oldest-first to one-line summary-only. The full text is one tool
call away (`recall_memory(id)`).

**Why this fixes core inflation:**

- The 48 % core-rate today reflects an agent decision that has no
  cost; everyone marks core. Computed-core has a cost the agent
  can't avoid: the entry has to have an `apply` line, which is
  itself a quality forcing function.
- The 77 % core-rate on `handoff` goes to zero — handoffs are
  inherently TTL'd targeted messages, not durable rules.
- The well-calibrated personas (docwarden, archivedrake) keep
  doing what they were doing; the poorly-calibrated personas
  (Slacksmith at 100 % core, crownmagpie at 74 %) get cleaned up
  on first migration sweep.

**Migration:** existing `core: true` entries get a one-time
migration. If they have a `apply`-like structure inferable from
the body, they keep their always-on status. If not, they drop to
the searchable depth with a marker (`legacy_core_demoted: true`).
Agents on next touch can re-pin or accept the demotion.

### 4.4 The save layer — triggers, validation, naming

**Enumerated triggers in CLAUDE.md.** The user's existing "auto
memory" section is the right shape; the redesign tightens it. The
trigger list (from input #2 §1.1, refined against input #3's
observed good patterns):

Save a **`rule`** when:
- The user uses imperative + universal ("always", "never", "from
  now on", "don't", "stop doing")
- The user corrects a stated belief and the correction is
  applicable beyond this task
- The user states a preference under disagreement, with rationale

Save a **`fact`** when:
- An agent grepped or fetched to learn something it'll need
  again — file path, port, API contract, tool inventory
- The user states a project invariant ("we use bun", "the canonical
  port is 4567")

Save a **`gotcha`** when:
- A tool call returned a surprising result the agent had to
  understand and act on
- A workaround was needed because something didn't work the way
  it should

Save a **`pointer`** when:
- The agent located a doc or section that other agents will need
- A skill or external resource is the right answer for a recurring
  question

Save a **`handoff`** when:
- Targeting a specific named persona with a short relay (≤500 B body)

Save a **`note`** when:
- Anything else worth jotting down. Status. Mid-session observation.
  "I tried X, it didn't work." These will fade.

**Removal test** (input #2 §1.2): if a future agent encountered the
same situation without this entry, would they make the same wrong
call? If yes, save it. If "they'd figure it out from context",
don't.

**Write-time validation.** Mechanical checks the dispatcher enforces:

- `kind` is in the enum. (Legacy values pass through but the
  agent's response includes a one-line "this kind is deprecated;
  on next write please use X".)
- `summary` is not a verbatim prefix of `text`. Reject with
  `summary_is_header`. The summary should distill, not title.
- For `rule`: `apply` field present and non-empty, OR the body
  contains a literal "Apply:" line.
- For `handoff`: `target` field present (recipient persona handle).
- Slug derives from `summary` with a domain prefix:
  `<domain>-<rule-name>` where domain is one of a small set
  (`tests`, `git`, `chat`, `memory`, `lifecycle`, `launcher`,
  `chat-router`, …, plus `misc` as fallback). Auto-infer where
  possible; require an explicit `domain` field when slug
  generation is ambiguous.

**Naming guidelines** (input #2 §2.3, validated against input #3's
good-entry examples like `compare-element-ignoreimages-masks-live-only`):

- Lead with domain: `tests-no-mocked-db`, `git-no-cd-flag`.
- Name by the rule, not the incident: `feedback-no-mocked-db` over
  `q3-incident-postmortem`.
- Verbs survive better than nouns.
- Drop dates from slugs; they live in metadata.

The mechanical enforcement converts these from "good ideas in a
doc" to "the only writes the system accepts."

### 4.5 The discovery layer — index, search, inline links, hook injection

**Index always rendered.** Every entry's slug + summary in a
one-line-per-entry table of contents at session start. Domain-
prefixed slugs auto-cluster:

```
=== INDEX (66 entries) ===
chat/scope-dm-needs-target ── DM requires both scope:dm AND target:handle
chat/router-blip-2026-05-13 ── (note, fades 2026-05-16)
git/no-cd-flag ── never use `git -C <path>` in this env (rule)
lifecycle/applyForceExit-symmetry ── force-exit drops chat presence + leave broadcast (gotcha)
memory/dream-reference-coercion ── REFERENCE_KINDS forget→fade coercion in applier
…
```

The index renders cheap (one line per entry, ~60-80 chars).
Even at 66 entries, the index footprint is ~5 KB. Plus the
always-on tier (~6 KB), the agent boots with ~11 KB of memory
context — well within budget.

**Lexical search wins.** `find_memory("mocked db")` against
slug-prefixed entries returns
`tests-no-mocked-db-prefer-tmpdir-real-driver` deterministically.
No embedding model required. Investing in naming pays back
linearly; investing in semantic search pays back logarithmically
but with a black-box failure mode.

**Inline `[[slug]]` links in body text.** The bottleneck on
cross-linking today is that the agent has to know the auto-
generated id to populate `see_also`. Resolve at render time
instead: an agent writes `see also [[memory-dream-reference-coercion]]`
in prose, the renderer turns it into a clickable / resolvable
reference. No round trip required.

The structured `see_also` field stays for cases where the link is
load-bearing (renderer surfaces neighbors on recall), but the
inline form takes the load off the agent.

**Hook-driven injection.** This is the highest-leverage discovery
mechanism (input #2 §7.3) and pantheon doesn't use it yet:

- **On session start:** inject the index + always-on tier (current
  behavior is roughly this, but the index is implicit).
- **On filename match in tool use:** when the agent reads or edits
  a file matching a domain pattern (`src/memory/*` → memory
  entries), inject the corresponding domain's index slice as a
  system reminder.
- **On `append_memory` tool call:** inject the "good entry shape"
  guide (rule/why/apply triad, slug conventions, summary-not-title
  rule) so the agent doesn't write a bad entry out of inertia.
- **On tool-call failure:** inject `gotcha`-kind entries whose
  summary text overlaps with the failure message.

The Claude Code plugin layer already has hooks for some of this;
the redesign formalizes the memory-driven injections.

**The `recall_memory` description IS the sell.** Today's
description (paraphrased): "Renders memory at startup-prompt shape."
That's a mechanic. The proposed:

> "Retrieves a memory entry by id, returning full text plus any
> linked entries and a 'still load-bearing?' prompt. Call this
> when you suspect a past session has dealt with a similar problem
> — corrections, stated preferences, gotchas, architectural
> decisions, file paths you grepped for last time. Cheap; prefer
> calling unnecessarily over duplicating work. After reading, if
> the entry is stale, follow up with `update_memory` to fix it."

Every clause does work. "Prefer calling unnecessarily over
duplicating work" tilts the default. "Follow up with
`update_memory` to fix it" plants the reconsolidation seed.

### 4.6 The decay layer — daemon-tick fade, recency, reconsolidation

#### 4.6.1 Daemon-tick fade

The 7-day handoff auto-fade today appears gated on persona summon
or a similar event — F2 shows 81 handoffs older than 7 days still
active. The redesign moves fade to a daemon-tick that runs
independently of agent activity:

- A pantheon daemon process (or a CLI cron in absence of one) runs
  every 6 hours and walks every `memory.json` checking:
  - `note`s older than 3 days → fade.
  - `note`s older than 14 days → forget.
  - `handoff`s older than 7 days → fade.
  - `handoff`s older than 30 days → forget.
  - Active entries with `lastReadAt` older than 90 days AND no
    `apply` field → fade with a `lifecycle: stale` marker.
  - `pin: true` entries not touched in 30 days → flag for review
    in the next summon's startup banner.

The daemon writes via the same mtime-guarded mutate-then-rename
pattern (storage/json.ts) so a concurrent persona session doesn't
clobber. Per-entry mutations get an `auto_faded_at` timestamp so
the operation is auditable.

#### 4.6.2 Recency-of-access timestamp

Every read via `recall_memory(id)` updates `lastReadAt`. The 90-
day stale check uses this. The well-calibrated rule that fires
weekly stays warm; the one-off "Phase 5 starting" entry never
gets re-read and decays naturally.

This is the simplest implementation of human memory's
"frequency-based consolidation" (input #1 §8 on language
durability through over-learning).

#### 4.6.3 Reconsolidation on recall

The current `recall_memory` is read-only. The redesign makes it
**a reconsolidation point**:

- Returns the entry's text + a structured prompt fragment:
  *"This entry was last touched <N> days ago. If the underlying
  claim is still load-bearing, you can ignore this. If it's no
  longer accurate, call `update_memory({ id, text: <new> })` to
  fix it, or `fade_memory({ id })` to retire it."*
- Returns the linked-entry neighborhood (`see_also` + inline
  `[[…]]` resolutions).
- Updates `lastReadAt`.

The point is to convert the silent read-then-skip into a moment
of explicit decision. The agent doesn't have to do anything; the
prompt is a cheap nudge. The cognitive-science analog is the
prediction-error gating on reconsolidation (input #1 §6) —
without an explicit "is this still right?" beat, the trace
just re-strengthens stale.

**The `supersedes` field.** When writing a new rule that overrides
an old one, the new entry names the old: `supersedes:
<old-slug>`. The harness then auto-fades the old. This is the
active form of consolidation — addresses the standing-rule pile
problem (righthand's case in input #3 §B.1) directly.

#### 4.6.4 What about `dream`?

The `dream` tool — pantheon's offline consolidation pass — is
the only working consolidation primitive in the corpus today.
filmstoat's dream pass is the corpus's *only* example of
intentional reconsolidation (input #3 §C.1.G5). Keep it. The
redesign makes it cheaper to invoke and more routine:

- Trigger automatically when active set exceeds budget on summon
  (current behavior is closer to manual invocation).
- Surface the audit trail (currently in `details`) as a normal
  log message in the chat — moves the affordance into the
  agent's view.
- Add a `dream --dry-run` mode for the agent to see proposed
  consolidations before applying.

The dream tool implements the cognitive-science notion of sleep-
dependent systems consolidation (input #1 §7). The redesign
should not over-load it with mystical weight ("creative
recombination", "threat simulation") — those theories are
contested even in cognitive science. The well-grounded thing
dream does is **cluster, consolidate, fade superseded** — and
that's what we want.

### 4.7 The dream pass, evolved

Building on §4.6.4: a routine, low-ceremony consolidation pass.

**When it runs:**

- Automatically on summon when active-set size > budget (today
  this is roughly the trigger; tighten to "always run if any
  superseded link is in the corpus").
- Manually via `dream({ dry_run })` for the agent to inspect.
- On a 7-day cadence per persona via the daemon-tick — even if
  the persona hasn't been summoned in a while.

**What it does:**

- Cluster entries by summary-similarity (lexical, not semantic —
  Levenshtein on slug + summary).
- Propose consolidations for clusters of ≥3 entries. The
  proposed consolidated entry has `see_also` to the originals.
- Fade entries explicitly superseded via `supersedes:` chain.
- Surface stale `fact`s (entries that name a file/symbol older
  than 30 days) with a "verify before relying on it" tag.
- Run reference-kind coercion (the existing "core can only be
  faded by the librarian at a pass" rule from input #3's dream-
  tuning log).

**What it doesn't do:**

- Doesn't rewrite entry bodies in place (preserve provenance).
- Doesn't delete forgotten entries (tombstone forever).
- Doesn't make creative connections — that's a step beyond the
  well-grounded science.

### 4.8 Project vs. personal vs. notebook

**Personal memory** stays as the persona-scoped surface today.
This is unambiguously useful and doesn't need re-shaping beyond
§4.1–§4.7.

**Project memory** has one entry total in the corpus (input #3
§C.7). Two paths forward:

- **Path A — restate the surface and prompt for use.** Add to
  CLAUDE.md a section "When does a memory belong on the project
  surface?" with concrete triggers ("when the rule applies to any
  agent working on this project, regardless of persona"). Tools'
  descriptions surface this on call.

- **Path B — fold project memory into a tag on personal memory.**
  Drop the separate surface. Add a `scope: "personal" | "project"`
  field on every entry. Cross-persona render queries the project-
  scoped entries from all personas.

Path A preserves the current shape. Path B is more invasive but
addresses the "agents don't reach for the project surface because
their work is naturally persona-scoped" finding. **My
recommendation: Path A.** Path B is a substantial schema change
for a problem (one entry total) that may resolve itself once the
CLAUDE.md guidance is sharper. Re-evaluate after 30 days.

**Notebook surface.** Zero adoption (input #3 §C.8). 15 tools, 21
KB plan doc, 60-line handler module — all unused. **Deprecate.**

Concretely:
- Remove the 15 notebook tools from `tools.ts` (the dispatcher
  rejects unknown calls, so removal is safe).
- Move `src/mcp/handlers/notebook.ts` to `src/mcp/handlers/notebook.deprecated.ts`
  for one release, then delete.
- Remove notebook references from CLAUDE.md and the bootstrap
  response.
- Preserve the storage paths (`<root>/personas/<h>/notebook.json`
  layout) on disk in case future need arises, but the surface
  isn't exposed.

The 21 KB plan doc gets a "(deprecated; see docs/memory-redesign/
4-proposal.md §4.8)" header and stays as a historical record.

**Why deprecate rather than fix discoverability?** Two reasons:

1. The redesigned memory surface already covers the "I want to
   write more than 240 chars" use case via `text` (mean 3 KB,
   max 16 KB) and the `apply` field. The notebook was meant as
   a "longer than memory" tier but memory bodies are not
   length-constrained in practice.
2. Adding discoverability hooks for an unused surface, while not
   adding them for the actually-used surfaces, would be the
   wrong investment. The principle from input #2 §7.3 — JIT
   injection — should land on the surface people use.

If a real "longer-form per-topic markdown surface" need re-
emerges later, it can come back. For now, kill the dead branch.

---

## 5. How agents are instructed

The redesign lands by **changing the prompts and the tool
descriptions**, not by re-educating agents through chat. Three
concrete artifacts get rewritten:

### 5.1 The global CLAUDE.md "auto memory" section

Today's "auto memory" section (in `~/.claude/CLAUDE.md`) is
adjective-driven ("save important things you learn"). The
redesigned version is **trigger-driven**:

```markdown
## Auto memory

You have a persistent memory system via mcp__pantheon__*.

### When to save

Save a **rule** (`append_memory({ kind: "rule", apply: "<trigger>" })`)
when the user:
  - uses "always", "never", "from now on", "don't ever"
  - corrects a belief you stated, with a reason
  - states a preference under disagreement, with a why

Save a **fact** when you:
  - grep/fetch something you'll need again (paths, ports, contracts)
  - learn an invariant about the project ("we use bun", "tests live in __tests__/")

Save a **gotcha** when:
  - a tool call surprised you
  - a workaround was needed because something didn't work as expected

Save a **note** (default; cheap) when:
  - you want to jot something down but aren't sure it's durable
  - mid-task scratch
  - "I tried X, didn't work" observations
  Notes fade in 3 days. Use this generously.

### When NOT to save

  - status updates ("I'm working on X") — use chat, not memory
  - the incident, when the rule is what's portable — name the rule
  - duplicate facts — if `find_memory(...)` returns a hit, prefer
    `update_memory` to fix the existing entry

### Naming

  - slug starts with a domain prefix: tests-, git-, chat-, memory-, lifecycle-, …
  - name by the rule, not the incident
  - verbs over nouns; no dates in the slug

### When to read

Call `recall_memory` or `find_memory` when you suspect:
  - a past session has solved a similar problem
  - the user is referencing prior decisions
  - you're about to make a non-obvious choice (preferences may exist)
  Prefer calling unnecessarily over duplicating work.

### Reconsolidation

After reading an entry, ask: is this still load-bearing?
  - If the underlying claim is still true, do nothing.
  - If the claim is stale, `update_memory({ id, text: <new> })`.
  - If the claim no longer applies, `fade_memory({ id })`.
```

This replaces the current "Types of memory" section and the
verbose narrative around it. The trigger list is the spine; the
rest of the section can be ~⅓ the current length.

### 5.2 Per-tool descriptions

The tool descriptions are part of the system prompt; their prose
is prompt-engineering surface. Three tools need the heavy-lift
rewrites:

**`append_memory`:**

> Save a memory entry. **Default `kind: "note"` — these fade in
> 3 days, use generously for any scratch observation.** Durable
> kinds (`rule`, `fact`, `gotcha`, `pointer`, `handoff`) require
> an `apply` field (rule/fact/pointer) or a `target` field
> (handoff). Always-on inclusion is computed from kind + structure,
> not chosen — don't pass `core` or `pin` unless you've read the
> redesign doc and are sure.

**`recall_memory`:**

> Retrieve a memory entry by id, with full text + linked entries.
> Call this when you suspect a past session has solved a similar
> problem. Cheap; prefer calling unnecessarily over duplicating
> work. The response includes a "still load-bearing?" prompt —
> if the entry is stale, follow up with `update_memory` or
> `fade_memory`.

**`update_memory`:**

> Rewrite an existing memory entry. Use this when an entry's
> underlying claim has changed (file moved, decision reversed,
> rule refined). **This is the right tool when you'd otherwise be
> tempted to write a new entry that "supersedes" an old one** —
> see also the `supersedes:` field on `append_memory` for the
> two-entry alternative.

The remaining tool descriptions get lighter edits but stay close
to today's shape.

### 5.3 The summon response

The bootstrap response from `login` / `manifest` / `claim` already
emits a `resume_summary` with `recent_memory`. The redesigned
version surfaces the **always-on tier + index** as a single
rendered block, with the trigger list above as a system reminder.

A summon banner gains a one-line "memory state" indicator:

```
Memory: 23 always-on (4.8 KB), 41 indexed, 12 fading (5 expire today)
```

The "fading today" count is a cheap cue to scan-and-rescue any
entries the agent wants to refresh.

---

## 6. Migration plan

The migration is **phased and backwards-compatible at every
phase**. No phase requires a hard cutover; each can be deployed
independently and reverted independently.

### Phase 0 — Document (this PR)

- Land `docs/memory-redesign/{1-human, 2-llm-patterns, 3-usage,
  4-proposal}.md` on a branch for review.
- No code changes.

### Phase 1 — Schema additions (backwards-compatible)

- Add fields to the persisted entry shape:
  - `apply: string` (default empty)
  - `pin: boolean` (default false)
  - `pin_reason: string` (default empty)
  - `lastReadAt: ISO-string` (default = `date`)
  - `supersedes: string` (slug, default empty)
  - `expires_at: ISO-string` (default empty)
  - `domain: string` (default inferred from slug prefix)
- Storage writes start including these fields; reads tolerate
  their absence.
- No render-layer changes yet; existing entries keep their
  current rendering.
- New tests pin the on-disk schema.

### Phase 2 — Remove `details`, formalize `notebook` deprecation

- Strip the `details` field from the agent-write API. Storage
  reader still tolerates it. The one existing entry (filmstoat's
  dream_log) gets a one-time read+rewrite to inline `details`
  into `text`.
- Hide notebook tools from `tools.ts` (move to
  `tools.deprecated.ts` until next release).
- Remove notebook references from CLAUDE.md / bootstrap.

### Phase 3 — Write-time validation

- Enforce `kind ∈ enum` (with deprecation pass-through for
  legacy values).
- Enforce `summary ≠ verbatim prefix of text`.
- Enforce `rule.apply ≠ empty`.
- Enforce `handoff.target ≠ empty`.
- Auto-derive `domain` from slug; require explicit `domain` if
  inference is ambiguous.

This is the most likely place to surface bugs (legacy entries
that don't validate). The dispatcher's response on rejection
should be specific: `summary_is_header`, `rule_missing_apply`,
etc., not generic `invalid_args`.

### Phase 4 — Computed core (the structural shift)

- Render layer stops reading `core: true`; instead computes
  `is_always_on(entry)` from kind + apply + pin.
- One-time migration: every existing `core: true` entry gets
  evaluated. Those with inferable `apply` content keep always-on
  status (via auto-populated `apply` field); those without drop
  to searchable depth with a `legacy_core_demoted: true` marker.
- Render budget drops from 10 KB core + 8 KB active to 6 KB
  always-on (single band).
- Phase gate: monitor for "agent says memory feels emptier" — if
  the 6 KB budget is too tight, can raise to 8 KB without further
  code changes.

### Phase 5 — Daemon-tick fade + reconsolidation prompts

- Implement the 6-hour daemon-tick walk over `memory.json` files.
- Wire `lastReadAt` updates on every `recall_memory`.
- Add the "still load-bearing?" prompt to recall responses.
- Add `supersedes:` auto-fade behavior.

### Phase 6 — Two-tier note/durable split

- Make `kind: "note"` the default when `append_memory` is called
  without explicit kind.
- Implement the 3-day / 14-day TTL for notes via daemon-tick.
- Update CLAUDE.md to land the trigger list from §5.1.

### Phase 7 — Hook-driven injection

- Wire the file-match injection hook (in the Claude Code plugin
  layer).
- Wire the `append_memory`-call-trigger injection ("good entry
  shape" guide).
- Wire the tool-failure injection (gotcha-overlap match).

This is the highest-leverage phase but also the most invasive in
the Claude Code plugin. Land last, after the core schema and
validation are stable.

### Phase 8 — Dream pass on cadence

- Wire the 7-day per-persona dream-tick to the daemon.
- Add `dream --dry-run`.
- Surface dream audits in chat rather than `details`.

---

## 7. Open questions and risks

**Q1. Is `note` a kind, or a separate storage path?** The
proposal treats it as a kind in the same `memory.json`. The
alternative — `note.json` as a separate file — is cleaner
conceptually but doubles the storage layer. The kind-in-same-file
approach is simpler; risk is that the file accumulates noise that
makes mtime-guarded writes slower. _Currently leaning kind-in-
same-file. Re-evaluate at Phase 6 if file sizes balloon._

**Q2. What happens to the well-disciplined personas under
computed-core?** Personas like docwarden (16 % core) and
archivedrake (20 % core) are already well-calibrated. The migration
sweep should preserve their always-on tier. Risk: their entries
don't have an `apply` field today; the auto-`apply`-inference may
not catch them. Mitigation: a manual review pass for the top-10
personas before Phase 4 lands.

**Q3. Will agents actually write `apply` lines?** The current
data shows agents under-using the structured fields they have
(`see_also` at 1.4 %). A new required field may be filled in
poorly ("apply: when you read this"). Mitigation: the tool
description and the CLAUDE.md trigger list make `apply` the
center of gravity. If after 60 days the `apply` quality is poor,
consider auto-derivation from body content via a regex.

**Q4. Project memory: Path A (prompt for adoption) vs. Path B
(fold into scope tag)?** Path A is the recommendation; Path B is
the contingency if adoption stays at zero after 30 days.

**Q5. What about the multi-KB session snapshots?** righthand's
15.9 KB pre-compaction handoff and similar entries are arguably
load-bearing (they preserve the continuity of a long session).
Under the proposal, these become `note`s with a 3-day fade — which
correctly retires them after the session has been picked up by
the next incarnation. Risk: if the next incarnation doesn't pick
up within 3 days, the snapshot is lost. Mitigation: the
remanifest helper should also write a `kind: "handoff"` short
relay pointing to the `note`, with a longer 7-day fade. The short
relay survives even if the snapshot fades.

**Q6. Should we keep `summoner_username`?** 96 % of values are
two personas (input #3 §C.10). The field carries useful audit
data but the cardinality is low. Keep it; it's cheap.

**Q7. What about the agents who already store huge bodies (24
entries > 8 KB)?** The 6 KB always-on budget will collapse them
on render anyway. Their full text remains retrievable via
`recall_memory(id)`. The render-time collapse is the right answer;
no schema change needed.

**Q8. Is the dream-tool's mystical positioning a problem?** The
human-memory science (input #1 §7) is honest that dream function
is contested. The pantheon `dream` tool is grounded in the
well-established "offline systems consolidation" half of the
science — not the speculative "threat simulation" half. The
proposal keeps the metaphor but trims any prose that overstates
it. _Action: review existing `dream` docs and trim mystical
claims to match the science._

**R1. Risk: the migration breaks an in-flight agent.** Every
phase has to be deployable without downtime. The mtime-guarded
storage writes already handle this; the validation phase is the
risky one. Mitigation: validate against a copy of the corpus
before deploying; ship validation in warn-only mode for one
release before enforcing.

**R2. Risk: trigger list in CLAUDE.md is too long, gets
truncated or ignored.** The user's CLAUDE.md is already approaching
the size where attention dilutes. Mitigation: cut the existing
"Types of memory" section to fit; the redesigned trigger list is
shorter than what it replaces.

**R3. Risk: agents prefer the old shapes for momentum.** Even
with new conventions, agents may default to the patterns they've
learned from prior sessions (via their own memory). Mitigation:
the bootstrap response surfaces the migration state; the dream
pass on first summon after Phase 6 actively re-shapes the legacy
entries.

**R4. Risk: the daemon-tick is fragile.** If the daemon stops,
fade stops, and we're back to the current state. Mitigation:
the daemon-tick is idempotent — running it twice in a row is
safe. A CLI `pantheon prune` command runs it on demand from
any agent's environment. Belt and suspenders.

---

## 8. Success criteria

How we'll know the redesign is working (input #2 §10 framing):

### 8.1 Quantitative gates (measured 60 days post-Phase 6)

- **`update_memory` calls per persona-week:** baseline today is 0.
  Target: ≥1 per active persona per week. Indicates reconsolida-
  tion is happening.
- **Active-rate per persona:** baseline 87.9 % corpus-wide.
  Target: ≤70 %. Indicates fade is firing.
- **Always-on tier size:** baseline ~12 KB per persona at render
  (core+active). Target: ≤6 KB. Indicates computed-core is doing
  its job.
- **`note`-kind share:** baseline 0 % (kind didn't exist). Target:
  ≥40 % of writes go to `note`. Indicates the cheap-write surface
  is absorbing what used to be journal noise.
- **Cross-link density:** baseline 1.4 % of entries have any
  structured link. Target: ≥15 %. Indicates inline `[[…]]`
  resolution is being used.
- **`summary`-as-header rate:** baseline 27 %. Target: ≤5 %.
  Indicates write-time validation is enforcing distillation.

### 8.2 Qualitative gates

- **Counterfactual test:** for 10 representative sessions in
  60-day window, would the session have gone measurably worse
  without memory? Target: ≥5/10 (input #2 §10.4). Today's
  estimate (based on input #3's qualitative review): ~2-3/10.
- **Stale-fact incidents:** how many times did an agent rely on a
  memory entry that turned out to be wrong about file paths /
  symbol names / protocol versions? Target: ≤1 per persona-month
  (vs. today, where this is happening invisibly).
- **Notebook-shaped writes to memory:** how many entries are
  >5 KB long-form documents? Target: declining. If memory is
  carrying notebook-shaped content, the notebook deprecation
  was wrong and we re-think.

### 8.3 The diagnostic question

> *Of the last 10 sessions a persona was summoned for, how many
> would have gone measurably worse if memory had been disabled?*

If after 60 days the answer is ≥6/10, the redesign worked. If
it's still ≤3/10, something else is wrong and we re-investigate.

---

## 9. What this proposal does not do

For honesty:

- **Does not solve the multi-agent coordination problem.** Project
  memory adoption is left at Path A (prompt for use). The
  "conflicting rules across personas" risk from input #2 §8.2 is
  not addressed in this redesign cycle.
- **Does not introduce semantic search.** Lexical + naming is the
  bet; revisit at 2-3× corpus scale.
- **Does not redesign the chat layer.** Status updates and "I'm
  working on X" go to chat (correct surface) — but the chat
  layer's own affordances for that are untouched.
- **Does not address the `summoner_username` two-value concentration.**
  This is a symptom of the orchestrator topology (Leandro
  summoning via liaison instead of directly), which is a workflow
  choice, not a memory choice.
- **Does not migrate existing entries proactively.** Legacy
  entries are read-tolerant; their migration happens on next
  touch via the dream pass or via natural updates. No forced
  rewrite.

---

## Closing

The redesign is, deliberately, **less ambitious than a re-
architecture**. The existing primitives work; what's broken is
the discipline around them. Phase 0 (this doc) and Phase 1
(schema additions) are reversible. Phase 4 (computed core) is
the structural pivot — the first irreversible-feeling change —
and ships with a fallback (`pin: true` for agents who want the
old explicit-core control).

The single sentence that should survive this whole doc:

> **Forgetting is not a bug; the system should help it happen.**

Everything else — the trigger lists, the `apply` fields, the
daemon-tick — is in service of that.

---

*End of proposal. Awaiting Leandro's redirect.*
