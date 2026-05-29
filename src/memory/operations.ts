import type { Paths } from "../storage/index.ts";
import { loadStore, mutateStore } from "./store.ts";
import { deriveSummary, slugify, SUMMARY_MAX_CHARS } from "./derive.ts";
import {
  MemoryError,
  type HandoffMeta,
  type MemoryEntry,
  type MemoryIndexEntry,
  type MemoryStatus,
  type MemoryStore,
} from "./types.ts";

/** §4 / §12-H — `details` field hard cap. Enforced at the API boundary
 * AND inside the store mutator (defense in depth). */
export const DETAILS_MAX_BYTES = 5 * 1024 * 1024;
// SUMMARY_MAX_CHARS + deriveSummary + slugify now live in `derive.ts`
// (imported above) so `validation.ts` can reuse them without an import
// cycle. Re-export the two that index.ts surfaces.
export { SUMMARY_MAX_CHARS, deriveSummary };

/** Kind tag for handoff entries. Mirrors `HANDOFF_KIND` in
 * `handoffs.ts` — kept as a local literal here to avoid an import
 * cycle through the handoff → identity modules. */
const HANDOFF_KIND = "handoff";

/** Handoffs are structurally barred from the Core tier. A handoff is
 * an ephemeral 7-day continuity note, not a durable foundational rail:
 * `core: true` on a handoff is core-inflation — it forces multi-KB
 * session snapshots into the Core render tier and the boot payload,
 * where they crowd out the actual standing rules Core exists for.
 * Handoffs surface on their own via `resume_summary.handoffs`.
 *
 * Enforced here at the data layer (not just one handler) so the
 * invariant holds for every write path: `append_memory`,
 * `rest({ handoff })`, dream consolidation, direct `update_memory`.
 * Coercion is silent — like the lifecycle forget→fade coercion, it's
 * a structural invariant, not a caller error. */
function coreAllowedForKind(kind: string | undefined): boolean {
  return kind !== HANDOFF_KIND;
}

/** Redesign-v2 schema-additive fields, picked from an input only when
 * present. Centralised so `appendEntry` and `setMemory` stay in sync as
 * the field set grows across phases. Behavior (validation, decay,
 * render) lands in later phases; P1 only persists. */
function v2Fields(input: {
  topic?: string;
  pin?: boolean;
  pin_reason?: string;
  due?: number | "next-session";
  supersedes?: string;
  session_seq?: number;
  matched?: number;
  last_matched_seq?: number;
}): Partial<MemoryEntry> {
  const out: Partial<MemoryEntry> = {};
  if (input.topic !== undefined) out.topic = input.topic;
  if (input.pin !== undefined) out.pin = input.pin;
  if (input.pin_reason !== undefined) out.pin_reason = input.pin_reason;
  if (input.due !== undefined) out.due = input.due;
  if (input.supersedes !== undefined) out.supersedes = input.supersedes;
  if (input.session_seq !== undefined) out.session_seq = input.session_seq;
  if (input.matched !== undefined) out.matched = input.matched;
  if (input.last_matched_seq !== undefined) {
    out.last_matched_seq = input.last_matched_seq;
  }
  return out;
}

export interface AppendInput {
  /** Optional ≤240 char headline. When omitted, derived from `text`'s
   * first non-empty line. */
  summary?: string;
  /** Required body. Counts toward the Core/Active byte budget. */
  text: string;
  /** Optional ≤5MB unbounded payload. Never inlined at startup. */
  details?: string;
  kind?: string;
  core?: boolean;
  summoner_username?: string;
  /** ms-epoch expiry timestamp (§6 MEDIUM handoff slot). The daemon-
   * tick auto-fades past this. Optional; entries without `expires_at`
   * never auto-fade. */
  expires_at?: number;
  /** §6 MEDIUM annotations: entry id this entry replies to. Must
   * exist in the same persona's memory. */
  replies_to?: string;
  /** §6 MEDIUM annotations: entry ids cited inline at end of
   * synopsis. Each must exist. */
  see_also?: string[];
  /** Structured handoff metadata — set only for `kind: "handoff"`
   * entries written via `rest({ handoff })`. */
  handoff?: HandoffMeta;
  // ── Redesign v2 (schema-additive; behavior lands in later phases).
  topic?: string;
  pin?: boolean;
  pin_reason?: string;
  due?: number | "next-session";
  supersedes?: string;
  session_seq?: number;
  matched?: number;
  last_matched_seq?: number;
}

