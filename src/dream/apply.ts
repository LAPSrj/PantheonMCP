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

  for (const action of plan.consolidate) {
    try {
      appendPersonaEntry(paths, username, {
        summary: action.new_entry.summary,
        text: action.new_entry.text,
        ...(action.new_entry.kind !== undefined ? { kind: action.new_entry.kind } : {}),
        ...(action.new_entry.core !== undefined ? { core: action.new_entry.core } : {}),
      });
      for (const sid of action.source_ids) {
        try {
          forgetPersonaEntry(paths, username, sid);
        } catch (err) {
          notes.push(
            `consolidate: forget source '${sid}' failed: ${(err as Error).message}`,
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
    try {
      forgetPersonaEntry(paths, username, action.id);
      forgotten++;
    } catch (err) {
      notes.push(`forget('${action.id}') failed: ${(err as Error).message}`);
    }
  }

  const audit = appendPersonaEntry(paths, username, {
    summary: `Dream ${todayIso()} — faded ${faded}, forgot ${forgotten}, consolidated ${consolidated}`,
    text: renderAuditBody(plan, notes),
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
          forgetProjectEntry(paths, project, sid);
        } catch (err) {
          notes.push(
            `consolidate: forget source '${sid}' failed: ${(err as Error).message}`,
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
    try {
      forgetProjectEntry(paths, project, action.id);
      forgotten++;
    } catch (err) {
      notes.push(`forget('${action.id}') failed: ${(err as Error).message}`);
    }
  }

  const audit = appendProjectEntry(paths, project, {
    summary: `Project-dream ${todayIso()} — faded ${faded}, forgot ${forgotten}, consolidated ${consolidated}`,
    text: renderAuditBody(plan, notes),
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

function renderAuditBody(plan: DreamPlan, notes: string[]): string {
  const lines: string[] = [];
  if (plan.fade.length > 0) {
    lines.push("## faded:");
    for (const a of plan.fade) {
      lines.push(`- ${a.id}${a.reason ? ` — ${a.reason}` : ""}`);
    }
  }
  if (plan.forget.length > 0) {
    lines.push("## forgotten:");
    for (const a of plan.forget) {
      lines.push(`- ${a.id}${a.reason ? ` — ${a.reason}` : ""}`);
    }
  }
  if (plan.consolidate.length > 0) {
    lines.push("## consolidated:");
    for (const a of plan.consolidate) {
      lines.push(
        `- (${a.source_ids.length}) ${a.source_ids.join(", ")} → "${a.new_entry.summary}"${a.reason ? ` — ${a.reason}` : ""}`,
      );
    }
  }
  if (notes.length > 0) {
    lines.push("## notes:");
    for (const n of notes) lines.push(`- ${n}`);
  }
  if (lines.length === 0) lines.push("No-op pass — librarian returned an empty plan.");
  return lines.join("\n");
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
