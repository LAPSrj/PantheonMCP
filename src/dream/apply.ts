/** Apply a DreamPlan to persona or project memory.
 *
 * Auto-apply, no review — the persona has the same information the
 * librarian had, so a review step adds no signal. Audit entry of
 * kind=`dream_log` summarizes what changed so the trail is greppable.
 *
 * Source ids in `consolidate.source_ids` are forgotten AFTER the new
 * entry is appended, so a mid-apply crash leaves both visible rather
 * than losing the source. Append + forget run in the same store mutate
 * for persona memory; project memory uses two store mutations (append,
 * then forget per id) — atomicity within each is guaranteed; cross-
 * action atomicity is best-effort. */

import type { Paths } from "../storage/index.ts";
import {
  appendEntry as appendPersonaEntry,
  fadeEntry as fadePersonaEntry,
  forgetEntry as forgetPersonaEntry,
  loadStore as loadPersonaStore,
} from "../memory/index.ts";
import {
  appendProjectEntry,
  fadeProjectEntry,
  forgetProjectEntry,
  loadProjectMemoryStore,
} from "../project-memory/index.ts";
import type {
  DreamApplyResult,
  DreamPlan,
  DreamScope,
} from "./types.ts";
import type { LibrarianSnapshot } from "./librarian.ts";

/** Kinds whose forget bar is high enough that a single dream pass
 * should never transition them straight from active → forgotten. The
 * applier coerces any such `forget` action to `fade`, mirroring the
 * core-coercion path: same multi-pass guarantee, surfaced in the
 * audit note for traceability.
 *
 * Mirrors the typology in `LIBRARIAN_SYSTEM_PROMPT`. Kept in sync by
 * convention — the prompt explains the rule to the librarian; this
 * set enforces it deterministically. `handoff` is intentionally
 * excluded: handoffs cycle by design (TTL-fade after 7 days; clearly
 * ephemeral). */
export const REFERENCE_KINDS: ReadonlySet<string> = new Set([
  "gotcha",
  "fact",
  "decision",
  "design",
  "cross-mcp-workflow",
  "sibling-network",
  "posture-rail",
]);

export function buildPersonaSnapshot(
  paths: Paths,
  username: string,
): LibrarianSnapshot {
  const store = loadPersonaStore(paths, username);
  const entries = store.entries
    .filter((e) => e.status === "active" || e.status === "faded")
    .map((e) => ({
      id: e.id,
      summary: e.summary,
      text: e.text,
      status: e.status as "active" | "faded",
      date: e.date,
      ...(e.kind !== undefined ? { kind: e.kind } : {}),
      ...(e.core !== undefined ? { core: e.core } : {}),
    }));
  return { scope: "persona", target: username, entries };
}

export function buildProjectSnapshot(
  paths: Paths,
  project: string,
): LibrarianSnapshot {
  const store = loadProjectMemoryStore(paths, project);
  const entries = store.entries
    .filter((e) => e.status === "active" || e.status === "faded")
    .map((e) => ({
      id: e.id,
      summary: e.summary,
      text: e.text,
      status: e.status as "active" | "faded",
      date: e.date,
      ...(e.kind !== undefined ? { kind: e.kind } : {}),
      ...(e.core !== undefined ? { core: e.core } : {}),
      ...(e.author_username !== undefined
        ? { author_username: e.author_username }
        : {}),
    }));
  return { scope: "project", target: project, entries };
}

