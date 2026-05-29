import type { Paths } from "../storage/index.ts";
import { loadStore } from "./store.ts";
import {
  ALWAYS_SUMMARY_BUDGET_BYTES,
  NOTES_PER_TOPIC,
  PIN_FULL_BUDGET_BYTES,
  TOPIC_FULL_BUDGET_BYTES,
  byteLen,
} from "./budgets.ts";
import {
  ALWAYS_TOPIC,
  entryTopic,
  mapLegacyKind,
} from "./taxonomy.ts";
import type { MemoryEntry, MemoryStore } from "./types.ts";

// Legacy budget names kept exported so callers/tests that imported them
// from the old three-tier render still resolve. They now map onto the
// v2 budgets (pinned ≈ old Core; topic-full ≈ old Active).
export const ACTIVE_BUDGET_BYTES = TOPIC_FULL_BUDGET_BYTES;
export const CORE_BUDGET_BYTES = PIN_FULL_BUDGET_BYTES;
export const CORE_HEAD_KEEP = 2;
export const CORE_TAIL_KEEP = 4;

/** Implicit topic for legacy entries that carry neither a `topic` field
 * nor a slug domain. Always rendered (the agent can't "declare" it), so
 * un-migrated personas keep seeing their working set until a dream /
 * manual pass re-topics those entries. */
const UNTOPICED = "(untopiced)";

export interface RenderOptions {
  include_forgotten?: boolean;
  /** Render ONLY the always-loaded surface (pinned FULL + `always`
   * SUMMARY) — the v2 analog of the old `only_core`. Used for cheap
   * peer-inspection (`get_memory({ username: other, only_core: true })`). */
  only_core?: boolean;
  /** §6 — the topics declared this session via `load_memory`. Entries
   * under these topics render at full detail; everything else is a menu
   * count. The implicit `(untopiced)` bucket is always loaded. */
  loaded_topics?: string[];
  /** Override "now" for deterministic due-reminder tests. */
  now?: number;
}

export interface RenderResult {
  text: string;
  /** Loud render warning surfaced when a budget guard collapses
   * entries. Null when nothing was collapsed. */
  warning: string | null;
}

/** §6 topic-scoped render. Status is NEVER mutated here; collapse is
 * render-time only and `recall_memory(id)` always returns full text. */
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
  const now = options.now ?? Date.now();
  const loaded = new Set([...(options.loaded_topics ?? []), UNTOPICED]);

  const visible = store.entries.filter((e) =>
    includeForgotten ? true : e.status !== "forgotten",
  );

  if (visible.length === 0) {
    return {
      text: "Nothing yet — this is your first session. Write useful notes with `append_memory` as you work (durable kinds need a `topic`).",
      warning: null,
    };
  }

  const sections: string[] = [];
  const warnings: string[] = [];

  // A pin (or legacy core) renders FULL every session, regardless of
  // topic. `core` is still honored until the core→pin migration lands.
  const isPinned = (e: MemoryEntry) => Boolean(e.pin) || Boolean(e.core);
  const pinned = visible.filter(isPinned);
  const unpinned = visible.filter((e) => !isPinned(e));

  // --- DUE REMINDERS (top, full, regardless of topic) ---
  if (!onlyCore) {
    const due = unpinned
      .filter((e) => mapLegacyKind(e.kind) === "reminder" && isReminderDue(e, now))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (due.length > 0) {
      sections.push("═══ DUE REMINDERS ═══");
      for (const e of due) sections.push(formatFull(e));
      sections.push("");
    }
  }

  // --- PINNED (full text, byte-budgeted; reject→consolidate guard at
  //     write, oldest→summary demotion here) ---
  if (pinned.length > 0) {
    const sorted = sortAscByDate(pinned);
    const { summaryIds, over } = budgetFullNewestFirst(sorted, PIN_FULL_BUDGET_BYTES);
    const totalKb = (sumBytes(sorted, (e) => e.text) / 1024).toFixed(1);
    sections.push(
      `═══ PINNED (full text) — ${sorted.length} entries, ${totalKb} KB / ${(
        PIN_FULL_BUDGET_BYTES / 1024
      ).toFixed(0)} KB ═══`,
    );
    for (const e of sorted.slice().reverse()) {
      sections.push(formatFull(e, { collapsed: summaryIds.has(e.id) }));
    }
    if (summaryIds.size > 0) {
      warnings.push(
        `${summaryIds.size} pinned entr${summaryIds.size === 1 ? "y" : "ies"} collapsed to summary (over ${(
          PIN_FULL_BUDGET_BYTES / 1024
        ).toFixed(0)} KB pin budget) — unpin or consolidate.`,
      );
    } else if (over) {
      warnings.push(
        `Pinned set exceeds the ${(PIN_FULL_BUDGET_BYTES / 1024).toFixed(0)} KB budget even collapsed — consolidate.`,
      );
    }
    sections.push("");
  }

  if (onlyCore) {
    // Peer-inspection: pinned + always summaries only.
    appendAlways(sections, warnings, unpinned, true);
    return finalize(sections, warnings);
  }

  // --- ALWAYS (summary, byte-budgeted) ---
  appendAlways(sections, warnings, unpinned, false);

  // --- DECLARED TOPICS (load × detail ladder) ---
  // Group unpinned, non-always, non-reminder entries by topic.
  const byTopic = new Map<string, MemoryEntry[]>();
  for (const e of unpinned) {
    const kind = mapLegacyKind(e.kind);
    if (kind === "reminder") continue;
    const topic = entryTopic(e) ?? UNTOPICED;
    if (topic === ALWAYS_TOPIC) continue;
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic)!.push(e);
  }

  const loadedTopicNames = [...byTopic.keys()]
    .filter((t) => loaded.has(t))
    .sort((a, b) => (a === UNTOPICED ? 1 : b === UNTOPICED ? -1 : a < b ? -1 : 1));

  for (const topic of loadedTopicNames) {
    renderTopic(sections, warnings, topic, byTopic.get(topic)!);
  }

  // --- DELIVERED HANDOFFS (A ∩ H ≠ ∅) ---
  const handoffs = unpinned.filter((e) => mapLegacyKind(e.kind) === "handoff");
  const delivered = handoffs.filter((e) => {
    const t = entryTopic(e);
    return t !== null && loaded.has(t);
  });
  if (delivered.length > 0) {
    sections.push("═══ DELIVERED HANDOFFS (fade if not needed) ═══");
    for (const e of sortDescByDate(delivered)) sections.push(formatFull(e));
    sections.push("");
  }

  // --- NOT LOADED (menu counts only) ---
  const menu = [...byTopic.entries()]
    .filter(([t]) => !loaded.has(t))
    .map(([t, entries]) => `${t}(${entries.filter((e) => e.status !== "forgotten").length})`)
    .sort();
  if (menu.length > 0) {
    sections.push("═══ NOT LOADED (load_memory to expand) ═══");
    sections.push(menu.join("  "));
    sections.push("");
  }

  // --- HIDDEN (forgotten — only when explicitly requested) ---
  if (includeForgotten) {
    const forgotten = visible.filter((e) => e.status === "forgotten");
    if (forgotten.length > 0) {
      sections.push("═══ HIDDEN (forgotten — shown by request) ═══");
      for (const e of sortDescByDate(forgotten)) sections.push(formatSummary(e));
      sections.push("");
    }
  }

  return finalize(sections, warnings);
}

