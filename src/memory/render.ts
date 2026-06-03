import type { Paths } from "../storage/index.ts";
import { loadStore } from "./store.ts";
import {
  ALWAYS_SUMMARY_BUDGET_BYTES,
  FADED_PER_TOPIC,
  NOTES_PER_TOPIC,
  PIN_FULL_BUDGET_BYTES,
  RENDER_TOTAL_BUDGET_BYTES,
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
   * peer-inspection (`get_memory_any({ username: other, only_core: true })`). */
  only_core?: boolean;
  /** §6 — the topics declared this session via `load_memory`. Entries
   * under these topics render at full detail; everything else is a menu
   * count. The implicit `(untopiced)` bucket is always loaded. */
  loaded_topics?: string[];
  /** Override "now" for deterministic due-reminder tests. */
  now?: number;
  /** The set of chat `agent_id`s currently live in the presence table
   * (`ChatRouter.liveAgentIds()`), threaded in by the caller — the same
   * injection path as `now`/`session_seq`. Drives the ORPHANED WATCHERS
   * block: a `kind:"watcher"` entry whose `watcher.owner_agent_id` is
   * absent from this set is orphaned. When UNDEFINED (peer renders, no
   * chat wired) the orphan block is skipped — a watcher only surfaces as
   * orphaned when liveness is actually known. Never mutates status. */
  live_agent_ids?: Set<string>;
  /** §10/§16 — this conversation's session ordinal, so a
   * `due: "next-session"` reminder fires only in a session LATER than
   * the one that created it. Undefined → treat next-session as due. */
  session_seq?: number;
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
  const sessionSeq = options.session_seq;
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

  // §spill-fix — one shared FULL-text ceiling for the whole render, so an
  // oversized boot payload can't get spilled by the MCP-client harness to
  // a flat, unisolated tool-results file. Spent in priority order:
  // orphaned watchers → due reminders → pinned → declared-topic durable →
  // delivered handoffs. `only_core` peer peeks (pinned + always only) are
  // already individually bounded, so they skip the shared ceiling.
  const budget: RenderBudget = {
    remaining: RENDER_TOTAL_BUDGET_BYTES,
    globalDemoted: false,
  };

  // A pin (or legacy core) renders FULL every session, regardless of
  // topic. `core` is still honored until the core→pin migration lands.
  const isPinned = (e: MemoryEntry) => Boolean(e.pin) || Boolean(e.core);
  const pinned = visible.filter(isPinned);
  const unpinned = visible.filter((e) => !isPinned(e));

  // --- ORPHANED WATCHERS (top, full, loud, regardless of topic) ---
  // Render-DERIVED from the live presence set — status is never mutated.
  // Silent while the arming session (`owner_agent_id`) is live; loud the
  // moment it leaves presence. Skipped entirely when liveness is unknown
  // (`live_agent_ids` undefined) so a peer render never false-alarms.
  if (!onlyCore && options.live_agent_ids !== undefined) {
    const orphaned = unpinned
      .filter(
        (e) =>
          e.status === "active" &&
          mapLegacyKind(e.kind) === "watcher" &&
          isWatcherOrphaned(e, options.live_agent_ids),
      )
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (orphaned.length > 0) {
      // Highest-priority FULL section: gated only by the global ceiling.
      // A collapsed orphan loses its re-arm payload, so under pressure the
      // newest still wins the budget first; the rest fall to a summary the
      // successor can `recall_memory(id)` + `claim_watcher(id)` from.
      const { summaryIds } = selectFullGlobal(orphaned, Number.POSITIVE_INFINITY, budget);
      sections.push("═══ ORPHANED WATCHERS — re-arm now ═══");
      for (const e of orphaned)
        sections.push(
          summaryIds.has(e.id) ? formatSummary(e) : formatOrphanedWatcher(e),
        );
      sections.push("");
    }
  }

  // --- DUE REMINDERS (top, full, regardless of topic) ---
  if (!onlyCore) {
    const due = unpinned
      .filter(
        (e) =>
          e.status === "active" &&
          mapLegacyKind(e.kind) === "reminder" &&
          isReminderDue(e, now, sessionSeq),
      )
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (due.length > 0) {
      const { summaryIds } = selectFullGlobal(due, Number.POSITIVE_INFINITY, budget);
      sections.push("═══ DUE REMINDERS ═══");
      for (const e of due)
        sections.push(formatFull(e, { collapsed: summaryIds.has(e.id) }));
      sections.push("");
    }
  }

  // --- PINNED (full text, byte-budgeted; reject→consolidate guard at
  //     write, oldest→summary demotion here) ---
  if (pinned.length > 0) {
    const sorted = sortAscByDate(pinned);
    const { summaryIds, over } = budgetFullNewestFirst(sorted, PIN_FULL_BUDGET_BYTES);
    // Pins are sacrosanct — the global ceiling never demotes them — but
    // their full bytes DO draw down the shared budget so the lower-
    // priority topic/handoff sections see only what's left.
    const pinnedFullBytes = sorted
      .filter((e) => !summaryIds.has(e.id))
      .reduce((s, e) => s + byteLen(e.text), 0);
    budget.remaining = Math.max(0, budget.remaining - pinnedFullBytes);
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
    renderTopic(sections, warnings, topic, byTopic.get(topic)!, budget);
  }

  // --- DELIVERED HANDOFFS (A ∩ H ≠ ∅) ---
  const handoffs = unpinned.filter(
    (e) => e.status === "active" && mapLegacyKind(e.kind) === "handoff",
  );
  const delivered = handoffs.filter((e) => {
    const t = entryTopic(e);
    return t !== null && loaded.has(t);
  });
  if (delivered.length > 0) {
    const deliveredAsc = sortAscByDate(delivered);
    const { summaryIds } = selectFullGlobal(deliveredAsc, Number.POSITIVE_INFINITY, budget);
    sections.push("═══ DELIVERED HANDOFFS (fade if not needed) ═══");
    for (const e of sortDescByDate(delivered))
      sections.push(formatFull(e, { collapsed: summaryIds.has(e.id) }));
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

  // Loud, render-time-only warning when the shared ceiling (not just a
  // per-section cap) forced FULL bodies down to summaries.
  if (budget.globalDemoted && Number.isFinite(RENDER_TOTAL_BUDGET_BYTES)) {
    warnings.push(
      `Boot render hit the ${(RENDER_TOTAL_BUDGET_BYTES / 1024).toFixed(0)} KB full-text ceiling ` +
        `(PANTHEON_RENDER_MAX_BYTES) — older full bodies collapsed to summary. ` +
        `recall_memory(id) for any one in full, or load fewer topics.`,
    );
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
  budget: RenderBudget,
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
    // Per-topic 8 KB cap AND the shared global ceiling: a body that the
    // per-topic budget would keep full but the global ceiling can't fit
    // collapses to summary (and flips budget.globalDemoted for the warn).
    const { summaryIds } = selectFullGlobal(durable, TOPIC_FULL_BUDGET_BYTES, budget);
    for (const e of durable.slice().reverse()) {
      sections.push(formatFull(e, { collapsed: summaryIds.has(e.id) }));
    }
    if (summaryIds.size > 0) {
      warnings.push(
        `topic '${topic}': ${summaryIds.size} entr${summaryIds.size === 1 ? "y" : "ies"} collapsed to summary — recall_memory(id) for full text.`,
      );
    }
  }

  if (notes.length > 0) {
    sections.push(`— notes (last ${NOTES_PER_TOPIC}) —`);
    for (const e of notes) sections.push(formatSummary(e));
  }

  if (faded.length > 0) {
    // Faded ≈ archived: cap to the newest-N summaries + a count of the
    // rest so a topic with a large faded pile can't render an unbounded
    // list every session. The older ones stay reachable via list_memory /
    // find_memory.
    const fadedDesc = sortDescByDate(faded);
    const shown = fadedDesc.slice(0, FADED_PER_TOPIC);
    const hidden = fadedDesc.length - shown.length;
    sections.push("— faded —");
    for (const e of shown) sections.push(formatSummary(e));
    if (hidden > 0) {
      sections.push(`  (+${hidden} older faded — list_memory / find_memory to see)`);
    }
  }

  sections.push("");
}

// --- budget helpers --------------------------------------------------------

/** Mutable global-ceiling accumulator threaded through every FULL-text
 * section of one render (orphaned watchers → due reminders → pinned →
 * declared-topic durable → delivered handoffs). `remaining` is the bytes
 * still spendable on FULL bodies; once it's exhausted, further bodies
 * collapse to summary and `globalDemoted` flips so `finalize` can warn. */
interface RenderBudget {
  remaining: number;
  globalDemoted: boolean;
}

/** Select which entries render FULL under BOTH a per-section cap and the
 * shared global ceiling, newest-first. An entry that the per-section cap
 * would have kept full but the GLOBAL ceiling cannot fit sets
 * `budget.globalDemoted` (drives the loud render warning). Decrements the
 * shared budget by every FULL body's bytes. Pure w.r.t. entry status —
 * collapse is render-time only. `perCap === Infinity` means "global
 * ceiling is the only gate" (used for the otherwise-uncapped watcher /
 * reminder / handoff sections). */
function selectFullGlobal(
  sortedAsc: MemoryEntry[],
  perCap: number,
  budget: RenderBudget,
): { summaryIds: Set<string>; sectionOver: boolean } {
  const full = new Set<string>();
  let sectionRunning = 0;
  for (let i = sortedAsc.length - 1; i >= 0; i--) {
    const e = sortedAsc[i]!;
    const cost = byteLen(e.text);
    const fitsSection = sectionRunning + cost <= perCap || full.size === 0;
    const fitsGlobal = cost <= budget.remaining;
    if (fitsSection && fitsGlobal) {
      full.add(e.id);
      sectionRunning += cost;
      budget.remaining -= cost;
    } else if (fitsSection) {
      // The per-section cap would have kept this full; the GLOBAL ceiling
      // is what forced it down. Record it so the render warns loudly.
      budget.globalDemoted = true;
    }
  }
  const summaryIds = new Set<string>();
  for (const e of sortedAsc) if (!full.has(e.id)) summaryIds.add(e.id);
  return { summaryIds, sectionOver: sectionRunning > perCap };
}

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

/** Render-time orphan predicate (the `isReminderDue` analog). A watcher
 * is orphaned iff its arming session (`watcher.owner_agent_id`) is no
 * longer in the live presence set. Pure: never mutates status. Returns
 * false when liveness is unknown or the entry carries no owner binding —
 * we only ever call a watch orphaned on positive evidence. */
export function isWatcherOrphaned(
  e: MemoryEntry,
  liveAgentIds: Set<string> | undefined,
): boolean {
  if (liveAgentIds === undefined) return false;
  const ownerId = e.watcher?.owner_agent_id;
  if (!ownerId) return false;
  return !liveAgentIds.has(ownerId);
}

function isReminderDue(
  e: MemoryEntry,
  now: number,
  sessionSeq: number | undefined,
): boolean {
  if (e.due === undefined) return true; // open reminder — always surfaces
  if (e.due === "next-session") {
    // Fires only in a session LATER than the one that created it.
    if (sessionSeq === undefined || e.session_seq === undefined) return true;
    return sessionSeq > e.session_seq;
  }
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

/** Loud orphan formatter: the binding that died + the executable re-arm
 * payload + the atomic-claim hint, so a successor can re-arm in place
 * without opening the entry's prose first. */
function formatOrphanedWatcher(entry: MemoryEntry): string {
  const parts: string[] = [];
  const dateShort = entry.date.slice(0, 10);
  parts.push(`#### [${entry.id}] (${dateShort}) (kind=watcher, ORPHANED)`);
  parts.push(`> ${entry.summary}`);
  const w = entry.watcher;
  if (w) {
    parts.push(
      `Owner session offline (armed by ${w.owner_username}). To re-arm: claim_watcher("${entry.id}") — atomic, you win or a live sibling did — then recreate:`,
    );
    const r = w.rearm ?? {};
    if (r.crons && r.crons.length > 0) parts.push(`  crons: ${r.crons.join(" | ")}`);
    if (r.commands && r.commands.length > 0) parts.push(`  commands: ${r.commands.join(" | ")}`);
    if (r.ledger) parts.push(`  ledger: ${r.ledger}`);
    if (r.notes) parts.push(`  notes: ${r.notes}`);
    if (w.close_condition) parts.push(`  close when: ${w.close_condition}`);
  }
  parts.push(entry.text);
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
