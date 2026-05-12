import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  NotebookError,
  exportNotebook,
  exportProjectNotebook,
  writePage,
  deletePage,
} from "../index.ts";
import { writeProjectPage } from "../../project-notebook/index.ts";

let tmpDir: string;
let paths: Paths;
let outDir: string;
const USER = "vellumpike";
const PROJECT = "pantheon";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-export-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-export-out-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

function expectThrowCode(fn: () => unknown, code: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(NotebookError);
  expect((err as NotebookError).code as string).toBe(code);
}

test("exportNotebook writes a markdown file with title + TOC + pages", () => {
  writePage(paths, USER, {
    topic: "swiper",
    title: "Z-index hell",
    body: "Pin `--swiper-z-index: 1` on clones.",
    tags: ["css", "swiper"],
  });
  writePage(paths, USER, {
    topic: "swiper",
    title: "Loop mode quirk",
    body: "Loop mode duplicates the first/last N slides.",
  });
  writePage(paths, USER, { topic: "bugherd", title: "RFR", body: "Tia." });

  const outPath = path.join(outDir, "out.md");
  const result = exportNotebook(paths, USER, { output_path: outPath });
  expect(result.bytes_written).toBeGreaterThan(0);
  expect(result.topics_written).toBe(2);
  expect(result.pages_written).toBe(3);

  const text = fs.readFileSync(outPath, "utf8");
  expect(text).toMatch(/^# Notebook — vellumpike/);
  expect(text).toContain("## Topics");
  expect(text).toContain("swiper");
  expect(text).toContain("bugherd");
  expect(text).toContain("Z\\-index hell"); // headings are inline-escaped
  expect(text).toContain("Pin `--swiper-z-index: 1`");
});

test("exportNotebook with topic filter writes only that topic", () => {
  writePage(paths, USER, { topic: "a", title: "A", body: "alpha" });
  writePage(paths, USER, { topic: "b", title: "B", body: "beta" });

  const outPath = path.join(outDir, "a.md");
  const result = exportNotebook(paths, USER, {
    output_path: outPath,
    topic: "a",
  });
  expect(result.topics_written).toBe(1);

  const text = fs.readFileSync(outPath, "utf8");
  expect(text).toContain("alpha");
  expect(text).not.toContain("beta");
});

test("exportNotebook excludes deleted pages by default; include_deleted surfaces them with marker", () => {
  const r = writePage(paths, USER, { topic: "t", title: "A", body: "abody" });
  writePage(paths, USER, { topic: "t", title: "B", body: "bbody" });
  deletePage(paths, USER, "t", r.page.id);

  const defaultPath = path.join(outDir, "default.md");
  exportNotebook(paths, USER, { output_path: defaultPath });
  const defaultText = fs.readFileSync(defaultPath, "utf8");
  expect(defaultText).not.toContain("abody");
  expect(defaultText).toContain("bbody");

  const inclPath = path.join(outDir, "incl.md");
  exportNotebook(paths, USER, {
    output_path: inclPath,
    include_deleted: true,
  });
  const inclText = fs.readFileSync(inclPath, "utf8");
  expect(inclText).toContain("abody");
  expect(inclText).toMatch(/\*\(deleted\)\*/);
});

test("exportNotebook refuses to overwrite by default; overwrite:true forces", () => {
  writePage(paths, USER, { topic: "t", title: "A", body: "a" });
  const outPath = path.join(outDir, "guard.md");
  exportNotebook(paths, USER, { output_path: outPath });

  expectThrowCode(
    () => exportNotebook(paths, USER, { output_path: outPath }),
    "file_exists",
  );

  // overwrite:true succeeds and writes a fresh file
  const result = exportNotebook(paths, USER, {
    output_path: outPath,
    overwrite: true,
  });
  expect(result.bytes_written).toBeGreaterThan(0);
});

test("exportNotebook rejects relative paths and missing parent dirs", () => {
  writePage(paths, USER, { topic: "t", title: "A", body: "a" });
  expectThrowCode(
    () => exportNotebook(paths, USER, { output_path: "relative.md" }),
    "invalid_path",
  );
  expectThrowCode(
    () =>
      exportNotebook(paths, USER, {
        output_path: path.join(outDir, "does-not-exist", "nested.md"),
      }),
    "invalid_path",
  );
});

test("exportNotebook with empty notebook writes a 'no topics yet' file", () => {
  const outPath = path.join(outDir, "empty.md");
  const result = exportNotebook(paths, USER, { output_path: outPath });
  expect(result.topics_written).toBe(0);
  expect(result.pages_written).toBe(0);
  const text = fs.readFileSync(outPath, "utf8");
  expect(text).toMatch(/no topics yet/);
});

test("exportNotebook with missing topic filter rejects topic_not_found", () => {
  writePage(paths, USER, { topic: "t", title: "A", body: "a" });
  expectThrowCode(
    () =>
      exportNotebook(paths, USER, {
        output_path: path.join(outDir, "x.md"),
        topic: "ghost",
      }),
    "topic_not_found",
  );
});

test("exportProjectNotebook writes project markdown with author stamps", () => {
  writeProjectPage(paths, PROJECT, {
    topic: "handshake",
    title: "Persona map",
    body: "Five own this flow.",
    author_username: "vellumpike",
  });
  writeProjectPage(paths, PROJECT, {
    topic: "handshake",
    title: "Wire format",
    body: "JSON over chat-mcp.",
    author_username: "semaphoremole",
  });

  const outPath = path.join(outDir, "project.md");
  const result = exportProjectNotebook(paths, PROJECT, {
    output_path: outPath,
  });
  expect(result.pages_written).toBe(2);
  const text = fs.readFileSync(outPath, "utf8");
  expect(text).toMatch(/^# Project notebook — pantheon/);
  expect(text).toContain("author: `vellumpike`");
  expect(text).toContain("author: `semaphoremole`");
});
