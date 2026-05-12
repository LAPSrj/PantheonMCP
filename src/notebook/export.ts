/** Notebook → markdown export.
 *
 * Renders an entire notebook (or a single topic) as a markdown document
 * and writes it to a caller-specified absolute path. Defaults:
 *   - `overwrite: false` — refuses to clobber an existing file.
 *   - `include_deleted: false` — tombstoned pages are skipped.
 *   - `absolute paths only` — refuses anything that doesn't start with
 *     `/`. Parent directory must already exist (we do not `mkdir -p`
 *     for arbitrary disk locations; the user is writing wherever they
 *     said and we don't want to side-effect their filesystem).
 *
 * Pure render functions are exported separately so the project-notebook
 * variant can reuse the same markdown shape.
 */

import fs from "node:fs";
import path from "node:path";
import {
  NotebookError,
  type NotebookPage,
  type NotebookStore,
  type NotebookTopic,
} from "./types.ts";
import { loadNotebookStore } from "./store.ts";
import type { Paths } from "../storage/index.ts";
import type {
  ProjectNotebookPage,
  ProjectNotebookStore,
  ProjectNotebookTopic,
} from "../project-notebook/types.ts";
import { loadProjectNotebookStore } from "../project-notebook/store.ts";

export interface ExportOptions {
  output_path: string;
  topic?: string;
  overwrite?: boolean;
  include_deleted?: boolean;
}

export interface ExportResult {
  output_path: string;
  bytes_written: number;
  topics_written: number;
  pages_written: number;
}

export function exportNotebook(
  paths: Paths,
  username: string,
  options: ExportOptions,
): ExportResult {
  validateOutputPath(options.output_path, options.overwrite ?? false);
  const store = loadNotebookStore(paths, username);
  const { markdown, topicsWritten, pagesWritten } = renderNotebookMarkdown(
    store,
    {
      title: `Notebook — ${username}`,
      topic: options.topic,
      include_deleted: options.include_deleted ?? false,
    },
  );
  fs.writeFileSync(options.output_path, markdown, "utf8");
  return {
    output_path: options.output_path,
    bytes_written: Buffer.byteLength(markdown, "utf8"),
    topics_written: topicsWritten,
    pages_written: pagesWritten,
  };
}

export function exportProjectNotebook(
  paths: Paths,
  project: string,
  options: ExportOptions,
): ExportResult {
  validateOutputPath(options.output_path, options.overwrite ?? false);
  const store = loadProjectNotebookStore(paths, project);
  const { markdown, topicsWritten, pagesWritten } = renderProjectNotebookMarkdown(
    store,
    {
      title: `Project notebook — ${project}`,
      topic: options.topic,
      include_deleted: options.include_deleted ?? false,
    },
  );
  fs.writeFileSync(options.output_path, markdown, "utf8");
  return {
    output_path: options.output_path,
    bytes_written: Buffer.byteLength(markdown, "utf8"),
    topics_written: topicsWritten,
    pages_written: pagesWritten,
  };
}

// --- pure render ----------------------------------------------------- //

export interface RenderOptions {
  title: string;
  topic?: string | undefined;
  include_deleted: boolean;
}

interface RenderCounts {
  markdown: string;
  topicsWritten: number;
  pagesWritten: number;
}

export function renderNotebookMarkdown(
  store: NotebookStore,
  options: RenderOptions,
): RenderCounts {
  const topics = filterTopics(store.topics, options.topic);
  if (options.topic !== undefined && topics.length === 0) {
    throw new NotebookError(
      "topic_not_found",
      `No topic '${options.topic}' to export.`,
    );
  }
  return renderTopicsMarkdown(options.title, topics, options.include_deleted);
}

export function renderProjectNotebookMarkdown(
  store: ProjectNotebookStore,
  options: RenderOptions,
): RenderCounts {
  const topics = filterTopics(store.topics, options.topic);
  if (options.topic !== undefined && topics.length === 0) {
    throw new NotebookError(
      "topic_not_found",
      `No topic '${options.topic}' to export.`,
    );
  }
  return renderTopicsMarkdown(options.title, topics, options.include_deleted);
}

