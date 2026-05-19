import type { Paths } from "../storage/index.ts";
import { loadStore } from "./store.ts";
import type { MemoryEntry, MemoryStore } from "./types.ts";

export const ACTIVE_BUDGET_BYTES = 8 * 1024;
export const CORE_BUDGET_BYTES = 10 * 1024;
export const CORE_HEAD_KEEP = 2;
export const CORE_TAIL_KEEP = 4;
const INDEX_FOOTER_THRESHOLD = 50;

export interface RenderOptions {
  include_forgotten?: boolean;
  /** When true, render ONLY the Core tier — skip Active/Index/Hidden.
   * Used by callers (typically peer-inspection like `get_memory({
   * username: other, only_core: true })`) who want the persona's
   * foundational notes without the longer working-set context. Per
   * the §6 LOW "cross-persona memory views" item. */
  only_core?: boolean;
}

export interface RenderResult {
  text: string;
  /** Loud render warning surfaced when Core collapse is active. Null
   * when nothing was collapsed. */
  warning: string | null;
}

/** §4 three-tier render. Status is NEVER mutated by this function;
 * collapse is render-time only. `recall_memory(id)` always returns
 * full text regardless of how this render rendered the entry. */
export function renderForPrompt(
  paths: Paths,
  username: string,
  options: RenderOptions = {},
): RenderResult {
  const store = loadStore(paths, username);
  return renderStore(store, options);
}

/** Pure rendering — exported for direct testing without touching disk. */
export function renderStore(
  store: MemoryStore,
  options: RenderOptions = {},
): RenderResult {
  const includeForgotten = options.include_forgotten ?? false;
  const onlyCore = options.only_core ?? false;

  const visible = store.entries.filter((e) =>
    includeForgotten ? true : e.status !== "forgotten",
  );

  if (visible.length === 0) {
    return {
      text: "Nothing yet — this is your first session. Write useful notes with `append_memory` as you work.",
      warning: null,
    };
  }

  const core = visible.filter((e) => Boolean(e.core));
  // only_core: skip the non-core tiers entirely.
  const nonCoreActive = onlyCore ? [] : visible.filter((e) => !e.core && e.status === "active");
  const nonCoreFaded = onlyCore ? [] : visible.filter((e) => !e.core && e.status === "faded");
  const forgotten = includeForgotten && !onlyCore
    ? visible.filter((e) => e.status === "forgotten")
    : [];

  const sections: string[] = [];
  let warning: string | null = null;

  // --- Core tier (10KB middle-out cap) ---
  if (core.length > 0) {
    const sortedCore = sortAscByDate(core);
    const { collapsedIds, withinBudget } = applyCoreMiddleOut(sortedCore);
    const totalKb = bytesKb(sumTextBytes(sortedCore));
    sections.push(
      "═══ CORE (core, full text)" +
        ` — ${sortedCore.length} entries, ${totalKb.toFixed(1)} KB / 10 KB ═══`,
    );
    for (const e of sortedCore) {
      sections.push(formatEntryFull(e, { collapsed: collapsedIds.has(e.id) }));
    }
    if (collapsedIds.size > 0) {
      warning =
        `Warning: ${collapsedIds.size} core entr${collapsedIds.size === 1 ? "y" : "ies"} ` +
        `collapsed to summary (over 10 KB cap) — recall_memory(id) for full text, ` +
        `or update_memory / fade_memory to prune permanently.`;
    } else if (!withinBudget) {
      warning =
        `Warning: Core total (${totalKb.toFixed(1)} KB) exceeds 10 KB cap — even with ` +
        `head_keep=${CORE_HEAD_KEEP} tail_keep=${CORE_TAIL_KEEP} preserved, ` +
        `entries are large. Consider trimming.`;
    }
    sections.push("");
  }

  // --- Active non-core (8KB byte budget; oldest beyond budget collapses) ---
  if (nonCoreActive.length > 0) {
    const sortedActive = sortAscByDate(nonCoreActive);
    const { fullIds } = applyActiveBudget(sortedActive);
    const totalKb = bytesKb(sumTextBytes(sortedActive));
    sections.push(
      "═══ ACTIVE (full text)" +
        ` — ${sortedActive.length} entries, ${totalKb.toFixed(1)} KB / 8 KB ═══`,
    );
    // Render newest first per Leandro's "newest at top" preference.
    const newestFirst = sortedActive.slice().reverse();
    for (const e of newestFirst) {
      sections.push(formatEntryFull(e, { collapsed: !fullIds.has(e.id) }));
    }
    sections.push("");
  }

  // --- Index synopsis (non-core faded entries) ---
  if (nonCoreFaded.length > 0) {
    sections.push(
      "═══ INDEX (synopsis only — `recall_memory(id)` to expand) ═══",
    );
    const sortedFaded = sortDescByDate(nonCoreFaded);
    const visibleIndex = sortedFaded.slice(0, INDEX_FOOTER_THRESHOLD);
    for (const e of visibleIndex) {
      sections.push(formatIndexLine(e));
    }
    if (sortedFaded.length > INDEX_FOOTER_THRESHOLD) {
      sections.push(
        `[+${sortedFaded.length - INDEX_FOOTER_THRESHOLD} more — call ` +
          `\`list_memory\` to filter]`,
      );
    }
    sections.push("");
  }

  // --- Forgotten (only when explicitly requested) ---
  if (forgotten.length > 0) {
    sections.push("═══ HIDDEN (forgotten — shown by request) ═══");
    for (const e of sortDescByDate(forgotten)) {
      sections.push(formatIndexLine(e));
    }
    sections.push("");
  }

  const body = sections.join("\n").trimEnd();
  return { text: body, warning };
}