export function applyPersonaPlan(
  paths: Paths,
  username: string,
  plan: DreamPlan,
): DreamApplyResult {
  const notes: string[] = [];
  let faded = 0;
  let forgotten = 0;
  let consolidated = 0;
  let core_forgets_coerced = 0;

  // Build a snapshot of which ids are currently core so the applier
  // can enforce the lifecycle rule: forget on a core entry is coerced
  // to fade. Snapshot taken once at the start; mid-plan mutations on
  // core status are vanishingly rare (no plan action sets core: true
  // on an existing entry).
  const preStore = loadPersonaStore(paths, username);
  const coreIds = new Set(
    preStore.entries.filter((e) => Boolean(e.core)).map((e) => e.id),
  );
  // Lookup for the reference-kind coercion: id → entry (active only;
  // already-faded reference entries can still be forgotten per the
  // one-tier-per-pass rule). Built once at the top so each forget
  // check is O(1).
  const activeRefById = new Map<string, { id: string; kind: string }>();
  for (const e of preStore.entries) {
    if (
      e.status === "active" &&
      typeof e.kind === "string" &&
      REFERENCE_KINDS.has(e.kind)
    ) {
      activeRefById.set(e.id, { id: e.id, kind: e.kind });
    }
  }
  let reference_forgets_coerced = 0;

  // Detect consolidation opportunities the librarian missed. Surfaces
  // as a note for the auditor; does NOT gate the apply.
  const liveEntries = preStore.entries.filter(
    (e) => e.status === "active" || e.status === "faded",
  );
  const skippedChains = detectSkippedConsolidations(liveEntries, plan);
  for (const chain of skippedChains) {
    notes.push(
      `consolidation skipped: replies_to chain of ${chain.length} entries ` +
        `(${chain.slice(0, 3).join(" ← ")}${chain.length > 3 ? ` ← … (+${chain.length - 3})` : ""}) ` +
        `— librarian neither consolidated nor forgot the chain.`,
    );
  }

  for (const action of plan.consolidate) {
    try {
      // Carry source ids forward as `see_also` so the render-time
      // index synopsis surfaces back-pointers from the consolidated
      // entry to its sources (`[see_also: a, b, …]`). At this point
      // the sources are still active in the store, so the
      // `appendEntry` reference-validation passes; the subsequent
      // fade/forget on each source leaves the references pointing
      // at tombstoned entries, which the renderer handles gracefully
      // and which `recall_memory(id)` can still resurrect.
      const validSeeAlso = action.source_ids.filter((sid) =>
        preStore.entries.some((e) => e.id === sid),
      );
      appendPersonaEntry(paths, username, {
        summary: action.new_entry.summary,
        text: action.new_entry.text,
        ...(action.new_entry.kind !== undefined ? { kind: action.new_entry.kind } : {}),
        ...(action.new_entry.core !== undefined ? { core: action.new_entry.core } : {}),
        ...(validSeeAlso.length > 0 ? { see_also: validSeeAlso } : {}),
      });
      for (const sid of action.source_ids) {
        try {
          // Source ids in a consolidate set get FADED rather than
          // forgotten when they're core — same lifecycle protection
          // as the standalone forget queue. The consolidated entry
          // already carries forward what matters.
          if (coreIds.has(sid)) {
            fadePersonaEntry(paths, username, sid);
            faded++;
            core_forgets_coerced++;
            notes.push(
              `consolidate: core source '${sid}' faded (not forgotten) per lifecycle rule.`,
            );
          } else {
            forgetPersonaEntry(paths, username, sid);
          }
        } catch (err) {
          notes.push(
            `consolidate: drop source '${sid}' failed: ${(err as Error).message}`,
          );
        }
      }
      consolidated++;
    } catch (err) {
      notes.push(`consolidate failed: ${(err as Error).message}`);
    }
  }

  for (const action of plan.fade) {
    try {
      fadePersonaEntry(paths, username, action.id);
      faded++;
    } catch (err) {
      notes.push(`fade('${action.id}') failed: ${(err as Error).message}`);
    }
  }

  for (const action of plan.forget) {
    if (coreIds.has(action.id)) {
      // Lifecycle rule: forget on core → fade. Surface the coercion
      // so the auditor sees the librarian's intent + the enforcement.
      try {
        fadePersonaEntry(paths, username, action.id);
        faded++;
        core_forgets_coerced++;
        notes.push(
          `forget('${action.id}') coerced to fade — entry is core; per lifecycle rule, core demotes at most one tier per pass.`,
        );
      } catch (err) {
        notes.push(
          `fade-coercion('${action.id}') failed: ${(err as Error).message}`,
        );
      }
      continue;
    }
    const refEntry = activeRefById.get(action.id);
    if (refEntry !== undefined) {
      // Reference-shape kinds (gotcha/fact/decision/design/...) get
      // the same multi-pass protection as core when active. They
      // carry recurring-context knowledge that's expensive to
      // re-derive; a single-pass forget loses lineage.
      try {
        fadePersonaEntry(paths, username, action.id);
        faded++;
        reference_forgets_coerced++;
        notes.push(
          `forget('${action.id}') coerced to fade — entry is an active ${refEntry.kind} ` +
            `(reference-shape kind); per lifecycle rule, reference entries demote at most one tier per pass.`,
        );
      } catch (err) {
        notes.push(
          `fade-coercion('${action.id}') failed: ${(err as Error).message}`,
        );
      }
      continue;
    }
    try {
      forgetPersonaEntry(paths, username, action.id);
      forgotten++;
    } catch (err) {
      notes.push(`forget('${action.id}') failed: ${(err as Error).message}`);
    }
  }

  const coercionSuffix =
    core_forgets_coerced > 0 || reference_forgets_coerced > 0
      ? (core_forgets_coerced > 0
          ? `, ${core_forgets_coerced} core-forget coerced to fade`
          : "") +
        (reference_forgets_coerced > 0
          ? `, ${reference_forgets_coerced} reference-forget coerced to fade`
          : "")
      : "";
  const bodies = renderAuditBodies(plan, notes);
  const summary = plan.posture_summary
    ? plan.posture_summary.length <= 240
      ? plan.posture_summary
      : `Dream ${todayIso()} — ${plan.posture_summary.slice(0, 200)}…`
    : `Dream ${todayIso()} — faded ${faded}, forgot ${forgotten}, consolidated ${consolidated}${coercionSuffix}`;
  const audit = appendPersonaEntry(paths, username, {
    summary,
    text: bodies.text,
    details: bodies.details,
    kind: "dream_log",
  });

  return {
    scope: "persona",
    target: username,
    faded,
    forgotten,
    consolidated,
    audit_entry_id: audit.id,
    notes,
  };
}

