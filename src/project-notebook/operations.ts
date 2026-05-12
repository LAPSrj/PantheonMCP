/** Project-notebook CRUD operations.
 *
 * Mirror of `src/notebook/operations.ts` keyed on `project`. Same shape,
 * same validation, same auto-vanish-when-empty TOC behavior. The
 * `author_username` field is required-but-not-enforced (handlers stamp
 * it from the caller's claimed persona; tests pass it in).
 */

import type { Paths } from "../storage/index.ts";
import {
  loadProjectNotebookStore,
  mutateProjectNotebookStore,
} from "./store.ts";
import {
  ProjectNotebookError,
  type ProjectNotebookPage,
  type ProjectNotebookStore,
  type ProjectNotebookTopic,
  type ProjectNotebookTopicRef,
} from "./types.ts";

// Reuse the same soft-warn thresholds and slug pattern as per-persona
// notebooks — the storage is the same shape, the limits should match.
import {
  PAGE_BODY_WARN_BYTES,
  SLUG_RE,
  TITLE_MAX_CHARS,
  TOPIC_TOTAL_WARN_BYTES,
} from "../notebook/types.ts";

export interface WriteProjectPageInput {
  topic: string;
  title: string;
  body: string;
  page_id?: string;
  tags?: string[];
  topic_title?: string;
  author_username?: string;
}

export interface WriteProjectPageResult {
  topic: string;
  page: ProjectNotebookPage;
  created: boolean;
  warning: string | null;
}

export function writeProjectPage(
  paths: Paths,
  project: string,
  input: WriteProjectPageInput,
): WriteProjectPageResult {
  validateSlug(input.topic);
  validateTitle(input.title);
  if (input.body.length === 0) {
    throw new ProjectNotebookError("missing_body", "Page body must be non-empty.");
  }

  let result!: WriteProjectPageResult;
  mutateProjectNotebookStore(paths, project, (store) => {
    const now = new Date().toISOString();
    const topicIdx = store.topics.findIndex((t) => t.slug === input.topic);
    const existingTopic = topicIdx >= 0 ? store.topics[topicIdx]! : undefined;

    if (existingTopic === undefined && input.page_id !== undefined) {
      throw new ProjectNotebookError(
        "topic_not_found",
        `No topic '${input.topic}' to update page '${input.page_id}' in.`,
      );
    }

    const topic: ProjectNotebookTopic =
      existingTopic ??
      ({
        slug: input.topic,
        title: input.topic_title ?? input.topic,
        created_at: now,
        updated_at: now,
        pages: [],
      } as ProjectNotebookTopic);

    let page: ProjectNotebookPage;
    let created: boolean;
    if (input.page_id !== undefined) {
      const idx = topic.pages.findIndex((p) => p.id === input.page_id);
      if (idx < 0) {
        throw new ProjectNotebookError(
          "page_not_found",
          `No page '${input.page_id}' in topic '${input.topic}'.`,
        );
      }
      const current = topic.pages[idx]!;
      page = {
        ...current,
        title: input.title,
        body: input.body,
        updated_at: now,
        status: "active",
        ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
        ...(input.author_username !== undefined
          ? { author_username: input.author_username }
          : {}),
      };
      topic.pages = topic.pages.slice();
      topic.pages[idx] = page;
      created = false;
    } else {
      const id = slugifyPage(input.title, new Set(topic.pages.map((p) => p.id)));
      page = {
        id,
        title: input.title,
        body: input.body,
        status: "active",
        created_at: now,
        updated_at: now,
        ...(input.tags !== undefined && input.tags.length > 0
          ? { tags: dedupeTags(input.tags) }
          : {}),
        ...(input.author_username !== undefined
          ? { author_username: input.author_username }
          : {}),
      };
      topic.pages = [...topic.pages, page];
      created = true;
    }
    topic.updated_at = now;

    const topics = store.topics.slice();
    if (topicIdx >= 0) {
      topics[topicIdx] = topic;
    } else {
      topics.push(topic);
    }
    result = {
      topic: topic.slug,
      page,
      created,
      warning: sizeWarning(page, topic),
    };
    return { ...store, topics };
  });
  return result;
}

export interface OpenProjectTopicResult {
  topic: ProjectNotebookTopic;
}

export function openProjectTopic(
  paths: Paths,
  project: string,
  topic: string,
  options: { include_deleted?: boolean } = {},
): OpenProjectTopicResult {
  validateSlug(topic);
  const store = loadProjectNotebookStore(paths, project);
  const found = store.topics.find((t) => t.slug === topic);
  if (!found) {
    throw new ProjectNotebookError(
      "topic_not_found",
      `No topic '${topic}' in project '${project}'.`,
    );
  }
  const pages = options.include_deleted
    ? found.pages
    : found.pages.filter((p) => p.status === "active");
  return { topic: { ...found, pages } };
}

