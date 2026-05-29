/** Redesign-v2 write-time validation (`5-proposal-v2.md` §12 / §16).
 *
 * Specific reject codes: `invalid_kind`, `summary_is_header`,
 * `topic_required`, `pin_budget_exceeded`, `always_budget_exceeded`.
 *
 * Per §17 P3 the migration runs **warn-only** for one release, then
 * enforces. So `validateWrite` defaults to collecting issues as
 * warnings (returned to the caller, surfaced in the handler response)
 * and only throws when `enforce: true`. The reject logic is identical
 * either way — flipping enforcement on is a one-flag change.
 *
 * Legacy kinds are mapped (not rejected) and warned about, so old
 * callers keep working through the migration window.
 */

import {
  ALWAYS_SUMMARY_BUDGET_BYTES,
  PIN_FULL_BUDGET_BYTES,
  byteLen,
} from "./budgets.ts";
import {
  TOPIC_REQUIRED_KINDS,
  ALWAYS_TOPIC,
  isLegacyKind,
  isV2Kind,
  knownTopics,
  mapLegacyKind,
  clusterTopics,
} from "./taxonomy.ts";
import { deriveSummary } from "./derive.ts";
import { MemoryError, type MemoryEntry } from "./types.ts";

export interface ValidationIssue {
  code: string;
  message: string;
  extra?: Record<string, unknown>;
}

export interface ValidateWriteInput {
  text: string;
  summary?: string;
  kind?: string;
  topic?: string;
  pin?: boolean;
}

export interface ValidateWriteOptions {
  /** The persona's current entries — needed for topic suggestions and
   * the pin / always budget guards. */
  existing: MemoryEntry[];
  /** When true, the first issue is thrown as a `MemoryError`; otherwise
   * issues are returned as warnings. Default false (warn-only, §17 P3). */
  enforce?: boolean;
  /** Skip the issue for an entry already on disk being updated, so a
   * no-op re-pin of an existing pinned entry doesn't trip the guard. */
  selfId?: string;
}

/** Run all write-time checks. Returns the (possibly empty) list of
 * issues. In enforce mode the first issue is thrown instead. */
