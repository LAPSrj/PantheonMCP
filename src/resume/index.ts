/** Resume-summary builder.
 *
 * Compact, bounded view of session-relevant state for a persona.
 * Surfaces in the manifest/login response so an agent reconnecting
 * to a project can see what it was working on without scrolling
 * memory or chat history. Replaces the "8-step boot" cost the audit's
 * B.5 complains about — no new daemon, just a richer claim/login
 * response.
 *
 * The summary is general infrastructure: counts of memory entries
 * by kind, the most recent N memory entries, the persona's last
 * status, and online-peer count. Pantheon doesn't know what any
 * given `kind` value means; consumers (CLAUDE.md, skills) interpret
 * the returned data however they wish.
 *
 * The summary stays bodyless — `recent_memory`, `handoffs`, and the
 * by-kind `memory_index` are all `{id, summary, …}` refs. Full bodies
 * come from `list_memory` / `recall_memory` / `check_messages`. The
 * index is bounded by a 14 KB byte budget so the whole manifest
 * response never spills to an on-disk tool-result file.
 *
 * `buildCoreMemory` is the deliberate exception to "bodies omitted":
 * it returns active `core: true` entries WITH full text, surfaced as a
 * sibling `core_memory` field on the manifest/claim response (not
 * nested in the resume summary, so the summary keeps its cheap-index
 * contract). Rationale: `core` means "always load this", but
 * `recent_memory` only shows the 5 newest as bodyless refs — an older
 * core entry was invisible on boot. See `buildCoreMemory`.
 *
 * Notebook integration: when the persona (or project) has notebook
 * topics, a TOC of up to 20 entries surfaces in the `notebooks` /
 * `project_notebooks` fields. Page bodies are NEVER inlined here —
 * the TOC is just a signal that a context-scoped store exists for
 * specific topics, fetched on demand via the notebook tools.
 */

import type { Paths } from "../storage/index.ts";
import { loadStore } from "../memory/store.ts";
import { HANDOFF_KIND } from "../memory/handoffs.ts";
import { listTopics as listNotebookTopics } from "../notebook/index.ts";
import { listProjectTopics } from "../project-notebook/index.ts";
import type { HandoffMeta, MemoryEntry } from "../memory/types.ts";

export interface ResumeSummary {
  /** Persona's last `status` line, when set. Read from the registry
   * persona file (status doesn't live there yet — placeholder for
   * forward compatibility). For now this is null; the chat-router
   * variant filled by `login` overrides it. */
  last_status: string | null;
  /** Index of the persona's most recent active memory entries.
   * Bounded to `recent_memory_limit` (default 5). Body bodies omitted
   * — pull via `recall_memory` or `get_memory_details`. */
  recent_memory: ResumeMemoryRef[];
  /** Counts of active memory entries grouped by `kind`. Useful for
   * "I have N retractions / M decisions on file." Entries without
   * a kind are counted under the synthetic key `_unspecified`. */
  memory_by_kind: Record<string, number>;
  /** Total active (non-faded, non-forgotten) memory count. */
  active_memory_count: number;
  /** Active `kind: "handoff"` entries, newest-first — one ref per
   * handoff so the agent can see what's waiting and `recall_memory`
   * the relevant one. Bodies omitted (handoffs can be multi-KB
   * session snapshots); the `summary` is the highlight. Empty when
   * the persona has no pending handoffs. Byte-bounded — see
   * `handoffs_truncated`. */
  handoffs: HandoffRef[];
  /** Set when the active handoff set exceeded the handoff byte
   * budget. `shown` newest handoffs are in `handoffs`; the rest are
   * reachable via `list_memory({ kind: "handoff" })`. Omitted when
   * nothing was cut. */
  handoffs_truncated?: { total: number; shown: number };
  /** A by-kind summary index of the persona's active memory — the
   * complete title catalog. Every active non-handoff entry as a
   * bodyless `{id, date, summary}` ref, grouped under its `kind`
   * (`_unspecified` for entries with no kind). The agent scans the
   * summaries on boot — no `recall_memory` or file read needed to see
   * WHAT it knows — then pulls full bodies on demand. Core entries
   * ARE included here (the index is the catalog); `core_memory`
   * additionally carries the full text of the core entries that fit
   * its budget. Handoffs are omitted — they have their own
   * `handoffs` field. Bounded by a byte budget — see
   * `memory_index_truncated`. */
  memory_index: Record<string, MemoryIndexRef[]>;
  /** Set when the active non-core/non-handoff set exceeded the
   * `memory_index` byte budget. `shown` entries (newest-first) made
   * it into `memory_index`; `total - shown` were dropped — call
   * `list_memory` to see the rest. Omitted when nothing was cut. */
  memory_index_truncated?: { total: number; shown: number };
  /** Notebook TOC entries for the persona, capped and sorted by
   * `last_touched_at` desc. Only surfaces when at least one topic
   * exists. Page bodies are NEVER inlined — fetch via the notebook
   * tools. */
  notebooks?: NotebookTOCRef[];
  /** Set when the persona has more than `notebook_toc_limit` topics —
   * indicates how many more are not shown. Omitted when within cap. */
  notebooks_truncated?: { total: number; shown: number };
  /** Project-shared notebook TOC. Populated only when `project` is
   * provided to `buildResumeSummary` and the project has at least
   * one topic. */
  project_notebooks?: NotebookTOCRef[];
  /** Mirror of `notebooks_truncated` for the project notebook. */
  project_notebooks_truncated?: { total: number; shown: number };
}

