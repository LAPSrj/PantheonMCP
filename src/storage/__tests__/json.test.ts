import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  writeJsonAtomic,
  readJson,
  mutateJsonAtomic,
  StorageError,
} from "../json.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-json-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("writeJsonAtomic creates the file and removes the tmp", () => {
  const target = path.join(tmpDir, "out.json");
  writeJsonAtomic(target, { hello: "world" });
  expect(fs.readFileSync(target, "utf8")).toContain("hello");

  const leftover = fs.readdirSync(tmpDir).filter((n) => n.includes(".tmp."));
  expect(leftover).toEqual([]);
});

test("writeJsonAtomic creates parent directories", () => {
  const target = path.join(tmpDir, "nested", "deep", "out.json");
  writeJsonAtomic(target, { ok: true });
  expect(fs.existsSync(target)).toBe(true);
});

test("writeJsonAtomic overwrites existing file atomically", () => {
  const target = path.join(tmpDir, "out.json");
  writeJsonAtomic(target, { v: 1 });
  writeJsonAtomic(target, { v: 2 });
  expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ v: 2 });
});

test("readJson returns null for missing file", () => {
  expect(readJson(path.join(tmpDir, "missing.json"))).toBeNull();
});

test("readJson round-trips values", () => {
  const target = path.join(tmpDir, "out.json");
  const value = { handle: "vellumpike", count: 3, items: ["a", "b"] };
  writeJsonAtomic(target, value);
  expect(readJson<typeof value>(target)).toEqual(value);
});

test("readJson throws StorageError on permanently malformed JSON", () => {
  const target = path.join(tmpDir, "broken.json");
  fs.writeFileSync(target, "{not json");
  let err: unknown;
  try {
    readJson(target);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(StorageError);
  expect((err as StorageError).code).toBe("json_parse_failed");
});

test("mutateJsonAtomic creates the file when missing", () => {
  const target = path.join(tmpDir, "store.json");
  const result = mutateJsonAtomic<{ entries: string[] }>(target, (cur) => {
    expect(cur).toBeNull();
    return { entries: ["one"] };
  });
  expect(result).toEqual({ entries: ["one"] });
  expect(readJson<{ entries: string[] }>(target)).toEqual({ entries: ["one"] });
});

test("mutateJsonAtomic mutates an existing file", () => {
  const target = path.join(tmpDir, "store.json");
  writeJsonAtomic(target, { entries: ["one"] });
  mutateJsonAtomic<{ entries: string[] }>(target, (cur) => {
    expect(cur).toEqual({ entries: ["one"] });
    return { entries: [...cur!.entries, "two"] };
  });
  expect(readJson<{ entries: string[] }>(target)).toEqual({ entries: ["one", "two"] });
});

test("mutateJsonAtomic returns current value when mutator returns undefined", () => {
  const target = path.join(tmpDir, "store.json");
  writeJsonAtomic(target, { entries: ["one"] });
  const result = mutateJsonAtomic<{ entries: string[] }>(target, () => undefined);
  expect(result).toEqual({ entries: ["one"] });
});

test("mutateJsonAtomic retries when a sibling races (mtime moved)", async () => {
  const target = path.join(tmpDir, "store.json");
  writeJsonAtomic(target, { v: 0 });

  let attempts = 0;
  const result = mutateJsonAtomic<{ v: number }>(target, (cur) => {
    attempts++;
    if (attempts === 1) {
      // Simulate a sibling racing in between our read and our pending rename.
      // The mtime will have moved when mutateJsonAtomic re-stats before commit.
      const sib = `${target}.tmp.99999.${Date.now() + 1000}.sib`;
      fs.writeFileSync(sib, JSON.stringify({ v: 99 }));
      fs.renameSync(sib, target);
    }
    return { v: (cur?.v ?? 0) + 1 };
  });

  // Second attempt sees the racing writer's value (99) and increments to 100.
  expect(attempts).toBe(2);
  expect(result).toEqual({ v: 100 });
  expect(readJson<{ v: number }>(target)).toEqual({ v: 100 });
});

test("mutateJsonAtomic gives up with mutate_conflict after 3 racing losses", () => {
  const target = path.join(tmpDir, "store.json");
  writeJsonAtomic(target, { v: 0 });

  let attempts = 0;
  let err: unknown;
  try {
    mutateJsonAtomic<{ v: number }>(target, () => {
      attempts++;
      // Race the file every attempt — mtime always moves before our rename.
      const sib = `${target}.tmp.99999.${Date.now() + attempts}.r${attempts}`;
      fs.writeFileSync(sib, JSON.stringify({ v: attempts * 10 }));
      fs.renameSync(sib, target);
      return { v: 1 };
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(StorageError);
  expect((err as StorageError).code).toBe("mutate_conflict");
  expect(attempts).toBe(3);
});
