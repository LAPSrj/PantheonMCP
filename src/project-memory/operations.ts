/** Project-memory CRUD operations.
 *
 * Mirrors the shape of `src/memory/operations.ts` but keyed on
 * `project` (not persona handle). Same three-tier body model, same
 * status state machine — with an `author_username` field stamped on
 * each append for blame transparency.
 *
 * Forgotten entries are kept forever: `forget` flips status; `restore`
 * flips it back. Nothing in this module deletes rows from disk. */

import type { Paths } from "../storage/index.ts";
import { loadProjectStore, mutateProjectStore } from "./store.ts";
import {
  ProjectMemoryError,
  type ProjectMemoryEntry,
  type ProjectMemoryIndexEntry,
  type ProjectMemoryStatus,
  type ProjectMemoryStore,
} from "./types.ts";

export const DETAILS_MAX_BYTES = 5 * 1024 * 1024;
export const SUMMARY_MAX_CHARS = 240;

export interface AppendProjectInput {
  summary?: string;
  text: string;
  details?: string;
  kind?: string;
  core?: boolean;
  /** Canonical persona username of the appending agent (NOT the
   * auto-suffixed chat handle). Stamped on the entry for blame. */
  author_username?: string;
  expires_at?: number;
}

export interface UpdateProjectInput {
  summary?: string;
  text?: string;
  details?: string | null;
  kind?: string;
  core?: boolean;
  status?: ProjectMemoryStatus;
}

export function appendProjectEntry(
  paths: Paths,
  project: string,
  input: AppendProjectInput,
): ProjectMemoryEntry {
  validateAppend(input);
  const summary = input.summary ?? deriveSummary(input.text);
  validateSummaryLength(summary);

  let created!: ProjectMemoryEntry;
  mutateProjectStore(paths, project, (store) => {
    const existingIds = new Set(store.entries.map((e) => e.id));
    created = {
      id: slugify(summary || input.text, existingIds),
      date: new Date().toISOString(),
      summary,
      text: input.text,
      status: "active",
      ...(input.details !== undefined ? { details: input.details } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.core ? { core: true } : {}),
      ...(input.author_username !== undefined
        ? { author_username: input.author_username }
        : {}),
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    };
    return { ...store, entries: [...store.entries, created] };
  });
  return created;
}

export function getProjectEntry(
  paths: Paths,
  project: string,
  id: string,
): ProjectMemoryEntry | null {
  const store = loadProjectStore(paths, project);
  return store.entries.find((e) => e.id === id) ?? null;
}

export function updateProjectEntry(
  paths: Paths,
  project: string,
  id: string,
  patch: UpdateProjectInput,
): ProjectMemoryEntry {
  if (patch.text !== undefined && patch.text.length === 0) {
    throw new ProjectMemoryError("missing_text", "Entry text must be non-empty.");
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
    throw new ProjectMemoryError(
      "invalid_status",
      `Invalid status '${patch.status}'. Use 'active', 'faded', or 'forgotten'.`,
    );
  }

  let updated!: ProjectMemoryEntry;
  mutateProjectStore(paths, project, (store) => {
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new ProjectMemoryError(
        "entry_not_found",
        `No project-memory entry with id '${id}' in project '${project}'.`,
      );
    }
    const current = store.entries[idx]!;
    const next: ProjectMemoryEntry = {
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
    const entries = store.entries.slice();
    entries[idx] = next;
    updated = next;
    return { ...store, entries };
  });
  return updated;
}

export function fadeProjectEntry(
  paths: Paths,
  project: string,
  id: string,
): ProjectMemoryEntry {
  return updateProjectEntry(paths, project, id, { status: "faded" });
}

/** Forget = soft tombstone. The entry stays in the file forever; it's
 * filtered out of default reads. Use `restoreProjectEntry` to surface
 * it again. */
export function forgetProjectEntry(
  paths: Paths,
  project: string,
  id: string,
): ProjectMemoryEntry {
  return updateProjectEntry(paths, project, id, { status: "forgotten" });
}

export function restoreProjectEntry(
  paths: Paths,
  project: string,
  id: string,
): ProjectMemoryEntry {
  return updateProjectEntry(paths, project, id, { status: "active" });
}

/** Get the heavy `details` payload, never inlined at render. */
export function getProjectDetails(
  paths: Paths,
  project: string,
  id: string,
): string | null {
  const entry = getProjectEntry(paths, project, id);
  if (!entry) {
    throw new ProjectMemoryError(
      "entry_not_found",
      `No project-memory entry with id '${id}' in project '${project}'.`,
    );
  }
  return entry.details ?? null;
}

export interface ListProjectFilter {
  status?: ProjectMemoryStatus | "all";
  core?: boolean;
  kind?: string;
  /** ISO date string lower bound on entry date. */
  since?: string;
  /** Case-insensitive substring against summary OR text. */
  filter?: string;
  /** Author filter — exact match on `author_username`. */
  author?: string;
}

export function listProjectIndex(
  paths: Paths,
  project: string,
  filter: ListProjectFilter = {},
): ProjectMemoryIndexEntry[] {
  const store = loadProjectStore(paths, project);
  const statusFilter = filter.status ?? "active";
  const lower = filter.filter?.toLowerCase();
  return store.entries
    .filter((e) => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (filter.core !== undefined && Boolean(e.core) !== filter.core)
        return false;
      if (filter.kind !== undefined && e.kind !== filter.kind) return false;
      if (filter.since !== undefined && e.date < filter.since) return false;
      if (filter.author !== undefined && e.author_username !== filter.author)
        return false;
      if (lower !== undefined) {
        const hay = `${e.summary}\n${e.text}`.toLowerCase();
        if (!hay.includes(lower)) return false;
      }
      return true;
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map(toIndexEntry);
}

function toIndexEntry(e: ProjectMemoryEntry): ProjectMemoryIndexEntry {
  return {
    id: e.id,
    date: e.date,
    status: e.status,
    core: Boolean(e.core),
    summary: e.summary,
    size_kb: byteLength(e.text) / 1024,
    has_details: e.details !== undefined && e.details.length > 0,
    ...(e.kind !== undefined ? { kind: e.kind } : {}),
    ...(e.author_username !== undefined ? { author_username: e.author_username } : {}),
  };
}

// --- internals -------------------------------------------------------- //

function validateAppend(input: AppendProjectInput): void {
  if (!input.text || input.text.length === 0) {
    throw new ProjectMemoryError(
      "missing_text",
      "AppendInput.text is required and must be non-empty.",
    );
  }
  if (input.details !== undefined) validateDetailsSize(input.details);
}

function validateDetailsSize(details: string): void {
  if (byteLength(details) > DETAILS_MAX_BYTES) {
    throw new ProjectMemoryError(
      "entry_too_large",
      `Details exceed the 5MB cap (${(byteLength(details) / 1_048_576).toFixed(2)} MB).`,
    );
  }
}

function validateSummaryLength(summary: string): void {
  if (summary.length > SUMMARY_MAX_CHARS) {
    throw new ProjectMemoryError(
      "summary_too_long",
      `Summary exceeds the ${SUMMARY_MAX_CHARS}-char cap (got ${summary.length}).`,
    );
  }
}

function deriveSummary(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  return firstLine.trim().slice(0, SUMMARY_MAX_CHARS);
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function slugify(input: string, existingIds: Set<string>): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "entry";
  let candidate = base;
  let counter = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter++;
  }
  return candidate;
}

/** Whole-store accessor (test/dream-pass utility). */
export function loadProjectMemoryStore(
  paths: Paths,
  project: string,
): ProjectMemoryStore {
  return loadProjectStore(paths, project);
}