export function applyProjectPlan(
  paths: Paths,
  project: string,
  plan: DreamPlan,
  /** Persona username to stamp on the audit entry + consolidated
   * entries. Optional — project entries support undefined author. */
  author_username: string | null = null,
): DreamApplyResult {
  const notes: string[] = [];
  let faded = 0;
  let forgotten = 0;
  let consolidated = 0;
  let core_forgets_coerced = 0;

  const preStore = loadProjectMemoryStore(paths, project);
  const coreIds = new Set(
    preStore.entries.filter((e) => Boolean(e.core)).map((e) => e.id),
  );
  // Same reference-kind lookup as the persona path. Project entries
  // carry a `kind` field with the same conventions.
  const activeRefById = new Map<string, { id: string; kind: string }>();
  for (const e of preStore.entries) {
    if (
      e.status === "active" &&
      typeof e.kind === "string" &&
      REFERENCE_KINDS.has(e.kind)
    ) {
      activeRefById.set(e.id, { id: e.id, kind: e.kind });
    }
  }
  let reference_forgets_coerced = 0;

  // Project entries don't carry replies_to (the field is persona-only),
  // so skipped-chain detection is a no-op here. Keeping the symmetric
  // call site documented so a future schema addition would slot in.

  for (const action of plan.consolidate) {
    try {
      appendProjectEntry(paths, project, {
        summary: action.new_entry.summary,
        text: action.new_entry.text,
        ...(action.new_entry.kind !== undefined ? { kind: action.new_entry.kind } : {}),
        ...(action.new_entry.core !== undefined ? { core: action.new_entry.core } : {}),
        ...(author_username !== null ? { author_username } : {}),
      });
      for (const sid of action.source_ids) {
        try {
          if (coreIds.has(sid)) {
            fadeProjectEntry(paths, project, sid);
            faded++;
            core_forgets_coerced++;
            notes.push(
              `consolidate: core source '${sid}' faded (not forgotten) per lifecycle rule.`,
            );
          } else {
            forgetProjectEntry(paths, project, sid);
          }
        } catch (err) {
          notes.push(
            `consolidate: drop source '${sid}' failed: ${(err as Error).message}`,
          );
        }
      }
      consolidated++;
    } catch (err) {
      notes.push(`consolidate failed: ${(err as Error).message}`);
    }
  }

  for (const action of plan.fade) {
    try {
      fadeProjectEntry(paths, project, action.id);
      faded++;
    } catch (err) {
      notes.push(`fade('${action.id}') failed: ${(err as Error).message}`);
    }
  }

  for (const action of plan.forget) {
    if (coreIds.has(action.id)) {
      try {
        fadeProjectEntry(paths, project, action.id);
        faded++;
        core_forgets_coerced++;
        notes.push(
          `forget('${action.id}') coerced to fade — entry is core; per lifecycle rule, core demotes at most one tier per pass.`,
        );
      } catch (err) {
        notes.push(
          `fade-coercion('${action.id}') failed: ${(err as Error).message}`,
        );
      }
      continue;
    }
    const refEntry = activeRefById.get(action.id);
    if (refEntry !== undefined) {
      try {
        fadeProjectEntry(paths, project, action.id);
        faded++;
        reference_forgets_coerced++;
        notes.push(
          `forget('${action.id}') coerced to fade — entry is an active ${refEntry.kind} ` +
            `(reference-shape kind); per lifecycle rule, reference entries demote at most one tier per pass.`,
        );
      } catch (err) {
        notes.push(
          `fade-coercion('${action.id}') failed: ${(err as Error).message}`,
        );
      }
      continue;
    }
    try {
      forgetProjectEntry(paths, project, action.id);
      forgotten++;
    } catch (err) {
      notes.push(`forget('${action.id}') failed: ${(err as Error).message}`);
    }
  }

  const coercionSuffix =
    core_forgets_coerced > 0 || reference_forgets_coerced > 0
      ? (core_forgets_coerced > 0
          ? `, ${core_forgets_coerced} core-forget coerced to fade`
          : "") +
        (reference_forgets_coerced > 0
          ? `, ${reference_forgets_coerced} reference-forget coerced to fade`
          : "")
      : "";
  const bodies = renderAuditBodies(plan, notes);
  const summary = plan.posture_summary
    ? plan.posture_summary.length <= 240
      ? plan.posture_summary
      : `Project-dream ${todayIso()} — ${plan.posture_summary.slice(0, 200)}…`
    : `Project-dream ${todayIso()} — faded ${faded}, forgot ${forgotten}, consolidated ${consolidated}${coercionSuffix}`;
  const audit = appendProjectEntry(paths, project, {
    summary,
    text: bodies.text,
    details: bodies.details,
    kind: "dream_log",
    ...(author_username !== null ? { author_username } : {}),
  });

  return {
    scope: "project",
    target: project,
    faded,
    forgotten,
    consolidated,
    audit_entry_id: audit.id,
    notes,
  };
}

