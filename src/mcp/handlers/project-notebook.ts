/** Project-notebook MCP handlers.
 *
 * Bare variants operate on the caller's project (resolved from chat
 * subscriber lookup). `_any` variants take an explicit `project`. Pages
 * are stamped with `author_username` derived from the caller's claimed
 * persona, mirroring `project_memory`'s author-blame posture.
 */

import {
  ProjectNotebookError,
  deleteProjectPage,
  deleteProjectTopic,
  getProjectPage,
  listProjectTopics,
  openProjectTopic,
  renameProjectTopic,
  restoreProjectPage,
  searchProjectNotebook,
  writeProjectPage,
} from "../../project-notebook/index.ts";
import { exportProjectNotebook } from "../../notebook/export.ts";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  asStringRequired,
  type Handler,
  type HandlerContext,
  ToolError,
} from "../types.ts";

function resolveCurrentProject(ctx: HandlerContext): string {
  if (ctx.chat && ctx.chat_agent_id) {
    const project = ctx.chat.getSubscriberProject(ctx.chat_agent_id);
    if (project) return project;
  }
  throw new ToolError(
    "no_project_scope",
    "Project-notebook operations require a project scope. Log into chat first.",
  );
}

function resolveAuthor(ctx: HandlerContext): string | undefined {
  return ctx.session.claimedUsername ?? ctx.session.guestUsername ?? undefined;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ProjectNotebookError) {
      throw new ToolError(err.code, err.message, err.extra);
    }
    throw err;
  }
}

// ---- shared per-op helpers ------------------------------------------ //

