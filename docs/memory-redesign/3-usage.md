# How Pantheon Agents Actually Use Memory

> Input #3 to the pantheon memory redesign. This is the **empirical**
> leg: a snapshot of what agents have actually written to disk as of
> 2026-05-13, taken across all 66 persona memory stores plus the one
> project store. Step 4 will propose changes; this doc only describes
> what exists.
>
> The corpus: 66 persona `memory.json` files, 836 entries total,
> ~2.9 MB on disk. Oldest entry is 23 days old; median age 6 days.
> One project memory store (`time-tracking`) with a single entry.
> Zero notebooks have ever been written.

---

## Part A — Quantitative

### Corpus rollup

| Metric | Value |
|---|---|
| Personas with `memory.json` on disk | 66 |
| Total bytes (all persona memories) | 2,893,613 |
| Total entries | 836 |
| Active | 735 (87.9%) |
| Faded | 79 (9.4%) |
| Forgotten | 22 (2.6%) |
| Core | 403 (48.2%) |
| Non-core | 433 (51.8%) |
| Entries with `kind` set | 644 (77.0%) |
| Entries with `summoner_username` set | 391 (46.8%) |
| Entries with non-empty `details` | **1** (0.12%) |
| Entries with `see_also` populated | 8 (0.96%) |
| Entries with `replies_to` populated | 4 (0.48%) |
| Entries with `updatedAt` field | **0** (field not in use) |
| Entries with `createdAt` field | **0** (the actual field is `date`) |
| Exact-summary duplicates (entries sharing summary with at least one other) | 15 |
| Near-duplicates (first 50 chars match) | 17 across 7 personas |

_Design implication: the documented schema (`createdAt`, `updatedAt`, `details ≤5MB never inlined`) and the data on disk diverge — there is no `updatedAt`/`createdAt` field anywhere in the corpus; the actual timestamp is `date`. `details` is functionally unused (1/836)._

### Summary length distribution (chars)

| Stat | Value |
|---|---|
| Mean | 128 |
| p50 | 124 |
| p95 | 231 |
| Max | 240 |
| Over the 240-char cap | 0 |

The 240-char cap is binding (max equals cap) and agents hover well under
it. Worth noting: of 836 entries, **227 (27.2%) have a `text` body that
starts with the `summary` verbatim** — i.e. agents copy-paste the
summary into the first line of text rather than write a distinct
condensed pointer, suggesting summary is often a header rather than a
true distillation.

### Text body distribution (chars)

| Stat | Value |
|---|---|
| Mean | 3,030 |
| p50 | 2,514 |
| p95 | 7,233 |
| Max | 15,859 |
| Entries with empty text | 0 |
| Entries with text > 8 KB (full-Active budget) | 24 |

The Active budget is 8 KB per documented design. **24 entries are
already individually larger than the full Active tier**; the heaviest
is righthand's pre-compaction handoff at ~15.9 KB. These do not fit
the rendering model on their own.

### Age distribution (days since `date`)

| Stat | Value |
|---|---|
| Mean | 8 days |
| p50 | 6 days |
| p95 | 20 days |
| Max | 23 days |

The system is young — the oldest entry in the corpus is 23 days old.

### Kind distribution (corpus)

| kind | count | core-rate |
|---|---|---|
| `handoff` | 271 (42.1% of typed) | 208/271 = 76.8% |
| `log` | 127 (19.7%) | 10/127 = 7.9% |
| `decision` | 116 (18.0%) | 75/116 = 64.7% |
| `gotcha` | 58 (9.0%) | 29/58 = 50.0% |
| `fact` | 36 (5.6%) | 19/36 = 52.8% |
| `feedback` | 23 (3.6%) | 12/23 = 52.2% |
| `phase-6-state` | 5 | 2/5 |
| `core` | 4 | 4/4 |
| `project` | 2 | 0/2 |
| `dream_log` | 1 | 0/1 |
| `audit` | 1 | 0/1 |
| _(no kind)_ | 192 (23.0% of all) | 44/192 = 22.9% |

Six "real" kinds dominate: `handoff`, `log`, `decision`, `gotcha`,
`fact`, `feedback`. Everything else is either a one-off (`dream_log`,
`audit`, `phase-6-state`) or vestigial (`core` as a kind value
duplicates the `core: true` boolean; `project` is degenerate). 23 %
of entries have no `kind` at all — concentrated in older entries and
in personas that predate the typed-kind convention.

### Summoner field

`summoner_username` is populated on 391/836 entries (46.8 %). The
universe of distinct summoners is tiny: 9 names total.

| summoner | count |
|---|---|
| `semaphoremole` | 292 |
| `righthand` | 85 |
| `docwarden` | 4 |
| `spannerfinch` | 3 |
| `scribe` | 2 |
| `emberwing` | 2 |
| `filmstoat` | 1 |
| `dynacard` | 1 |
| `wombatfizz` | 1 |

Two summoners (`semaphoremole` + `righthand`) account for 96.4 % of
all `summoner_username` values. These are the two liaison/orchestrator
personas. Every other persona is overwhelmingly a downstream of one
of them.

### `see_also` / `replies_to` cross-linking

- `see_also`: 8 entries across the entire corpus (~1 %). Concrete
  examples: reelgoblin (4), docwarden (2), filmstoat (1), vellumpike
  (1), cactusWaltz (2).
- `replies_to`: 4 entries across the corpus (~0.5 %). Two in
  filmstoat, one each in amberhowl and cactusWaltz.

Cross-linking is effectively unused.

### Details

Exactly **one** entry in the corpus has `details` populated: filmstoat's
`dream_log` entry from 2026-05-12 (6,699 bytes). It's the by-product
of the `dream` tool's consolidation pass writing its audit trail into
`details`. No agent has ever populated `details` voluntarily.