interface AuditBodies {
  /** Compact summary going into the dream_log entry's `text` — the
   * body rendered inline at startup. */
  text: string;
  /** Full plan dump going into `details` — accessed only via
   * `get_memory_details(id)`. Off-budget. */
  details: string;
}

/** Render the audit body in two tiers: a compact reason-category
 * roll-up for `text` (rendered inline) and the full per-action dump
 * for `details` (never inlined). Forget reasons get grouped by
 * first-clause to keep the count summary readable even at 30+
 * forgets. Top 5 forget decisions are surfaced verbatim alongside
 * the rollup for fast skim. */
function renderAuditBodies(plan: DreamPlan, notes: string[]): AuditBodies {
  const text = renderAuditRollup(plan, notes);
  const details = renderAuditDetail(plan, notes);
  return { text, details };
}

function renderAuditRollup(plan: DreamPlan, notes: string[]): string {
  const lines: string[] = [];

  if (plan.posture_summary) {
    lines.push(`> ${plan.posture_summary}`);
    lines.push("");
  }

  lines.push(
    `Counts — fade: ${plan.fade.length}, forget: ${plan.forget.length}, consolidate: ${plan.consolidate.length}.`,
  );
  lines.push("");

  if (plan.consolidate.length > 0) {
    lines.push("## consolidated:");
    for (const a of plan.consolidate) {
      lines.push(
        `- (${a.source_ids.length}) → \`${escapeMd(a.new_entry.summary)}\`${a.reason ? ` — ${a.reason}` : ""}`,
      );
    }
    lines.push("");
  }

  const fadeCats = groupByReason(plan.fade);
  if (fadeCats.size > 0) {
    lines.push("## fade categories:");
    for (const [cat, ids] of topN(fadeCats, 3)) {
      lines.push(`- ${ids.length}× ${cat}`);
    }
    if (fadeCats.size > 3) {
      lines.push(`- (+${fadeCats.size - 3} more categories — see details)`);
    }
    lines.push("");
  }

  const forgetCats = groupByReason(plan.forget);
  if (forgetCats.size > 0) {
    lines.push("## forget categories:");
    for (const [cat, ids] of topN(forgetCats, 3)) {
      lines.push(`- ${ids.length}× ${cat}`);
    }
    if (forgetCats.size > 3) {
      lines.push(`- (+${forgetCats.size - 3} more categories — see details)`);
    }
    lines.push("");
  }

  if (plan.forget.length > 0) {
    lines.push("## notable forgets (top 5 by id):");
    for (const a of plan.forget.slice(0, 5)) {
      lines.push(`- \`${a.id}\`${a.reason ? ` — ${a.reason}` : ""}`);
    }
    if (plan.forget.length > 5) {
      lines.push(
        `- (+${plan.forget.length - 5} more — see details for full list)`,
      );
    }
    lines.push("");
  }

  if (notes.length > 0) {
    const visible = notes.slice(0, 5);
    lines.push("## notes:");
    for (const n of visible) lines.push(`- ${n}`);
    if (notes.length > visible.length) {
      lines.push(
        `- (+${notes.length - visible.length} more notes — see details)`,
      );
    }
    lines.push("");
  }

  if (
    plan.fade.length === 0 &&
    plan.forget.length === 0 &&
    plan.consolidate.length === 0 &&
    notes.length === 0
  ) {
    lines.push("No-op pass — librarian returned an empty plan.");
  }

  return lines.join("\n").trimEnd();
}