function filterTopics<T extends { slug: string }>(
  topics: T[],
  filter: string | undefined,
): T[] {
  if (filter === undefined) return topics;
  return topics.filter((t) => t.slug === filter);
}

function renderTopicsMarkdown(
  title: string,
  topics: ReadonlyArray<NotebookTopic | ProjectNotebookTopic>,
  includeDeleted: boolean,
): RenderCounts {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`_Exported ${new Date().toISOString()}_`);
  lines.push("");

  let topicsWritten = 0;
  let pagesWritten = 0;

  if (topics.length === 0) {
    lines.push("> _(no topics yet)_");
    lines.push("");
    return { markdown: lines.join("\n"), topicsWritten, pagesWritten };
  }

  // TOC
  lines.push("## Topics");
  lines.push("");
  for (const t of topics) {
    const active = t.pages.filter((p) => p.status === "active").length;
    const totalShown = includeDeleted ? t.pages.length : active;
    lines.push(
      `- **${escapeInline(t.title)}** (\`${t.slug}\`) — ${totalShown} page${totalShown === 1 ? "" : "s"}, updated ${t.updated_at}`,
    );
  }
  lines.push("");

  for (const t of topics) {
    const visiblePages = includeDeleted
      ? t.pages
      : t.pages.filter((p) => p.status === "active");
    if (visiblePages.length === 0) continue;
    topicsWritten++;
    lines.push("---");
    lines.push("");
    lines.push(`## Topic: ${escapeInline(t.title)}`);
    lines.push("");
    lines.push(`- slug: \`${t.slug}\``);
    lines.push(`- created: ${t.created_at}`);
    lines.push(`- updated: ${t.updated_at}`);
    lines.push("");

    for (const p of visiblePages) {
      pagesWritten++;
      lines.push(`### ${escapeInline(p.title)}${p.status === "deleted" ? " *(deleted)*" : ""}`);
      lines.push("");
      const meta: string[] = [];
      meta.push(`id: \`${p.id}\``);
      if (p.author_username !== undefined) {
        meta.push(`author: \`${p.author_username}\``);
      }
      if (p.tags && p.tags.length > 0) {
        meta.push(`tags: ${p.tags.map((t) => `\`${t}\``).join(", ")}`);
      }
      meta.push(`created: ${p.created_at}`);
      meta.push(`updated: ${p.updated_at}`);
      lines.push(`_${meta.join(" · ")}_`);
      lines.push("");
      lines.push(p.body);
      lines.push("");
    }
  }

  // Trailing newline for POSIX-friendliness.
  return { markdown: lines.join("\n").trimEnd() + "\n", topicsWritten, pagesWritten };
}

function escapeInline(s: string): string {
  // Don't try to be clever — bodies are emitted verbatim. Only escape
  // the inline headings/list items where Markdown control chars would
  // distort the structure.
  return s.replace(/([\\`*_{}\[\]()#+\-!|<>])/g, "\\$1");
}

// --- path validation ------------------------------------------------- //

function validateOutputPath(outputPath: string, overwrite: boolean): void {
  if (!path.isAbsolute(outputPath)) {
    throw new NotebookError(
      "invalid_path",
      `Output path must be absolute. Got '${outputPath}'.`,
    );
  }
  const parent = path.dirname(outputPath);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new NotebookError(
      "invalid_path",
      `Parent directory '${parent}' does not exist. Create it before exporting.`,
    );
  }
  if (!overwrite && fs.existsSync(outputPath)) {
    throw new NotebookError(
      "file_exists",
      `Refusing to overwrite '${outputPath}'. Pass overwrite: true to force.`,
      { path: outputPath },
    );
  }
}

// Re-export helper for symmetry with operations.ts module shape.
export { type NotebookPage, type ProjectNotebookPage };