export interface UpdateInput {
  summary?: string;
  text?: string;
  details?: string | null;
  kind?: string;
  core?: boolean;
  status?: MemoryStatus;
  replies_to?: string | null;
  see_also?: string[] | null;
  // ── Redesign v2 patch fields (null clears where sensible).
  topic?: string;
  pin?: boolean;
  pin_reason?: string;
  due?: number | "next-session" | null;
  supersedes?: string;
  matched?: number;
  last_matched_seq?: number;
}

export function appendEntry(
  paths: Paths,
  username: string,
  input: AppendInput,
): MemoryEntry {
  validateAppend(input);
  const summary = input.summary ?? deriveSummary(input.text);
  validateSummaryLength(summary);

  let created!: MemoryEntry;
  mutateStore(paths, username, (store) => {
    const existingIds = new Set(store.entries.map((e) => e.id));
    // §6 MEDIUM annotations: validate references against this
    // persona's memory before persisting. Invalid refs reject with
    // `invalid_reference` so the caller knows their annotation
    // pointed at a missing entry.
    if (input.replies_to !== undefined) {
      validateReference(input.replies_to, existingIds, "replies_to");
    }
    if (input.see_also !== undefined) {
      for (const ref of input.see_also) {
        validateReference(ref, existingIds, "see_also");
      }
    }
    created = {
      id: slugify(summary || input.text, existingIds, input.topic),
      date: new Date().toISOString(),
      summary,
      text: input.text,
      status: "active",
      ...(input.details !== undefined ? { details: input.details } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.core && coreAllowedForKind(input.kind) ? { core: true } : {}),
      ...(input.summoner_username !== undefined
        ? { summoner_username: input.summoner_username }
        : {}),
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
      ...(input.handoff !== undefined ? { handoff: input.handoff } : {}),
      ...(input.replies_to !== undefined ? { replies_to: input.replies_to } : {}),
      ...(input.see_also !== undefined && input.see_also.length > 0
        ? { see_also: [...input.see_also] }
        : {}),
      ...v2Fields(input),
    };
    return { ...store, entries: [...store.entries, created] };
  });
  return created;
}

function validateReference(
  ref: string,
  existingIds: Set<string>,
  field: string,
): void {
  if (!existingIds.has(ref)) {
    throw new MemoryError(
      "invalid_reference",
      `${field} references unknown entry id '${ref}'.`,
      { field, ref },
    );
  }
}

/** §16 — bump the per-persona session ordinal and return the new value.
 * Called once per conversation at the first `load_memory`. Atomic via
 * the mtime-guarded store mutator so sibling incarnations don't reuse a
 * seq. A legacy store with no `session_seq` starts at 1. */
export function beginSession(paths: Paths, username: string): number {
  let next = 1;
  mutateStore(paths, username, (store) => {
    next = (store.session_seq ?? 0) + 1;
    return { ...store, session_seq: next };
  });
  return next;
}

export function getEntry(
  paths: Paths,
  username: string,
  id: string,
): MemoryEntry | null {
  const store = loadStore(paths, username);
  return store.entries.find((e) => e.id === id) ?? null;
}