export interface ResumeMemoryRef {
  id: string;
  date: string;
  summary: string;
  kind: string | null;
  core: boolean;
  has_details: boolean;
}

/** One line of the by-kind summary index. Bodyless — `recall_memory(id)`
 * pulls the full entry. */
export interface MemoryIndexRef {
  id: string;
  date: string;
  summary: string;
}

/** A pending handoff, surfaced on the boot path. The agent scans
 * `summary` to decide which handoff is relevant, then pulls the full
 * prose body via `recall_memory(id)`. `expires_at` is the epoch-ms
 * TTL deadline (handoffs auto-fade ~7 days after write). `handoff`
 * carries the structured, machine-usable slice (trust posture, pickup
 * checklist, curated memory refs, prohibitions) inline — so the next
 * session can act on it without a `recall_memory` round trip. Only
 * present when the handoff was written with structured fields. */
export interface HandoffRef {
  id: string;
  date: string;
  summary: string;
  expires_at: number | null;
  handoff?: HandoffMeta;
}

/** A core memory entry surfaced with its FULL body on the boot path
 * (manifest / claim). Unlike `ResumeMemoryRef`, this carries `text` so
 * the agent reconnects with its foundational rails loaded — no
 * per-entry `recall_memory` round trip. Core entries that don't fit
 * the byte budget are NOT emitted here at all (no collapsed refs) —
 * they're counted in `CoreMemoryResult.truncated` and remain
 * discoverable as refs in `resume_summary.memory_index`. */
export interface CoreMemoryEntry {
  id: string;
  date: string;
  summary: string;
  kind: string | null;
  /** Full entry body. */
  text: string;
}

/** Return shape of `buildCoreMemory`: the entries that fit the budget,
 * plus a `truncated` count when core entries were left out. */
export interface CoreMemoryResult {
  entries: CoreMemoryEntry[];
  /** Set when not every active core entry fit the budget. `shown`
   * entries are in `entries`; `total - shown` were dropped — they
   * still appear as refs in `resume_summary.memory_index`. */
  truncated?: { total: number; shown: number };
}

export interface NotebookTOCRef {
  slug: string;
  title: string;
  page_count: number;
  last_touched_at: string;
}

export interface ResumeOptions {
  /** Cap on `recent_memory` entries. Default 5. */
  recent_memory_limit?: number;
  /** Cap on `notebooks` / `project_notebooks` TOC entries. Default 20. */
  notebook_toc_limit?: number;
  /** When set, the project-notebook TOC is loaded for this project and
   * surfaced under `project_notebooks`. */
  project?: string;
}

const DEFAULT_RECENT_LIMIT = 5;
const DEFAULT_NOTEBOOK_TOC_LIMIT = 20;
/** Byte budgets for the bodyless boot-payload sections, measured over
 * `id + date + summary` per entry. Each walk is newest-first and stops
 * at its budget — no entry-count cap — so the whole manifest response
 * stays bounded (core_memory 12 KB + handoffs 6 KB + memory_index
 * 12 KB + recent ~2 KB ≈ 30 KB ceiling) and never spills to an
 * on-disk tool-result file, however inflated the persona's store. */
