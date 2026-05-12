/** Notebook MCP handlers — per-persona surface + cross-persona reads.
 *
 * Mirrors the project-memory handler shape: pure functions wrap the
 * `notebook/` and `project-notebook/` modules and translate domain
 * errors into `ToolError`. Cross-persona reads (`*_any`) take an
 * explicit `username`; the bare variants operate on the caller's
 * claimed persona.
 */

import {
  NotebookError,
  type SearchHit,
  deletePage,
  deleteTopic,
  exportNotebook,
  getPage,
  listTopics,
  openTopic,
  renameTopic,
  restorePage,
  searchNotebook,
  writePage,
} from "../../notebook/index.ts";
import { listPersonas } from "../../identity/index.ts";
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

function requireClaimed(ctx: HandlerContext): string {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) {
    throw new ToolError(
      "no_persona",
      "Notebook writes require a claimed persona — call `claim` or `manifest` first.",
    );
  }
  return claimed;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof NotebookError) {
      throw new ToolError(err.code, err.message, err.extra);
    }
    throw err;
  }
}

// --- writes ----------------------------------------------------------- //

export const notebook_write_page: Handler = async (args, ctx) => {
  const username = requireClaimed(ctx);
  const topic = asStringRequired(args.topic, "topic");
  const title = asStringRequired(args.title, "title");
  const body = asStringRequired(args.body, "body");
  const page_id = asString(args.page_id);
  const tags = asStringArray(args.tags);
  const topic_title = asString(args.topic_title);
  return wrap(() =>
    writePage(ctx.paths, username, {
      topic,
      title,
      body,
      author_username: username,
      ...(page_id !== undefined ? { page_id } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(topic_title !== undefined ? { topic_title } : {}),
    }),
  );
};

export const notebook_delete_page: Handler = async (args, ctx) => {
  const username = requireClaimed(ctx);
  const topic = asStringRequired(args.topic, "topic");
  const page_id = asStringRequired(args.page_id, "page_id");
  return wrap(() => ({ topic, page: deletePage(ctx.paths, username, topic, page_id) }));
};

export const notebook_restore_page: Handler = async (args, ctx) => {
  const username = requireClaimed(ctx);
  const topic = asStringRequired(args.topic, "topic");
  const page_id = asStringRequired(args.page_id, "page_id");
  return wrap(() => ({ topic, page: restorePage(ctx.paths, username, topic, page_id) }));
};

export const notebook_delete_topic: Handler = async (args, ctx) => {
  const username = requireClaimed(ctx);
  const topic = asStringRequired(args.topic, "topic");
  return wrap(() => deleteTopic(ctx.paths, username, topic));
};

export const notebook_rename_topic: Handler = async (args, ctx) => {
  const username = requireClaimed(ctx);
  const from = asStringRequired(args.from, "from");
  const to = asStringRequired(args.to, "to");
  return wrap(() => renameTopic(ctx.paths, username, from, to));
};

// --- reads (self) ----------------------------------------------------- //

export const notebook_open: Handler = async (args, ctx) => {
  const username = requireClaimed(ctx);
  const topic = asStringRequired(args.topic, "topic");
  const include_deleted = asBoolean(args.include_deleted);
  return wrap(() => {
    const result = openTopic(ctx.paths, username, topic, {
      ...(include_deleted !== undefined ? { include_deleted } : {}),
    });
    return { username, ...result };
  });
};

export const notebook_get_page: Handler = async (args, ctx) => {
  const username = requireClaimed(ctx);
  const topic = asStringRequired(args.topic, "topic");
  const page_id = asStringRequired(args.page_id, "page_id");
  return wrap(() => ({
    username,
    topic,
    page: getPage(ctx.paths, username, topic, page_id),
  }));
};

export const notebook_list_topics: Handler = async (args, ctx) => {
  const username = requireClaimed(ctx);
  const include_empty = asBoolean(args.include_empty);
  return wrap(() => {
    const topics = listTopics(ctx.paths, username, {
      ...(include_empty !== undefined ? { include_empty } : {}),
    });
    return { username, count: topics.length, topics };
  });
};

export const notebook_search: Handler = async (args, ctx) => {
  const username = requireClaimed(ctx);
  const query = asStringRequired(args.query, "query");
  const topic = asString(args.topic);
  const tag = asString(args.tag);
  const limit = asNumber(args.limit);
  return wrap(() => {
    const hits = searchNotebook(ctx.paths, username, {
      query,
      ...(topic !== undefined ? { topic } : {}),
      ...(tag !== undefined ? { tag } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { username, query, count: hits.length, hits };
  });
};

// --- cross-persona reads --------------------------------------------- //

function asTargetUsername(args: Record<string, unknown>): string {
  return asStringRequired(args.username, "username");
}

export const notebook_list_topics_any: Handler = async (args, ctx) => {
  const username = asTargetUsername(args);
  const include_empty = asBoolean(args.include_empty);
  return wrap(() => {
    const topics = listTopics(ctx.paths, username, {
      ...(include_empty !== undefined ? { include_empty } : {}),
    });
    return { username, count: topics.length, topics };
  });
};

export const notebook_open_any: Handler = async (args, ctx) => {
  const username = asTargetUsername(args);
  const topic = asStringRequired(args.topic, "topic");
  const include_deleted = asBoolean(args.include_deleted);
  return wrap(() => {
    const result = openTopic(ctx.paths, username, topic, {
      ...(include_deleted !== undefined ? { include_deleted } : {}),
    });
    return { username, ...result };
  });
};

export const notebook_get_page_any: Handler = async (args, ctx) => {
  const username = asTargetUsername(args);
  const topic = asStringRequired(args.topic, "topic");
  const page_id = asStringRequired(args.page_id, "page_id");
  return wrap(() => ({
    username,
    topic,
    page: getPage(ctx.paths, username, topic, page_id),
  }));
};

export const notebook_search_any: Handler = async (args, ctx) => {
  const query = asStringRequired(args.query, "query");
  const scope = (asString(args.scope) ?? "self") as "self" | "all";
  if (scope !== "self" && scope !== "all") {
    throw new ToolError(
      "invalid_argument",
      `notebook_search_any: scope must be 'self' or 'all'; got '${scope}'.`,
    );
  }
  const targetUsername = asString(args.username);
  const topic = asString(args.topic);
  const tag = asString(args.tag);
  const limit = asNumber(args.limit);

  let usernames: string[];
  if (targetUsername !== undefined) {
    usernames = [targetUsername];
  } else if (scope === "all") {
    usernames = listPersonas(ctx.paths).map((p) => p.username);
  } else {
    usernames = [requireClaimed(ctx)];
  }

  return wrap(() => {
    const allHits: Array<SearchHit & { username: string }> = [];
    for (const u of usernames) {
      const hits = searchNotebook(ctx.paths, u, {
        query,
        ...(topic !== undefined ? { topic } : {}),
        ...(tag !== undefined ? { tag } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      for (const h of hits) allHits.push({ ...h, username: u });
    }
    allHits.sort((a, b) =>
      a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
    );
    const capped = limit !== undefined ? allHits.slice(0, limit) : allHits;
    return { scope, query, count: capped.length, hits: capped };
  });
};

// --- export ---------------------------------------------------------- //

export const notebook_export: Handler = async (args, ctx) => {
  const username = requireClaimed(ctx);
  const output_path = asStringRequired(args.output_path, "output_path");
  const topic = asString(args.topic);
  const overwrite = asBoolean(args.overwrite);
  const include_deleted = asBoolean(args.include_deleted);
  return wrap(() =>
    exportNotebook(ctx.paths, username, {
      output_path,
      ...(topic !== undefined ? { topic } : {}),
      ...(overwrite !== undefined ? { overwrite } : {}),
      ...(include_deleted !== undefined ? { include_deleted } : {}),
    }),
  );
};

export const notebook_export_any: Handler = async (args, ctx) => {
  const username = asTargetUsername(args);
  const output_path = asStringRequired(args.output_path, "output_path");
  const topic = asString(args.topic);
  const overwrite = asBoolean(args.overwrite);
  const include_deleted = asBoolean(args.include_deleted);
  return wrap(() => ({
    username,
    ...exportNotebook(ctx.paths, username, {
      output_path,
      ...(topic !== undefined ? { topic } : {}),
      ...(overwrite !== undefined ? { overwrite } : {}),
      ...(include_deleted !== undefined ? { include_deleted } : {}),
    }),
  }));
};
