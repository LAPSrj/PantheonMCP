import { test, expect } from "bun:test";
import { TOOLS } from "../tools.ts";

function props(name: string): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool '${name}' not found in TOOLS`);
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  return schema.properties ?? {};
}

function required(name: string): string[] {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool '${name}' not found in TOOLS`);
  return (tool.inputSchema as { required?: string[] }).required ?? [];
}

/** Bare personal-memory tools — reads AND writes — operate only on the
 * caller's own claimed persona. None expose a cross-persona `username`
 * target; with `additionalProperties: false`, passing one is a hard
 * reject at the dispatch boundary. Cross-persona READS live behind the
 * `_any` variants (deniable by tool name); shared WRITES go through
 * PROJECT memory, never a peer's personal store. */
const SELF_ONLY_TOOLS = [
  // writes
  "append_memory",
  "update_memory",
  "set_memory",
  "fade_memory",
  "forget_memory",
  "snapshot_memory",
  "restore_memory",
  "delete_snapshot",
  "list_snapshots",
  // reads
  "get_memory",
  "list_memory",
  "recall_memory",
  "list_topics",
  "load_memory",
  "find_memory",
];

/** Cross-persona READ variants — the elevated, separately-deniable
 * tools an operator can withhold from regular agents. */
const ANY_READ_TOOLS = [
  "get_memory_any",
  "list_memory_any",
  "recall_memory_any",
];

test("bare personal-memory tools expose no cross-persona `username`", () => {
  for (const name of SELF_ONLY_TOOLS) {
    expect(props(name)).not.toHaveProperty("username");
  }
});

test("find_memory is self-only — no cross-persona `scope`", () => {
  expect(props("find_memory")).not.toHaveProperty("scope");
});

test("`_any` read variants exist and require a `username` target", () => {
  for (const name of ANY_READ_TOOLS) {
    expect(TOOLS.find((t) => t.name === name)).toBeDefined();
    expect(props(name)).toHaveProperty("username");
    expect(required(name)).toContain("username");
  }
});

test("find_memory_any searches all personas — query only, no `username`", () => {
  expect(TOOLS.find((t) => t.name === "find_memory_any")).toBeDefined();
  expect(props("find_memory_any")).toHaveProperty("query");
  expect(props("find_memory_any")).not.toHaveProperty("username");
});