export function updateEntry(
  paths: Paths,
  username: string,
  id: string,
  patch: UpdateInput,
): MemoryEntry {
  if (patch.text !== undefined && patch.text.length === 0) {
    throw new MemoryError("missing_text", "Entry text must be non-empty.");
  }
  if (patch.summary !== undefined) validateSummaryLength(patch.summary);
  if (patch.details !== undefined && patch.details !== null) {
    validateDetailsSize(patch.details);
  }
  if (
    patch.status !== undefined &&
    patch.status !== "active" &&
    patch.status !== "faded" &&
    patch.status !== "forgotten"
  ) {
    throw new MemoryError(
      "invalid_status",
      `Invalid status '${patch.status}'. Use 'active', 'faded', or 'forgotten'.`,
    );
  }

  let updated!: MemoryEntry;
  mutateStore(paths, username, (store) => {
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new MemoryError("entry_not_found", `No memory entry with id '${id}'.`);
    }
    const current = store.entries[idx]!;
    // Validate annotation refs against the rest of the store (the
    // entry being updated is also a valid target — self-reference
    // is silly but not invalid_reference territory).
    const existingIds = new Set(store.entries.map((e) => e.id));
    if (patch.replies_to !== undefined && patch.replies_to !== null) {
      validateReference(patch.replies_to, existingIds, "replies_to");
    }
    if (patch.see_also !== undefined && patch.see_also !== null) {
      for (const ref of patch.see_also) {
        validateReference(ref, existingIds, "see_also");
      }
    }
    const next: MemoryEntry = {
      ...current,
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    };
    if (patch.details === null) {
      delete next.details;
    } else if (patch.details !== undefined) {
      next.details = patch.details;
    }
    if (patch.core !== undefined) {
      if (patch.core) next.core = true;
      else delete next.core;
    }
    // Handoffs can never be Core (see `coreAllowedForKind`). If this
    // update leaves the entry a handoff — whether it already was one
    // or `kind` was just changed to "handoff" — strip core regardless
    // of what the patch or the prior entry carried.
    if (next.core && !coreAllowedForKind(next.kind)) {
      delete next.core;
    }
    if (patch.replies_to === null) {
      delete next.replies_to;
    } else if (patch.replies_to !== undefined) {
      next.replies_to = patch.replies_to;
    }
    if (patch.see_also === null) {
      delete next.see_also;
    } else if (patch.see_also !== undefined) {
      next.see_also = [...patch.see_also];
    }
    // v2 patch fields. `...current` already preserved any existing
    // values; apply explicit patches here.
    if (patch.topic !== undefined) next.topic = patch.topic;
    if (patch.pin !== undefined) {
      if (patch.pin) next.pin = true;
      else {
        delete next.pin;
        delete next.pin_reason;
      }
    }
    if (patch.pin_reason !== undefined) next.pin_reason = patch.pin_reason;
    if (patch.due === null) {
      delete next.due;
    } else if (patch.due !== undefined) {
      next.due = patch.due;
    }
    if (patch.supersedes !== undefined) next.supersedes = patch.supersedes;
    if (patch.matched !== undefined) next.matched = patch.matched;
    if (patch.last_matched_seq !== undefined) {
      next.last_matched_seq = patch.last_matched_seq;
    }
    const entries = store.entries.slice();
    entries[idx] = next;
    updated = next;
    return { ...store, entries };
  });
  return updated;
}

/** §13 explicit user calls only — sets status to faded. Status NEVER
 * auto-mutates from render-time budget enforcement. */
export function fadeEntry(
  paths: Paths,
  username: string,
  id: string,
): MemoryEntry {
  return updateEntry(paths, username, id, { status: "faded" });
}

export function forgetEntry(
  paths: Paths,
  username: string,
  id: string,
): MemoryEntry {
  return updateEntry(paths, username, id, { status: "forgotten" });
}

/** `recall_memory(id)` — §4: returns full text regardless of render
 * tier. The render layer collapses to summary; this path always
 * returns the body. Also flips faded → active per summon-mcp parity. */
export function recallEntry(
  paths: Paths,
  username: string,
  id: string,
): MemoryEntry {
  let recalled!: MemoryEntry;
  mutateStore(paths, username, (store) => {
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new MemoryError("entry_not_found", `No memory entry with id '${id}'.`);
    }
    const current = store.entries[idx]!;
    if (current.status === "active") {
      recalled = current;
      return undefined;
    }
    const next: MemoryEntry = { ...current, status: "active" };
    const entries = store.entries.slice();
    entries[idx] = next;
    recalled = next;
    return { ...store, entries };
  });
  return recalled;
}

/** Returns `details` only. The natural read path for the heavy
 * payload — never bundled into the startup render. */
export function getDetails(
  paths: Paths,
  username: string,
  id: string,
): string | null {
  const entry = getEntry(paths, username, id);
  if (!entry) {
    throw new MemoryError("entry_not_found", `No memory entry with id '${id}'.`);
  }
  return entry.details ?? null;
}

/** `set_memory` — replace the entire active entry list with a single
 * new entry. Rare; preserved for parity with summon-mcp. */
export function setMemory(
  paths: Paths,
  username: string,
  input: AppendInput,
): MemoryEntry {
  validateAppend(input);
  const summary = input.summary ?? deriveSummary(input.text);
  validateSummaryLength(summary);

  const entry: MemoryEntry = {
    id: slugify(summary || input.text, new Set(), input.topic),
    date: new Date().toISOString(),
    summary,
    text: input.text,
    status: "active",
    ...(input.details !== undefined ? { details: input.details } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.core && coreAllowedForKind(input.kind) ? { core: true } : {}),
    ...(input.summoner_username !== undefined
      ? { summoner_username: input.summoner_username }
      : {}),
    ...v2Fields(input),
  };
  mutateStore(paths, username, (store) => ({
    ...store,
    entries: [entry],
  }));
  return entry;
}

