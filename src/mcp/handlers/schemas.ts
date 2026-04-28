/** Schema-registry MCP handlers.
 *
 * Pantheon exposes a generic JSON-schema registry that consumers
 * (takt-starter agents, etc.) populate with their own typed-message
 * schemas. `send_structured({ schema_id })` validates payloads
 * against a registered schema before accepting. Pantheon stays
 * neutral on the value space — kinds and schemas are owned by the
 * consumer. */

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
  ToolError,
} from "../types.ts";

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
  try {
    const stored = registerSchema(ctx.paths, {
      id,
      schema: schema as JsonSchema,
      ...(description !== undefined ? { description } : {}),
      exclusive,
    });
    return {
      ok: true,
      schema_id: stored.id,
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
  const removed = unregisterSchema(ctx.paths, id);
  return { ok: true, removed, schema_id: id };
};

export const list_schemas: Handler = async (_args, ctx) => {
  const all = listSchemas(ctx.paths);
  return {
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
  const schema = getSchema(ctx.paths, id);
  if (!schema) {
    throw new ToolError(
      "schema_not_found",
      `No schema registered with id '${id}'.`,
      { schema_id: id },
    );
  }
  return {
    ok: true,
    schema_id: schema.id,
    ...(schema.description !== undefined ? { description: schema.description } : {}),
    schema: schema.schema,
    created_at: schema.created_at,
    updated_at: schema.updated_at,
  };
};