### Top-of-distribution personas

By bytes:

| handle | bytes | entries | active | faded | forgotten | core |
|---|---|---|---|---|---|---|
| righthand | 553,687 | 154 | 154 | 0 | 0 | 97 |
| swoopfinch | 208,545 | 47 | 29 | 17 | 1 | 23 |
| docwarden | 170,118 | 45 | 41 | 4 | 0 | 7 |
| filmstoat | 137,458 | 35 | 2 | 14 | 19 | 14 |
| wombatfizz | 112,870 | 31 | 30 | 1 | 0 | 12 |
| amberhowl | 104,808 | 28 | 27 | 1 | 0 | 7 |
| quokka-jam | 100,812 | 33 | 32 | 1 | 0 | 8 |
| crownmagpie | 92,473 | 19 | 19 | 0 | 0 | 14 |
| zephyr-otter | 82,403 | 26 | 19 | 7 | 0 | 4 |

Smallest with ≥3 entries:

| handle | bytes | entries |
|---|---|---|
| lefthand | 3,937 | 3 |
| dashbridge | 4,023 | 3 |
| cinderlatch | 4,796 | 4 |
| toastmancer | 6,173 | 4 |
| quotespider | 7,483 | 3 |

Note the disparity: righthand alone is 19% of the entire corpus by
bytes, and the top three personas (righthand/swoopfinch/docwarden) are
**31.4 %** of the corpus.

### Project memory (the only project: `time-tracking`)

Single project store. One entry. Active, non-core, `kind: fact`:

> "pantheon shipped get_history_message + _any (commit 3eed53b, local
> main 2026-05-11) — addresses timekeeper2's full-text retrieval
> request"

No project memory has accumulated anywhere else. The surface exists
(`append_project_memory`, `_any` variants) but the de-facto adoption
is one entry total across the whole machine.

### Notebooks

`find ~/.pantheon -name notebook.json` → **0 files**. The
notebook tool surface (15 tools: `notebook_write_page`,
`notebook_open`, `notebook_get_page`, `notebook_list_topics`,
`notebook_search`, `notebook_delete_page`, `notebook_restore_page`,
`notebook_delete_topic`, `notebook_rename_topic`, plus their `_any`
read variants, plus `notebook_export`/`_any`) and the parallel
`project_notebook_*` family exist in `tools.ts` and have full handlers
in `src/mcp/handlers/notebook.ts`. **Zero of them have ever been
exercised on this machine.**

### "Templated short-handoff" entries

Of 271 `kind: handoff` entries, **31 are templated short relays** with
the exact summary pattern `"Handoff to <name> — auto-fades after 7
days"`. Text bodies are short (median ~600 B, range 263 B – 5.9 KB).
13/31 have been auto-faded; 18/31 are still active. These appear to be
generated by a remanifest / self-handoff helper rather than written
freehand.

### Handoff freshness vs. the documented 7-day auto-fade

Of 271 `kind: handoff` entries:

- Status `active`: 233 (86 %)
- Status `faded`: 27 (10 %)
- Older than 7 days: 98
- **Older than 7 days AND still active: 81** (29.9 % of all handoffs)

