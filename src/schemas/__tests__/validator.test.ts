import { test, expect } from "bun:test";
import { validatePayload } from "../validator.ts";

test("type=object: missing required field reported", () => {
  const errs = validatePayload(
    { a: 1 },
    { type: "object", required: ["a", "b"] },
  );
  expect(errs.map((e) => e.path)).toEqual(["/b"]);
});

test("type=object: nested required field reported with path", () => {
  const errs = validatePayload(
    { evidence: {} },
    {
      type: "object",
      required: ["evidence"],
      properties: {
        evidence: { type: "object", required: ["file", "line"] },
      },
    },
  );
  expect(errs.map((e) => e.path).sort()).toEqual(["/evidence/file", "/evidence/line"]);
});

test("type mismatch: integer expected, string given", () => {
  const errs = validatePayload(
    { n: "abc" },
    { type: "object", properties: { n: { type: "integer" } } },
  );
  expect(errs).toHaveLength(1);
  expect(errs[0]!.path).toBe("/n");
  expect(errs[0]!.message).toContain("integer");
});

test("integer vs number: 1.5 fails type=integer", () => {
  const errs = validatePayload(1.5, { type: "integer" });
  expect(errs).toHaveLength(1);
});

test("array items validated", () => {
  const errs = validatePayload(
    [1, "two", 3],
    { type: "array", items: { type: "integer" } },
  );
  expect(errs.map((e) => e.path)).toEqual(["/1"]);
});

test("enum: value not in enum reported", () => {
  const errs = validatePayload("blue", { enum: ["red", "green"] });
  expect(errs).toHaveLength(1);
});

test("enum: object equality works", () => {
  const errs = validatePayload(
    { x: 1 },
    { enum: [{ x: 1 }, { x: 2 }] },
  );
  expect(errs).toHaveLength(0);
});

test("additionalProperties: false rejects extras", () => {
  const errs = validatePayload(
    { a: 1, surprise: "no" },
    {
      type: "object",
      properties: { a: { type: "integer" } },
      additionalProperties: false,
    },
  );
  expect(errs.map((e) => e.path)).toEqual(["/surprise"]);
});

test("string constraints: pattern + length", () => {
  const errs = validatePayload(
    "ab",
    { type: "string", minLength: 3, pattern: "^[a-z]+$" },
  );
  expect(errs).toHaveLength(1);
  expect(errs[0]!.message).toContain("minLength");
});

test("number constraints: minimum + maximum", () => {
  const errsLow = validatePayload(0, { type: "number", minimum: 1 });
  expect(errsLow).toHaveLength(1);
  const errsHigh = validatePayload(11, { type: "number", maximum: 10 });
  expect(errsHigh).toHaveLength(1);
});

test("valid payload returns empty error list", () => {
  const errs = validatePayload(
    {
      pattern: 14,
      evidence: { file: "a.ts", line: 89, severity: "high" },
    },
    {
      type: "object",
      required: ["pattern", "evidence"],
      properties: {
        pattern: { type: "integer", minimum: 1 },
        evidence: {
          type: "object",
          required: ["file", "line"],
          properties: {
            file: { type: "string", minLength: 1 },
            line: { type: "integer", minimum: 1 },
            severity: { enum: ["low", "medium", "high"] },
          },
        },
      },
    },
  );
  expect(errs).toEqual([]);
});

test("type union: matches any of the listed types", () => {
  const errs1 = validatePayload(null, { type: ["string", "null"] });
  expect(errs1).toEqual([]);
  const errs2 = validatePayload(42, { type: ["string", "null"] });
  expect(errs2).toHaveLength(1);
});
