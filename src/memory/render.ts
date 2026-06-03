import type { Paths } from "../storage/index.ts";
import { loadStore } from "./store.ts";
import {
  ALWAYS_SUMMARY_BUDGET_BYTES,
  FADED_PER_TOPIC,
  NOTES_PER_TOPIC,
  PIN_FULL_BUDGET_BYTES,
  RENDER_FULLTEXT_BUDGET_BYTES,
  RENDER_INLINE_CEILING_BYTES,
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

/** One render section, tagged with a `priority` (lower = higher value,
 * compacted/dropped LAST) and an optional one-line `compact` fallback the
 * inline-ceiling pass swaps in when the whole result must shrink. The
 * blocks are pushed in priority order, so flattening them in push order
 * yields the prior flat-`sections` output byte-for-byte in the common
 * (under-ceiling) case. */
interface RenderBlock {
  priority: number;
  lines: string[];
  /** Self-describing one-line replacement (count + how to expand). `null`
   * = already minimal; the fit pass can only drop it, never compact it. */
  compact: string | null;
  compacted?: boolean;
  dropped?: boolean;
}

/** Compaction priorities — lower value = higher worth, collapsed/dropped
 * LAST. Pins are sacrosanct (10) and, being PIN_FULL_BUDGET-capped, in
 * practice never need compacting; declared topics carry a per-topic offset
 * so the oldest/last-loaded (the same ones TIER 1 already demoted) collapse
 * first. */
const PRI = {
  PINNED: 10,
  WATCHERS: 20,
  REMINDERS: 25,
  ALWAYS: 30,
  TOPIC: 40,
  HANDOFFS: 60,
  MENU: 70,
  HIDDEN: 80,
} as const;

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

  const blocks: RenderBlock[] = [];
  const warnings: string[] = [];

  // §spill-fix TIER 1 — one shared FULL-text budget across the render's
  // full sections (orphaned watchers → due reminders → pinned →
  // declared-topic durable → delivered handoffs), demoting oldest-first to
  // summary under pressure. TIER 2 (the whole-output inline ceiling) is
  // applied as a final pass in `finalize`. `only_core` peer peeks (pinned +
  // always only) are already individually bounded.
  const budget: RenderBudget = {
    remaining: RENDER_FULLTEXT_BUDGET_BYTES,
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
      const lines = ["═══ ORPHANED WATCHERS — re-arm now ═══"];
      for (const e of orphaned)
        lines.push(
          summaryIds.has(e.id) ? formatSummary(e) : formatOrphanedWatcher(e),
        );
      lines.push("");
      blocks.push({
        priority: PRI.WATCHERS,
        lines,
        compact: `═══ ORPHANED WATCHERS — ${orphaned.length} to re-arm (recall_memory(id) then claim_watcher(id)) ═══`,
      });
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
      const lines = ["═══ DUE REMINDERS ═══"];
      for (const e of due)
        lines.push(formatFull(e, { collapsed: summaryIds.has(e.id) }));
      lines.push("");
      blocks.push({
        priority: PRI.REMINDERS,
        lines,
        compact: `═══ DUE REMINDERS — ${due.length} due (recall_memory(id) for each) ═══`,
      });
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
    const lines = [
      `═══ PINNED (full text) — ${sorted.length} entries, ${totalKb} KB / ${(
        PIN_FULL_BUDGET_BYTES / 1024
      ).toFixed(0)} KB ═══`,
    ];
    for (const e of sorted.slice().reverse()) {
      lines.push(formatFull(e, { collapsed: summaryIds.has(e.id) }));
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
    lines.push("");
    blocks.push({
      priority: PRI.PINNED,
      lines,
      compact: `═══ PINNED — ${sorted.length} entries (collapsed to fit; recall_memory(id) for any) ═══`,
    });
  }

  if (onlyCore) {
    // Peer-inspection: pinned + always summaries only.
    appendAlways(blocks, warnings, unpinned, true);
    return finalize(blocks, warnings);
  }

  // --- ALWAYS (summary, byte-budgeted) ---
  appendAlways(blocks, warnings, unpinned, false);

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

  // The per-topic priority offset increases with load order, so under
  // inline-ceiling pressure the later-loaded topics — the same ones TIER 1
  // already demoted as the shared full-text budget drained left-to-right —
  // collapse to a count FIRST. Deterministic and consistent with TIER 1.
  loadedTopicNames.forEach((topic, i) => {
    renderTopic(blocks, warnings, topic, byTopic.get(topic)!, budget, i);
  });

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
    const lines = ["═══ DELIVERED HANDOFFS (fade if not needed) ═══"];
    for (const e of sortDescByDate(delivered))
      lines.push(formatFull(e, { collapsed: summaryIds.has(e.id) }));
    lines.push("");
    blocks.push({
      priority: PRI.HANDOFFS,
      lines,
      compact: `═══ DELIVERED HANDOFFS — ${delivered.length} (recall_memory(id) to read) ═══`,
    });
  }

  // --- NOT LOADED (menu counts only) ---
  const menu = [...byTopic.entries()]
    .filter(([t]) => !loaded.has(t))
    .map(([t, entries]) => `${t}(${entries.filter((e) => e.status !== "forgotten").length})`)
    .sort();
  if (menu.length > 0) {
    blocks.push({
      priority: PRI.MENU,
      lines: ["═══ NOT LOADED (load_memory to expand) ═══", menu.join("  "), ""],
      // Already a compact count line; if even this overflows, the fit pass
      // collapses it to the topic count rather than the full slug list.
      compact: `═══ NOT LOADED — ${menu.length} topics (list_topics to browse) ═══`,
    });
  }

  // --- HIDDEN (forgotten — only when explicitly requested) ---
  if (includeForgotten) {
    const forgotten = visible.filter((e) => e.status === "forgotten");
    if (forgotten.length > 0) {
      const lines = ["═══ HIDDEN (forgotten — shown by request) ═══"];
      for (const e of sortDescByDate(forgotten)) lines.push(formatSummary(e));
      lines.push("");
      blocks.push({
        priority: PRI.HIDDEN,
        lines,
        compact: `═══ HIDDEN — ${forgotten.length} forgotten (list_memory({ status: "forgotten" })) ═══`,
      });
    }
  }

  // Loud, render-time-only warning when TIER 1 (the shared full-text
  // budget, not just a per-section cap) forced FULL bodies down to
  // summaries. TIER 2 (inline ceiling) adds its own warning in `finalize`.
  if (budget.globalDemoted && Number.isFinite(RENDER_FULLTEXT_BUDGET_BYTES)) {
    warnings.push(
      `Boot render hit the ${(RENDER_FULLTEXT_BUDGET_BYTES / 1024).toFixed(0)} KB full-text budget ` +
        `(PANTHEON_RENDER_MAX_BYTES) — older full bodies collapsed to summary. ` +
        `recall_memory(id) for any one in full, or load fewer topics.`,
    );
  }

  return finalize(blocks, warnings);
}

