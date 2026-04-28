/** Minimal JSON Schema validator — a pragmatic subset, not Ajv.
 *
 * Supported keywords: `type`, `required`, `properties`, `items`,
 * `enum`, `additionalProperties`, `minLength`, `maxLength`,
 * `minimum`, `maximum`, `pattern`. Anything else in the schema is
 * silently ignored at validate time; `register_schema` accepts it
 * verbatim and the caller's prose-doc explains what's enforced.
 *
 * Returns a list of `{path, message}` errors. Empty list = valid.
 * Validation never throws on the payload — every value is tested
 * against the schema and reported, never asserted. */

import type { JsonSchema, JsonType, ValidationError } from "./types.ts";

export function validatePayload(
  payload: unknown,
  schema: JsonSchema,
): ValidationError[] {
  const errors: ValidationError[] = [];
  walk(payload, schema, "", errors);
  return errors;
}

function walk(
  value: unknown,
  schema: JsonSchema,
  path: string,
  out: ValidationError[],
): void {
  // type check
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      out.push({
        path,
        message: `expected type ${types.join("|")}, got ${jsTypeOf(value)}`,
      });
      // Bail out of deeper checks when the type is wrong — they'd just
      // produce noise.
      return;
    }
  }
  // enum
  if (schema.enum !== undefined) {
    const ok = schema.enum.some((candidate) => deepEqual(candidate, value));
    if (!ok) {
      out.push({
        path,
        message: `value not in enum (${schema.enum.length} options)`,
      });
    }
  }
  // string-specific
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      out.push({ path, message: `string shorter than minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      out.push({ path, message: `string longer than maxLength ${schema.maxLength}` });
    }
    if (schema.pattern !== undefined) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        // Invalid regex — silently skip; register_schema is lenient.
      }
      if (re && !re.test(value)) {
        out.push({ path, message: `string does not match pattern ${schema.pattern}` });
      }
    }
  }
  // number-specific
  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      out.push({ path, message: `number below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      out.push({ path, message: `number above maximum ${schema.maximum}` });
    }
  }
  // object
  if (isPlainObject(value)) {
    const obj = value as Record<string, unknown>;
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          out.push({ path: `${path}/${key}`, message: "required field missing" });
        }
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) {
          walk(obj[key], sub, `${path}/${key}`, out);
        }
      }
    }
    if (schema.additionalProperties !== undefined && schema.properties) {
      const known = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (known.has(key)) continue;
        if (schema.additionalProperties === false) {
          out.push({ path: `${path}/${key}`, message: "additional property not allowed" });
        } else if (typeof schema.additionalProperties === "object") {
          walk(obj[key], schema.additionalProperties, `${path}/${key}`, out);
        }
      }
    }
  }
  // array
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, idx) => {
      walk(item, schema.items!, `${path}/${idx}`, out);
    });
  }
}

function matchesType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

function jsTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
