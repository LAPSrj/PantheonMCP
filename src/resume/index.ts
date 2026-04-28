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
 * Bounded by a soft byte budget (~2 KB rendered) so the summary
 * stays cheap. Full retrieval is via the existing tools
 * (`list_memory`, `recall_memory`, `check_messages`). */

import type { Paths } from "../storage/index.ts";
import { loadStore } from "../memory/store.ts";
import type { MemoryEntry } from "../memory/types.ts";

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
}

export interface ResumeMemoryRef {
  id: string;
  date: string;
  summary: string;
  kind: string | null;
  core: boolean;
  has_details: boolean;
}

export interface ResumeOptions {
  /** Cap on `recent_memory` entries. Default 5. */
  recent_memory_limit?: number;
}

const DEFAULT_RECENT_LIMIT = 5;

export function buildResumeSummary(
  paths: Paths,
  username: string,
  options: ResumeOptions = {},
): ResumeSummary {
  const limit = options.recent_memory_limit ?? DEFAULT_RECENT_LIMIT;
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
  return {
    last_status: null,
    recent_memory: recent,
    memory_by_kind: byKind,
    active_memory_count: active.length,
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
