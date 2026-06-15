/** Per-entry update history (revision log).
 *
 * Every content-changing `update_memory` / `amend_memory` records a FULL
 * snapshot of the entry's prior content into `entry.revisions[]` before
 * the edit is applied. The list is append-only and chronological: the
 * first element is the entry's original (creation) state, each later
 * element is the state that an edit replaced, and the live entry itself
 * is the current tip. So the complete timeline is `[...revisions, tip]`.
 *
 * Storage keeps FULL snapshots (not diffs) so any past revision's full
 * text is retrievable directly. The DIFF view is computed at read time
 * (`buildHistory`) — the first revision is shown full, each subsequent
 * one as a line-diff against the one before it.
 *
 * History is NEVER rendered at boot and is STRIPPED from `recall_memory`
 * (which only flags `has_history`); it is fetched via `get_memory_history`
 * — the same heavy-optional-field pattern as `details` / `sources`.
 *
 * The heavy `details` payload (≤5MB) is intentionally NOT snapshotted —
 * carrying it per revision could explode the store. History covers the
 * editable content fields below; `details` history is out of scope.
 */

import type { MemoryEntry, MemoryStatus } from "./types.ts";

/** Content fields tracked by the revision log. A change to any of these
 * via `updateEntry` / `amendEntry` records a revision. */
export interface ContentSnapshot {
  text: string;
  summary: string;
  status: MemoryStatus;
  kind?: string;
  topic?: string;
  pin?: boolean;
  pin_reason?: string;
  due?: number | "next-session";
}

/** One past state of an entry, captured immediately before the edit that
 * replaced it. `snapshot` is the FULL prior content; `at` / `changed` /
 * `session_seq` describe the edit that superseded it. */
export interface MemoryRevision {
  /** 0-based position in `revisions[]`. rev 0 is the original state. */
  rev: number;
  /** ISO timestamp of the edit that superseded this snapshot. */
  at: string;
  /** Per-persona session ordinal of the superseding edit, when known. */
  session_seq?: number;
  /** Summoner handle of the superseding session, when spawned. */
  summoner?: string;
  /** Which tracked fields the superseding edit changed. */
  changed: string[];
  /** Full prior content. */
  snapshot: ContentSnapshot;
}

/** Edit attribution threaded from the handler (session + summoner). */
export interface RevisionMeta {
  at?: string;
  session_seq?: number;
  summoner?: string;
}

/** Update-history capture is ON by default. Set the env opt-out to a
 * disabling value (`0` / `false` / `off` / `no`, case-insensitive) to stop
 * recording revisions — existing `revisions[]` stay readable; only new
 * edits skip capture. Read live so tests / operators can toggle it. */
const HISTORY_ENV_VAR = "PANTHEON_MEMORY_HISTORY";

export function historyEnabled(): boolean {
  const v = process.env[HISTORY_ENV_VAR];
  if (v === undefined) return true;
  const norm = v.trim().toLowerCase();
  return !(norm === "0" || norm === "false" || norm === "off" || norm === "no");
}

const SNAPSHOT_FIELDS: (keyof ContentSnapshot)[] = [
  "text",
  "summary",
  "status",
  "kind",
  "topic",
  "pin",
  "pin_reason",
  "due",
];

export function snapshotContent(entry: MemoryEntry): ContentSnapshot {
  const snap: ContentSnapshot = {
    text: entry.text,
    summary: entry.summary,
    status: entry.status,
  };
  if (entry.kind !== undefined) snap.kind = entry.kind;
  if (entry.topic !== undefined) snap.topic = entry.topic;
  if (entry.pin !== undefined) snap.pin = entry.pin;
  if (entry.pin_reason !== undefined) snap.pin_reason = entry.pin_reason;
  if (entry.due !== undefined) snap.due = entry.due;
  return snap;
}

/** Names of the tracked fields whose value differs between two entry
 * states. Empty array => no content change worth recording. */
export function changedFields(before: MemoryEntry, after: MemoryEntry): string[] {
  const a = snapshotContent(before) as unknown as Record<string, unknown>;
  const b = snapshotContent(after) as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (const f of SNAPSHOT_FIELDS) {
    if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) out.push(f);
  }
  return out;
}

/** Return `next` with a revision recorded when the edit changed any
 * tracked content field. The recorded snapshot is `current`'s prior
 * content; the metadata describes the edit that replaced it. When nothing
 * tracked changed, `next` is returned unchanged (no revision churn). */