function renderAuditDetail(plan: DreamPlan, notes: string[]): string {
  const lines: string[] = [];
  if (plan.fade.length > 0) {
    lines.push("## faded:");
    for (const a of plan.fade) {
      lines.push(`- ${a.id}${a.reason ? ` — ${a.reason}` : ""}`);
    }
    lines.push("");
  }
  if (plan.forget.length > 0) {
    lines.push("## forgotten:");
    for (const a of plan.forget) {
      lines.push(`- ${a.id}${a.reason ? ` — ${a.reason}` : ""}`);
    }
    lines.push("");
  }
  if (plan.consolidate.length > 0) {
    lines.push("## consolidated:");
    for (const a of plan.consolidate) {
      lines.push(
        `- (${a.source_ids.length}) ${a.source_ids.join(", ")} → "${a.new_entry.summary}"${a.reason ? ` — ${a.reason}` : ""}`,
      );
    }
    lines.push("");
  }
  if (notes.length > 0) {
    lines.push("## notes:");
    for (const n of notes) lines.push(`- ${n}`);
  }
  return lines.join("\n").trimEnd();
}

/** Group plan entries by a normalized first-clause of their reason.
 * Entries without a reason go under the synthetic key
 * `(no reason given)`. Keys are lowercased + whitespace-collapsed
 * + truncated to 80 chars so near-duplicates merge. */
function groupByReason(
  items: ReadonlyArray<{ id: string; reason?: string }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const it of items) {
    const key = normalizeReason(it.reason);
    const existing = out.get(key);
    if (existing) existing.push(it.id);
    else out.set(key, [it.id]);
  }
  return out;
}

