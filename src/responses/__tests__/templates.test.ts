import { test, expect, beforeEach } from "bun:test";
import {
  _clearTemplateCache,
  getResponseTemplate,
  listTemplateNames,
} from "../templates.ts";

beforeEach(() => {
  _clearTemplateCache();
});

test("listTemplateNames returns the bundled markdown filenames", () => {
  const names = listTemplateNames();
  expect(names).toContain("whoami-no-match");
  expect(names).toContain("whoami-sole-match");
});

test("getResponseTemplate loads a template and caches it", () => {
  const a = getResponseTemplate("whoami-no-match");
  expect(a).toContain("Invent a fresh");
  // Second call should hit the cache (same string reference is fine
  // since fs.readFileSync returns identical contents).
  const b = getResponseTemplate("whoami-no-match");
  expect(b).toBe(a);
});

test("getResponseTemplate interpolates {{key}} placeholders", () => {
  const out = getResponseTemplate("whoami-sole-match", {
    cwd: "/repos/pantheon",
    username: "vellumpike",
  });
  expect(out).toContain("/repos/pantheon");
  expect(out).toContain("vellumpike");
  expect(out).not.toContain("{{cwd}}");
  expect(out).not.toContain("{{username}}");
});

test("getResponseTemplate leaves unknown placeholders intact", () => {
  const out = getResponseTemplate("whoami-sole-match", { username: "x" });
  expect(out).toContain("{{cwd}}");
});

test("login-note carries the presence-lapsed recovery clause", () => {
  // Self-documenting recovery: when an agent's Monitor exits 3
  // (presence_lapsed), the login-note's recovery clause is the
  // authoritative source of "what to do next." Keeping it here in the
  // template means the guidance ships with pantheon — no separate
  // CLAUDE.md or external doc needs to be kept in sync.
  const out = getResponseTemplate("login-note", {
    agent_id: "fake-id",
    username: "vellumpike",
    project: "p",
    fetch_bin: "/x/bin",
  });
  expect(out).toContain("presence_lapsed");
  expect(out).toContain("mcp__pantheon__login");
  // Critical guard: agent must NOT call logout (would evict the
  // session currently holding the canonical handle).
  expect(out).toContain("DO NOT");
  expect(out).toContain("logout");
});
