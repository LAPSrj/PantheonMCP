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
