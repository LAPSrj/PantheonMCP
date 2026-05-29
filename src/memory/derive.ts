/** Summary derivation + slug helpers, factored out of `operations.ts`
 * so `validation.ts` can reuse them without an import cycle
 * (operations → validation → operations). */

/** §4 — summary upper bound; rejected at the API as `summary_too_long`. */
export const SUMMARY_MAX_CHARS = 240;

/** Derive a ≤240-char headline from an entry's text: the first
 * non-empty line, stripped of a leading markdown header marker, then
 * sentence-aware trimmed to the cap. */
export function deriveSummary(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const clean = firstLine.replace(/^#+\s*/, "").trim();
  if (clean.length <= SUMMARY_MAX_CHARS) return clean;
  // Sentence-aware fallback: cut at the last sentence boundary that
  // fits, else hard-trim with ellipsis.
  const trimmed = clean.slice(0, SUMMARY_MAX_CHARS);
  const lastBoundary = Math.max(
    trimmed.lastIndexOf(". "),
    trimmed.lastIndexOf("! "),
    trimmed.lastIndexOf("? "),
  );
  if (lastBoundary >= SUMMARY_MAX_CHARS / 2) {
    return trimmed.slice(0, lastBoundary + 1);
  }
  return trimmed.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
}

/** §4 unified slug domain: `slug = <topic>/<name>`. When a topic is
 * given, the generated id is namespaced under it (`chat/scope-dm-target`);
 * otherwise a flat slug. De-duplicates against `existingIds`. */
export function slugify(
  source: string,
  existingIds: Set<string>,
  topic?: string,
): string {
  const clean = source
    .replace(/^#+\s*/, "")
    .replace(/\d{4}-\d{2}-\d{2}[T ]?\d{0,2}:?\d{0,2}:?\d{0,2}[Z ]?/g, "")
    .replace(/^[\s—–-]+/, "")
    .trim();

  let name = clean
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");

  if (!name) name = `entry-${Date.now()}`;

  const prefix =
    topic !== undefined && topic.length > 0 ? `${slugSegment(topic)}/` : "";
  const base = `${prefix}${name}`;
  if (!existingIds.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
}

/** Normalise a topic into a slug-safe single segment (no slashes). */
function slugSegment(topic: string): string {
  return (
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "topic"
  );
}
