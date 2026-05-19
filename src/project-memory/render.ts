/** Project-memory render — produces the PROJECT tier shown at login
 * for any agent in that project. Same three-tier shape as persona
 * memory but with separate budgets so chatty project memory doesn't
 * squeeze persona context.
 *
 * Status is never mutated here — collapse is render-time only. */

import type { Paths } from "../storage/index.ts";
import { loadProjectStore } from "./store.ts";
import type {
  ProjectMemoryEntry,
  ProjectMemoryStore,
} from "./types.ts";

export const PROJECT_CORE_BUDGET_BYTES = 6 * 1024;
export const PROJECT_ACTIVE_BUDGET_BYTES = 4 * 1024;

export interface ProjectRenderResult {
  text: string;
  warning: string | null;
}

export function renderProjectMemory(
  paths: Paths,
  project: string,
): ProjectRenderResult {
  return renderProjectStore(loadProjectStore(paths, project), project);
}

export function renderProjectStore(
  store: ProjectMemoryStore,
  project: string,
): ProjectRenderResult {
  const visible = store.entries.filter((e) => e.status !== "forgotten");
  if (visible.length === 0) {
    return {
      text: `═══ PROJECT MEMORY: ${project} (shared) — no entries yet ═══`,
      warning: null,
    };
  }
  const core = visible.filter((e) => Boolean(e.core));
  const active = visible.filter((e) => !e.core && e.status === "active");
  const faded = visible.filter((e) => !e.core && e.status === "faded");

  const lines: string[] = [];
  let warning: string | null = null;

  if (core.length > 0) {
    const coreBytes = sumTextBytes(core);
    lines.push(
      `═══ PROJECT MEMORY: ${project} — CORE (shared, full text)` +
        ` — ${core.length} entries, ${(coreBytes / 1024).toFixed(1)} KB / ${PROJECT_CORE_BUDGET_BYTES / 1024} KB ═══`,
    );
    const collapsedIds = applyMiddleOut(core, PROJECT_CORE_BUDGET_BYTES);
    if (collapsedIds.size > 0) {
      warning =
        `Warning: ${collapsedIds.size} project-memory core entries collapsed to summary (over ${PROJECT_CORE_BUDGET_BYTES / 1024} KB cap).`;
    }
    for (const e of sortAscByDate(core)) {
      lines.push(formatEntry(e, { collapsed: collapsedIds.has(e.id) }));
    }
  }

  if (active.length > 0) {
    const activeBytes = sumTextBytes(active);
    lines.push(
      `═══ PROJECT MEMORY: ${project} — ACTIVE (shared)` +
        ` — ${active.length} entries, ${(activeBytes / 1024).toFixed(1)} KB / ${PROJECT_ACTIVE_BUDGET_BYTES / 1024} KB ═══`,
    );
    const collapsedIds = applyOldestFirst(active, PROJECT_ACTIVE_BUDGET_BYTES);
    for (const e of sortDescByDate(active)) {
      lines.push(formatEntry(e, { collapsed: collapsedIds.has(e.id) }));
    }
  }

  if (faded.length > 0) {
    lines.push(
      `═══ PROJECT MEMORY: ${project} — FADED (${faded.length} entries; summary only) ═══`,
    );
    for (const e of sortDescByDate(faded)) {
      lines.push(`#### [${e.id}] (${e.date.slice(0, 10)})${authorTag(e)}`);
      lines.push(`> ${e.summary}`);
    }
  }

  return { text: lines.join("\n"), warning };
}

function authorTag(e: ProjectMemoryEntry): string {
  return e.author_username ? ` (by @${e.author_username})` : "";
}

function formatEntry(
  e: ProjectMemoryEntry,
  options: { collapsed: boolean },
): string {
  const header = `#### [${e.id}] (${e.date.slice(0, 10)})${authorTag(e)}${e.kind ? ` (kind=${e.kind})` : ""}`;
  if (options.collapsed) {
    return [
      header,
      `> ${e.summary}`,
      `_(collapsed; ${(byteLength(e.text) / 1024).toFixed(1)} KB body — \`recall_project_memory("${e.id}")\` for full text)_`,
    ].join("\n");
  }
  return [header, `> ${e.summary}`, e.text].join("\n");
}

function sumTextBytes(entries: ProjectMemoryEntry[]): number {
  return entries.reduce((sum, e) => sum + byteLength(e.text), 0);
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function sortAscByDate(entries: ProjectMemoryEntry[]): ProjectMemoryEntry[] {
  return entries.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
}

function sortDescByDate(entries: ProjectMemoryEntry[]): ProjectMemoryEntry[] {
  return entries.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Core middle-out collapse: keep first 2 + last 4, collapse the rest
 * until under budget. */
function applyMiddleOut(
  entries: ProjectMemoryEntry[],
  budget: number,
): Set<string> {
  const collapsed = new Set<string>();
  const sorted = sortAscByDate(entries);
  if (sumTextBytes(sorted) <= budget) return collapsed;
  const HEAD = 2;
  const TAIL = 4;
  // Collapse from the middle out — entries past the head/tail boundary
  // first, then expand inward as needed.
  const middleStart = HEAD;
  const middleEnd = sorted.length - TAIL;
  for (let i = middleStart; i < middleEnd; i++) {
    collapsed.add(sorted[i]!.id);
    if (sumTextBytes(sorted.filter((e) => !collapsed.has(e.id))) <= budget) {
      return collapsed;
    }
  }
  return collapsed;
}

/** Active oldest-first collapse: drop the eldest entries' text first
 * until under budget. */
function applyOldestFirst(
  entries: ProjectMemoryEntry[],
  budget: number,
): Set<string> {
  const collapsed = new Set<string>();
  const sorted = sortAscByDate(entries);
  for (const e of sorted) {
    if (sumTextBytes(sorted.filter((x) => !collapsed.has(x.id))) <= budget) {
      return collapsed;
    }
    collapsed.add(e.id);
  }
  return collapsed;
}