// --- topic + always rendering --------------------------------------------

function appendAlways(
  sections: string[],
  warnings: string[],
  unpinned: MemoryEntry[],
  forceShowEmpty: boolean,
): void {
  const always = unpinned.filter(
    (e) => entryTopic(e) === ALWAYS_TOPIC && e.status !== "forgotten",
  );
  if (always.length === 0) {
    if (forceShowEmpty) {
      // peer-inspection only_core with no always-band: render nothing.
    }
    return;
  }
  const sorted = sortAscByDate(always);
  const { titleIds } = budgetSummaryNewestFirst(sorted, ALWAYS_SUMMARY_BUDGET_BYTES);
  sections.push(`═══ ALWAYS (summary) — ${sorted.length} entries ═══`);
  for (const e of sorted.slice().reverse()) {
    sections.push(titleIds.has(e.id) ? formatTitle(e) : formatSummary(e));
  }
  if (titleIds.size > 0) {
    warnings.push(
      `${titleIds.size} 'always' entr${titleIds.size === 1 ? "y" : "ies"} collapsed to title (over the always-summary budget) — consolidate.`,
    );
  }
  sections.push("");
}

function renderTopic(
  sections: string[],
  warnings: string[],
  topic: string,
  entries: MemoryEntry[],
): void {
  const active = entries.filter((e) => e.status === "active");
  const faded = entries.filter((e) => e.status === "faded");

  const notes = sortDescByDate(
    active.filter((e) => mapLegacyKind(e.kind) === "note"),
  ).slice(0, NOTES_PER_TOPIC);
  const durable = sortAscByDate(
    active.filter((e) => mapLegacyKind(e.kind) !== "note"),
  );

  sections.push(`═══ TOPIC: ${topic} ═══`);

  if (durable.length > 0) {
    const { summaryIds } = budgetFullNewestFirst(durable, TOPIC_FULL_BUDGET_BYTES);
    for (const e of durable.slice().reverse()) {
      sections.push(formatFull(e, { collapsed: summaryIds.has(e.id) }));
    }
    if (summaryIds.size > 0) {
      warnings.push(
        `topic '${topic}': ${summaryIds.size} entr${summaryIds.size === 1 ? "y" : "ies"} collapsed to summary (over ${(
          TOPIC_FULL_BUDGET_BYTES / 1024
        ).toFixed(0)} KB) — recall_memory(id) for full text.`,
      );
    }
  }

  if (notes.length > 0) {
    sections.push(`— notes (last ${NOTES_PER_TOPIC}) —`);
    for (const e of notes) sections.push(formatSummary(e));
  }

  if (faded.length > 0) {
    sections.push("— faded —");
    for (const e of sortDescByDate(faded)) sections.push(formatSummary(e));
  }

  sections.push("");
}