export function getProjectPage(
  paths: Paths,
  project: string,
  topic: string,
  pageId: string,
): ProjectNotebookPage {
  validateSlug(topic);
  const store = loadProjectNotebookStore(paths, project);
  const t = store.topics.find((x) => x.slug === topic);
  if (!t) {
    throw new ProjectNotebookError(
      "topic_not_found",
      `No topic '${topic}' in project '${project}'.`,
    );
  }
  const p = t.pages.find((x) => x.id === pageId);
  if (!p) {
    throw new ProjectNotebookError(
      "page_not_found",
      `No page '${pageId}' in topic '${topic}'.`,
    );
  }
  return p;
}

export function listProjectTopics(
  paths: Paths,
  project: string,
  options: { include_empty?: boolean } = {},
): ProjectNotebookTopicRef[] {
  const store = loadProjectNotebookStore(paths, project);
  const refs: ProjectNotebookTopicRef[] = [];
  for (const t of store.topics) {
    const active = t.pages.filter((p) => p.status === "active");
    if (active.length === 0 && !options.include_empty) continue;
    refs.push({
      slug: t.slug,
      title: t.title,
      page_count: active.length,
      last_touched_at: t.updated_at,
    });
  }
  refs.sort((a, b) =>
    a.last_touched_at < b.last_touched_at
      ? 1
      : a.last_touched_at > b.last_touched_at
        ? -1
        : 0,
  );
  return refs;
}

export function deleteProjectPage(
  paths: Paths,
  project: string,
  topic: string,
  pageId: string,
): ProjectNotebookPage {
  return setProjectPageStatus(paths, project, topic, pageId, "deleted");
}

export function restoreProjectPage(
  paths: Paths,
  project: string,
  topic: string,
  pageId: string,
): ProjectNotebookPage {
  return setProjectPageStatus(paths, project, topic, pageId, "active");
}

function setProjectPageStatus(
  paths: Paths,
  project: string,
  topic: string,
  pageId: string,
  status: "active" | "deleted",
): ProjectNotebookPage {
  validateSlug(topic);
  let updated!: ProjectNotebookPage;
  mutateProjectNotebookStore(paths, project, (store) => {
    const topicIdx = store.topics.findIndex((t) => t.slug === topic);
    if (topicIdx < 0) {
      throw new ProjectNotebookError(
        "topic_not_found",
        `No topic '${topic}' in project '${project}'.`,
      );
    }
    const t = store.topics[topicIdx]!;
    const pageIdx = t.pages.findIndex((p) => p.id === pageId);
    if (pageIdx < 0) {
      throw new ProjectNotebookError(
        "page_not_found",
        `No page '${pageId}' in topic '${topic}'.`,
      );
    }
    const now = new Date().toISOString();
    const page = t.pages[pageIdx]!;
    updated = { ...page, status, updated_at: now };
    const pages = t.pages.slice();
    pages[pageIdx] = updated;
    const topics = store.topics.slice();
    topics[topicIdx] = { ...t, pages, updated_at: now };
    return { ...store, topics };
  });
  return updated;
}

export function deleteProjectTopic(
  paths: Paths,
  project: string,
  topic: string,
): { topic: string; pages_deleted: number } {
  validateSlug(topic);
  let count = 0;
  mutateProjectNotebookStore(paths, project, (store) => {
    const idx = store.topics.findIndex((t) => t.slug === topic);
    if (idx < 0) {
      throw new ProjectNotebookError(
        "topic_not_found",
        `No topic '${topic}' in project '${project}'.`,
      );
    }
    const t = store.topics[idx]!;
    const now = new Date().toISOString();
    const pages = t.pages.map((p) => {
      if (p.status === "active") {
        count++;
        return { ...p, status: "deleted" as const, updated_at: now };
      }
      return p;
    });
    const topics = store.topics.slice();
    topics[idx] = { ...t, pages, updated_at: now };
    return { ...store, topics };
  });
  return { topic, pages_deleted: count };
}

export function renameProjectTopic(
  paths: Paths,
  project: string,
  from: string,
  to: string,
): { from: string; to: string; pages_moved: number } {
  validateSlug(from);
  validateSlug(to);
  if (from === to) return { from, to, pages_moved: 0 };
  let moved = 0;
  mutateProjectNotebookStore(paths, project, (store) => {
    const fromIdx = store.topics.findIndex((t) => t.slug === from);
    if (fromIdx < 0) {
      throw new ProjectNotebookError(
        "topic_not_found",
        `No topic '${from}' in project '${project}'.`,
      );
    }
    if (store.topics.some((t) => t.slug === to)) {
      throw new ProjectNotebookError(
        "topic_exists",
        `Cannot rename to '${to}': a topic with that slug already exists in project '${project}'.`,
      );
    }
    const t = store.topics[fromIdx]!;
    moved = t.pages.length;
    const now = new Date().toISOString();
    const renamed: ProjectNotebookTopic = { ...t, slug: to, updated_at: now };
    const topics = store.topics.slice();
    topics[fromIdx] = renamed;
    return { ...store, topics };
  });
  return { from, to, pages_moved: moved };
}

