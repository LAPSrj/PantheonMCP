# Notebook feature plan

> Status: design — implementation gated on Leandro's nod.
> Author: vellumpike, 2026-05-12, requested by righthand on behalf of Leandro.
> Sibling: this lives alongside `docs/memory.md` and `docs/project-memory.md` as
> a third persona-scoped knowledge layer with a deliberately different surface.

## 1. The need (Leandro's framing)

> "A place to write things that might be useful in specific contexts but you
> don't need to be remembered always. Maybe just the notebook topics would
> come on the login."

Memory (and project-memory) surface ambiently: every entry is either rendered
into the prompt at login (Core / Active) or sits one substring away in the
faded Index. That's the right shape for "facts that bear on present state."

A notebook is for the opposite shape: **stuff you only care about once you're
back in *that* specific context.** The agent should know it *exists* (TOC) and
be able to fetch it on demand — but the body never crowds the resume payload.

Concrete examples (righthand's framing, paraphrased):

- "How swiper.js z-index interacts with the carousel slide-clone pattern"
- "Tia's preferred BugHerd RFR/IGNITE handoff workflow"
- "Debug recipes for visual-diff false-positives at 0.93–0.95 score range"
- "What each audit-impl sub-agent in `.claude/agents/` does"

None of those belong in `get_memory` output. All of them are one tool-call
worth of value when you're in the context.

## 2. Why this is a separate layer (not a memory `kind`)

I considered piggy-backing on memory with a `kind: "note"` convention and a
render filter. Rejected. Reasons:

1. **Render coupling.** Memory's render pipeline is byte-budgeted and assumes
   every active entry is render-eligible. A notebook entry would have to be
   filtered out at *every* render call site (Core, Active, Index, peer-inspect
   via `only_core`, dream-consolidation, snapshot, find_memory). One missed
   filter and notebook bodies leak into the prompt — the exact failure the
   feature exists to prevent.
2. **Lifecycle decoupling.** Faded memory and "older notebook page" are
   unrelated states. Coupling them means a fade pass over memory either
   accidentally fades notes (wrong) or has to special-case `kind=note`
   (smelly).
3. **Shape difference.** Memory entries are flat. Notebooks naturally group
   pages under a topic — the TOC entry *is* the topic, not any single page.
   That grouping doesn't model cleanly as a memory `kind`.
4. **Future-proofing.** Project-notebook, cross-persona reads, and (later)
   per-page version history all want a store of their own. Starting separate
   costs ~250 LOC; merging later would cost more.

So: **dedicated store, dedicated module, dedicated tool surface.** Same
storage patterns (atomic JSON, mutate-then-rename, `~/.pantheon/personas/<handle>/notebook.json`).
Same tier-discipline mindset (TOC vs body). No shared code with memory beyond
generic storage helpers.

## 3. Data model

### 3.1 Store layout

Per persona: `~/.pantheon/personas/<handle>/notebook.json`.

```ts
interface NotebookStore {
  version: 1;
  topics: NotebookTopic[];   // never duplicated by slug
}

interface NotebookTopic {
  slug: string;              // kebab-case, 1–64 chars, ^[a-z0-9][a-z0-9_-]*$
  title: string;             // free-form, ≤ 240 chars; defaults to slug if omitted
  created_at: string;        // ISO-8601
  updated_at: string;        // bumps on any page mutation in the topic
  pages: NotebookPage[];     // ordered by created_at asc
}

interface NotebookPage {
  id: string;                // kebab slug; unique within the topic
  title: string;             // ≤ 240 chars; required (it's the TOC bullet on open)
  body: string;              // load-bearing markdown; no enforced cap (see §3.4)
  tags?: string[];           // free-form, lowercase; powers search filter
  status: "active" | "deleted";
  created_at: string;
  updated_at: string;
  author_username?: string;  // canonical persona, NOT auto-suffixed handle.
                             // Only meaningful in cross-persona contexts; for
                             // per-persona notebooks it'll match the persona,
                             // but we stamp it anyway so a future move/merge
                             // doesn't lose attribution.
}
```

### 3.2 Status / lifecycle

Pages have a tombstone state (`"deleted"`), mirroring memory's `forgotten`.
Hard-delete is *not* exposed as a tool in v1 — deleted pages stay in the file,
filtered out of every default read, recoverable via `notebook_restore_page`.

Topics auto-vanish from the TOC when **every** page is deleted. The empty
topic record stays on disk (cheap, preserves slug history) but isn't surfaced
in `notebook_list_topics` or in `resume_summary` until a page is restored or
appended. Compaction (hard-purge of empty topics + deleted pages) is a Phase 3
maintenance pass — out of scope for v1.

No `expires_at` for v1. Notebook content is context-scoped reference material;
the user fades it explicitly when it stops being useful. Adding TTL later is
schema-additive.

No `core` flag. The feature is **defined** by not being core-loaded; surfacing
"core notebook pages" would defeat the point. If a page belongs in `core`
memory, it's a memory entry, not a notebook page.

### 3.3 IDs and slugs

- **Topic slug** is supplied by the caller (it's the user-facing key in
  `notebook_open({ topic })`). Validate against `/^[a-z0-9][a-z0-9_-]{0,63}$/`.
  Reject collisions explicitly with `topic_exists` rather than auto-suffixing
  — the caller picked the slug; surprising them with a `-2` would break their
  expectation. (Same posture as snapshot labels.)
- **Page id** is derived from `title` via the same slugify path memory uses,
  with `-2` / `-3` suffixes on collision *within the topic*. Page ids are
  topic-scoped, not globally unique — `<topic>:<page>` is the canonical
  reference shape, and that's what cross-persona/search results return.

### 3.4 Body size

No hard cap on `body`. Memory uses a `details ≤ 5 MB` split because Active
entries are render-budgeted and you need to keep "the big payload" off-budget.
Notebook bodies are never rendered at login, so the split has nothing to do.

That said, we'll soft-warn over 64 KB (single page) and over 1 MB (whole topic)
in the write response — not blocking, just a `warning` field so the agent
considers whether this should be sharded across pages or kicked over to
`get_history_message` territory. The hard limit is operational: the whole
`notebook.json` file is parsed on every op, so multi-MB stores will start to
feel sluggish. Phase 3 may move to one-file-per-topic if real usage demands.

## 4. Tool surface

### 4.1 Naming

`notebook_*` prefix throughout. Verb is `write` (create-or-update) for the
mutation, `open` for the bulk read, `get_page` for the precise read,
`search` for query, `delete_*` / `restore_page` / `rename_topic` for the rest.
`_any` variant on the read paths only — same posture as `recall_project_memory_any`.

### 4.2 Per-persona surface (operates on caller's claimed persona)

| Tool | Purpose | Required | Optional |
|------|---------|----------|----------|
| `notebook_list_topics` | TOC view: every topic + page_count + updated_at | — | `include_empty?: boolean` (false by default — empty topics hidden) |
| `notebook_open` | All active pages in a topic, full bodies | `topic` | `include_deleted?: boolean` |
| `notebook_get_page` | Single page, full body | `topic`, `page_id` | — |
| `notebook_search` | Substring across title + body + tags | `query` | `topic?`, `tag?`, `limit?` (default 20) |
| `notebook_write_page` | Create or update a page | `topic`, `title`, `body` | `page_id?` (update if matches, else create), `tags?`, `topic_title?` (sets/updates `NotebookTopic.title` — only honored when topic is new or empty) |
| `notebook_delete_page` | Soft tombstone | `topic`, `page_id` | — |
| `notebook_restore_page` | Flip `deleted → active` | `topic`, `page_id` | — |
| `notebook_delete_topic` | Bulk tombstone every page in a topic | `topic` | — |
| `notebook_rename_topic` | Move all pages to a new slug | `from`, `to` | — |

### 4.3 Cross-persona reads (`_any` variants)

| Tool | Purpose | Required |
|------|---------|----------|
| `notebook_list_topics_any` | TOC for another persona | `username` |
| `notebook_open_any` | Read a peer's topic | `username`, `topic` |
| `notebook_get_page_any` | Read a single peer page | `username`, `topic`, `page_id` |
| `notebook_search_any` | Search self or all personas | `query`; `scope: "self" \| "all"` (default `"self"`) — mirrors `find_memory`. Optional `username?` for a specific peer instead of the union. |

No cross-persona *write* tools. Notebook ownership stays with the persona who
authored the page; if a peer wants to capture another agent's notes, the
copy-paste happens through chat. (This matches memory: there's no
`append_memory_any`.)

### 4.4 Tool schemas — concrete shape

Mirroring the `tools.ts` style. Three representative entries; the rest follow
the same pattern.

```ts
// notebook_write_page
{
  name: "notebook_write_page",
  description: "Create or update a page in the caller's notebook. ...",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["topic", "title", "body"],
    properties: {
      topic:       { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
      title:       { type: "string", minLength: 1, maxLength: 240 },
      body:        { type: "string", minLength: 1 },
      page_id:     { type: "string" },
      tags:        { type: "array", items: { type: "string" } },
      topic_title: { type: "string", maxLength: 240 },
    },
  },
}

// notebook_open
{
  name: "notebook_open",
  description: "Return every active page under a topic.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["topic"],
    properties: {
      topic:            { type: "string" },
      include_deleted:  { type: "boolean" },
    },
  },
}

// notebook_search
{
  name: "notebook_search",
  description: "Substring search across title + body + tags.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1 },
      topic: { type: "string" },
      tag:   { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
}
```

### 4.5 Error codes

Reuse memory's posture (lower-case snake) so the dispatcher's wrap behavior
is uniform.

- `topic_not_found` — open / write-update / delete-topic / rename on missing slug
- `topic_exists` — rename target collides with an existing slug
- `page_not_found` — get_page / delete_page / restore_page / write_page (with page_id) on missing id
- `invalid_topic_slug` — pattern reject
- `invalid_argument` — generic fallback (matches existing dispatch)
- `no_persona` — write paths called without a claimed persona

## 5. Resume summary changes

`ResumeSummary` (`src/resume/index.ts`) gains one field:

```ts
interface ResumeSummary {
  last_status: string | null;
  recent_memory: ResumeMemoryRef[];
  memory_by_kind: Record<string, number>;
  active_memory_count: number;
  notebooks: NotebookTOCRef[];   // NEW
}

interface NotebookTOCRef {
  topic: string;          // slug
  title: string;          // human label
  page_count: number;     // active pages only
  last_touched_at: string;
}
```

Rules:

- Sort by `last_touched_at` desc.
- Cap at **20 entries** (TOC entries are short — ~80 chars each → ~1.6 KB
  total, well under the resume summary's soft budget).
- When more than 20 exist, surface a footer in the same array shape but with a
  sentinel — actually no, the cleaner pattern is: cap the array at 20, and add
  a sibling `notebooks_truncated: { total: 42, shown: 20 }` field. Empty TOC
  means the array is empty + the field is omitted.
- Empty notebooks: omit the `notebooks` field entirely (mirrors the
  `_unspecified` kind treatment — invisible when there's nothing to say).

This change is the only thing visible to the agent at login. **Page bodies
never appear in `resume_summary`** — that's the whole point.

All five call sites of `buildResumeSummary` (in `identity.ts` claim + manifest
×2, and `chat.ts` login ×2) pick this up for free; no per-handler edit needed.

## 6. Storage / lifecycle

### 6.1 Atomicity

Same pattern as memory:

- `loadNotebookStore(paths, username)` — `readJson` with empty-store fallback.
- `mutateNotebookStore(paths, username, mutator)` — fingerprint-guarded
  `mutateJsonAtomic` from `src/storage/json.ts`, so concurrent sibling
  incarnations writing to the same notebook can't clobber each other.

The schema is exclusive to one persona at a time, so the same fingerprint
guard memory uses is sufficient. No new lock primitives needed.

### 6.2 No snapshots in v1

Memory has snapshots because snapshot/restore is load-bearing for the dream
pass — you want to checkpoint before a consolidation rewrite, and you want
"undo" for prompt-budget tuning. Notebooks have neither pressure. Defer
snapshots; revisit if a user reports "I deleted my notebook by accident."

### 6.3 No project-notebook in v1

Project-memory exists because facts decided by one persona are useful to
others working in the same project. The notebook use cases righthand listed
are mostly per-persona context (a specialist's recipes, a sub-agent map *I*
need). The few that are project-shared (e.g. "the takt-starter → nyus sync
handshake") can sit as project-memory entries.

Phase 2 candidate: `project_notebook` as a sibling of `project_memory`, same
shape, file at `~/.pantheon/projects/<project>/notebook.json`. TOC entries
attached to a per-project resume payload (which doesn't exist yet — would
need to ride on top of `get_project_memory` or a new `project_summary` tool).
Don't ship in v1; the per-persona pattern needs real usage first.

### 6.4 Auto-fade / TTL: no

Notebook entries are user-decided. The `expires_at` daemon pass that auto-
fades handoff memories is the wrong fit — notes go stale on the user's
schedule, not the clock's.

### 6.5 Dream / consolidation: no

The `dream` flow is about merging redundant memory entries to keep the byte
budget honest. Notebooks have no budget pressure (TOC is the only render
surface and it's bounded by topic count, not body size). No dream pass for v1.

## 7. Open questions (answers)

Pre-resolved here so the implementer doesn't have to re-litigate. Each
answer is reversible if usage proves it wrong.

1. **Page "kind"?** — No. `tags: string[]` instead. Tags are free-form,
   queryable via `notebook_search({ tag })`. Memory's `kind` is a fixed-ish
   vocabulary (`decision`, `gotcha`, `handoff`, `fact`, `log`) tied to the
   `memory_by_kind` resume count. Notebook has no analog need.
2. **Auto-hint** (surface "you have notes on this") — No, defer. Scope-creep
   surface; needs a stable signal (tool args? recent chat?) and the wrong
   signal becomes annoying noise. Revisit after a few personas have built up
   real notebooks.
3. **Snapshot/restore lifecycle** — No, defer. Tombstone-on-delete (with
   `notebook_restore_page`) covers the "I clicked the wrong thing" case.
4. **Migration / backfill** — No. v1 starts empty. Long-form memory entries
   that *look* like notebook material stay where they are; agents can
   manually move them by reading + writing if it's worth the disruption.
5. **Login output budget** — 20 TOC entries cap (≈1.6 KB), `notebooks_truncated`
   sibling field counts the rest. Sort by `last_touched_at` desc so the most
   recently-used contexts win the slots.
6. **Project_notebook** — No, defer. Phase 2.

## 8. Phased implementation order

Each phase is independently mergeable, each adds tests + docs.

### Phase 1 — Core read/write (per-persona)

1. `src/notebook/types.ts` — types + error class.
2. `src/notebook/store.ts` — `loadNotebookStore` / `mutateNotebookStore` over
   the storage helpers. Add `notebookFilePath` to `src/storage/paths.ts`.
3. `src/notebook/operations.ts` — `writePage`, `getPage`, `openTopic`,
   `listTopics`, `deletePage`, `restorePage`, `deleteTopic`, `renameTopic`,
   `searchNotebook`. Pure-data functions, mirror memory/operations.ts shape.
4. `src/notebook/__tests__/notebook.test.ts` — at minimum: round-trip write
   + read; topic auto-vanish when last page deleted; restore flips back;
   rename moves all pages; search hits title/body/tags; collision behavior
   (page_id `-2` suffix, topic `topic_exists`); validation errors.
5. `src/mcp/tools.ts` — add the 9 per-persona tool definitions.
6. `src/mcp/handlers/notebook.ts` — handlers for all 9. Same `wrap()` pattern
   `project-memory.ts` uses to translate `NotebookError → ToolError`.
7. `src/mcp/handlers/index.ts` — register them.
8. `src/mcp/__tests__/notebook-handlers.test.ts` — dispatcher-level coverage
   including `no_persona` rejection and invalid-args rejects.

**Acceptance:** agent can `notebook_write_page` and round-trip via
`notebook_open` and `notebook_search`. No resume_summary change yet — keep
the change set tight.

### Phase 2 — Resume summary integration

1. Extend `ResumeSummary` interface in `src/resume/index.ts` with
   `notebooks` + `notebooks_truncated`.
2. Update `buildResumeSummary` to load the notebook store, project to
   `NotebookTOCRef[]`, apply the 20-cap sort, omit when empty.
3. Test: `src/resume/__tests__/resume.test.ts` — empty notebook ⇒ field
   absent; 1 topic ⇒ field present; 25 topics ⇒ array length 20 +
   `notebooks_truncated.total === 25`; sort order is `last_touched_at` desc.
4. Update `docs/resume-summary.md` (or wherever the resume contract is
   documented) — call out that `notebooks` is TOC-only, bodies via tools.

**Acceptance:** `mcp__pantheon__login` returns a `notebooks` field, agent
can read it without further tool calls.

### Phase 3 — Cross-persona reads + bootstrap copy nudge

1. Add `_any` variants: `notebook_list_topics_any`, `notebook_open_any`,
   `notebook_get_page_any`, `notebook_search_any`. Each takes `username` (or
   `scope` for search) and routes through the same operations module.
2. Tool defs in `tools.ts`, handlers in `notebook.ts`, register.
3. Tests: cross-persona round-trip; `scope: "all"` union sort; `username`
   missing/unknown → `persona_not_found`.
4. **Bootstrap copy** — extend the agent-bootstrap text (`src/responses/bootstrap.ts`
   or wherever the login note lives) to mention notebooks in one sentence
   only when `resume_summary.notebooks` is non-empty. Form: "You have notes
   on N topic(s) — `notebook_list_topics` for the index." No extra prose when
   notebooks are empty (don't teach the feature mid-bootstrap; the tool list
   is enough).

**Acceptance:** an agent summoning another persona's notes via `_any` works;
agents with existing notebooks see a single-line nudge at login.

### Phase 4 (optional, deferred) — Compaction + project_notebook

Not for v1. Track as follow-up if and when:

- `notebook.json` files start measurably slowing down ops → one-file-per-topic
  migration.
- A real cross-persona shared-context use case emerges → `project_notebook`
  mirroring `project_memory`.
- Recovery from accidental wipe becomes a complaint → snapshots.

## 9. Risks / sharp edges to watch for during implementation

- **TOC explosion.** An agent that writes 200 single-page topics floods the
  resume summary with low-signal entries. The 20-cap handles the surface
  symptom, but the cause is "topic is the wrong grouping for this content."
  Document the intended shape (topic = recurring context, page = a note
  within that context) in `docs/notebook.md` so it stays load-bearing.
- **Slug collisions across personas in `_any` search.** When two personas
  have a `swiper-zindex` topic, search results need `username` stamped on
  every hit (mirror `findMemory`'s `FindMemoryHit`). Don't return a flat
  list of pages; key by `(username, topic, page_id)`.
- **Last-touched-at math.** A `notebook_open` (read) does NOT bump
  `updated_at`. Only writes / deletes / restores / renames bump it. Otherwise
  the resume TOC turns into "what I most recently *read*", not "what I most
  recently *worked in*", which is the wrong signal.
- **Rename atomicity.** `notebook_rename_topic` rewrites every page reference
  in one mutate-then-rename pass. Half-rename (some pages moved, others not)
  is unrepresentable in the store shape — but if a tool consumer paginates a
  rename through multiple calls (which the surface doesn't expose, but could
  via a future helper), it'd be a footgun. Keep the surface single-call.
- **Topic record without pages but still present on disk.** Already covered
  in §3.2 (auto-vanish from TOC but kept on disk) — surfacing this in the
  docs prevents the next implementer from "fixing" it as dead state.

## 10. What's NOT in scope for v1

For clarity, things I considered and explicitly cut:

- Per-page version history / edit log.
- Page-level access control or visibility flags.
- Auto-categorization (LLM-suggested tags).
- Page hyperlinks / `replies_to` analog. (Memory has it; notebook can add it
  later if cross-page references inside a topic prove necessary. v1 lets you
  reference by `<topic>:<page_id>` in body text.)
- Markdown rendering or syntax validation. Bodies are opaque strings.
- Notebook export / import. Backup is "copy `notebook.json` somewhere safe."

---

**Next step:** Leandro nods, I implement Phase 1, ship behind tests, then DM
for the go-ahead on each subsequent phase.
