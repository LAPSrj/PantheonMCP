import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { Session } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import { createContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import { CROSS_AGENT_HIDDEN, TOOLS } from "../tools.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-xa-tools-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(cross_agent_enabled: boolean): HandlerContext {
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  return createContext({
    paths,
    session: new Session("test-session"),
    watchdog: new Watchdog(realScheduler),
    parent_pid: 99999,
    platform: "linux",
    cross_agent_enabled,
  });
}

function parseResult(r: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

// --- hidden-set composition ---

test("CROSS_AGENT_HIDDEN is exactly the `_any` tools", () => {
  for (const t of TOOLS) {
    expect(CROSS_AGENT_HIDDEN.has(t.name)).toBe(t.name.endsWith("_any"));
  }
  // Spot-check the cross-persona variants, including force_*_any.
  for (const name of [
    "get_memory_any",
    "list_memory_any",
    "recall_memory_any",
    "find_memory_any",
    "summon_any",
    "conjure_any",
    "search_history_any",
    "list_projects_any",
    "edit_project_any",
    "force_rest_any",
    "force_exit_any",
    "append_project_memory_any",
  ]) {
    expect(CROSS_AGENT_HIDDEN.has(name)).toBe(true);
  }
});

test("CROSS_AGENT_HIDDEN keeps every self / non-`_any` tool", () => {
  for (const name of [
    "login",
    "send_message",
    "get_memory",
    "append_memory",
    "recall_memory",
    "fork",
    "summon",
    "append_project_memory",
    "force_rest",
    "force_exit",
    "whoami",
    "validate_user_quote",
  ]) {
    expect(CROSS_AGENT_HIDDEN.has(name)).toBe(false);
  }
});

// --- tools/list filter (mirrors server.ts) ---

test("filtering TOOLS by the hidden set drops only `_any` tools", () => {
  const advertised = TOOLS.filter((t) => !CROSS_AGENT_HIDDEN.has(t.name));
  const names = new Set(advertised.map((t) => t.name));
  expect(names.has("get_memory_any")).toBe(false);
  expect(names.has("force_rest_any")).toBe(false);
  expect(names.has("get_memory")).toBe(true);
  expect(names.has("summon")).toBe(true);
  expect(names.has("force_rest")).toBe(true);
  expect(advertised.length).toBeLessThan(TOOLS.length);
});

// --- dispatch guard ---

test("dispatch rejects an `_any` tool when cross-agent reach is off", async () => {
  const ctx = makeCtx(false);
  const r = await dispatch("get_memory_any", { username: "beta", id: "x" }, ctx);
  expect(r.isError).toBe(true);
  expect(parseResult(r).error).toBe("tool_unavailable_cross_agent");
});

test("dispatch rejects force_*_any when cross-agent reach is off", async () => {
  const ctx = makeCtx(false);
  const r = await dispatch("force_rest_any", { target_username: "beta" }, ctx);
  expect(r.isError).toBe(true);
  expect(parseResult(r).error).toBe("tool_unavailable_cross_agent");
});

test("dispatch allows the same `_any` tool when cross-agent reach is on", async () => {
  const ctx = makeCtx(true);
  const r = await dispatch("get_memory_any", { username: "beta", id: "x" }, ctx);
  // Not blocked by the cross-agent guard — it falls through to normal
  // handling (which errors for its own reasons, but NOT this code).
  expect(parseResult(r).error).not.toBe("tool_unavailable_cross_agent");
});

test("dispatch never blocks a self tool when cross-agent reach is off", async () => {
  const ctx = makeCtx(false);
  const r = await dispatch("whoami", {}, ctx);
  const payload = r.isError ? parseResult(r) : {};
  expect(payload.error).not.toBe("tool_unavailable_cross_agent");
});