export function recordRevision(
  current: MemoryEntry,
  next: MemoryEntry,
  meta: RevisionMeta = {},
): MemoryEntry {
  if (!historyEnabled()) return next;
  const changed = changedFields(current, next);
  if (changed.length === 0) return next;
  const prior = current.revisions ?? [];
  const revision: MemoryRevision = {
    rev: prior.length,
    at: meta.at ?? new Date().toISOString(),
    changed,
    snapshot: snapshotContent(current),
    ...(meta.session_seq !== undefined ? { session_seq: meta.session_seq } : {}),
    ...(meta.summoner !== undefined ? { summoner: meta.summoner } : {}),
  };
  return { ...next, revisions: [...prior, revision] };
}

/** A single item in the presentation timeline. */
export interface HistoryItem {
  rev: number;
  /** ISO when this state was CREATED (became current). */
  created_at: string;
  /** ISO when a later edit replaced it; absent for the current tip. */
  superseded_at?: string;
  /** Fields the edit that produced THIS state changed (vs. the prior
   * one). Absent for rev 0 (the original). */
  changed?: string[];
  session_seq?: number;
  summoner?: string;
  current: boolean;
  /** rev 0: the full snapshot. Later revs: a line-diff vs. the previous
   * revision's text + a scalar before→after for non-text fields. */
  full?: ContentSnapshot;
  diff?: HistoryDiff;
}

export interface HistoryDiff {
  text?: string;
  /** Non-text scalar field changes, before → after. */
  fields?: Record<string, { from: unknown; to: unknown }>;
}

/** Build the full timeline `[...revisions, tip]` with the first item
 * shown full and each later item as a diff against the previous. */
export function buildHistory(entry: MemoryEntry): HistoryItem[] {
  const revisions = entry.revisions ?? [];
  // Snapshots oldest → newest, then the live tip.
  const snaps: ContentSnapshot[] = [
    ...revisions.map((r) => r.snapshot),
    snapshotContent(entry),
  ];
  // created_at[k]: rev 0 = entry.date; rev k>0 = the supersede time of
  // rev k-1 (i.e. when the prior state was replaced by this one).
  const items: HistoryItem[] = [];
  for (let k = 0; k < snaps.length; k++) {
    const isTip = k === snaps.length - 1;
    const createdAt = k === 0 ? entry.date : revisions[k - 1]!.at;
    const item: HistoryItem = {
      rev: k,
      created_at: createdAt,
      current: isTip,
    };
    if (!isTip) item.superseded_at = revisions[k]!.at;
    // The edit that produced state k (k>0) is the one that superseded
    // state k-1 — its metadata lives on revisions[k-1].
    if (k > 0) {
      const producing = revisions[k - 1]!;
      item.changed = producing.changed;
      if (producing.session_seq !== undefined) item.session_seq = producing.session_seq;
      if (producing.summoner !== undefined) item.summoner = producing.summoner;
    }
    if (k === 0) {
      item.full = snaps[0]!;
    } else {
      item.diff = diffSnapshots(snaps[k - 1]!, snaps[k]!);
    }
    items.push(item);
  }
  return items;
}

/** Full content of a specific revision index. rev in `[0, revisions.length]`
 * — the last index is the current tip. Returns null when out of range. */
export function revisionContent(entry: MemoryEntry, rev: number): ContentSnapshot | null {
  const revisions = entry.revisions ?? [];
  if (!Number.isInteger(rev) || rev < 0 || rev > revisions.length) return null;
  if (rev === revisions.length) return snapshotContent(entry);
  return revisions[rev]!.snapshot;
}

/** Highest valid revision index (the current tip). */
export function tipRev(entry: MemoryEntry): number {
  return (entry.revisions ?? []).length;
}

function diffSnapshots(a: ContentSnapshot, b: ContentSnapshot): HistoryDiff {
  const out: HistoryDiff = {};
  if (a.text !== b.text) out.text = lineDiff(a.text, b.text);
  const fields: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of SNAPSHOT_FIELDS) {
    if (f === "text") continue;
    const av = (a as unknown as Record<string, unknown>)[f];
    const bv = (b as unknown as Record<string, unknown>)[f];
    if (JSON.stringify(av) !== JSON.stringify(bv)) fields[f] = { from: av, to: bv };
  }
  if (Object.keys(fields).length > 0) out.fields = fields;
  return out;
}

/** Minimal LCS line-diff producing a unified-ish block: ` ` context,
 * `-` removed, `+` added. Plain text (no color / emoji) per house style. */
export function lineDiff(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) lines.push(`- ${a[i++]}`);
  while (j < m) lines.push(`+ ${b[j++]}`);
  return lines.join("\n");
}