export interface ListIndexFilter {
  status?: MemoryStatus | "all";
  core?: boolean;
  kind?: string;
  /** ISO date string lower bound on entry date. */
  since?: string;
  /** Substring match (case-insensitive) against summary OR text. */
  filter?: string;
}

/** §11b `list_memory` — index-shape only, no inline bodies. Sorted
 * by date descending (newest at top) per §12-H. */
export function listIndex(
  paths: Paths,
  username: string,
  options: ListIndexFilter = {},
): MemoryIndexEntry[] {
  const store = loadStore(paths, username);
  const status = options.status ?? "active";
  const matches = store.entries.filter((e) => {
    if (status !== "all" && e.status !== status) return false;
    if (options.core !== undefined && Boolean(e.core) !== options.core) return false;
    if (options.kind !== undefined && e.kind !== options.kind) return false;
    if (options.since !== undefined && e.date < options.since) return false;
    if (options.filter !== undefined) {
      const f = options.filter.toLowerCase();
      const hay = `${e.summary}\n${e.text}`.toLowerCase();
      if (!hay.includes(f)) return false;
    }
    return true;
  });
  matches.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return matches.map(toIndexEntry);
}

function toIndexEntry(e: MemoryEntry): MemoryIndexEntry {
  return {
    id: e.id,
    date: e.date,
    status: e.status,
    core: Boolean(e.core),
    summary: e.summary,
    size_kb: byteSizeKb(e.text),
    has_details: e.details !== undefined,
    ...(e.kind !== undefined ? { kind: e.kind } : {}),
    ...(e.topic !== undefined ? { topic: e.topic } : {}),
  };
}

/** §6 LOW — cross-agent search. Walk one or many persona memory
 * stores and return matching entries with `username` attached so
 * callers can route follow-ups (e.g. `recall_memory({ id, username })`).
 *
 * Caller passes the usernames list — the MCP handler resolves
 * `scope: "self" | "all"` against `listPersonas` before calling.
 * This keeps the operation pure (no registry coupling) and testable
 * with arbitrary fixture lists. Sorted newest-first across the union;
 * results capped at `filter.limit` (default 50). */
export interface FindMemoryFilter {
  query: string;
  kind?: string;
  since?: string;
  status?: "active" | "faded" | "forgotten" | "all";
  core?: boolean;
  /** Cap on total results across all personas. Default 50. */
  limit?: number;
}

export interface FindMemoryHit extends MemoryIndexEntry {
  username: string;
}

export function findMemory(
  paths: Paths,
  usernames: ReadonlyArray<string>,
  filter: FindMemoryFilter,
): FindMemoryHit[] {
  const limit = filter.limit ?? 50;
  const baseFilter: ListIndexFilter = {
    filter: filter.query,
    ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.status !== undefined ? { status: filter.status } : {}),
    ...(filter.core !== undefined ? { core: filter.core } : {}),
  };
  const out: FindMemoryHit[] = [];
  for (const username of usernames) {
    const matches = listIndex(paths, username, baseFilter);
    for (const m of matches) out.push({ ...m, username });
  }
  // listIndex returns newest-first per-persona; re-sort the union.
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out.slice(0, limit);
}

function byteSizeKb(text: string): number {
  return Math.round((Buffer.byteLength(text, "utf8") / 1024) * 10) / 10;
}

function validateAppend(input: AppendInput): void {
  if (!input.text || input.text.length === 0) {
    throw new MemoryError("missing_text", "Entry text is required.");
  }
  if (input.details !== undefined) validateDetailsSize(input.details);
}

function validateSummaryLength(summary: string): void {
  if (summary.length > SUMMARY_MAX_CHARS) {
    throw new MemoryError(
      "summary_too_long",
      `Summary is ${summary.length} chars; cap is ${SUMMARY_MAX_CHARS}. Trim or move detail to text/details.`,
      { length: summary.length, cap: SUMMARY_MAX_CHARS },
    );
  }
}

function validateDetailsSize(details: string): void {
  const bytes = Buffer.byteLength(details, "utf8");
  if (bytes > DETAILS_MAX_BYTES) {
    throw new MemoryError(
      "entry_too_large",
      `details payload is ${bytes} bytes; cap is ${DETAILS_MAX_BYTES} (5 MB).`,
      { bytes, cap: DETAILS_MAX_BYTES },
    );
  }
}

export type { MemoryStore };
