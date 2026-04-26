import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Smoke test that the plugin source bundle (`plugin/`) ships every
 * file the manifest declares, that JSON parses, and that the slash
 * commands carry frontmatter CC will recognize. Catches "I forgot
 * to commit a file" regressions cheaply.
 *
 * The plugin itself is not LOADED here — that requires a real CC
 * install. This test is structural only. */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_DIR = path.join(REPO_ROOT, "plugin");

test("plugin/plugin.json exists and parses", () => {
  const manifestPath = path.join(PLUGIN_DIR, "plugin.json");
  expect(fs.existsSync(manifestPath)).toBe(true);
  const raw = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  expect(manifest.name).toBe("pantheon");
  expect(typeof manifest.version).toBe("string");
  expect(manifest.commands_dir).toBe("./commands");
});

test("plugin manifest declares the seven canonical slash commands", () => {
  const expected = [
    "pantheon-summon",
    "pantheon-rest",
    "pantheon-cast",
    "pantheon-list",
    "pantheon-stage",
    "pantheon-status",
    "pantheon-doctor",
  ];
  for (const cmd of expected) {
    const file = path.join(PLUGIN_DIR, "commands", `${cmd}.md`);
    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, "utf8");
    // Frontmatter delimiters present.
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain("description:");
  }
});

test("plugin hooks exist and are executable", () => {
  const hooks = ["watchdog-reset.sh", "color-binding.sh", "context-pct-nudge.sh", "tab-title.sh"];
  for (const h of hooks) {
    const file = path.join(PLUGIN_DIR, "hooks", h);
    expect(fs.existsSync(file)).toBe(true);
    const stat = fs.statSync(file);
    // Owner-execute bit set (0o100 = user-execute).
    expect((stat.mode & 0o100) !== 0).toBe(true);
  }
});

test("settings-templates exist and are well-formed JSON with merge_into hint", () => {
  const templates = ["role-builder.json", "role-monitor.json", "role-liaison.json"];
  for (const t of templates) {
    const file = path.join(PLUGIN_DIR, "settings-templates", t);
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(parsed._template_meta).toBeDefined();
    const meta = parsed._template_meta as Record<string, unknown>;
    expect(meta.name).toBeDefined();
    expect(meta.merge_into).toBeDefined();
    expect((parsed.permissions as Record<string, unknown>).allow).toBeDefined();
  }
});

test("plugin/README.md ships install instructions", () => {
  const readme = path.join(PLUGIN_DIR, "README.md");
  expect(fs.existsSync(readme)).toBe(true);
  const body = fs.readFileSync(readme, "utf8");
  expect(body).toContain("Install");
  expect(body).toContain("~/.claude/plugins/pantheon");
});
