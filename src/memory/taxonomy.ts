/** Redesign-v2 memory taxonomy (`docs/memory-redesign/5-proposal-v2.md`
 * §2–§4): the seven canonical kinds, the legacy→v2 kind mapping, which
 * kinds load by topic vs. require a topic, and the reserved `always`
 * topic. Centralised so validation, render, and the topic tools share
 * one source of truth.
 *
 * Legacy kinds are *mapped*, not rejected (the `kind_legacy` warning is
 * advisory even under enforcement). Topic requirements, by contrast, are
 * now enforced on write — the §17 P3 warn-only window is over.
 */

import type { MemoryEntry } from "./types.ts";

/** §2 — the seven kinds, in render-precedence-ish order. */
export const MEMORY_KINDS = [
  "rule",
  "fact",
  "gotcha",
  "pointer",
  "note",
  "handoff",
  "reminder",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** §3 — durable kinds: loaded by topic, no auto-decay (supersede /
 * dream / manual only). These REQUIRE a topic at write time. */
export const DURABLE_KINDS: ReadonlySet<string> = new Set([
  "rule",
  "fact",
  "gotcha",
  "pointer",
]);

/** §4 — kinds that require a `topic` at write time. Durable kinds plus
 * `handoff` (which is topic-delivered per §8). `note` inherits the
 * session's active topic when omitted; `reminder` is due-gated, not
 * topic-gated — neither is required. */
export const TOPIC_REQUIRED_KINDS: ReadonlySet<string> = new Set([
  ...DURABLE_KINDS,
  "handoff",
]);

/** §4 — the reserved topic loaded in every session (as SUMMARY). Must
 * be chosen explicitly; never an empty default. */
export const ALWAYS_TOPIC = "always";

/** §2 — legacy kind → v2 kind. Applied on read/render and surfaced as a
 * write-time warning so old callers migrate without hard failures.
 * `phase-*` and any unrecognised/absent kind fold into `note`. */
const LEGACY_KIND_MAP: Record<string, MemoryKind> = {
  decision: "rule",
  feedback: "rule",
  audit: "gotcha",
  log: "note",
  // `phase-*` handled by prefix below.
};

const VALID_KINDS: ReadonlySet<string> = new Set(MEMORY_KINDS);

export function isV2Kind(kind: string | undefined): kind is MemoryKind {
  return kind !== undefined && VALID_KINDS.has(kind);
}

/** Map any kind value (legacy, absent, or already-v2) to a v2 kind.
 * Already-valid kinds pass through. `phase-*` → note. Everything else
 * (including undefined and genuinely unknown strings) → note. */
export function mapLegacyKind(kind: string | undefined): MemoryKind {
  if (isV2Kind(kind)) return kind;
  if (kind === undefined) return "note";
  if (kind in LEGACY_KIND_MAP) return LEGACY_KIND_MAP[kind]!;
  if (kind.startsWith("phase-") || kind.startsWith("phase_")) return "note";
  return "note";
}

/** True when `kind` is a recognised legacy alias (has a defined v2
 * target other than the catch-all). Used to phrase the migration
 * warning precisely ("'decision' → 'rule'") vs. the unknown-kind case. */
export function isLegacyKind(kind: string | undefined): boolean {
  if (kind === undefined) return false;
  if (kind in LEGACY_KIND_MAP) return true;
  return kind.startsWith("phase-") || kind.startsWith("phase_");
}

/** §4 — `slug = <topic>/<name>`. Derive the topic an entry belongs to,
 * preferring the explicit `topic` field, then the slug domain (the part
 * before the first `/`), else null (un-topiced legacy entry). */
export function entryTopic(entry: Pick<MemoryEntry, "topic" | "id">): string | null {
  if (entry.topic !== undefined && entry.topic.length > 0) return entry.topic;
  const slash = entry.id.indexOf("/");
  if (slash > 0) return entry.id.slice(0, slash);
  return null;
}

export interface TopicSummary {
  topic: string;
  /** Active (non-forgotten) entries filed under this topic. */
  count: number;
  /** Whether the topic is the reserved `always` topic. */
  always: boolean;
}

/** Cluster a persona's visible entries by topic, with per-topic active
 * counts. Forgotten entries are excluded; faded entries count (they're
 * still loadable). Sorted: `always` first, then by descending count,
 * then alphabetically. Reminders are due-gated, not topic-gated — they
 * are excluded from the topic menu. */
export function clusterTopics(entries: MemoryEntry[]): TopicSummary[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.status === "forgotten") continue;
    if (e.kind === "reminder") continue;
    const topic = entryTopic(e);
    if (topic === null) continue;
    counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  const out: TopicSummary[] = [];
  for (const [topic, count] of counts) {
    out.push({ topic, count, always: topic === ALWAYS_TOPIC });
  }
  out.sort((a, b) => {
    if (a.always !== b.always) return a.always ? -1 : 1;
    if (a.count !== b.count) return b.count - a.count;
    return a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0;
  });
  return out;
}

/** The set of distinct topic names across a persona's visible entries
 * (forgotten excluded). Includes the topic of reminders too, for
 * sprawl-guard "prefer an existing topic" suggestions. */
export function knownTopics(entries: MemoryEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    if (e.status === "forgotten") continue;
    const topic = entryTopic(e);
    if (topic !== null) set.add(topic);
  }
  return [...set].sort();
}
