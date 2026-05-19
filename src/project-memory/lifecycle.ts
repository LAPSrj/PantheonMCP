/** Lifecycle-rule coercion for project-memory writes.
 *
 * Mirrors `src/memory/lifecycle.ts` for the project-memory store.
 * See that module for the rationale; the rule and the reference-
 * kind set are identical across persona and project memory. */

import { REFERENCE_KINDS } from "../memory/lifecycle.ts";
import {
  fadeProjectEntry,
  forgetProjectEntry,
  getProjectEntry,
} from "./operations.ts";
import {
  ProjectMemoryError,
  type ProjectMemoryEntry,
} from "./types.ts";
import type { Paths } from "../storage/index.ts";

export interface ProjectForgetCoercionResult {
  entry: ProjectMemoryEntry;
  coerced: "fade" | null;
  reason?: string;
}

export function forgetProjectEntryWithLifecycleCoercion(
  paths: Paths,
  project: string,
  id: string,
): ProjectForgetCoercionResult {
  const existing = getProjectEntry(paths, project, id);
  if (!existing) {
    throw new ProjectMemoryError(
      "entry_not_found",
      `No project-memory entry '${id}' for project '${project}'.`,
    );
  }

  if (existing.core === true) {
    const faded = fadeProjectEntry(paths, project, id);
    return {
      entry: faded,
      coerced: "fade",
      reason:
        `core entry — lifecycle rule fades core, never forgets directly. ` +
        `Demote at most one tier per pass; the next pass can forget the (now-faded) entry.`,
    };
  }

  if (
    existing.status === "active" &&
    typeof existing.kind === "string" &&
    REFERENCE_KINDS.has(existing.kind)
  ) {
    const faded = fadeProjectEntry(paths, project, id);
    return {
      entry: faded,
      coerced: "fade",
      reason:
        `active reference-kind entry (kind=${existing.kind}) — lifecycle rule ` +
        `fades active reference-shape entries; never forgets directly. The ` +
        `next pass (where the entry is faded) can forget normally.`,
    };
  }

  const forgotten = forgetProjectEntry(paths, project, id);
  return { entry: forgotten, coerced: null };
}
