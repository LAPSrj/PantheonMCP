/** Project-memory MCP handlers.
 *
 * Bare variants (`append_project_memory`, etc.) operate on the caller's
 * project — resolved from chat router subscriber lookup, same as the
 * schema registry. `_any` variants take an explicit `project` arg, in
 * the `summon` / `summon_any` style.
 *
 * The `author_username` field on every appended entry is stamped from
 * the caller's claimed persona username (NOT the chat handle, which
 * may carry an auto-suffix). Forgotten entries are tombstoned forever;
 * `restore_project_memory` flips them back to active. */

import {
  ProjectMemoryError,
  appendProjectEntry,
  fadeProjectEntry,
  forgetProjectEntryWithLifecycleCoercion,
  getProjectDetails,
  getProjectEntry,
  listProjectIndex,
  renderProjectMemory,
  restoreProjectEntry,
  updateProjectEntry,
  type ListProjectFilter,
  type ProjectMemoryStatus,
} from "../../project-memory/index.ts";
import {
  asBoolean,
  asNumber,
  asString,
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
    "Project-memory operations require a project scope. Log into chat first (the bootstrap's step 1).",
  );
}

function resolveAuthorUsername(ctx: HandlerContext): string | undefined {
  return ctx.session.claimedUsername ?? ctx.session.guestUsername ?? undefined;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ProjectMemoryError) {
      throw new ToolError(err.code, err.message, err.extra);
    }
    throw err;
  }
}

function asStatusFilter(v: unknown): ProjectMemoryStatus | "all" | undefined {
  if (v === undefined) return undefined;
  if (v === "active" || v === "faded" || v === "forgotten" || v === "all") {
    return v;
  }
  throw new ToolError(
    "invalid_argument",
    `'status' must be one of 'active' | 'faded' | 'forgotten' | 'all'.`,
  );
}

// ---------------------------------------------------------------- //
// Internal handlers parameterized by project
// ---------------------------------------------------------------- //

