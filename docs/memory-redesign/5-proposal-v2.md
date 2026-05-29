# Pantheon Memory — Redesign v2 (final)

> Supersedes §4–§9 of `4-proposal.md`. Builds on its diagnosis (§1–§3),
> findings (F1–F10), principles (P1–P8), and inputs #1–#3. Captures the
> 2026-05-29 design session with Leandro. The diagnosis still stands;
> this is the revised, agreed *model*, ready for final review.

## 1. The core shift

1. **Topic-scoped lazy load.** Memory is not dumped at boot. The agent
   sees a topic menu and loads only the topic(s) relevant to the
   declared task. Relevance is **declared, not inferred** — an unloaded
   entry costs zero context, so no disuse-fade is needed (this removes
   the read-recency tracking gap entirely).
2. **Per-kind relevance axes.** Each kind surfaces/decays by the signal
   that fits its purpose — topic, recency-count, due-date, or
   matching-session — not one TTL for everything.

## 2. Kinds (7)

| kind | from (legacy) | purpose |
|---|---|---|
| `rule` | decision, feedback | durable behavioral instruction |
| `fact` | fact | durable descriptive info |
| `gotcha` | gotcha, audit | known pitfall (warning marker) |
| `pointer` | — | breadcrumb to a doc/file |
| `note` | log, phase-*, untyped | scratch / status / **temporary working context** |
| `handoff` | handoff (short relays) | bridge to the next incarnation |
| `reminder` | **new** | "remind me later" |

Removed: the `core` bool, the `details` field, the `apply` field, the
free-form kind, the notebook surface (F7 — zero adoption).

## 3. Relevance axes — one per purpose

| kind | loaded by | decay |
|---|---|---|
| rule / fact / gotcha / pointer | **topic** | none — supersede / dream / manual |
| note | **topic** (agent-set, else inherits active) + **last-5-per-topic** | none auto — never forgotten; manual ok |
| reminder | **due** (date \| next-session \| open) | forgotten after delivered + done |
| handoff | **topic delivery** + **matching-session counter** | §8 |

## 4. Topics

- New **`topic`** field, **unified with the slug domain**:
  `slug = <topic>/<name>` (e.g. `chat/scope-dm-target`). One taxonomy;
  the index auto-clusters by topic.
- **Required** on durable kinds → **reject-with-suggestion**
  (`topic_required` + existing-topic list + an inferred suggestion to
  confirm).
- **Notes set their own topic explicitly**; if omitted they inherit the
  session's active topic. (A multi-topic session can still file a note
  under the single topic it's about.)
- **`always`** — reserved topic, loaded every session. Must be chosen
  explicitly; never an empty default (that path was core-inflation in
  disguise — P2/P3).
- **Sprawl guard** — prefer an existing topic; a new one is flagged
  (`reuse one of {…}?`). Same starvation discipline as the kind enum.

## 5. Pins + two budget guards

- `pin` = **"render in full every session, regardless of topic"**
  (`pin_reason` required) — a detail+load flag, not mere inclusion.
- **Two symmetric guards, both "reject → consolidate":**
  - **Pins** (full-text) — a pin that would push the always-FULL set
    over its byte budget is rejected (`pin_budget_exceeded`).
  - **`always`-summaries** — an `always` entry that would push the
    always-SUMMARY band over its byte budget is rejected
    (`always_budget_exceeded`).
  
  Both bound the every-session surface by construction and force
  consolidation instead of unbounded growth.

## 6. What loads each session (load × detail)

```
ALWAYS-LOADED (regardless of declared topics):
  · pinned          → FULL            (byte-budgeted; reject→consolidate)
  · topic = always  → SUMMARY         (byte-budgeted; reject→consolidate; pin one to get it full)

DECLARED-TOPIC (loaded via load_memory):
  · active          → FULL             (you declared it → you want its detail)
  · faded           → title+summary → title-only under budget pressure (oldest first)
  · notes           → the last 5 per topic, as title+summary. Older notes are
                       search/list-only. Notes NEVER render full inline; body via
                       recall_memory(id). Never auto-forgotten.

NOT LOADED:
  · other topics    → menu count only:  "memory(5) launcher(3)"  (no per-entry lines)

SURFACED REGARDLESS OF TOPIC:
  · due reminders   → top "DUE REMINDERS" block, full
  · delivered handoffs → shown when A ∩ H ≠ ∅, with a "fade if not needed" prompt
```