export interface ProjectSearchHit {
  project: string;
  topic: string;
  page_id: string;
  title: string;
  snippet: string;
  tags: string[];
  updated_at: string;
  author_username?: string;
}

export interface ProjectSearchOptions {
  query: string;
  topic?: string;
  tag?: string;
  author?: string;
  limit?: number;
}

export function searchProjectNotebook(
  paths: Paths,
  project: string,
  opts: ProjectSearchOptions,
): ProjectSearchHit[] {
  const store = loadProjectNotebookStore(paths, project);
  return searchProjectStore(project, store, opts);
}

export function searchProjectStore(
  project: string,
  store: ProjectNotebookStore,
  opts: ProjectSearchOptions,
): ProjectSearchHit[] {
  const limit = opts.limit ?? 20;
  const needle = opts.query.toLowerCase();
  if (needle.length === 0) return [];
  const tagFilter = opts.tag?.toLowerCase();
  const hits: ProjectSearchHit[] = [];
  for (const t of store.topics) {
    if (opts.topic !== undefined && t.slug !== opts.topic) continue;
    for (const p of t.pages) {
      if (p.status !== "active") continue;
      if (opts.author !== undefined && p.author_username !== opts.author) continue;
      if (
        tagFilter !== undefined &&
        !(p.tags ?? []).some((tag) => tag.toLowerCase() === tagFilter)
      ) {
        continue;
      }
      const hayTitle = p.title.toLowerCase();
      const hayBody = p.body.toLowerCase();
      const hayTags = (p.tags ?? []).join(" ").toLowerCase();
      const idx = [hayTitle, hayBody, hayTags]
        .map((h) => h.indexOf(needle))
        .find((i) => i >= 0);
      if (idx === undefined) continue;
      hits.push({
        project,
        topic: t.slug,
        page_id: p.id,
        title: p.title,
        snippet: snippetAround(p.body, needle),
        tags: p.tags ?? [],
        updated_at: p.updated_at,
        ...(p.author_username !== undefined
          ? { author_username: p.author_username }
          : {}),
      });
    }
  }
  hits.sort((a, b) =>
    a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
  );
  return hits.slice(0, limit);
}

// --- helpers --------------------------------------------------------- //

function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new ProjectNotebookError(
      "invalid_topic_slug",
      `Topic slug '${slug}' must match /^[a-z0-9][a-z0-9_-]{0,63}$/.`,
    );
  }
}

function validateTitle(title: string): void {
  if (title.length === 0) {
    throw new ProjectNotebookError(
      "invalid_title",
      "Page title must be non-empty.",
    );
  }
  if (title.length > TITLE_MAX_CHARS) {
    throw new ProjectNotebookError(
      "invalid_title",
      `Page title is ${title.length} chars; cap is ${TITLE_MAX_CHARS}.`,
    );
  }
}

function slugifyPage(title: string, existing: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || `page-${Date.now()}`;
  if (!existing.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (t.length === 0) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function snippetAround(body: string, needle: string): string {
  const lower = body.toLowerCase();
  const at = lower.indexOf(needle);
  if (at < 0) return body.slice(0, 200);
  const start = Math.max(0, at - 80);
  const end = Math.min(body.length, at + needle.length + 120);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < body.length ? "…" : "";
  return prefix + body.slice(start, end) + suffix;
}

function sizeWarning(
  page: ProjectNotebookPage,
  topic: ProjectNotebookTopic,
): string | null {
  const bodyBytes = Buffer.byteLength(page.body, "utf8");
  const topicBytes = topic.pages.reduce(
    (sum, p) => sum + Buffer.byteLength(p.body, "utf8"),
    0,
  );
  const parts: string[] = [];
  if (bodyBytes > PAGE_BODY_WARN_BYTES) {
    parts.push(
      `page body is ${kb(bodyBytes)} (soft-warn over ${kb(PAGE_BODY_WARN_BYTES)})`,
    );
  }
  if (topicBytes > TOPIC_TOTAL_WARN_BYTES) {
    parts.push(
      `topic total is ${kb(topicBytes)} (soft-warn over ${kb(TOPIC_TOTAL_WARN_BYTES)})`,
    );
  }
  if (parts.length === 0) return null;
  return `project notebook: ${parts.join("; ")} — consider sharding across pages or moving heavy content elsewhere.`;
}

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}
