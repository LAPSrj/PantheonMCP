/** Schema-registry MCP handlers.
 *
 * Pantheon exposes a generic JSON-schema registry that consumers
 * (takt-starter agents, etc.) populate with their own typed-message
 * schemas. `send_structured({ schema_id })` validates payloads
 * against a registered schema before accepting. Pantheon stays
 * neutral on the value space — kinds and schemas are owned by the
 * consumer.
 *
 * Schemas are project-scoped. `register_schema` writes to the caller's
 * project; `get_schema` / `list_schemas` read the caller's project plus
 * the legacy `__legacy_global__` fallback bucket. Cross-project access
 * (if/when added) goes through `_any` variants — same pattern as the
 * summon family. */

import {
  SchemaError,
  getSchema,
  listSchemas,
  registerSchema,
  unregisterSchema,
  type JsonSchema,
} from "../../schemas/index.ts";
import {
  asBoolean,
  asObject,
  asString,
  asStringRequired,
  type Handler,
  type HandlerContext,
  ToolError,
} from "../types.ts";

/** Resolve the project the calling session belongs to. Required for
 * every schema-registry handler — schemas are project-scoped. Throws
 * `no_project_scope` when the session has neither a chat login nor a
 * resolvable persona project; that's an early-bootstrap state and the
 * agent should log in first. */
function resolveCallerProject(ctx: HandlerContext): string {
  if (ctx.chat && ctx.chat_agent_id) {
    const project = ctx.chat.getSubscriberProject(ctx.chat_agent_id);
    if (project) return project;
  }
  throw new ToolError(
    "no_project_scope",
    "Schema-registry operations are project-scoped — log into chat first (the bootstrap's step 1).",
  );
}

function resolveCallerUsername(ctx: HandlerContext): string | null {
  return ctx.session.claimedUsername ?? ctx.session.guestUsername ?? null;
}

function requireRouterDb(ctx: HandlerContext): import("bun:sqlite").Database {
  const db = ctx.chat?.chatDb() ?? null;
  if (!db) {
    throw new ToolError(
      "no_chat_router",
      "Schema registry requires the chat router (chat.db is not attached to this session).",
    );
  }
  return db;
}

export const register_schema: Handler = async (args, ctx) => {
  const id = asStringRequired(args.schema_id, "schema_id");
  const description = asString(args.description);
  const exclusive = asBoolean(args.exclusive) ?? false;
  const schema = asObject(args.schema);
  if (!schema) {
    throw new ToolError(
      "invalid_schema_body",
      "`schema` must be an object — a JSON Schema (subset: type / required / properties / items / enum / additionalProperties / minLength / maxLength / minimum / maximum / pattern).",
    );
  }
  const db = requireRouterDb(ctx);
  const project = resolveCallerProject(ctx);
  const registered_by = resolveCallerUsername(ctx) ?? undefined;
  try {
    const stored = registerSchema(db, {
      project,
      id,
      schema: schema as JsonSchema,
      ...(description !== undefined ? { description } : {}),
      ...(registered_by !== undefined ? { registered_by } : {}),
      exclusive,
    });
    return {
      ok: true,
      schema_id: stored.id,
      project,
      ...(stored.description !== undefined ? { description: stored.description } : {}),
      created_at: stored.created_at,
      updated_at: stored.updated_at,
      replaced: stored.created_at !== stored.updated_at,
    };
  } catch (err) {
    if (err instanceof SchemaError) {
      throw new ToolError(err.code, err.message, err.extra);
    }
    throw err;
  }
};

export const unregister_schema: Handler = async (args, ctx) => {
  const id = asStringRequired(args.schema_id, "schema_id");
  const db = requireRouterDb(ctx);
  const project = resolveCallerProject(ctx);
  const removed = unregisterSchema(db, project, id);
  return { ok: true, removed, schema_id: id, project };
};

export const list_schemas: Handler = async (_args, ctx) => {
  const db = requireRouterDb(ctx);
  const project = resolveCallerProject(ctx);
  const all = listSchemas(db, project);
  return {
    project,
    count: all.length,
    schemas: all.map((s) => ({
      schema_id: s.id,
      ...(s.description !== undefined ? { description: s.description } : {}),
      created_at: s.created_at,
      updated_at: s.updated_at,
    })),
  };
};

export const get_schema: Handler = async (args, ctx) => {
  const id = asStringRequired(args.schema_id, "schema_id");
  const db = requireRouterDb(ctx);
  const project = resolveCallerProject(ctx);
  const schema = getSchema(db, project, id);
  if (!schema) {
    throw new ToolError(
      "schema_not_found",
      `No schema registered with id '${id}' in project '${project}' (or the legacy fallback).`,
      { schema_id: id, project },
    );
  }
  return {
    ok: true,
    schema_id: schema.id,
    project,
    ...(schema.description !== undefined ? { description: schema.description } : {}),
    schema: schema.schema,
    created_at: schema.created_at,
    updated_at: schema.updated_at,
  };
};