const MEMORY_INDEX_BUDGET_BYTES = 12 * 1024;
const HANDOFFS_BUDGET_BYTES = 6 * 1024;

export function buildResumeSummary(
  paths: Paths,
  username: string,
  options: ResumeOptions = {},
): ResumeSummary {
  const limit = options.recent_memory_limit ?? DEFAULT_RECENT_LIMIT;
  const tocLimit = options.notebook_toc_limit ?? DEFAULT_NOTEBOOK_TOC_LIMIT;
  const store = loadStore(paths, username);
  const active = store.entries.filter((e) => e.status === "active");
  // Date-descending; ids are timestamp-prefixed in pantheon, but date
  // is the explicit field — sort by it directly so we don't depend on
  // id internals. Equal dates: id tie-break for determinism.
  const sorted = [...active].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
  const recent = sorted.slice(0, limit).map(toRef);
  const byKind: Record<string, number> = {};
  for (const e of active) {
    const key = e.kind ?? "_unspecified";
    byKind[key] = (byKind[key] ?? 0) + 1;
  }

  // Pending handoffs — active `kind: "handoff"` entries, newest-first.
  // Byte-capped: a persona with a large handoff pile would otherwise
  // blow the boot payload one ref at a time. Cost is the SERIALIZED
  // ref so a handoff carrying a structured block is counted in full.
  const allHandoffs = active
    .filter((e) => e.kind === HANDOFF_KIND)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });
  const handoffs: HandoffRef[] = [];
  let handoffBytes = 0;
  for (const e of allHandoffs) {
    const ref = toHandoffRef(e);
    const cost = Buffer.byteLength(JSON.stringify(ref), "utf8");
    if (handoffs.length > 0 && handoffBytes + cost > HANDOFFS_BUDGET_BYTES) {
      break;
    }
    handoffs.push(ref);
    handoffBytes += cost;
  }

  // By-kind summary index. `sorted` is already date-descending, so
  // walking it newest-first and stopping at the budget keeps the
  // freshest entries. Handoffs are excluded (they have their own
  // field); core entries ARE included — `core_memory` carries the
  // ones whose full text fit, and the index is the complete title
  // catalog (so an overflowed rail is still discoverable).
  const indexable = sorted.filter((e) => e.kind !== HANDOFF_KIND);
  const memory_index: Record<string, MemoryIndexRef[]> = {};
  let indexBytes = 0;
  let shown = 0;
  for (const e of indexable) {
    const ref = toIndexRef(e);
    const cost = Buffer.byteLength(e.id + e.date + e.summary, "utf8");
    if (shown > 0 && indexBytes + cost > MEMORY_INDEX_BUDGET_BYTES) break;
    const key = e.kind ?? "_unspecified";
    (memory_index[key] ??= []).push(ref);
    indexBytes += cost;
    shown++;
  }

  const out: ResumeSummary = {
    last_status: null,
    recent_memory: recent,
    memory_by_kind: byKind,
    active_memory_count: active.length,
    handoffs,
    ...(handoffs.length < allHandoffs.length
      ? {
          handoffs_truncated: {
            total: allHandoffs.length,
            shown: handoffs.length,
          },
        }
      : {}),
    memory_index,
    ...(shown < indexable.length
      ? { memory_index_truncated: { total: indexable.length, shown } }
      : {}),
  };

  // Notebook TOC — personal.
  const notebookTopics = listNotebookTopics(paths, username);
  if (notebookTopics.length > 0) {
    const shown = notebookTopics.slice(0, tocLimit).map(toTOCRef);
    out.notebooks = shown;
    if (notebookTopics.length > tocLimit) {
      out.notebooks_truncated = {
        total: notebookTopics.length,
        shown: shown.length,
      };
    }
  }

  // Notebook TOC — project.
  if (options.project !== undefined) {
    const projectTopics = safeListProjectTopics(paths, options.project);
    if (projectTopics.length > 0) {
      const shown = projectTopics.slice(0, tocLimit).map(toTOCRef);
      out.project_notebooks = shown;
      if (projectTopics.length > tocLimit) {
        out.project_notebooks_truncated = {
          total: projectTopics.length,
          shown: shown.length,
        };
      }
    }
  }

  return out;
}

/** Total full-text byte budget for the `core_memory` boot payload.
 * Core entries past this are NOT emitted here — they show as refs in
 * `memory_index`. Keeps the manifest response bounded even for
 * personas with a large (inflated) standing-rule pile. */