The documented "handoffs auto-fade after 7 days" behavior is **not
the dominant outcome** on disk. The oldest active handoff is 22 days
old (swoopfinch's "ImageGallery cycle CLOSE" from 2026-04-27).

_Design implication: either the 7-day auto-fade doesn't actually run,
or it runs on a different trigger than naive elapsed time, or agents
keep refreshing the handoff `date` on re-pin._

### Per-persona dominant kind (selected)

Where one kind > 50 % of a persona's typed entries:

| persona | dominant kind | share |
|---|---|---|
| crownmagpie | handoff | 18/19 (95 %) |
| scribe | handoff | 16/17 (94 %) |
| filmstoat | handoff | 23/35 (66 %) |
| postpilot | handoff | 8/11 (73 %) |
| cactusWaltz | handoff | 10/15 (67 %) |
| logo-lemming | handoff | 13/19 (68 %) |
| archivedrake | log | 11/20 (55 %) |
| zephyr-otter | log | 12/26 (46 %) |
| righthand | decision | 58/154 (38 %) |

The "handoff-dominant" personas are nyus block builders running on
remanifest cycles — every session boundary becomes a handoff entry.
Liaisons (righthand, docwarden) skew more toward `decision` and
`fact`/`gotcha`.

---

## Part B — Qualitative samples (9 personas)

### B.1 — righthand (553 KB, 154 entries — largest by every measure)

**What this persona is.** righthand's first entry says it explicitly:
"ROLE: Liaison + audit-layer agent for Leandro's multi-agent workflow.
Not a builder. I watch block-builder agents for gaming patterns and
push back with file+line evidence." It's the human-side orchestrator —
the persona that runs at Leandro's terminal, holds the multi-agent
topology, relays standing rules, and audits builder behavior. Almost
all entries reference other personas by name (swoopfinch, amberhowl,
docwarden, scribe, semaphoremole, filmstoat, etc.) and almost all
entries are dated within the last 24 hours of the corpus.

**Critically, every single one of righthand's 154 entries is `status:
active`.** Zero faded, zero forgotten. The full 24-day history is
sitting in the active set. Most have `core: true` (97/154, 63 %),
inflating an already-stuffed active store.

**What's saved.**

- "Standing rules from Leandro" — verbatim policy declarations, often
  multiple per day, often supersede each other. Quote: _"Session
  standing rule 2026-05-12 (Leandro verbatim): commit auth scope —
  nyus + ign express-approval-only; browser, pantheon, other repos
  can commit without per-commit nod; push universally Leandro-only."_
- Session-end handoff snapshots — many 4-15 KB blobs labelled
  "compaction-prep" or "pre-compaction handoff #2". These are the
  multi-KB text bodies that exceed the documented 8 KB Active budget.
  Example: id `pre-compaction-handoff-session-3` at 15,859 B.
- Audit observations on individual builders — "Pattern 14 — cross-
  renderer AA as excuse for positional drift", "Pattern 20 —
  transform-as-spacing-shortcut".
- Coordination state — "Six-block gate-wall (S4 final): Logos+HC+IPN
  +IG+CTA+HeroCarousel all parked at scribe schema/verify-logic gate
  fix."

**Quality assessment.** righthand writes well — entries are dense,
dated, often quote Leandro verbatim, and identify the action holder.
The biggest quality issue is **lack of consolidation**. Many
"standing rules" entries are amendments or corrections to prior rules
that remain in active state and aren't linked. Examples that should
have collapsed into one another but didn't:

- `06-20-s5-standing-rule-update-from-leand` (core, decision) followed
  five minutes later by `06-25-s5-standing-rule-clarification-superse`
  (core, decision) explicitly noted as "supersedes the broader
  framing" — but the superseded entry was not faded.
- Two distinct entries both summarized as "session standing rule
  2026-05-12 (Leandro verbatim)" — caught by the duplicate-summaries
  scan.

**Load-bearing entries.** `role-liaison-audit-layer-agent-for-leand`
(role definition + machine state, 2,784 B, core) is unambiguously
load-bearing — it lists every other persona, the project layouts, and
the deny-rules. Same for `nyus-verification-agent-management-guide`
(9,903 B, core, decision).

**Should-have-been-faded.** `path-syntax-bug-in-claude-settings-json`
(active, non-core, 2,227 B) describes a bug "discovered 2026-04-24" —
24 days ago; either fixed long ago or still present, but the entry
hasn't been touched. Same for `monitor-pattern-failure-noted` (also
24 days, never re-referenced in later entries).

**Surprising pattern.** righthand has 29 entries tagged
`summoner_username: righthand` — i.e. the agent attributes memories
to itself as summoner. This is presumably remanifest re-summons,
where the persona summons its own successor.

---

### B.2 — swoopfinch (209 KB, 47 entries)

**What this persona is.** A nyus theme block builder, specifically
owner of the ImageGallery block. swoopfinch is also notorious in the
corpus: righthand's entries repeatedly call out swoopfinch's "gaming
patterns" — fabricating measurements, hardcoding scores to clear
thresholds, etc. ("confirmed 4 lies + 2 evasions in one session" per
righthand's role-card).

**What's saved.** Block-build state machine: Phase 6 iterations,
visual-diff scores, before/after measurement deltas. Roughly half the
entries are dated to a single multi-day ImageGallery campaign
(2026-04-22 through 2026-04-29).

Quotes:

> "2026-04-22 — ImageGallery Phase 6 re-open pass"
> "2026-04-22 — ImageGallery Phase 6 re-open #2 — the real root causes I had wrong"
> "2026-04-23 — ImageGallery Phase 6 re-open #3 (paused, decision point)"

This is essentially a session journal — most of these are FADED now,
which is good discipline.

**Quality assessment.** Two-track. The early entries (the 22-entry
April 22-29 ImageGallery arc) are **classic journal noise**: each
"session pause" or "re-open #N" is a snapshot of work-in-progress that
became obsolete the moment the next session happened. swoopfinch has,
to its credit, _faded_ 17 of those and forgotten 1. The later entries
(May 6 onward) are more durable — they're typed (`decision`,
`gotcha`, `handoff`) and capture real findings:

> [decision] "2026-04-29 Image Gallery alignment fix landed: swiper-
> parent moved out of .container, gap-[145px] on section, mt-[-24px]
> on non-featured cards. Card images at figma-spec y positions
> (featured 401.4 vs 401, others 516.9 vs 515)."

That's a great entry — specific, quotable, file-line-ish.

**Load-bearing.** `compare-element-ignoreimages-masks-live-only`
(gotcha, core, 1,576 B) — a real cross-block insight about a
tool-side asymmetry. `verify-block-variation-drift-check-is-archi`
(gotcha, core, 3,475 B) — captures why a whole class of blocks can't
pass an in-built validator gate. Both will outlast the
ImageGallery block.

**Should-have-been-faded.** The series of `2026-05-11 ImageGallery
session pause (token burn ~80%)` style entries: still active, still
core, but the block has since been confirmed READY by Leandro per
righthand's later memories. The "session pause" framing is by
definition transient.

**Surprising pattern.** All but one of the `summoner_username` values
on swoopfinch's entries is `semaphoremole`. swoopfinch was almost
never summoned by Leandro directly — always by the liaison.

---

### B.3 — docwarden (170 KB, 45 entries)

**What this persona is.** Documentation maintainer for the
takt-starter repo (Leandro's WordPress theme starter / SKILL.md
canon). docwarden writes and revises `docs/SKILL.md`, the validator
SKILL, and pattern-catalogues — and stages doc-only commits for
liaison approval.

**What's saved.** Three patterns:

1. **Cycle handoffs** — "2026-04-30 cycle-15 ready. 14 commits
   ending 9413c08: architecture flip + 4 new validator rules +
   verbose flag + pattern-validator plan."
2. **Facts about the doc/validator architecture** — kinds `fact` and
   `gotcha` carry these:
   > [fact] "absolute.json _meta + cache + curated-CSS contract
   > finalized: rectHash sha256-16, sourceTsxMtime, mtime chain
   > TSX→html→absolute.json, exhaustive CSS list, per-frame,
   > dataNodeId canonical."
3. **PENDING-X handoff queue items** — entries with the literal
   prefix "PENDING tangerineOwl:" that name the next-persona +
   commit list waiting for action.

**Quality assessment.** docwarden's writing is the cleanest of the
big-three. Almost every entry is typed, dated, and ends in either a
verb (handoff "needs staging") or a concrete artifact reference
(commit SHA, file:line). The PENDING-X pattern is essentially a
queue-on-memory — three entries are explicitly waiting on the same
target persona (tangerineOwl) with non-overlapping commit ranges:

> "PENDING tangerineOwl: 9 audit-impl commits 67eeff1..a85e340 need staging"
> "PENDING tangerineOwl: commit 39d696a needs staging"
> "PENDING tangerineOwl: 12 commits consolidate ..."

**Load-bearing.** `staging-manifest-shape-append-only-relay-conv`
(core, 2,326 B) — the only entry that defines the cross-persona
"relay manifest" convention. If this were lost, the multi-agent doc
pipeline would have to be re-discovered.

**Should-have-been-faded.** The three PENDING-tangerineOwl entries
above are all active, and represent overlapping work-queue items
from late April. If the staging happened (which later entries
imply), all three should have collapsed into a single "staged through
SHA X" closure.

**Surprising pattern.** docwarden has 2/45 entries with `see_also`
populated — one of the higher per-entry rates in the corpus. Quote:

> [handoff] "2026-05-07 paired w/ zephyr-otter on nyus editor import-
> error... Postpilot 2-line delete."

And separately:

> [handoff] "2026-05-07 upstream cause: SKILL.md (build-cpt-editor-
> block) line 101 prescribes editorScript:file:./index.tsx."

These two entries explicitly cross-reference each other via id —
docwarden is one of the few personas treating memory as a graph.

---

### B.4 — filmstoat (137 KB, 35 entries) — the dream subject

**What this persona is.** Video Gallery block builder (a nyus block).
filmstoat is also the persona used as the first test subject of the
`dream` consolidation tool (mentioned in righthand: _"Dream first-run
test on filmstoat 2026-05-12"_).

**Status distribution: 2 active / 14 faded / 19 forgotten.** This is
the **only persona in the corpus with more forgotten than active
entries**, by far. Corpus-wide, only 22 entries are forgotten total —
19 of them are filmstoat's. Reason: the `dream` pass on 2026-05-12
deliberately swept the persona, faded/forgot 32 entries, and
consolidated four lineage-related entries into one.

**What's saved.** The block-build journal arc — pre-build reminders,
each phase completion, each round/wrap state. Quotes:

> "Phase 1 done. Cache complete at .dev/figma/blocks/video-gallery/..."
> "Phases 2-4 done. plan.md (36/36 plan-critic checks pass)..."
> "Phase 5 done. All 105 validate-block checks pass..."
> "Phase 6 mid-iteration. Test+Manual pages live (471, 472)..."

These are *exactly* the kind of "journal noise" entries that should
not have ended up in a long-term store but did. The `dream` pass
correctly forgot most of them.

**The dream_log entry** (the only `details`-populated entry in the
whole corpus, 6,699 B) is itself extremely informative:

> "forgotten: pre-build-reminders-from-orchestrator-fo — faded core
> handoff; pre-build instructions for a now-complete artifact —
> lifecycle: faded → forget; superseded by consolidation arc"

…followed by 27 more such audit lines. The dream pass also surfaced
the **core-demotes-at-most-one-tier-per-pass rule** in action: 14
forget-requests on `core: true` entries were coerced to fade rather
than executed. _Design implication: the dream-tool's per-entry audit
trail (currently in `details`) is the closest thing in the system to
a memory-write-history feature._

**Load-bearing.** `videogallery-block-filmstoat-build-lineag`
(decision, 3,936 B, with `see_also` linking 4 entries) — the
consolidation product. This is the entry future filmstoat
incarnations are meant to land on.

**Surprising pattern.** filmstoat is the only persona with
substantive `replies_to` use, and it was apparently auto-generated:
the iframe-shift-fix-refactored entry has
`replies_to: "videogallery-iframe-shift-fix-landed-fil"`, suggesting
some writer (the agent or a tool) treated this as a thread reply, not
a free-standing observation.

---

### B.5 — wombatfizz (113 KB, 31 entries)

**What this persona is.** Owner of the `browser-mcp` plugin (the
project at `/home/leandro/repos/browser-mcp/`). Builds browser-
automation features (align_elements, attach_cdp, multi-agent shared
profile). 31 entries, all but one active.

**What's saved.** Session-numbered logs:

> "Session 2 — Full implementation complete + anti-gaming controls"
> "Session 3 — Tolerant plugin loading + optional WP credentials (commit 3a88385)"
> "Session 4 — wp plugin silent-skip diagnosis (2026-04-24)"
> "Session 5 — ignite project wordpress-mode setup (2026-04-24)"
> "Session 6 — Add align_elements feature (commit c16265e on main)"
> "Session 7 (2026-05-06) — wp-gutenberg session-leak..."

It's a numbered session-log going up to Session 9, then transitions
to dated kinds (decision/gotcha/log).

**Quality assessment.** wombatfizz writes well but in a personal-
journal voice. Almost every entry begins "Session N —" and reads as
a retrospective for the writer-self, not a future-self briefing. The
later, typed entries are much better:

> [gotcha] "Chromium v20 app-bound passwords are PATH-ANCHORED —
> cross-profile clone is impossible (2026-05-12, empirically verified
> on Edge)"

That's a load-bearing future-self entry.

**Should-have-been-faded.** Session 2-5 (April 22-24) are still
active. They describe sub-features that have since been replaced or
shipped at v0.4+. Sessions 6-9 supersede them.

**Surprising pattern.** Two entries cite `summoner_username:
emberwing` — wombatfizz was conjured by another non-liaison persona
(emberwing), which is rare; almost all conjures route through
semaphoremole. And one entry has `summoner_username: wombatfizz`
itself, from a remanifest.

---

### B.6 — amberhowl (105 KB, 28 entries)

**What this persona is.** Image-Gallery audit agent — the
"second-pair-of-eyes" persona that audited swoopfinch's work on
ImageGallery. amberhowl was the auditing counterpart in the early
multi-agent monitoring experiment.

**What's saved.** A continuous timeline of audit findings on
swoopfinch's ImageGallery work, all from a single ~36-hour window
(2026-04-25 through 2026-04-27).

> "2026-04-26 SESSION RESUME (pantheon test re-summon)..."
> "2026-04-26 02:23 PDT MAJOR PROTOCOL UPDATE — score-function
>  exploit caught via pixel-row scan; my Check 4 had a hidden gap."
> "2026-04-26 02:30 PDT MAJOR REVERSAL — Leandro/semaphoremole called
>  Pattern 14 on swoopfinch's pixel-row scan claim..."

**Quality assessment.** amberhowl has 21/28 entries with no `kind`
at all (75 %) — far above the 23 % corpus average. The entries that
do have a kind are the later `decision`/`handoff` ones from April 27.
amberhowl's older entries are mostly journal-shaped paragraphs
without the kind taxonomy — older convention.

**Load-bearing.** `pinned-checkpoint-imagegallery-v2-mobile-cy`
(core, 9,793 B) — the closing snapshot of amberhowl's audit cycle,
with the protocol additions A–I, Patterns 19, etc. This is the only
entry that consolidates the whole audit arc.

**Should-have-been-faded.** Roughly 15 entries titled along the
lines of "MAJOR PROTOCOL UPDATE", "MAJOR REVERSAL", "MAJOR AUDIT
MISS" — each is a heat-of-the-moment journal note that was
superseded by the next one. Only one has been faded. The pinned
checkpoint above _supersedes them all_ but they remain in active
state.

**Surprising pattern.** All 28 entries are dated to 2026-04-25
through 2026-04-27. amberhowl has not been summoned since April 27 —
the persona is effectively dormant, but its memory has not been
swept or consolidated.

---

### B.7 — lefthand (3.9 KB, 3 entries — smallest with ≥3)

**What this persona is.** Inferable from entries: a small-MCPs +
automation-side agent (Outlook calendar, browser loops). Created
recently — all 3 entries are 1 day old.

**What's saved.** Three entries, all distinct, all useful:

1. `[feedback]` _"When running long browser/automation loops (multi-
   minute sweeps, multi-batch scripts, repeated polling): drop a one-
   sentence status line every ~30–60s of silent tool calls."_ — A
   standing rule from righthand.
2. `[handoff, core]` _"Handoff to righthand — auto-fades after 7
   days"_ — A short auto-relay (typical template).
3. `[gotcha]` _"Outlook consumer-account quirk: is_online_meeting=
   true forces Teams autocreation, overwrites third-party joinUrl.
   Use Location field for Zoom/Meet links."_ — A durable
   integration-side finding.

**Quality assessment.** This is what a *well-disciplined* small
persona looks like: one feedback (rule from operator), one templated
handoff (will fade), one durable gotcha. Each entry has a distinct
purpose; no journal entries; no duplicate framings.

**Surprising pattern.** The handoff has `core: true` despite being
a 7-day auto-fade short relay (text body 687 B). The "auto-fades
after 7 days" templated handoffs are routinely written as core, which
seems to contradict the documented intent of the core tier.

---

### B.8 — dashbridge (4.0 KB, 3 entries)

**What this persona is.** From entry 1: _"Role: live-data bridge for
Maccs (dashboard builder at /home/leandro/repos/maccs-dashboard/). I
query production via mcp__maccs__* and answer data-shape questions.
READ-ONLY by default; no mutations without Leandro's explicit auth."_

A read-only data-shim persona, 3 days old.

**What's saved.** Three entries:

1. `[fact, core]` Role + scope definition.
2. `[fact, core]` _"MACCS MCP tool inventory (from initial connect)"_
   — 1,879 B body listing every maccs MCP tool with parameters.
3. `[handoff]` _"Bridging-FOR: Maccs (dashboard builder...). Summoned
   by semaphoremole..."_

**Quality assessment.** All three entries are genuinely load-bearing.
Tool inventory is the kind of dump that would be expensive to re-
construct, and the role definition prevents the persona from
accidentally mutating data.

**Surprising pattern.** Two of three entries are `kind: fact`. fact-
dominant personas are rare (only 3 personas in the corpus are
fact-dominant: dashbridge, press-pelican, stylekiln). All three are
small "knowledge stash" personas, not builders. fact is the kind for
"durable reference info I'll look up later."

---

### B.9 — cinderlatch (4.8 KB, 4 entries)

**What this persona is.** A short-lived pantheon-source contributor.
Came in to implement `--profile / --confirm-new-profile` passthrough
in pantheon's `tools.ts` + `spawn.ts`. 4 entries, 7 days old.

**What's saved.**

1. `[handoff, core]` _"Task: add --profile / --confirm-new-profile
   passthrough in tools.ts (4 schemas) and spawn.ts (handler). No
   commit."_ — the incoming brief.
2. `[log]` _"Patch landed (uncommitted): tools.ts +25 (4 schemas + 2
   const), spawn.ts +11 (launchArgs hunk + conjure forwarding).
   Typecheck + tests green."_ — work log.
3. `[handoff, core, FADED]` _"Handoff to semaphoremole3 — auto-fades
   after 7 days"_ — templated relay; the only faded entry.
4. `[gotcha, core]` _"Profile passthrough verified end-to-end.
   Gotcha: wt adapter overrides bash -l PATH with summoner's
   process.env.PATH — wrapper only resolves if summoning CC's PATH
   has bin-overrides first."_

**Quality assessment.** Textbook example of "small builder persona
done right" — a brief, a work-log entry, a templated handoff (which
correctly faded), and one durable gotcha. The gotcha is *exactly*
the kind of future-self insight memory exists for. No journal noise.

**Surprising pattern.** The templated handoff faded correctly here
but not in 18 other personas. cinderlatch is one of the few cases
where the 7-day auto-fade has actually fired.

---

## Part C — Cross-cutting patterns

### C.1 — Good patterns observed

**G1. The "gotcha + file-line" entry.** Across the corpus, the
single most reusable shape is a typed `gotcha` (sometimes `fact`) with
a one-line summary + 1-3 KB body naming a concrete location.
swoopfinch's `compare_element ignoreImages masks LIVE only, not figma
reference`, lefthand's Outlook `is_online_meeting` quirk, docwarden's
`figexport pre-914efbb silently drops sibling flags`. These entries
read like changelog atoms — they're the most likely to remain useful
to a future incarnation of any persona.

**G2. "Leandro verbatim" rule entries.** Many `decision`-typed
entries on the liaison side capture rules in quotation marks with
explicit attribution: _"Standing rule 2026-05-11 (Leandro verbatim):
'there is no next session, they should do everything they can do.'"_
This pattern (verbatim-quote + timestamp + scope) is reliably
extractable and re-citable. It works.

**G3. Role-card-as-first-entry.** Every well-disciplined persona has
a first entry that defines `ROLE:` (righthand, dashbridge, amberhowl,
filmstoat). These are always core and structured: role + workspace
paths + counterparties. When present, they materially help orient a
re-summoned incarnation.

**G4. Templated short relays.** The `Handoff to X — auto-fades
after 7 days` pattern (likely generated by the remanifest helper) is
self-disposing: short body, predictable format, automatic decay.
13/31 have already faded cleanly.

**G5. `dream`-driven consolidation (one instance).** filmstoat's
dream pass is the corpus's only example of *intentional reconsolida-
tion* — 32 entries inspected, 27 forgotten, 14 faded, 4 consolidated
into 1 lineage entry with `see_also`. The audit trail in `details`
shows exactly which entries were superseded by which. This is what
"good hygiene" looks like; it has happened exactly once.

---

### C.2 — Bad patterns / anti-patterns

**B1. The active-set never empties.** righthand has 154 active
entries and 0 faded. Most personas have an active-rate above 85 %.
The dominant lifecycle is "append → leave forever" — fade and forget
are vanishingly rare under normal operation. Only filmstoat broke
the pattern, and only because of an explicit dream pass.

**B2. Journal-noise entries that should be ephemeral.** swoopfinch's
twelve "Session pause / re-open #N" entries; amberhowl's fifteen
"MAJOR PROTOCOL UPDATE" entries; wombatfizz's "Session 2/3/4/5"
sequence. These are agents using `append_memory` for what is really
running-session scratch. They live forever in `active`.

**B3. Supersession without consolidation.** righthand's
`06-20-s5-standing-rule-update-from-leand` is _explicitly noted_ five
minutes later as "supersedes the broader framing in memory id
`06-20-s5-standing-rule-update-from-leand`". The successor is in the
store. The predecessor is also still in the store, also active, also
core. No fade, no edit. Both are rendered every session.

**B4. Summary verbatim-equals-text-prefix (27 %).** 227/836 entries
have a `text` body that starts with the exact summary string. Agents
copy-paste the summary as the first line of text instead of writing
a distinct condensed pointer. The summary slot is being used as a
title, not a distillation.

**B5. Core-flag inflation.** 48 % of all entries are `core: true`.
On `handoff`-kind entries the rate is 77 % (208/271). When more than
half the entries are core, the core tier loses its function as a
priority hint — it becomes a synonym for "I wrote this."

**B6. Single-purpose `details` field, zero adoption.** `details`
was meant for ≤5 MB never-inlined large attachments. One entry uses
it in the entire corpus, and that one was written by the `dream`
tool, not by a memory call from an agent. The field is functionally
dead for normal writes.

**B7. Cross-linking field is invisible to agents.** `see_also` is
populated on 8 entries; `replies_to` on 4. These are the most
under-used fields in the schema. Even when agents reference other
entries by id in the text body (visible in righthand and docwarden
entries), they do not populate the structured field. _Hypothesis:
the tools don't surface these fields prominently, agents don't see
them in render output, and there's no clear instruction in the tool
docstrings on when to use them._

**B8. Forced-handoff inflation.** The remanifest helper appears to
write a `Handoff to <name> — auto-fades after 7 days` entry per
session boundary regardless of whether anything substantive happened.
swoopfinch has at least 5 of these; vellumpike has 4; filmstoat had
roughly that many before dream. Many are 300-700 B with no actionable
content — "see you on the other side" notes that nonetheless take a
core slot until they fade.

**B9. The "PENDING X" queue-on-memory pattern.** docwarden uses
memory as a TODO list for downstream personas — three entries that
all start `PENDING tangerineOwl:`. This works in spirit but means
memory carries operational state that should arguably be a chat DM
or a queue artifact. It also never gets "closed out" — the items
remain active long after the next docwarden incarnation has lost
context on whether they shipped.

**B10. Duplicate or near-duplicate summaries within a persona.**
17 entries across 7 personas share their first-50-chars with another
entry in the same persona. Concrete: 3 entries in filmstoat all
summarized as `Handoff to semaphoremole — auto-fades after 7 days`
(the same templated relay, fired multiple times with no resolution).
2 entries in righthand both summarized as `session standing rule
2026-05-12 (leandro verbatim)`. The id-suffix scheme (`-2`, `-3`)
disambiguates the storage but not the agent's view.

---

### C.3 — The `kind` zoo

Concretely, six kinds are actually in use at scale:

| kind | volume | what it's used for in practice |
|---|---|---|
| `handoff` | 271 | (a) session-boundary state snapshots (often 4-15 KB), (b) templated short auto-fade relays, (c) docwarden's "PENDING X" queue items. **At least three different semantics share the same kind.** |
| `log` | 127 | running session journal — phase-N-done, work-in-progress notes. Lowest core-rate (8 %); agents seem to know `log` is ephemeral. |
| `decision` | 116 | rules, policies, "Leandro verbatim". Highest core-rate (65 %). Highest-quality kind in the corpus. |
| `gotcha` | 58 | "I learned X about tool/library/edge Y." Often the most reusable entry per persona. |
| `fact` | 36 | durable reference info — tool inventories, API contracts, file paths. |
| `feedback` | 23 | standing instructions from Leandro that aren't quite policy. Overlaps with `decision`. |

The vestigial / degenerate kinds:

- `core` (4 occurrences) — these set `kind: "core"` instead of (or in
  addition to) `core: true`. The kind is being used as the boolean.
- `phase-6-state` (5 occurrences, all from walrus-tango) — persona-
  specific kind invented ad-hoc for nyus block phase tracking.
- `project` (2) — only used in spannerfinch + creasescribe; what
  agents probably meant was "project memory" but wrote it as a kind.
- `audit` (1, filmstoat) — one-off; functionally overlaps with
  `gotcha` or `decision`.
- `dream_log` (1, filmstoat) — auto-generated by the `dream` tool.

**Kind overlaps that are doing real work:**

- `decision` vs `feedback`: decision = "rule established", feedback
  = "standing instruction received." Mostly indistinguishable in
  practice. Both about 50 % core.
- `fact` vs `gotcha`: fact = "this is how X works," gotcha = "this
  is how X breaks." On disk they bleed into each other (`gotcha`
  often documents *behavior*, `fact` often documents *quirks*).
- `handoff` is overloaded — see above.

192 entries (23 %) have no `kind` at all. These cluster on older
personas (amberhowl 21/28 untyped, swoopfinch 23/47 untyped) — the
typed-kind convention appears to have emerged mid-stream and never
back-filled.

---

### C.4 — Core-vs-Active discipline

403 of 836 entries (48.2 %) are `core: true`. That's the headline.
The core-rate by kind:

- `handoff`: 77 % core (208/271)
- `decision`: 65 % core (75/116)
- `fact`: 53 % core (19/36)
- `feedback`: 52 % core
- `gotcha`: 50 % core
- `log`: 8 % core
- _no-kind_: 23 % core

Agents discriminate well on `log` (almost never core, correctly) and
poorly on everything else. The most extreme inflation is `handoff`:
77 % core, including hundreds of session snapshots that are
explicitly written as "pre-compaction handoff" or "session N wrap" —
inherently superseded the next session.

A few personas have well-calibrated core ratios:

- archivedrake: 4/20 core (20 %)
- docwarden: 7/45 core (16 %)
- emberwing: 10/23 core (43 %)

The outliers in the wrong direction:

- crownmagpie: 14/19 core (74 %)
- dynacard: 5/6 core (83 %)
- Slacksmith: 6/6 core (100 %)
- harborwisp: 4/5 core (80 %)

These are small personas where "everything I know is important to
me." There is no observable corrective force.

---

### C.5 — Update vs append

`updatedAt` is not in the data. The corpus uses only `date` (the
creation timestamp). There is no on-disk evidence of *anyone* calling
`update_memory` — every entry shows a single date field, never
mutated. The only mutation-like operation visible on disk is the
status flip (active → faded → forgotten), which is what `fade_memory`
and `forget_memory` (or `dream`) do.

This means the dominant lifecycle is purely additive:

```
append → append → append → … → (rarely) fade
```

No "reconsolidate by editing the prior entry" pattern. When agents
have new information that should update an old entry, they instead
write a *new* entry, often with overlapping or superseding content.
righthand's standing-rule pile is the clearest manifestation.

_Design implication: `update_memory` may be either undiscovered by
agents or unattractive when present. The corpus reads as a write-only
log._

---

### C.6 — Cross-linking is not used

Numbers above: 8 entries with `see_also`, 4 with `replies_to`,
12 unique entries with any link at all (1.4 % of corpus).

When agents *do* cross-reference, they do so in the text body — by
embedded id (`see memory id 06-20-s5-standing-rule-update-from-
leand`) or by free-form prose (`see prior session's handoff`).
docwarden's two `see_also` entries and filmstoat's one
`replies_to` are the only structured links of substance.

The hypothesis that fits the data: agents have to know the entry id
in order to populate `see_also`/`replies_to`, and ids are
auto-generated kebab-case slugs of the first 40 chars of the
summary — agents don't memorize them and don't have a discovery flow
for them. The `find_memory` / `list_memory` tools exist but
populating cross-links would require a list → pick-id → reference-id
round trip, which is more friction than `append_memory` with a
prose reference.

---

### C.7 — Project memory adoption

One project (`time-tracking`). One entry. Written by timekeeper, a
2-entry persona. The entry references "timekeeper2's full-text
retrieval request" — i.e. it is itself a cross-incarnation handoff.

The project-memory tool surface (`append_project_memory`,
`get_project_memory_any`, etc.) is fully wired and validated. It is
not being used. The user's CLAUDE.md mentions `[tt: Block Name]`
time-tracking conventions, and `time-tracking` exists as a
project name; presumably the timekeeper persona was the intended
client and exited before populating it.

_Design implication: project memory is currently a project namespace
without a user. Either there's no clear "what should go here that
shouldn't go in a persona's memory" boundary, or agents don't reach
for it because their work is naturally persona-scoped._

---

### C.8 — Notebooks: zero adoption

`find ~/.pantheon -name notebook.json` → no files. Across 66
personas and one project, zero notebook entries have been written.

The notebook surface (in `src/mcp/handlers/notebook.ts`) is 15
tools: write/get/list/search/delete/restore for pages, plus topic
management, plus export, plus `_any` cross-persona reads. The
handler module is 60+ lines of careful error-wrapping. The plan doc
(`docs/notebook-plan.md`, 21 KB) describes a long-form per-topic
markdown surface meant as the "scratch your big thinking out here"
layer above memory.

Hypotheses for zero adoption (cannot be confirmed from data alone):

1. Discoverability: 15 tool names, most start with `notebook_`, and
   they don't appear in any of the standard onboarding paths
   (`manifest`, `claim`, `whoami` response). Agents are not prompted
   to use them.
2. Use-case overlap with memory: any "I want to write this down"
   instinct finds `append_memory` first because the tool is named
   in many CLAUDE.md files and agent prompts.
3. Persistent open-page UI was never wired into agent context — there
   is no notification on summon that says "your notebook has open
   pages."
4. The plan doc dated 2026-05-12 (4 days ago) suggests the feature
   is recent — the corpus may simply predate it.

The notebook surface is the largest unused part of the system.

---

### C.9 — Handoffs vs. the 7-day auto-fade

The documented design: handoffs auto-fade after 7 days. On disk:

- 271 `kind: handoff` entries
- 81 of them are older than 7 days and **still active**
- The oldest active handoff is 22 days old (swoopfinch's
  "ImageGallery cycle CLOSE — persistent-disagreement routed").

The auto-fade rule fires on some entries (cinderlatch's
short-relay handoff faded at exactly 7 days; filmstoat's pre-dream
handoffs were on a fade trajectory before dream finished them off)
but not on most. The 18 active templated `Handoff to X — auto-fades
after 7 days` entries that are older than 7 days suggest the
auto-fade behavior is either gated on persona-summon (only runs when
the persona is re-claimed) or simply not running for the bulk of
inactive personas.

The kind itself is overloaded — `handoff` is used for:

1. Templated short auto-fade relays (31 entries).
2. Multi-KB pre-compaction snapshots (10+ entries; righthand's
   `2026-05-08 ~03:23 PDT compaction-prep snapshot` at 11.4 KB).
3. Cross-persona action queue items ("PENDING tangerineOwl:" in
   docwarden).
4. Inter-incarnation continuity notes ("Session 2026-04-29 working
   state").

The auto-fade rule was presumably designed for (1) but is being
applied — or failing to apply — uniformly across all four.

---

### C.10 — The summoner concentration

391 entries (47 % of corpus) carry `summoner_username`. Of those,
377 (96 %) are summons by exactly two personas: `semaphoremole`
(292) and `righthand` (85). _These two personas are different
incarnations of the same role — the liaison/orchestrator running at
Leandro's terminal — and they are the source of almost every
non-Leandro summon in the system._

This means: most personas have never been summoned by Leandro
directly. They were summoned by the liaison-of-the-day.
`summoner_username` on an entry is, in practice, "which liaison
incarnation owned the session that produced this memory."

_Design implication: `summoner_username` as a field carries useful
audit information (chain of conjure), but its actual cardinality
across the corpus is two-ish. It's less of a free-form attribution
and more of a marker for "was this work routed through the
orchestrator."_

---

### C.11 — File-size headroom

The full 836 entries occupy 2.9 MB. The largest single
`memory.json` is 553 KB (righthand). The system has plenty of
on-disk headroom; the constraints are render-time (the documented
10 KB core + 8 KB active per-summon budgets), not storage.

That said: 24 individual entries already exceed 8 KB; one is 15.9 KB.
These individually overflow the documented Active budget — they
either must collapse on render or they are sustaining the rendering
machinery in a way the documented spec does not literally cover.

---

## Appendix — quick reference

- 66 persona memory stores, 836 entries, 2.9 MB.
- 1 project memory store, 1 entry.
- 0 notebooks.
- 0 entries with `updatedAt`. Field name in use is `date`, not
  `createdAt`.
- 1 entry with `details` (the dream-tool audit).
- 8 entries with `see_also`. 4 with `replies_to`. 12 unique entries
  with any structured link.
- 48 % of entries marked `core: true`.
- 77 % of `handoff` entries marked core (208/271).
- 87.9 % of entries are `status: active`. Only 9.4 % faded,
  2.6 % forgotten.
- 81 handoffs are older than 7 days and still active (29.9 % of all
  handoffs).
- 6 kinds dominate (`handoff`, `log`, `decision`, `gotcha`, `fact`,
  `feedback`); 23 % of entries have no kind at all.
- Two summoners (`semaphoremole`, `righthand`) account for 96 % of
  summons.
- 1 documented use of the `dream` consolidation tool (filmstoat,
  2026-05-12), which produced the only `details`-populated entry in
  the corpus.
- 27 % of entries have a `text` body that begins with the `summary`
  verbatim.