// --- budget helpers --------------------------------------------------------

/** Accumulate FULL text newest-first until `budget` is crossed; older
 * entries collapse to summary. Always keeps at least the newest full. */
function budgetFullNewestFirst(
  sortedAsc: MemoryEntry[],
  budget: number,
): { summaryIds: Set<string>; over: boolean } {
  const full = new Set<string>();
  let running = 0;
  for (let i = sortedAsc.length - 1; i >= 0; i--) {
    const e = sortedAsc[i]!;
    const cost = byteLen(e.text);
    if (running + cost <= budget || full.size === 0) {
      full.add(e.id);
      running += cost;
    }
  }
  const summaryIds = new Set<string>();
  for (const e of sortedAsc) if (!full.has(e.id)) summaryIds.add(e.id);
  return { summaryIds, over: running > budget };
}

/** Same shape for SUMMARY budgets: newest summaries kept; older →
 * title-only. */
function budgetSummaryNewestFirst(
  sortedAsc: MemoryEntry[],
  budget: number,
): { titleIds: Set<string> } {
  const keep = new Set<string>();
  let running = 0;
  for (let i = sortedAsc.length - 1; i >= 0; i--) {
    const e = sortedAsc[i]!;
    const cost = byteLen(e.summary);
    if (running + cost <= budget || keep.size === 0) {
      keep.add(e.id);
      running += cost;
    }
  }
  const titleIds = new Set<string>();
  for (const e of sortedAsc) if (!keep.has(e.id)) titleIds.add(e.id);
  return { titleIds };
}

function isReminderDue(e: MemoryEntry, now: number): boolean {
  if (e.due === undefined) return true; // open reminder — always surfaces
  if (e.due === "next-session") return true; // P6 consumes after delivery
  return e.due <= now;
}

// --- formatting ------------------------------------------------------------

function formatFull(entry: MemoryEntry, opts: { collapsed?: boolean } = {}): string {
  const parts: string[] = [];
  const dateShort = entry.date.slice(0, 10);
  parts.push(`#### [${entry.id}] (${dateShort})${tagSuffix(entry)}`);
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

/** SUMMARY detail: slug + summary (title+summary line). */
function formatSummary(entry: MemoryEntry): string {
  const dateShort = entry.date.slice(0, 10);
  const tags = [mapLegacyKind(entry.kind), kbLabel(entry.text)];
  if (entry.status === "faded") tags.push("faded");
  const seeAlso =
    entry.see_also && entry.see_also.length > 0
      ? ` [see_also: ${entry.see_also.join(", ")}]`
      : "";
  const prefix = entry.replies_to ? "  ↳ " : "- ";
  return `${prefix}[${entry.id}] (${dateShort}, ${tags.join(", ")}) ${entry.summary}${seeAlso}`;
}

/** TITLE detail: slug only. */
function formatTitle(entry: MemoryEntry): string {
  return `- [${entry.id}] (${mapLegacyKind(entry.kind)})`;
}

function tagSuffix(entry: MemoryEntry): string {
  const tags: string[] = [];
  const kind = mapLegacyKind(entry.kind);
  if (kind) tags.push(`kind=${kind}`);
  if (entry.topic) tags.push(`topic=${entry.topic}`);
  if (entry.pin) tags.push("pinned");
  if (entry.status === "faded") tags.push("faded");
  if (entry.details !== undefined) tags.push("has_details");
  return tags.length > 0 ? ` (${tags.join(", ")})` : "";
}

function finalize(sections: string[], warnings: string[]): RenderResult {
  const body = sections.join("\n").trimEnd();
  return {
    text: body.length > 0 ? body : "No memory under the loaded topics. `list_topics` to browse, `load_memory` to expand.",
    warning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}

function sortAscByDate<T extends { date: string }>(arr: T[]): T[] {
  return arr.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function sortDescByDate<T extends { date: string }>(arr: T[]): T[] {
  return arr.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function sumBytes(entries: MemoryEntry[], pick: (e: MemoryEntry) => string): number {
  return entries.reduce((s, e) => s + byteLen(pick(e)), 0);
}

function kbLabel(text: string): string {
  const b = byteLen(text);
  if (b < 1024) return `${b}B`;
  return `${(b / 1024).toFixed(1)}KB`;
}