Within a declared topic: default full, collapse oldest active → summary
if one topic is huge. Discovery of the unloaded = topic names (browse) +
`find_memory` (lexical, content, across all entries).

## 7. Detail ladder

```
FULL → SUMMARY (slug — summary_max240) → TITLE (slug) → TALLY (domain count) → HIDDEN
```

State sets the ceiling; budget demotes oldest-first. `faded` =
title+summary → title under pressure. `superseded` → **forgotten**
(tombstoned, recoverable via `include_forgotten`).

`summary_max240`: the field is renamed to carry its limit (a
generation-time nudge). For rules/gotchas the summary should phrase the
**trigger** — *"when doing X, remember Y"* — not a bare title (this is
what `apply` used to hold; it now lives in the summary).

## 8. Handoff decay — matching-sessions-only, threshold 3

`H` = handoff topics, `A` = the session's loaded topics:

```
handoff(H), matched = 0:
  A ∩ H = ∅          → NOT delivered, matched FROZEN   (off-topic AND dormant both preserve it)
  A == H             → AUTOFADE after this 1 session     (exact focus → consume)
  A ∩ H ≠ ∅, A ≠ H   → deliver + "fade if not needed"; matched++ (once per session);
                        AUTOFADE when matched == 3
  faded → forgotten   on the next matching session, or on supersede
```

A handoff **never expires unseen** — it waits through dormancy and
off-topic sessions, decaying only once relevant sessions have actually
seen it.

## 9. Boot sequence + load gate

**Order: `manifest → list_topics → load_memory(topic) → login → monitor`.**
The bootstrap/login notes must state this order explicitly.

```
manifest        (identity claimed at MCP boot, per env — unchanged)
list_topics()   gate-exempt; returns the topic menu (topics + counts) + due-reminder count
load_memory(topics)   REQUIRED before chat — must pass a topic (even "always");
                       lifts the dispatcher gate (per-CONVERSATION flag, survives re-login)
login()         join chat
monitor         start the watcher
```

- **Dispatcher gate:** non-exempt pantheon tools (including `login`) are
  rejected (`memory_not_loaded`) until `load_memory` runs. Exempt:
  `manifest`, `list_topics`, `load_memory`, `session_info`, `whoami`.
  The watcher (Monitor) is harness-side. **Strict** — a summon can't
  `answer`/`send` before loading memory; an incoming DM waits one
  sub-second `load_memory`.
- **Fresh/empty persona:** `list_topics` is empty → the load gate is
  **skipped**; the agent goes straight to `login → monitor`.

## 10. Reminder

`due: <ISO instant> | "next-session" | null(open)`. A clock-time request
("3pm") is interpreted in the **system-local zone at write time**, stored
as a **UTC instant**, and rendered **local + tz** (same helper as the
watcher fix). Fires: date → daemon-tick / the monitor sends a timed
reminder at the due instant; next-session → `session_seq + 1`; open →
resurfaces every session until acted on. When due → top block, full.
Delivered + done → forgotten. Due-gated, not topic-gated.

## 11. `get_instructions` tool

A read-only, **topic-keyed pull** for canonical pantheon guidance the
agent's CLAUDE.md doesn't inline — the same on-demand shape as
`load_memory`. Curated agent-facing content (`memory`, `chat`,
`lifecycle`, `summon`, `topics`, …), not the contributor docs dumped in.
Distinct from memory: instructions = system-authored *manual* (shared,
stable); memory = persona-authored *experience* (learned).

**Auto-surfaced** (the make-or-break, so it doesn't strand like the
notebook): pointed to from **error messages** (`topic_required` →
`get_instructions('topics')`, etc.), injected **JIT** on relevant tool
calls / failures, and named once in the bootstrap.

## 12. Save layer

Trigger-driven CLAUDE.md: save a **rule** on "always/never/correction
with a reason"; a **fact** on grepped-info / project invariant; a
**gotcha** on surprise / workaround; a **pointer** on a located
doc/skill; a **reminder** on "remind me…"; a **note** for anything else,
including temporary working context. Naming: `<topic>/<rule-name>`, verbs
over nouns, no dates in the slug.

