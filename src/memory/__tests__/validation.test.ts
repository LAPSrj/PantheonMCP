import { test, expect } from "bun:test";
import { validateWrite } from "../validation.ts";
import { MemoryError, type MemoryEntry } from "../types.ts";

function entry(partial: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: partial.id ?? "x/y",
    date: partial.date ?? "2026-05-29T00:00:00.000Z",
    summary: partial.summary ?? "s",
    text: partial.text ?? "t",
    status: partial.status ?? "active",
    ...partial,
  };
}

test("durable kind without topic warns topic_required + lists existing + suggestion", () => {
  const existing = [
    entry({ id: "chat/a", topic: "chat", kind: "rule" }),
    entry({ id: "launcher/b", topic: "launcher", kind: "fact" }),
  ];
  const issues = validateWrite(
    { text: "the chat router dedups by seq", kind: "rule" },
    { existing },
  );
  const topicReq = issues.find((i) => i.code === "topic_required");
  expect(topicReq).toBeDefined();
  expect(topicReq!.extra!.existing_topics).toEqual(["chat", "launcher"]);
  // "chat" appears in the text → suggested.
  expect(topicReq!.extra!.suggestion).toBe("chat");
});

test("note without topic does NOT require a topic", () => {
  const issues = validateWrite({ text: "scratch", kind: "note" }, { existing: [] });
  expect(issues.find((i) => i.code === "topic_required")).toBeUndefined();
});

test("reminder without topic does NOT require a topic", () => {
  const issues = validateWrite(
    { text: "ping Leandro", kind: "reminder" },
    { existing: [] },
  );
  expect(issues.find((i) => i.code === "topic_required")).toBeUndefined();
});

test("legacy kind warns kind_legacy with the mapped target", () => {
  const issues = validateWrite(
    { text: "x", kind: "decision", topic: "git" },
    { existing: [] },
  );
  const legacy = issues.find((i) => i.code === "kind_legacy");
  expect(legacy).toBeDefined();
  expect(legacy!.extra!.mapped).toBe("rule");
});

test("unknown kind warns invalid_kind", () => {
  const issues = validateWrite(
    { text: "x", kind: "wibble", topic: "git" },
    { existing: [] },
  );
  expect(issues.find((i) => i.code === "invalid_kind")).toBeDefined();
});

test("summary that just echoes the first line warns summary_is_header", () => {
  const issues = validateWrite(
    { text: "Use bun not npm\nmore detail", summary: "Use bun not npm", kind: "note" },
    { existing: [] },
  );
  expect(issues.find((i) => i.code === "summary_is_header")).toBeDefined();
});

test("a trigger-phrased summary does not warn summary_is_header", () => {
  const issues = validateWrite(
    {
      text: "Use bun not npm\nmore detail",
      summary: "when installing deps, use bun (never npm)",
      kind: "note",
    },
    { existing: [] },
  );
  expect(issues.find((i) => i.code === "summary_is_header")).toBeUndefined();
});

test("new topic on a durable kind is flagged new_topic (advisory)", () => {
  const existing = [entry({ id: "chat/a", topic: "chat" })];
  const issues = validateWrite(
    { text: "x", kind: "rule", topic: "brand-new" },
    { existing },
  );
  expect(issues.find((i) => i.code === "new_topic")).toBeDefined();
});

test("pin over budget warns pin_budget_exceeded", () => {
  const big = "a".repeat(11 * 1024);
  const issues = validateWrite(
    { text: big, kind: "rule", topic: "git", pin: true },
    { existing: [] },
  );
  expect(issues.find((i) => i.code === "pin_budget_exceeded")).toBeDefined();
});

test("always-topic over summary budget warns always_budget_exceeded", () => {
  const existing: MemoryEntry[] = [];
  for (let i = 0; i < 40; i++) {
    existing.push(
      entry({ id: `always/${i}`, topic: "always", summary: "x".repeat(230) }),
    );
  }
  const issues = validateWrite(
    { text: "one more", summary: "y".repeat(230), kind: "fact", topic: "always" },
    { existing },
  );
  expect(issues.find((i) => i.code === "always_budget_exceeded")).toBeDefined();
});

test("enforce mode throws a MemoryError on the first hard issue", () => {
  expect(() =>
    validateWrite({ text: "x", kind: "rule" }, { existing: [], enforce: true }),
  ).toThrow(MemoryError);
});

test("enforce mode does NOT throw on advisory-only issues (kind_legacy)", () => {
  // legacy kind + valid topic → only kind_legacy, which is advisory.
  const issues = validateWrite(
    { text: "x", kind: "decision", topic: "git" },
    { existing: [entry({ id: "git/a", topic: "git" })], enforce: true },
  );
  expect(issues.find((i) => i.code === "kind_legacy")).toBeDefined();
});

test("selfId excludes the entry being updated from pin/always budgets", () => {
  const big = "a".repeat(9 * 1024);
  const existing = [entry({ id: "git/self", topic: "git", pin: true, text: big })];
  // Re-validating the same entry's pin shouldn't double-count its bytes.
  const issues = validateWrite(
    { text: big, kind: "rule", topic: "git", pin: true },
    { existing, selfId: "git/self" },
  );
  expect(issues.find((i) => i.code === "pin_budget_exceeded")).toBeUndefined();
});
