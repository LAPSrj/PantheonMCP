/** Notebook CRUD operations.
 *
 * Per-persona variant. Mirrors `src/memory/operations.ts` in spirit but
 * keyed on `(topic, page_id)` rather than entry-id. Same atomic-store
 * mutator pattern. Pure functions: no MCP awareness, no chat coupling.
 *
 * Soft-warns over 64 KB body / 1 MB topic — non-blocking, returned on
 * the response as a `warning` field. Hard caps live in `types.ts`.
 */

import type { Paths } from "../storage/index.ts";
import { loadNotebookStore, mutateNotebookStore } from "./store.ts";
import {
  NotebookError,
  PAGE_BODY_WARN_BYTES,
  SLUG_RE,
  TITLE_MAX_CHARS,
  TOPIC_TOTAL_WARN_BYTES,
  type NotebookPage,
  type NotebookStore,
  type NotebookTopic,
  type NotebookTopicRef,
} from "./types.ts";

export interface WritePageInput {
  topic: string;
  title: string;
  body: string;
  page_id?: string;
  tags?: string[];
  /** When the topic is new (or has no active pages), this title is
   * assigned to the topic record. Ignored on subsequent writes — to
   * rename a topic, use `rename_topic`. Defaults to `topic` slug. */
  topic_title?: string;
  /** Stamped on the page for cross-persona attribution. Pass the
   * canonical persona username, not the auto-suffixed chat handle. */
  author_username?: string;
}

export interface WritePageResult {
  topic: string;
  page: NotebookPage;
  created: boolean;
  warning: string | null;
}