// --- helpers --------------------------------------------------------------

function sortAscByDate<T extends { date: string }>(arr: T[]): T[] {
  return arr.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function sortDescByDate<T extends { date: string }>(arr: T[]): T[] {
  return arr.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function bytesKb(b: number): number {
  return b / 1024;
}

function sumTextBytes(entries: MemoryEntry[]): number {
  return entries.reduce((sum, e) => sum + bytes(e.text), 0);
}

/** Middle-out collapse policy:
 *
 * Sort entries ascending by date. Always keep the oldest `CORE_HEAD_KEEP`
 * and the newest `CORE_TAIL_KEEP` entries as full text — they anchor
 * the timeline. The middle is the budget-elastic region: collapse middle
 * entries (from the center outward) one at a time until the total full-
 * text byte count fits in `CORE_BUDGET_BYTES`.
 *
 * If even with the entire middle collapsed we're still over budget, the
 * head + tail entries themselves are larger than 10 KB. In that case
 * we leave them as-is and emit a loud warning — auto-fading the user's
 * own pinned core entries is explicitly forbidden by §4 ("status NEVER
 * auto-mutates").
 */
function applyCoreMiddleOut(sorted: MemoryEntry[]): {
  collapsedIds: Set<string>;
  withinBudget: boolean;
} {
  const collapsed = new Set<string>();
  const total = sumTextBytes(sorted);
  if (total <= CORE_BUDGET_BYTES) {
    return { collapsedIds: collapsed, withinBudget: true };
  }
  const middleStart = CORE_HEAD_KEEP;
  const middleEnd = sorted.length - CORE_TAIL_KEEP;
  if (middleEnd <= middleStart) {
    // Nothing to collapse — head + tail span the entire list.
    return { collapsedIds: collapsed, withinBudget: false };
  }
  const middleIndices = orderFromCenterOutward(middleStart, middleEnd);
  let runningBytes = total;
  for (const idx of middleIndices) {
    if (runningBytes <= CORE_BUDGET_BYTES) break;
    const entry = sorted[idx]!;
    collapsed.add(entry.id);
    runningBytes -= bytes(entry.text);
  }
  return { collapsedIds: collapsed, withinBudget: runningBytes <= CORE_BUDGET_BYTES };
}

/** Walk indices in [start, end) from the center outward. Used so the
 * first entries collapsed are the ones farthest from both anchors. */
function orderFromCenterOutward(start: number, end: number): number[] {
  const out: number[] = [];
  if (end <= start) return out;
  const center = (start + end - 1) / 2;
  const indices: { i: number; d: number }[] = [];
  for (let i = start; i < end; i++) {
    indices.push({ i, d: Math.abs(i - center) });
  }
  // Closest to center first (so they collapse first); ties broken by
  // newer-first to keep the older anchor of the middle visible longer.
  indices.sort((a, b) => (a.d !== b.d ? a.d - b.d : b.i - a.i));
  for (const { i } of indices) out.push(i);
  return out;
}

/** §4 / §11b — Active non-core budget: 8KB byte budget. Newest entries
 * are kept full first; oldest entries beyond the budget render as
 * summary-only inline. */
function applyActiveBudget(sorted: MemoryEntry[]): {
  fullIds: Set<string>;
} {
  const full = new Set<string>();
  let runningBytes = 0;
  // Walk newest → oldest, accumulating until we cross the budget.
  for (let i = sorted.length - 1; i >= 0; i--) {
    const entry = sorted[i]!;
    const cost = bytes(entry.text);
    if (runningBytes + cost <= ACTIVE_BUDGET_BYTES || full.size === 0) {
      // Always keep at least the newest entry full, even if oversized.
      full.add(entry.id);
      runningBytes += cost;
    } else {
      // Budget exhausted — older entries collapse to summary-only.
    }
  }
  return { fullIds: full };
}

interface FullFormatOpts {
  collapsed: boolean;
}

function formatEntryFull(entry: MemoryEntry, opts: FullFormatOpts): string {
  const parts: string[] = [];
  const dateShort = entry.date.slice(0, 10);
  const tags: string[] = [];
  if (entry.kind) tags.push(`kind=${entry.kind}`);
  if (entry.status === "faded") tags.push("faded");
  if (entry.details !== undefined) tags.push("has_details");
  const tagSuffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
  parts.push(`#### [${entry.id}] (${dateShort})${tagSuffix}`);
  parts.push(`> ${entry.summary}`);
  if (opts.collapsed) {
    parts.push(
      `_(collapsed; ${kbLabel(entry.text)} body — \`recall_memory("${entry.id}")\` for full text)_`,
    );
  } else {
    parts.push(entry.text);
  }
  return parts.join("\n");
}

function formatIndexLine(entry: MemoryEntry): string {
  const dateShort = entry.date.slice(0, 10);
  const tags: string[] = [];
  if (entry.kind) tags.push(`kind=${entry.kind}`);
  tags.push(kbLabel(entry.text));
  if (entry.details !== undefined) tags.push("has_details");
  const summarySnippet =
    entry.summary.length > 0 ? entry.summary : truncate(firstLine(entry.text), 80);
  // §6 MEDIUM annotations: render `↳` prefix when this entry is a
  // reply, and append `[see_also: a, b]` cite when set. Indent is
  // format-time only — the persisted `replies_to` is the source of
  // truth.
  const prefix = entry.replies_to ? "  ↳ " : "- ";
  const seeAlsoCite =
    entry.see_also && entry.see_also.length > 0
      ? ` [see_also: ${entry.see_also.join(", ")}]`
      : "";
  return `${prefix}[${entry.id}] (${dateShort}, ${tags.join(", ")}) ${summarySnippet}${seeAlsoCite}`;
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim().length > 0) ?? "";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function kbLabel(text: string): string {
  const b = bytes(text);
  if (b < 1024) return `${b}B`;
  return `${(b / 1024).toFixed(1)}KB`;
}