function doWrite(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const topic = asStringRequired(args.topic, "topic");
  const title = asStringRequired(args.title, "title");
  const body = asStringRequired(args.body, "body");
  const page_id = asString(args.page_id);
  const tags = asStringArray(args.tags);
  const topic_title = asString(args.topic_title);
  const author_username = resolveAuthor(ctx);
  return wrap(() =>
    writeProjectPage(ctx.paths, project, {
      topic,
      title,
      body,
      ...(page_id !== undefined ? { page_id } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(topic_title !== undefined ? { topic_title } : {}),
      ...(author_username !== undefined ? { author_username } : {}),
    }),
  );
}

function doOpen(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const topic = asStringRequired(args.topic, "topic");
  const include_deleted = asBoolean(args.include_deleted);
  return wrap(() => {
    const result = openProjectTopic(ctx.paths, project, topic, {
      ...(include_deleted !== undefined ? { include_deleted } : {}),
    });
    return { project, ...result };
  });
}

function doGet(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const topic = asStringRequired(args.topic, "topic");
  const page_id = asStringRequired(args.page_id, "page_id");
  return wrap(() => ({
    project,
    topic,
    page: getProjectPage(ctx.paths, project, topic, page_id),
  }));
}

function doList(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const include_empty = asBoolean(args.include_empty);
  return wrap(() => {
    const topics = listProjectTopics(ctx.paths, project, {
      ...(include_empty !== undefined ? { include_empty } : {}),
    });
    return { project, count: topics.length, topics };
  });
}

function doSearch(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const query = asStringRequired(args.query, "query");
  const topic = asString(args.topic);
  const tag = asString(args.tag);
  const author = asString(args.author);
  const limit = asNumber(args.limit);
  return wrap(() => {
    const hits = searchProjectNotebook(ctx.paths, project, {
      query,
      ...(topic !== undefined ? { topic } : {}),
      ...(tag !== undefined ? { tag } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { project, query, count: hits.length, hits };
  });
}

function doDeletePage(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const topic = asStringRequired(args.topic, "topic");
  const page_id = asStringRequired(args.page_id, "page_id");
  return wrap(() => ({
    project,
    topic,
    page: deleteProjectPage(ctx.paths, project, topic, page_id),
  }));
}

function doRestorePage(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const topic = asStringRequired(args.topic, "topic");
  const page_id = asStringRequired(args.page_id, "page_id");
  return wrap(() => ({
    project,
    topic,
    page: restoreProjectPage(ctx.paths, project, topic, page_id),
  }));
}

function doDeleteTopic(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const topic = asStringRequired(args.topic, "topic");
  return wrap(() => ({
    project,
    ...deleteProjectTopic(ctx.paths, project, topic),
  }));
}

function doRename(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const from = asStringRequired(args.from, "from");
  const to = asStringRequired(args.to, "to");
  return wrap(() => ({
    project,
    ...renameProjectTopic(ctx.paths, project, from, to),
  }));
}

function doExport(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const output_path = asStringRequired(args.output_path, "output_path");
  const topic = asString(args.topic);
  const overwrite = asBoolean(args.overwrite);
  const include_deleted = asBoolean(args.include_deleted);
  return wrap(() => ({
    project,
    ...exportProjectNotebook(ctx.paths, project, {
      output_path,
      ...(topic !== undefined ? { topic } : {}),
      ...(overwrite !== undefined ? { overwrite } : {}),
      ...(include_deleted !== undefined ? { include_deleted } : {}),
    }),
  }));
}

function asProjectArg(args: Record<string, unknown>): string {
  return asStringRequired(args.project, "project");
}

// ---- public handlers ------------------------------------------------ //

export const project_notebook_write_page: Handler = async (args, ctx) =>
  doWrite(args, ctx, resolveCurrentProject(ctx));
export const project_notebook_write_page_any: Handler = async (args, ctx) =>
  doWrite(args, ctx, asProjectArg(args));

export const project_notebook_open: Handler = async (args, ctx) =>
  doOpen(args, ctx, resolveCurrentProject(ctx));
export const project_notebook_open_any: Handler = async (args, ctx) =>
  doOpen(args, ctx, asProjectArg(args));

export const project_notebook_get_page: Handler = async (args, ctx) =>
  doGet(args, ctx, resolveCurrentProject(ctx));
export const project_notebook_get_page_any: Handler = async (args, ctx) =>
  doGet(args, ctx, asProjectArg(args));

export const project_notebook_list_topics: Handler = async (args, ctx) =>
  doList(args, ctx, resolveCurrentProject(ctx));
export const project_notebook_list_topics_any: Handler = async (args, ctx) =>
  doList(args, ctx, asProjectArg(args));

export const project_notebook_search: Handler = async (args, ctx) =>
  doSearch(args, ctx, resolveCurrentProject(ctx));
export const project_notebook_search_any: Handler = async (args, ctx) =>
  doSearch(args, ctx, asProjectArg(args));

export const project_notebook_delete_page: Handler = async (args, ctx) =>
  doDeletePage(args, ctx, resolveCurrentProject(ctx));
export const project_notebook_delete_page_any: Handler = async (args, ctx) =>
  doDeletePage(args, ctx, asProjectArg(args));

export const project_notebook_restore_page: Handler = async (args, ctx) =>
  doRestorePage(args, ctx, resolveCurrentProject(ctx));
export const project_notebook_restore_page_any: Handler = async (args, ctx) =>
  doRestorePage(args, ctx, asProjectArg(args));

export const project_notebook_delete_topic: Handler = async (args, ctx) =>
  doDeleteTopic(args, ctx, resolveCurrentProject(ctx));
export const project_notebook_delete_topic_any: Handler = async (args, ctx) =>
  doDeleteTopic(args, ctx, asProjectArg(args));

export const project_notebook_rename_topic: Handler = async (args, ctx) =>
  doRename(args, ctx, resolveCurrentProject(ctx));
export const project_notebook_rename_topic_any: Handler = async (args, ctx) =>
  doRename(args, ctx, asProjectArg(args));

export const project_notebook_export: Handler = async (args, ctx) =>
  doExport(args, ctx, resolveCurrentProject(ctx));
export const project_notebook_export_any: Handler = async (args, ctx) =>
  doExport(args, ctx, asProjectArg(args));