function doAppend(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const text = asStringRequired(args.text, "text");
  const summary = asString(args.summary_max240);
  const details = asString(args.details);
  const kind = asString(args.kind);
  const core = asBoolean(args.core);
  const expires_at = asNumber(args.expires_at);
  const author = resolveAuthorUsername(ctx);
  const created = wrap(() =>
    appendProjectEntry(ctx.paths, project, {
      text,
      ...(summary !== undefined ? { summary } : {}),
      ...(details !== undefined ? { details } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(core !== undefined ? { core } : {}),
      ...(expires_at !== undefined ? { expires_at } : {}),
      ...(author !== undefined ? { author_username: author } : {}),
    }),
  );
  // §16: compact response — don't echo the body the caller just sent.
  // `verbose: true` returns the full stored entry.
  if (asBoolean(args.verbose) === true) return created;
  const derived: Record<string, unknown> = {};
  if (summary === undefined && created.summary !== undefined) {
    derived.summary = created.summary;
  }
  return {
    id: created.id,
    status: created.status,
    text_chars: text.length,
    ...(created.author_username !== undefined
      ? { author_username: created.author_username }
      : {}),
    ...(Object.keys(derived).length > 0 ? { derived } : {}),
  };
}

function doUpdate(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const id = asStringRequired(args.id, "id");
  const summary = asString(args.summary_max240);
  const text = asString(args.text);
  const kind = asString(args.kind);
  const core = asBoolean(args.core);
  const detailsRaw = args.details;
  const status = asStatusFilter(args.status);
  // Map "all" out — status patch only accepts a single value.
  const patchStatus =
    status === "all" || status === undefined ? undefined : status;
  const patch: Record<string, unknown> = {
    ...(summary !== undefined ? { summary } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(core !== undefined ? { core } : {}),
    ...(detailsRaw === null
      ? { details: null }
      : typeof detailsRaw === "string"
        ? { details: detailsRaw }
        : {}),
    ...(patchStatus !== undefined ? { status: patchStatus } : {}),
  };
  const before = getProjectEntry(ctx.paths, project, id);
  const updated = wrap(() => updateProjectEntry(ctx.paths, project, id, patch));
  // §16: compact response — per-field changed/unchanged, no body echo.
  // `verbose: true` returns the full updated entry.
  if (asBoolean(args.verbose) === true) return updated;
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const u = updated as unknown as Record<string, unknown>;
  const prev = (before ?? {}) as unknown as Record<string, unknown>;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const coerced: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (eq(prev[key], u[key])) unchanged.push(key);
    else changed.push(key);
    if (u[key] !== undefined && key !== "text" && key !== "details" && !eq(patch[key], u[key])) {
      coerced[key] = u[key];
    }
  }
  return {
    id: u.id,
    status: u.status,
    changed,
    unchanged,
    ...(Object.keys(coerced).length > 0 ? { coerced } : {}),
    ...(changed.includes("text") && typeof u.text === "string"
      ? { text_chars: (u.text as string).length }
      : {}),
  };
}

/** §4 lifecycle rule (project-memory parity): core + active reference-
 * kind entries coerce to `fade`. See src/memory/lifecycle.ts. */
function doForget(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const id = asStringRequired(args.id, "id");
  return wrap(() =>
    forgetProjectEntryWithLifecycleCoercion(ctx.paths, project, id),
  );
}

function doFade(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const id = asStringRequired(args.id, "id");
  return wrap(() => fadeProjectEntry(ctx.paths, project, id));
}

function doRestore(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const id = asStringRequired(args.id, "id");
  return wrap(() => restoreProjectEntry(ctx.paths, project, id));
}

function doGet(
  _args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const result = renderProjectMemory(ctx.paths, project);
  return { project, text: result.text, warning: result.warning };
}

function doRecall(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const id = asStringRequired(args.id, "id");
  const entry = getProjectEntry(ctx.paths, project, id);
  if (!entry) {
    throw new ToolError(
      "entry_not_found",
      `No project-memory entry with id '${id}' in project '${project}'.`,
      { id, project },
    );
  }
  return { project, entry };
}

function doList(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const filter: ListProjectFilter = {};
  const status = asStatusFilter(args.status);
  if (status !== undefined) filter.status = status;
  const core = asBoolean(args.core);
  if (core !== undefined) filter.core = core;
  const kind = asString(args.kind);
  if (kind !== undefined) filter.kind = kind;
  const since = asString(args.since);
  if (since !== undefined) filter.since = since;
  const filterStr = asString(args.filter);
  if (filterStr !== undefined) filter.filter = filterStr;
  const author = asString(args.author);
  if (author !== undefined) filter.author = author;
  const entries = listProjectIndex(ctx.paths, project, filter);
  return { project, count: entries.length, entries };
}

function doDetails(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  const id = asStringRequired(args.id, "id");
  try {
    const details = getProjectDetails(ctx.paths, project, id);
    return { project, id, details };
  } catch (err) {
    if (err instanceof ProjectMemoryError) {
      throw new ToolError(err.code, err.message, err.extra);
    }
    throw err;
  }
}

function asProjectArg(args: Record<string, unknown>): string {
  return asStringRequired(args.project, "project");
}

// ---------------------------------------------------------------- //
// Public handlers (bare = caller's project; _any = explicit project)
// ---------------------------------------------------------------- //

export const append_project_memory: Handler = async (args, ctx) =>
  doAppend(args, ctx, resolveCurrentProject(ctx));

export const append_project_memory_any: Handler = async (args, ctx) =>
  doAppend(args, ctx, asProjectArg(args));

export const update_project_memory: Handler = async (args, ctx) =>
  doUpdate(args, ctx, resolveCurrentProject(ctx));

export const update_project_memory_any: Handler = async (args, ctx) =>
  doUpdate(args, ctx, asProjectArg(args));

export const forget_project_memory: Handler = async (args, ctx) =>
  doForget(args, ctx, resolveCurrentProject(ctx));

export const forget_project_memory_any: Handler = async (args, ctx) =>
  doForget(args, ctx, asProjectArg(args));

export const fade_project_memory: Handler = async (args, ctx) =>
  doFade(args, ctx, resolveCurrentProject(ctx));

export const fade_project_memory_any: Handler = async (args, ctx) =>
  doFade(args, ctx, asProjectArg(args));

export const restore_project_memory: Handler = async (args, ctx) =>
  doRestore(args, ctx, resolveCurrentProject(ctx));

export const restore_project_memory_any: Handler = async (args, ctx) =>
  doRestore(args, ctx, asProjectArg(args));

export const get_project_memory: Handler = async (args, ctx) =>
  doGet(args, ctx, resolveCurrentProject(ctx));

export const get_project_memory_any: Handler = async (args, ctx) =>
  doGet(args, ctx, asProjectArg(args));

export const recall_project_memory: Handler = async (args, ctx) =>
  doRecall(args, ctx, resolveCurrentProject(ctx));

export const recall_project_memory_any: Handler = async (args, ctx) =>
  doRecall(args, ctx, asProjectArg(args));

export const list_project_memory: Handler = async (args, ctx) =>
  doList(args, ctx, resolveCurrentProject(ctx));

export const list_project_memory_any: Handler = async (args, ctx) =>
  doList(args, ctx, asProjectArg(args));

export const get_project_memory_details: Handler = async (args, ctx) =>
  doDetails(args, ctx, resolveCurrentProject(ctx));

export const get_project_memory_details_any: Handler = async (args, ctx) =>
  doDetails(args, ctx, asProjectArg(args));
