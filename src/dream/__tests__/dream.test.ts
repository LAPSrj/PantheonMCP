import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import {
  appendEntry as appendPersonaEntry,
  getEntry as getPersonaEntry,
  listIndex as listPersonaIndex,
} from "../../memory/index.ts";
import {
  appendProjectEntry,
  getProjectEntry,
  listProjectIndex,
} from "../../project-memory/index.ts";
import {
  applyPersonaPlan,
  applyProjectPlan,
  buildPersonaSnapshot,
  parseAndValidateLibrarianOutput,
  type DreamPlan,
} from "../index.ts";

let tmpDir: string;
let paths: ReturnType<typeof resolvePaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-dream-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("parseAndValidateLibrarianOutput accepts a well-formed plan with prose surrounding", () => {
  const raw = `Here's the plan:\n\n{"fade":[{"id":"a"}],"forget":[],"consolidate":[]}\n\nDone.`;
  const plan = parseAndValidateLibrarianOutput(raw);
  expect(plan.fade).toHaveLength(1);
});

test("parseAndValidateLibrarianOutput rejects missing required keys", () => {
  const raw = `{"fade":[]}`;
  expect(() => parseAndValidateLibrarianOutput(raw)).toThrow(/schema validation/);
});

test("parseAndValidateLibrarianOutput rejects non-JSON output", () => {
  expect(() => parseAndValidateLibrarianOutput("no json here")).toThrow(
    /no JSON object/,
  );
});

test("parseAndValidateLibrarianOutput rejects an invalid action shape", () => {
  // consolidate.new_entry missing required `summary`.
  const raw = `{"fade":[],"forget":[],"consolidate":[{"source_ids":["a"],"new_entry":{"text":"x"}}]}`;
  expect(() => parseAndValidateLibrarianOutput(raw)).toThrow(/schema validation/);
});

test("buildPersonaSnapshot omits forgotten entries; keeps active + faded", async () => {
  const { forgetEntry, fadeEntry } = await import("../../memory/index.ts");
  appendPersonaEntry(paths, "vellumpike", { text: "alive 1" });
  const dead = appendPersonaEntry(paths, "vellumpike", { text: "to forget" });
  const faded = appendPersonaEntry(paths, "vellumpike", { text: "to fade" });
  forgetEntry(paths, "vellumpike", dead.id);
  fadeEntry(paths, "vellumpike", faded.id);
  const snap = buildPersonaSnapshot(paths, "vellumpike");
  // Only alive + faded survive — forgotten is excluded.
  const ids = snap.entries.map((e) => e.id).sort();
  expect(ids).not.toContain(dead.id);
  expect(snap.entries.find((e) => e.id === faded.id)?.status).toBe("faded");
});

test("applyPersonaPlan: fade flips status to faded; forget tombstones; consolidate appends + forgets sources", () => {
  const a = appendPersonaEntry(paths, "vellumpike", { text: "fade me", summary: "fade me" });
  const b = appendPersonaEntry(paths, "vellumpike", { text: "forget me", summary: "forget me" });
  const c = appendPersonaEntry(paths, "vellumpike", { text: "source 1", summary: "src 1" });
  const d = appendPersonaEntry(paths, "vellumpike", { text: "source 2", summary: "src 2" });
  const plan: DreamPlan = {
    fade: [{ id: a.id }],
    forget: [{ id: b.id }],
    consolidate: [
      {
        source_ids: [c.id, d.id],
        new_entry: {
          summary: "consolidated src 1+2",
          text: "merged body",
          kind: "consolidated",
        },
      },
    ],
  };
  const result = applyPersonaPlan(paths, "vellumpike", plan);
  expect(result.faded).toBe(1);
  expect(result.forgotten).toBe(1);
  expect(result.consolidated).toBe(1);
  expect(getPersonaEntry(paths, "vellumpike", a.id)!.status).toBe("faded");
  expect(getPersonaEntry(paths, "vellumpike", b.id)!.status).toBe("forgotten");
  expect(getPersonaEntry(paths, "vellumpike", c.id)!.status).toBe("forgotten");
  expect(getPersonaEntry(paths, "vellumpike", d.id)!.status).toBe("forgotten");
  // New consolidated entry exists, kind=consolidated.
  const all = listPersonaIndex(paths, "vellumpike", { status: "active" });
  const consolidated = all.find((e) => e.summary === "consolidated src 1+2");
  expect(consolidated).toBeTruthy();
  // Audit entry of kind=dream_log was appended.
  const audit = listPersonaIndex(paths, "vellumpike", { kind: "dream_log" });
  expect(audit).toHaveLength(1);
  expect(audit[0]!.summary).toContain("faded 1, forgot 1, consolidated 1");
});

test("applyProjectPlan: same shape, stamps author_username on new entries", () => {
  const a = appendProjectEntry(paths, "pantheon", {
    text: "source 1",
    summary: "src 1",
    author_username: "alpha",
  });
  const b = appendProjectEntry(paths, "pantheon", {
    text: "source 2",
    summary: "src 2",
    author_username: "beta",
  });
  const plan: DreamPlan = {
    fade: [],
    forget: [],
    consolidate: [
      {
        source_ids: [a.id, b.id],
        new_entry: { summary: "merged 1+2", text: "merged" },
      },
    ],
  };
  const result = applyProjectPlan(paths, "pantheon", plan, "vellumpike");
  expect(result.consolidated).toBe(1);
  expect(getProjectEntry(paths, "pantheon", a.id)!.status).toBe("forgotten");
  const all = listProjectIndex(paths, "pantheon", { status: "active" });
  const consolidated = all.find((e) => e.summary === "merged 1+2");
  expect(consolidated).toBeTruthy();
  expect(consolidated!.author_username).toBe("vellumpike");
  // Audit entry of kind=dream_log.
  const audit = listProjectIndex(paths, "pantheon", { kind: "dream_log" });
  expect(audit).toHaveLength(1);
});

test("applyPersonaPlan: empty plan still produces an audit entry (no-op trail)", () => {
  appendPersonaEntry(paths, "vellumpike", { text: "untouched" });
  const result = applyPersonaPlan(paths, "vellumpike", {
    fade: [],
    forget: [],
    consolidate: [],
  });
  expect(result.faded).toBe(0);
  expect(result.forgotten).toBe(0);
  expect(result.consolidated).toBe(0);
  const audit = listPersonaIndex(paths, "vellumpike", { kind: "dream_log" });
  expect(audit).toHaveLength(1);
});

test("applyPersonaPlan: forget on unknown id captures the error in notes, doesn't crash", () => {
  const result = applyPersonaPlan(paths, "vellumpike", {
    fade: [],
    forget: [{ id: "nonexistent-id" }],
    consolidate: [],
  });
  expect(result.forgotten).toBe(0);
  expect(result.notes.length).toBeGreaterThan(0);
  expect(result.notes[0]).toContain("forget('nonexistent-id')");
});
