/** Schema-registry types. Pantheon stores caller-registered JSON
 * schemas keyed by id. `send_structured({ schema_id, payload })`
 * validates `payload` against the registered schema before accepting.
 *
 * The registry is intentionally schema-language-minimal — pantheon
 * implements a small JSON Schema subset (`type`, `required`,
 * `properties`, `items`, `enum`, `additionalProperties`,
 * `min/maxLength`, `minimum`, `maximum`, `pattern`). That's enough
 * to enforce typed-evidence shapes without taking a dependency on a
 * full validator. Consumers who need more should keep validation at
 * their own layer and pass the payload through with `schema_id`
 * unset. */

export interface Schema {
  /** Public id, used by `send_structured({ schema_id })`. Free-form
   * but conventionally namespaced — `<consumer>/<kind>@v<N>`, e.g.
   * `takt-starter/pushback@v1`. */
  id: string;
  /** Human description. Surfaces in `list_schemas` so consumers can
   * tell what each schema is for without fetching the body. */
  description?: string;
  /** Caller-supplied JSON Schema (validated subset). Stored verbatim. */
  schema: JsonSchema;
  /** ms-epoch timestamps maintained by the registry. */
  created_at: number;
  updated_at: number;
}

/** The supported JSON Schema subset. Anything outside this set is
 * accepted by `register_schema` (no schema-of-schemas validation —
 * we trust callers) but ignored by `validate`. */
export interface JsonSchema {
  type?: JsonType | JsonType[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  description?: string;
}

export type JsonType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

export interface ValidationError {
  /** JSON pointer-style path into the payload, e.g. `/evidence/file`. */
  path: string;
  message: string;
}

export class SchemaError extends Error {
  code: SchemaErrorCode;
  extra: Record<string, unknown>;
  constructor(
    code: SchemaErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "SchemaError";
  }
}

export type SchemaErrorCode =
  | "schema_not_found"
  | "invalid_schema_id"
  | "invalid_schema_body"
  | "schema_already_exists";
