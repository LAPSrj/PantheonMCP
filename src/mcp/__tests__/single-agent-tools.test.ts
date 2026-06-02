import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { Session } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import { createContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import { SINGLE_AGENT_HIDDEN, TOOLS } from "../tools.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-sa-tools-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(single_agent: boolean): HandlerContext {
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  return createContext({
    paths,
    session: new Session("test-session"),
    watchdog: new Watchdog(realScheduler),
    parent_pid: 99999,
    platform: "linux",
    single_agent,
  });
}

function parseResult(r: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

// --- hidden-set composition ---

test("SINGLE_AGENT_HIDDEN hides persona-creation, project, and cross-persona reads", () => {
  for (const name of [
    "register",
    "claim",
    "become",
    "fork",
    "merge",
    "summon",
    "conjure",
    "summon_any",
    "conjure_any",
    "append_project_memory",
    "get_project_memory",
    "list_project_memory_any",
    "get_memory_any",
    "list_memory_any",
    "recall_memory_any",
    "find_memory_any",
    "search_history_any",
    "get_history_conversation_any",
    "project_notebook_open",
  ]) {
    expect(SINGLE_AGENT_HIDDEN.has(name)).toBe(true);
  }
});

test("SINGLE_AGENT_HIDDEN keeps chat, force, lifecycle, and own-memory tools", () => {
  for (const name of [
    "login",
    "logout",
    "send_message",
    "ask",
    "answer",
    "update_status",
    "list_agents",
    "find_role",
    "force_rest",
    "force_exit",
    "force_rest_any",
    "force_exit_any",
    "rest",
    "exit",
    "get_memory",
    "append_memory",
    "recall_memory",
    "load_memory",
    "whoami",
  ]) {
    expect(SINGLE_AGENT_HIDDEN.has(name)).toBe(false);
  }
});

// --- tools/list filter (mirrors server.ts) ---

test("filtering TOOLS by the hidden set drops only hidden, advertised tools", () => {
  const advertised = TOOLS.filter((t) => !SINGLE_AGENT_HIDDEN.has(t.name));
  const names = new Set(advertised.map((t) => t.name));
  expect(names.has("fork")).toBe(false);
  expect(names.has("append_project_memory")).toBe(false);
  expect(names.has("get_memory_any")).toBe(false);
  expect(names.has("login")).toBe(true);
  expect(names.has("get_memory")).toBe(true);
  expect(names.has("force_rest")).toBe(true);
  // Strictly fewer tools advertised.
  expect(advertised.length).toBeLessThan(TOOLS.length);
});

// --- dispatch guard ---

test("dispatch rejects a hidden tool in a single-agent session", async () => {
  const ctx = makeCtx(true);
  const r = await dispatch("fork", { username: "beta" }, ctx);
  expect(r.isError).toBe(true);
  expect(parseResult(r).error).toBe("tool_unavailable_single_agent");
});

test("dispatch rejects a hidden project-memory tool in a single-agent session", async () => {
  const ctx = makeCtx(true);
  const r = await dispatch("append_project_memory", { text: "x" }, ctx);
  expect(r.isError).toBe(true);
  expect(parseResult(r).error).toBe("tool_unavailable_single_agent");
});

test("dispatch allows the same hidden tool in a normal (multi-agent) session", async () => {
  const ctx = makeCtx(false);
  const r = await dispatch("fork", { username: "beta" }, ctx);
  // Not blocked by the single-agent guard — it falls through to normal
  // handling (which errors for its own reasons, but NOT this code).
  const payload = parseResult(r);
  expect(payload.error).not.toBe("tool_unavailable_single_agent");
});

test("dispatch does not block a kept tool in a single-agent session", async () => {
  const ctx = makeCtx(true);
  const r = await dispatch("whoami", {}, ctx);
  // whoami is kept; whatever it returns, it must not be the guard error.
  const payload = r.isError ? parseResult(r) : {};
  expect(payload.error).not.toBe("tool_unavailable_single_agent");
});