Write-time validation (specific reject codes): kind ∈ enum;
`summary_max240` ≤240 and ≠ first line of text (`summary_is_header`);
durable kinds require `topic` (`topic_required`); handoff requires
topics; pins/`always` respect budget (`pin_budget_exceeded`,
`always_budget_exceeded`).

## 13. Discovery + JIT injection

- **Index** = topic-clustered slug ── summary lines.
- **Lexical search** (`find_memory`) across all entries (incl. unloaded).
- **JIT injection** keys off what matches deterministically — **topic**
  (file/path → topic; e.g. editing `src/memory/*` injects `memory`
  rules) and **lexical overlap** of the situation/error text against
  entry **summaries** (which now carry the trigger). No semantic search;
  no parsing of free-text triggers.

## 14. Decay execution

- **Time-based** (reminder dates) → daemon-tick (6 h) / monitor at due
  instant; mtime-guarded mutate-then-rename.
- **Session/topic-based** (handoff counter, next-session reminders, note
  last-5 windowing) → evaluated at `load_memory` (the session boundary).
- **Dream pass** → cluster / consolidate / supersede-fade; the cleanup
  path for durable entries (no disuse clock). Runs on summon when over
  budget + a per-persona cadence; `--dry-run` to inspect.

## 15. Timezone (cross-cutting)

Store every timestamp as an epoch/UTC instant; **display in system-local
time with a short tz label** via one helper (`formatLocalTime`, e.g.
`21:55:12 PDT`). The watcher previously emitted unlabelled UTC, which
agents misread as local — fix already in the working tree (watcher + CLI;
storage untouched).

## 16. Schema delta

**Add:** `topic`; `pin` + `pin_reason`; `due`; `supersedes`;
`session_seq` (per-persona session ordinal, stamped at write);
`matched` + `last_matched_seq` (handoff counter, dedup per session).
**Rename:** `summary` → `summary_max240`.
**Remove from agent API:** `apply`, `details`, the `core` bool, the
notebook tools.
**Dropped behavior:** read-recency (`lastReadAt`) auto-fade — topic-gating
makes unloaded entries free, so disuse-fade is unnecessary and was the
source of the tracking gap. The reconsolidation "still load-bearing?"
prompt still fires on explicit `recall_memory`.
**New tools:** `list_topics`, `load_memory`, `get_instructions`.

## 17. Migration (phased, reversible — per original §6)

- **P1** schema additions, tolerant reads.
- **P2** remove `details`/`apply`; deprecate notebook tools.
- **P3** write-time validation (warn-only one release, then enforce).
- **P4** boot reorder: `list_topics` + `load_memory` + the load gate.
- **P5** the four decay axes (daemon-tick / load-time); reminder kind +
  timed monitor delivery.
- **P6** `get_instructions` + JIT injection hooks.

Legacy entries: kind auto-mapped; topic inferred from the slug-domain
where present, else flagged for re-topic on next touch (never silently
`always`). Every phase deploys and reverts independently.

## 18. What v2 does NOT change

The §1–§3 diagnosis; project-vs-personal (Path A — prompt for use, not a
new surface); no semantic search (lexical + naming is the bet); the dream
tool's grounded "offline consolidation" framing. Original §8 success
criteria carry over, plus: ≥40 % of writes are notes; pinned + `always`
sets stay within budget; the topic-menu load is used, not bypassed.

---

*Final v2. **Implemented** (2026-05-29) — Leandro greenlit the end-to-end
build. Schema (P1), topic-scoped render + write validation + new tools +
load gate (P3/P4/P11), decay engine (P6), and the legacy-surface
deprecation (P2) are landed on local main with full test coverage. See
`docs/memory.md` (v2 model section) for the as-built reference.*

*Two follow-ups are intentionally deferred pending Leandro's call:*
- *Flipping write validation from warn-only to enforce
  (`PANTHEON_MEMORY_ENFORCE=1`) — §17 P3's "then enforce" step.*
- *The HARD schema removal of `core` / `details` from the tool inputs.
  They're deprecated-with-mapping today (safe + reversible); a hard cut
  would reject a live agent's in-flight write, so it waits for explicit
  go-ahead.*