// --- topic + always rendering --------------------------------------------

function appendAlways(
  blocks: RenderBlock[],
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
  const lines = [`═══ ALWAYS (summary) — ${sorted.length} entries ═══`];
  for (const e of sorted.slice().reverse()) {
    lines.push(titleIds.has(e.id) ? formatTitle(e) : formatSummary(e));
  }
  if (titleIds.size > 0) {
    warnings.push(
      `${titleIds.size} 'always' entr${titleIds.size === 1 ? "y" : "ies"} collapsed to title (over the always-summary budget) — consolidate.`,
    );
  }
  lines.push("");
  blocks.push({
    priority: PRI.ALWAYS,
    lines,
    compact: `═══ ALWAYS — ${sorted.length} entries (recall_memory(id) to read any) ═══`,
  });
}

function renderTopic(
  blocks: RenderBlock[],
  warnings: string[],
  topic: string,
  entries: MemoryEntry[],
  budget: RenderBudget,
  topicIndex: number,
): void {
  const active = entries.filter((e) => e.status === "active");
  const faded = entries.filter((e) => e.status === "faded");

  const notes = sortDescByDate(
    active.filter((e) => mapLegacyKind(e.kind) === "note"),
  ).slice(0, NOTES_PER_TOPIC);
  const durable = sortAscByDate(
    active.filter((e) => mapLegacyKind(e.kind) !== "note"),
  );

  const lines = [`═══ TOPIC: ${topic} ═══`];

  if (durable.length > 0) {
    // Per-topic 8 KB cap AND the shared global ceiling: a body that the
    // per-topic budget would keep full but the global ceiling can't fit
    // collapses to summary (and flips budget.globalDemoted for the warn).
    const { summaryIds } = selectFullGlobal(durable, TOPIC_FULL_BUDGET_BYTES, budget);
    for (const e of durable.slice().reverse()) {
      lines.push(formatFull(e, { collapsed: summaryIds.has(e.id) }));
    }
    if (summaryIds.size > 0) {
      warnings.push(
        `topic '${topic}': ${summaryIds.size} entr${summaryIds.size === 1 ? "y" : "ies"} collapsed to summary — recall_memory(id) for full text.`,
      );
    }
  }

  if (notes.length > 0) {
    lines.push(`— notes (last ${NOTES_PER_TOPIC}) —`);
    for (const e of notes) lines.push(formatSummary(e));
  }

  if (faded.length > 0) {
    // Faded ≈ archived: cap to the newest-N summaries + a count of the
    // rest so a topic with a large faded pile can't render an unbounded
    // list every session. The older ones stay reachable via list_memory /
    // find_memory.
    const fadedDesc = sortDescByDate(faded);
    const shown = fadedDesc.slice(0, FADED_PER_TOPIC);
    const hidden = fadedDesc.length - shown.length;
    lines.push("— faded —");
    for (const e of shown) lines.push(formatSummary(e));
    if (hidden > 0) {
      lines.push(`  (+${hidden} older faded — list_memory / find_memory to see)`);
    }
  }

  lines.push("");
  // Per-topic offset: later-loaded topics get a higher priority number, so
  // the inline-ceiling pass collapses them to a count first.
  const count = entries.filter((e) => e.status !== "forgotten").length;
  blocks.push({
    priority: PRI.TOPIC + topicIndex,
    lines,
    compact: `═══ TOPIC: ${topic} — ${count} entr${count === 1 ? "y" : "ies"} (collapsed to fit; recall_memory(id) / list_memory({ filter: "${topic}" })) ═══`,
  });
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

function finalize(blocks: RenderBlock[], warnings: string[]): RenderResult {
  fitToInlineCeiling(blocks, warnings);
  let body = assembleBlocks(blocks);
  // Absolute backstop — should be unreachable, because every section is
  // independently byte-capped (pins ≤ PIN_FULL, always ≤ ALWAYS_SUMMARY,
  // full sections ≤ TIER 1, the rest collapsed to one-liners by the fit
  // pass) and their sum stays under the ceiling. Kept so the guarantee is
  // TOTAL even against a future section that forgets its cap: hard-trim on
  // a UTF-8 boundary + a self-describing tail.
  const ceiling = RENDER_INLINE_CEILING_BYTES;
  if (Number.isFinite(ceiling) && byteLen(body) > ceiling) {
    const tail =
      "\n\n[render hard-trimmed to stay inline — recall_memory(id) / list_memory to read the rest]";
    body = truncateToBytes(body, ceiling - byteLen(tail)) + tail;
    if (!warnings.some((w) => w.includes("inline ceiling"))) {
      warnings.push(
        "Boot render hard-trimmed to the inline ceiling — read entries via recall_memory(id) / list_memory.",
      );
    }
  }
  return {
    text: body.length > 0 ? body : "No memory under the loaded topics. `list_topics` to browse, `load_memory` to expand.",
    warning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}

/** Flatten the live (non-dropped) blocks into the rendered body, in push
 * order (= priority order). Matches the prior flat-`sections` join exactly
 * when nothing was compacted/dropped. */
function assembleBlocks(blocks: RenderBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.dropped) continue;
    for (const line of b.lines) lines.push(line);
  }
  return lines.join("\n").trimEnd();
}

