import { importEntries, loadStore } from "../memory/index.ts";
import type { Paths } from "../storage/index.ts";
import { deletePersona, patchPersona, readPersona } from "./registry.ts";
import { IdentityError, type Persona } from "./types.ts";

/** Persona consolidation — fold `from` INTO `into` and (by default)
 * drop the source, so an operator ends with a single persona.
 *
 * The inverse of `forkPersona`:
 * - Memory is deep-copied via `importEntries`, which regenerates ids,
 *   PRESERVES each entry's date / status / topic / pin / kind, remaps
 *   internal references, and skips forgotten tombstones. The target's
 *   own entries are untouched; both sets coexist under `into`.
 * - Profile: the target keeps its own description / launch / mode /
 *   color. With `union_profile` (default true) the source's `owns` and
 *   `expertise` are unioned into the target (dedup, order-stable) so the
 *   consolidated persona covers everything both did.
 * - Chat history references the source `agent_id`, so it is NOT moved —
 *   past messages stay attributed to the source handle. (The handler
 *   also refuses to merge a source that's currently online in chat.)
 *
 * The chat-side online check lives in the MCP `merge` handler (it has
 * the router in `ctx.chat`); this pure function performs the registry +
 * memory work only. */
export interface MergeOptions {
  paths: Paths;
  from: string;
  into: string;
  /** Union the source's `owns` + `expertise` into the target. Default
   * true. */
  union_profile?: boolean;
  /** Unregister + drop the source (incl. its memory file) after a
   * successful merge. Default true. Set false for a non-destructive
   * copy-merge that leaves the source intact. */
  drop_source?: boolean;
}

export interface MergeResult {
  /** The resulting target persona (post profile-union). */
  persona: Persona;
  source: string;
  merged_entries: number;
  remapped_refs: number;
  skipped_forgotten: number;
  source_dropped: boolean;
}

export function mergePersona(options: MergeOptions): MergeResult {
  if (options.from === options.into) {
    throw new IdentityError(
      "merge_into_self",
      "`from` and `into` must be different personas.",
    );
  }
  const source = readPersona(options.paths, options.from);
  if (!source) {
    throw new IdentityError(
      "not_registered",
      `Source persona '${options.from}' is not registered.`,
    );
  }
  const target = readPersona(options.paths, options.into);
  if (!target) {
    throw new IdentityError(
      "not_registered",
      `Target persona '${options.into}' is not registered.`,
    );
  }

  const sourceStore = loadStore(options.paths, options.from);
  const skippedForgotten = sourceStore.entries.filter(
    (e) => e.status === "forgotten",
  ).length;
  const { imported, remapped_refs } = importEntries(
    options.paths,
    options.into,
    sourceStore.entries,
  );

  let persona = target;
  if (options.union_profile ?? true) {
    persona = patchPersona(options.paths, options.into, {
      owns: unionStable(target.owns, source.owns),
      expertise: unionStable(target.expertise, source.expertise),
    });
  }

  const dropSource = options.drop_source ?? true;
  if (dropSource) {
    deletePersona(options.paths, options.from, { dropMemory: true });
  }

  return {
    persona,
    source: source.username,
    merged_entries: imported.length,
    remapped_refs,
    skipped_forgotten: skippedForgotten,
    source_dropped: dropSource,
  };
}

/** Order-stable set union: `a` first (verbatim), then any of `b` not
 * already present. */
function unionStable(a: string[], b: string[]): string[] {
  const seen = new Set(a);
  const out = [...a];
  for (const x of b) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