export function writePage(
  paths: Paths,
  username: string,
  input: WritePageInput,
): WritePageResult {
  validateSlug(input.topic);
  validateTitle(input.title);
  if (input.body.length === 0) {
    throw new NotebookError("missing_body", "Page body must be non-empty.");
  }

  let result!: WritePageResult;
  mutateNotebookStore(paths, username, (store) => {
    const now = new Date().toISOString();
    const topicIdx = store.topics.findIndex((t) => t.slug === input.topic);
    const existingTopic = topicIdx >= 0 ? store.topics[topicIdx]! : undefined;

    if (existingTopic === undefined && input.page_id !== undefined) {
      throw new NotebookError(
        "topic_not_found",
        `No topic '${input.topic}' to update page '${input.page_id}' in.`,
      );
    }

    const topic: NotebookTopic =
      existingTopic ??
      ({
        slug: input.topic,
        title: input.topic_title ?? input.topic,
        created_at: now,
        updated_at: now,
        pages: [],
      } as NotebookTopic);

    let page: NotebookPage;
    let created: boolean;
    if (input.page_id !== undefined) {
      const idx = topic.pages.findIndex((p) => p.id === input.page_id);
      if (idx < 0) {
        throw new NotebookError(
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

export interface OpenTopicResult {
  topic: NotebookTopic;
}

export function openTopic(
  paths: Paths,
  username: string,
  topic: string,
  options: { include_deleted?: boolean } = {},
): OpenTopicResult {
  validateSlug(topic);
  const store = loadNotebookStore(paths, username);
  const found = store.topics.find((t) => t.slug === topic);
  if (!found) {
    throw new NotebookError("topic_not_found", `No topic '${topic}'.`);
  }
  const pages = options.include_deleted
    ? found.pages
    : found.pages.filter((p) => p.status === "active");
  return { topic: { ...found, pages } };
}

export function getPage(
  paths: Paths,
  username: string,
  topic: string,
  pageId: string,
): NotebookPage {
  validateSlug(topic);
  const store = loadNotebookStore(paths, username);
  const t = store.topics.find((x) => x.slug === topic);
  if (!t) {
    throw new NotebookError("topic_not_found", `No topic '${topic}'.`);
  }
  const p = t.pages.find((x) => x.id === pageId);
  if (!p) {
    throw new NotebookError(
      "page_not_found",
      `No page '${pageId}' in topic '${topic}'.`,
    );
  }
  return p;
}

/** TOC view. Active pages only by default; empty topics omitted. */
export function listTopics(
  paths: Paths,
  username: string,
  options: { include_empty?: boolean } = {},
): NotebookTopicRef[] {
  const store = loadNotebookStore(paths, username);
  const refs: NotebookTopicRef[] = [];
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

export function deletePage(
  paths: Paths,
  username: string,
  topic: string,
  pageId: string,
): NotebookPage {
  return setPageStatus(paths, username, topic, pageId, "deleted");
}

export function restorePage(
  paths: Paths,
  username: string,
  topic: string,
  pageId: string,
): NotebookPage {
  return setPageStatus(paths, username, topic, pageId, "active");
}

function setPageStatus(
  paths: Paths,
  username: string,
  topic: string,
  pageId: string,
  status: "active" | "deleted",
): NotebookPage {
  validateSlug(topic);
  let updated!: NotebookPage;
  mutateNotebookStore(paths, username, (store) => {
    const topicIdx = store.topics.findIndex((t) => t.slug === topic);
    if (topicIdx < 0) {
      throw new NotebookError("topic_not_found", `No topic '${topic}'.`);
    }
    const t = store.topics[topicIdx]!;
    const pageIdx = t.pages.findIndex((p) => p.id === pageId);
    if (pageIdx < 0) {
      throw new NotebookError(
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

/** Bulk-tombstone every page in a topic. The topic record stays on
 * disk (it'll auto-vanish from TOC since no active pages remain). */
export function deleteTopic(
  paths: Paths,
  username: string,
  topic: string,
): { topic: string; pages_deleted: number } {
  validateSlug(topic);
  let count = 0;
  mutateNotebookStore(paths, username, (store) => {
    const idx = store.topics.findIndex((t) => t.slug === topic);
    if (idx < 0) {
      throw new NotebookError("topic_not_found", `No topic '${topic}'.`);
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

export function renameTopic(
  paths: Paths,
  username: string,
  from: string,
  to: string,
): { from: string; to: string; pages_moved: number } {
  validateSlug(from);
  validateSlug(to);
  if (from === to) {
    return { from, to, pages_moved: 0 };
  }
  let moved = 0;
  mutateNotebookStore(paths, username, (store) => {
    const fromIdx = store.topics.findIndex((t) => t.slug === from);
    if (fromIdx < 0) {
      throw new NotebookError("topic_not_found", `No topic '${from}'.`);
    }
    const toExists = store.topics.some((t) => t.slug === to);
    if (toExists) {
      throw new NotebookError(
        "topic_exists",
        `Cannot rename to '${to}': a topic with that slug already exists.`,
      );
    }
    const t = store.topics[fromIdx]!;
    moved = t.pages.length;
    const now = new Date().toISOString();
    const renamed: NotebookTopic = { ...t, slug: to, updated_at: now };
    const topics = store.topics.slice();
    topics[fromIdx] = renamed;
    return { ...store, topics };
  });
  return { from, to, pages_moved: moved };
}

export interface SearchHit {
  topic: string;
  page_id: string;
  title: string;
  /** First match snippet (≤200 chars around the hit). */
  snippet: string;
  tags: string[];
  updated_at: string;
}

export interface SearchOptions {
  query: string;
  topic?: string;
  tag?: string;
  limit?: number;
}

export function searchNotebook(
  paths: Paths,
  username: string,
  opts: SearchOptions,
): SearchHit[] {
  const store = loadNotebookStore(paths, username);
  return searchStore(store, opts);
}

/** Pure-data variant — exported for cross-persona unions and tests. */
export function searchStore(
  store: NotebookStore,
  opts: SearchOptions,
): SearchHit[] {
  const limit = opts.limit ?? 20;
  const needle = opts.query.toLowerCase();
  if (needle.length === 0) return [];
  const tagFilter = opts.tag?.toLowerCase();
  const hits: SearchHit[] = [];
  for (const t of store.topics) {
    if (opts.topic !== undefined && t.slug !== opts.topic) continue;
    for (const p of t.pages) {
      if (p.status !== "active") continue;
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
        topic: t.slug,
        page_id: p.id,
        title: p.title,
        snippet: snippetAround(p.body, needle),
        tags: p.tags ?? [],
        updated_at: p.updated_at,
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
    throw new NotebookError(
      "invalid_topic_slug",
      `Topic slug '${slug}' must match /^[a-z0-9][a-z0-9_-]{0,63}$/.`,
    );
  }
}

function validateTitle(title: string): void {
  if (title.length === 0) {
    throw new NotebookError("invalid_title", "Page title must be non-empty.");
  }
  if (title.length > TITLE_MAX_CHARS) {
    throw new NotebookError(
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

function sizeWarning(page: NotebookPage, topic: NotebookTopic): string | null {
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
  return `notebook: ${parts.join("; ")} — consider sharding across pages or moving heavy content elsewhere.`;
}

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}