/** §spill-fix TIER 2 — the HARD inline-cap guarantee. While the assembled
 * body exceeds RENDER_INLINE_CEILING_BYTES, collapse the lowest-VALUE
 * section to its one-line `compact` form first (highest priority number,
 * later-pushed on ties), so pins/reminders/watchers/always survive and the
 * oldest/last-loaded topics shrink first. If everything compactable is
 * already a one-liner and it STILL doesn't fit (pathological topic counts),
 * drop the lowest-value one-liners entirely — never a pin/reminder/watcher/
 * always. Smart compaction, never a file pointer: each collapsed section
 * keeps a recall_memory(id) / list_memory hint, and one loud warning names
 * what happened. No-op when the ceiling is disabled (Infinity) or the body
 * already fits. */
function fitToInlineCeiling(blocks: RenderBlock[], warnings: string[]): void {
  const ceiling = RENDER_INLINE_CEILING_BYTES;
  if (!Number.isFinite(ceiling)) return;
  if (byteLen(assembleBlocks(blocks)) <= ceiling) return;

  let acted = false;

  // Phase 1 — compact lowest-value compactable blocks to their count line.
  const compactOrder = blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.compact !== null && !b.compacted)
    .sort((x, y) => y.b.priority - x.b.priority || y.i - x.i);
  for (const { b } of compactOrder) {
    if (byteLen(assembleBlocks(blocks)) <= ceiling) break;
    b.lines = [b.compact!, ""];
    b.compacted = true;
    acted = true;
  }

  // Phase 2 — still over: drop lowest-value one-liners outright, but never
  // the every-session floor (pins/reminders/watchers/always: priority ≤
  // ALWAYS). Their content is action/standing-critical; they're already
  // single count lines and cost almost nothing.
  if (byteLen(assembleBlocks(blocks)) > ceiling) {
    const dropOrder = blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.priority > PRI.ALWAYS && !b.dropped)
      .sort((x, y) => y.b.priority - x.b.priority || y.i - x.i);
    for (const { b } of dropOrder) {
      if (byteLen(assembleBlocks(blocks)) <= ceiling) break;
      b.dropped = true;
      acted = true;
    }
  }

  if (acted) {
    warnings.push(
      `Boot render exceeded the ${(ceiling / 1024).toFixed(0)} KB inline ceiling ` +
        `(PANTHEON_RENDER_INLINE_CEILING) — lower-priority sections were collapsed to ` +
        `counts to keep the whole result inline (never spilled to a file). ` +
        `recall_memory(id) for any entry, list_memory / find_memory to browse, or load fewer topics.`,
    );
  }
}

/** Trim a string to at most `maxBytes` UTF-8 bytes without splitting a
 * multibyte codepoint. */
function truncateToBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  // Back up off any UTF-8 continuation byte (0b10xxxxxx).
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.toString("utf8", 0, end);
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
