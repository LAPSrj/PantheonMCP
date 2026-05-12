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
  defaultLibrarianTimeout,
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

// --- Commit 1: lifecycle rule + timeout scaling --------------------- //

test("applyPersonaPlan: forget on a core entry is coerced to fade per lifecycle rule", () => {
  const coreEntry = appendPersonaEntry(paths, "vellumpike", {
    text: "foundational",
    summary: "core entry",
    core: true,
  });
  const result = applyPersonaPlan(paths, "vellumpike", {
    fade: [],
    forget: [{ id: coreEntry.id, reason: "librarian thought it was redundant" }],
    consolidate: [],
  });
  // Coerced — not actually forgotten.
  expect(result.forgotten).toBe(0);
  expect(result.faded).toBe(1);
  expect(getPersonaEntry(paths, "vellumpike", coreEntry.id)!.status).toBe("faded");
  // Core flag retained.
  expect(getPersonaEntry(paths, "vellumpike", coreEntry.id)!.core).toBe(true);
  // Note recorded.
  expect(
    result.notes.some((n) =>
      n.includes(`forget('${coreEntry.id}') coerced to fade`),
    ),
  ).toBe(true);
  // Audit summary surfaces the coercion count.
  const audit = listPersonaIndex(paths, "vellumpike", { kind: "dream_log" });
  expect(audit[0]!.summary).toContain("core-forget coerced to fade");
});

test("applyPersonaPlan: consolidate source_ids hitting a core entry → fade source instead of forget", () => {
  const coreSource = appendPersonaEntry(paths, "vellumpike", {
    text: "core arc segment",
    summary: "phase-1",
    core: true,
  });
  const regularSource = appendPersonaEntry(paths, "vellumpike", {
    text: "regular log",
    summary: "phase-2",
  });
  const result = applyPersonaPlan(paths, "vellumpike", {
    fade: [],
    forget: [],
    consolidate: [
      {
        source_ids: [coreSource.id, regularSource.id],
        new_entry: { summary: "consolidated arc", text: "merged" },
      },
    ],
  });
  expect(result.consolidated).toBe(1);
  // Core source faded (not forgotten); regular source forgotten.
  expect(getPersonaEntry(paths, "vellumpike", coreSource.id)!.status).toBe("faded");
  expect(getPersonaEntry(paths, "vellumpike", regularSource.id)!.status).toBe(
    "forgotten",
  );
  expect(
    result.notes.some((n) =>
      n.includes(`core source '${coreSource.id}' faded`),
    ),
  ).toBe(true);
});

test("applyPersonaPlan: faded → forget is allowed (lifecycle one-tier-per-pass rule)", async () => {
  const { fadeEntry } = await import("../../memory/index.ts");
  const e = appendPersonaEntry(paths, "vellumpike", {
    text: "already aging",
    summary: "stale",
  });
  fadeEntry(paths, "vellumpike", e.id);
  const result = applyPersonaPlan(paths, "vellumpike", {
    fade: [],
    forget: [{ id: e.id }],
    consolidate: [],
  });
  // Non-core faded entry can be forgotten in the same pass.
  expect(result.forgotten).toBe(1);
  expect(getPersonaEntry(paths, "vellumpike", e.id)!.status).toBe("forgotten");
});

test("applyProjectPlan: core-forget coercion mirrors the persona path", () => {
  const coreEntry = appendProjectEntry(paths, "pantheon", {
    text: "project foundation",
    summary: "core fact",
    core: true,
    author_username: "alpha",
  });
  const result = applyProjectPlan(
    paths,
    "pantheon",
    {
      fade: [],
      forget: [{ id: coreEntry.id }],
      consolidate: [],
    },
    "vellumpike",
  );
  expect(result.forgotten).toBe(0);
  expect(result.faded).toBe(1);
  expect(getProjectEntry(paths, "pantheon", coreEntry.id)!.status).toBe(
    "faded",
  );
  const audit = listProjectIndex(paths, "pantheon", { kind: "dream_log" });
  expect(audit[0]!.summary).toContain("core-forget coerced to fade");
});

test("defaultLibrarianTimeout scales with entry count and caps at 600_000ms", () => {
  expect(defaultLibrarianTimeout(0)).toBe(60_000);
  expect(defaultLibrarianTimeout(10)).toBe(60_000 + 10 * 3_000);
  expect(defaultLibrarianTimeout(33)).toBe(60_000 + 33 * 3_000); // 159_000
  // Cap at 600_000ms (10 min) — kicks in around entry count 180.
  expect(defaultLibrarianTimeout(200)).toBe(600_000);
  expect(defaultLibrarianTimeout(9999)).toBe(600_000);
});