export const CORE_MEMORY_TOTAL_BUDGET_BYTES = 12 * 1024;
/** Per-entry full-text cap. A core entry whose body exceeds this is
 * skipped regardless of remaining budget — a multi-KB body is a
 * document, not a rail, and the agent should `recall_memory` it
 * deliberately rather than carry it on every boot. */
export const CORE_MEMORY_PER_ENTRY_CAP_BYTES = 4 * 1024;

/** Build the full-text core memory payload for the boot path.
 *
 * `core: true` semantically means "always load this" — but the resume
 * summary's `recent_memory` only surfaces the 5 most recent entries as
 * bodyless refs, so an older core entry is invisible on reconnect until
 * the agent calls `recall_memory`. This returns active core entries
 * with their full `text`, so manifest/claim hand the agent its rails
 * up front.
 *
 * `kind: "handoff"` entries are EXCLUDED even though they carry
 * `core: true` — a handoff is a one-time continuity note (often a
 * multi-KB session snapshot), not a durable rail. Handoffs surface
 * separately as bodyless refs in `ResumeSummary.handoffs`.
 *
 * Hard-bounded: entries are walked newest-first; a body over
 * `CORE_MEMORY_PER_ENTRY_CAP_BYTES`, or one that would push the
 * running total past `CORE_MEMORY_TOTAL_BUDGET_BYTES`, is dropped —
 * NOT emitted as a collapsed ref (that is what bloated the payload).
 * Dropped entries are counted in `truncated` and remain discoverable
 * as refs in `memory_index`. Output (`entries`) is ascending by date.
 *
 * Faded/forgotten core entries are excluded — only `status: "active"`.
 */
export function buildCoreMemory(
  paths: Paths,
  username: string,
): CoreMemoryResult {
  const store = loadStore(paths, username);
  const core = store.entries.filter(
    (e) =>
      e.status === "active" && Boolean(e.core) && e.kind !== HANDOFF_KIND,
  );
  if (core.length === 0) return { entries: [] };
  const sorted = core
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // Keep newest-first so the freshest rails win the budget when tight.
  const keptIds = new Set<string>();
  let runningBytes = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i]!;
    const cost = Buffer.byteLength(e.text, "utf8");
    if (
      cost <= CORE_MEMORY_PER_ENTRY_CAP_BYTES &&
      runningBytes + cost <= CORE_MEMORY_TOTAL_BUDGET_BYTES
    ) {
      keptIds.add(e.id);
      runningBytes += cost;
    }
  }
  const entries: CoreMemoryEntry[] = sorted
    .filter((e) => keptIds.has(e.id))
    .map((e) => ({
      id: e.id,
      date: e.date,
      summary: e.summary,
      kind: e.kind ?? null,
      text: e.text,
    }));
  return {
    entries,
    ...(entries.length < core.length
      ? { truncated: { total: core.length, shown: entries.length } }
      : {}),
  };
}

function toIndexRef(e: MemoryEntry): MemoryIndexRef {
  return { id: e.id, date: e.date, summary: e.summary };
}

function toHandoffRef(e: MemoryEntry): HandoffRef {
  return {
    id: e.id,
    date: e.date,
    summary: e.summary,
    expires_at: e.expires_at ?? null,
    ...(e.handoff !== undefined ? { handoff: e.handoff } : {}),
  };
}

function toRef(e: MemoryEntry): ResumeMemoryRef {
  return {
    id: e.id,
    date: e.date,
    summary: e.summary,
    kind: e.kind ?? null,
    core: e.core ?? false,
    has_details: e.details !== undefined && e.details.length > 0,
  };
}

function toTOCRef(t: {
  slug: string;
  title: string;
  page_count: number;
  last_touched_at: string;
}): NotebookTOCRef {
  return {
    slug: t.slug,
    title: t.title,
    page_count: t.page_count,
    last_touched_at: t.last_touched_at,
  };
}

/** Project notebook load is wrapped because an invalid `project` name
 * (e.g. legacy entries in the chat router with disallowed chars)
 * shouldn't tank the whole resume payload. Bad project → empty TOC. */
function safeListProjectTopics(
  paths: Paths,
  project: string,
): ReadonlyArray<{
  slug: string;
  title: string;
  page_count: number;
  last_touched_at: string;
}> {
  try {
    return listProjectTopics(paths, project);
  } catch {
    return [];
  }
}
