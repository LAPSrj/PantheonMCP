import { test, expect } from "bun:test";
import { renderMarkdownBlock, stripAnsi } from "../console-markdown.ts";

test("renders a single-line blockquote with left bar", () => {
  const out = renderMarkdownBlock("> a quoted line", 40);
  expect(out).toContain("▌");
  // Body is dim (CSI 2) and grey-barred. Stripping ANSI leaves "▌ a quoted line".
  expect(stripAnsi(out)).toBe("▌ a quoted line");
});

test("merges consecutive quote lines into a single block", () => {
  const out = renderMarkdownBlock("> first\n> second\n> third", 40);
  const stripped = stripAnsi(out).split("\n");
  expect(stripped).toEqual(["▌ first", "▌ second", "▌ third"]);
});

test("blank `>` line renders bar with no body", () => {
  const out = renderMarkdownBlock("> top\n>\n> bottom", 40);
  const stripped = stripAnsi(out).split("\n");
  // The empty quote line still emits the bar (no trailing space content).
  expect(stripped[0]).toBe("▌ top");
  expect(stripped[1]).toMatch(/^▌\s*$/);
  expect(stripped[2]).toBe("▌ bottom");
});

test("optional space after `>` is tolerated", () => {
  const out = renderMarkdownBlock(">no-space\n> with-space", 40);
  const stripped = stripAnsi(out).split("\n");
  expect(stripped).toEqual(["▌ no-space", "▌ with-space"]);
});

test("long quote lines wrap; bar reappears on every wrapped row", () => {
  const long = "> " + "word ".repeat(20).trim();
  const out = renderMarkdownBlock(long, 20);
  const stripped = stripAnsi(out).split("\n");
  // Every wrapped line must start with the bar prefix.
  for (const l of stripped) {
    expect(l.startsWith("▌ ")).toBe(true);
  }
  // It actually wrapped (more than one line).
  expect(stripped.length).toBeGreaterThan(1);
});

test("inline markdown renders inside quotes (bold + code)", () => {
  const out = renderMarkdownBlock("> see `foo()` and **bold**", 40);
  // ANSI codes for bold (CSI 1) and code (CSI 36) should appear.
  expect(out).toContain("\x1b[1m");
  expect(out).toContain("\x1b[36m");
});

test("non-quote text after a quote breaks the quote block", () => {
  const out = renderMarkdownBlock("> quote line\nplain paragraph", 40);
  const stripped = stripAnsi(out).split("\n");
  expect(stripped[0]).toBe("▌ quote line");
  expect(stripped[1]).toBe("plain paragraph");
});

// Sanity: existing block kinds still work after the parser change.

test("regression: paragraphs unaffected", () => {
  const out = renderMarkdownBlock("just a paragraph", 40);
  expect(stripAnsi(out)).toBe("just a paragraph");
});

test("regression: heading + list still parse", () => {
  const out = renderMarkdownBlock("# Title\n- item one\n- item two", 40);
  const stripped = stripAnsi(out);
  expect(stripped).toContain("Title");
  expect(stripped).toContain("• item one");
  expect(stripped).toContain("• item two");
});

test("regression: fenced code block unaffected", () => {
  const out = renderMarkdownBlock("```\nfoo\nbar\n```", 40);
  expect(stripAnsi(out)).toBe("foo\nbar");
});