export function validateWrite(
  input: ValidateWriteInput,
  opts: ValidateWriteOptions,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // 1. kind ∈ enum (legacy → mapped + warned; unknown → warned).
  if (input.kind !== undefined && !isV2Kind(input.kind)) {
    if (isLegacyKind(input.kind)) {
      issues.push({
        code: "kind_legacy",
        message: `kind '${input.kind}' is a legacy alias; it maps to '${mapLegacyKind(
          input.kind,
        )}'. Prefer a v2 kind: rule, fact, gotcha, pointer, note, handoff, reminder.`,
        extra: { kind: input.kind, mapped: mapLegacyKind(input.kind) },
      });
    } else {
      issues.push({
        code: "invalid_kind",
        message: `kind '${input.kind}' is not one of: rule, fact, gotcha, pointer, note, handoff, reminder.`,
        extra: { kind: input.kind },
      });
    }
  }

  // 2. summary phrases a trigger, not a bare title. Only nudge when an
  //    explicit summary was supplied and it just echoes the first line.
  if (input.summary !== undefined) {
    const firstLine = deriveSummary(input.text);
    if (input.summary.trim() === firstLine.trim() && firstLine.length > 0) {
      issues.push({
        code: "summary_is_header",
        message:
          "summary_max240 just repeats the first line of text. Phrase the trigger instead — e.g. \"when doing X, remember Y\".",
      });
    }
  }

  // 3. durable kinds (+ handoff) require a topic.
  const effectiveKind = mapLegacyKind(input.kind);
  const hasTopic = input.topic !== undefined && input.topic.length > 0;
  if (TOPIC_REQUIRED_KINDS.has(effectiveKind) && !hasTopic) {
    const existing = clusterTopics(opts.existing).map((t) => t.topic);
    issues.push({
      code: "topic_required",
      message: `kind '${effectiveKind}' requires a topic (slug = <topic>/<name>). Reuse an existing topic if one fits, or confirm a new one. See get_instructions({ topic: "topics" }).`,
      extra: {
        kind: effectiveKind,
        existing_topics: existing,
        suggestion: suggestTopic(input, opts.existing),
      },
    });
  }

  // 4. sprawl guard: a brand-new topic on a durable kind is flagged
  //    (prefer reusing an existing one).
  if (hasTopic && input.topic !== ALWAYS_TOPIC) {
    const existing = new Set(knownTopics(opts.existing));
    if (!existing.has(input.topic!) && existing.size > 0) {
      issues.push({
        code: "new_topic",
        message: `'${input.topic}' is a new topic. Reuse one of {${[...existing]
          .slice(0, 12)
          .join(", ")}}? If it's genuinely new, this is fine.`,
        extra: { topic: input.topic, existing_topics: [...existing] },
      });
    }
  }

  // 5. pin budget — adding this pin must not push the always-FULL set
  //    over PIN_FULL_BUDGET_BYTES.
  if (input.pin) {
    const current = opts.existing
      .filter(
        (e) =>
          e.pin && e.status !== "forgotten" && e.id !== opts.selfId,
      )
      .reduce((sum, e) => sum + byteLen(e.text), 0);
    const next = current + byteLen(input.text);
    if (next > PIN_FULL_BUDGET_BYTES) {
      issues.push({
        code: "pin_budget_exceeded",
        message: `Pinning this entry would push the always-FULL set to ${next} bytes (cap ${PIN_FULL_BUDGET_BYTES}). Consolidate or unpin another entry first.`,
        extra: { bytes: next, cap: PIN_FULL_BUDGET_BYTES },
      });
    }
  }

  // 6. always budget — adding an `always`-topic entry must not push the
  //    always-SUMMARY band over ALWAYS_SUMMARY_BUDGET_BYTES.
  if (input.topic === ALWAYS_TOPIC) {
    const summaryBytes = byteLen(input.summary ?? deriveSummary(input.text));
    const current = opts.existing
      .filter(
        (e) =>
          e.topic === ALWAYS_TOPIC &&
          e.status !== "forgotten" &&
          e.id !== opts.selfId,
      )
      .reduce((sum, e) => sum + byteLen(e.summary), 0);
    const next = current + summaryBytes;
    if (next > ALWAYS_SUMMARY_BUDGET_BYTES) {
      issues.push({
        code: "always_budget_exceeded",
        message: `Adding this to the 'always' band would push its summaries to ${next} bytes (cap ${ALWAYS_SUMMARY_BUDGET_BYTES}). Consolidate the always set first.`,
        extra: { bytes: next, cap: ALWAYS_SUMMARY_BUDGET_BYTES },
      });
    }
  }

  if (opts.enforce && issues.length > 0) {
    // Throw the first hard issue. `kind_legacy` / `new_topic` are
    // advisory even under enforcement — they never block a write.
    const hard = issues.find(
      (i) => i.code !== "kind_legacy" && i.code !== "new_topic",
    );
    if (hard) {
      throw new MemoryError(
        hard.code as never,
        hard.message,
        hard.extra ?? {},
      );
    }
  }

  return issues;
}

/** Lightweight topic suggestion: an existing topic whose name appears
 * in the entry text/summary, else the most-used existing topic, else
 * null. No semantic search — lexical overlap only (§13). */
function suggestTopic(
  input: ValidateWriteInput,
  existing: MemoryEntry[],
): string | null {
  const hay = `${input.summary ?? ""}\n${input.text}`.toLowerCase();
  const topics = clusterTopics(existing);
  for (const t of topics) {
    if (t.topic === ALWAYS_TOPIC) continue;
    if (hay.includes(t.topic.toLowerCase())) return t.topic;
  }
  const firstNonAlways = topics.find((t) => t.topic !== ALWAYS_TOPIC);
  return firstNonAlways ? firstNonAlways.topic : null;
}