function normalizeReason(reason: string | undefined): string {
  if (!reason || reason.trim().length === 0) return "(no reason given)";
  // First-clause: split on `;` or `. ` or `, ` (in priority order).
  let clause = reason.trim();
  for (const sep of [";", ". ", ", "]) {
    const at = clause.indexOf(sep);
    if (at > 0) {
      clause = clause.slice(0, at);
      break;
    }
  }
  return clause
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function topN<K, V>(
  map: Map<K, V[]>,
  n: number,
): Array<[K, V[]]> {
  return [...map.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, n);
}

function escapeMd(s: string): string {
  // Light escape — `s.replace` for any `` ` `` chars that would break
  // the inline-code rendering. Bodies don't need fuller escaping;
  // this is just for the inline `\`...\`` snippets.
  return s.replace(/`/g, "\\`");
}

/** Detect replies_to chains of length ≥3 that the librarian did NOT
 * consolidate AND did NOT forget entirely. These are the clearest
 * "consolidation opportunity skipped" signals: a structured chain of
 * related entries left intact, when the prompt-trained librarian
 * should have folded them.
 *
 * Returns ordered chains, root-first (oldest parent to newest leaf).
 * Does NOT consider artifact-id clustering (commit SHAs, block names)
 * — that detection is heavier and fuzzier; replies_to is canonical
 * and structured, so it's the high-precision signal worth surfacing.
 *
 * Detect-don't-gate: the warning informs the auditor; nothing in the
 * apply is rejected or blocked. */
function detectSkippedConsolidations(
  entries: ReadonlyArray<{ id: string; replies_to?: string }>,
  plan: DreamPlan,
): string[][] {
  // Build child → parent adjacency. Only entries that ARE replies
  // create edges.
  const parentOf = new Map<string, string>();
  const idSet = new Set<string>();
  for (const e of entries) {
    idSet.add(e.id);
    if (e.replies_to && e.replies_to.length > 0) {
      parentOf.set(e.id, e.replies_to);
    }
  }

  // Identify chain roots: entries that have at least one descendant
  // but are not themselves descendants. Walking children from each
  // root produces the maximal chain rooted there.
  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of parentOf) {
    if (!idSet.has(parent)) continue; // parent outside snapshot — skip.
    const arr = childrenOf.get(parent) ?? [];
    arr.push(child);
    childrenOf.set(parent, arr);
  }
  const roots: string[] = [];
  for (const e of entries) {
    if (parentOf.has(e.id)) continue; // not a root.
    if (childrenOf.has(e.id)) roots.push(e.id);
  }

  // For each root, walk the chain via depth-first single path
  // (multiple children fork — we pick the longest path for the
  // warning; alternative branches are still part of the chain
  // family but the warning surfaces the longest one for readability).
  const chains: string[][] = [];
  for (const root of roots) {
    const chain = longestChain(root, childrenOf);
    if (chain.length >= 3) chains.push(chain);
  }

  if (chains.length === 0) return chains;

  // Filter out chains the librarian handled — fully consolidated OR
  // every member ended up in `forget`. Either action is a valid
  // "the chain was processed" outcome.
  const consolidatedIds = new Set<string>();
  for (const action of plan.consolidate) {
    for (const sid of action.source_ids) consolidatedIds.add(sid);
  }
  const forgetIds = new Set<string>();
  for (const action of plan.forget) forgetIds.add(action.id);

  return chains.filter((chain) => {
    const allConsolidated = chain.every((id) => consolidatedIds.has(id));
    const allForgotten = chain.every((id) => forgetIds.has(id));
    return !allConsolidated && !allForgotten;
  });
}

function longestChain(
  root: string,
  childrenOf: Map<string, string[]>,
): string[] {
  let best: string[] = [];
  const dfs = (node: string, path: string[]): void => {
    const children = childrenOf.get(node) ?? [];
    if (children.length === 0) {
      if (path.length > best.length) best = path.slice();
      return;
    }
    for (const c of children) {
      path.push(c);
      dfs(c, path);
      path.pop();
    }
  };
  dfs(root, [root]);
  return best;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Convenience helper used in tests / dry-run paths. */
export function summarizePlan(plan: DreamPlan): string {
  return `fade=${plan.fade.length} forget=${plan.forget.length} consolidate=${plan.consolidate.length}`;
}

/** Re-export for tests that want a no-network path. */
export type { DreamScope };
