import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  IdentityError,
  createPersona,
  mergePersona,
  listPersonas,
  readPersona,
} from "../index.ts";
import { appendEntry, loadStore, updateEntry } from "../../memory/index.ts";

let tmpDir: string;
let paths: Paths;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-merge-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Target ("into") persona with one of its own entries. */
function seedTarget() {
  createPersona(paths, {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work/pantheon",
    platform: "linux",
    description: "lead implementer",
    expertise: ["typescript", "mcp"],
    owns: ["/repos/pantheon"],
    mode: "fresh",
    color: "purple",
  });
  appendEntry(paths, "vellumpike", {
    text: "Target's own rule: bun for everything.",
    kind: "rule",
    topic: "conventions",
  });
}

/** Source ("from") persona with a durable entry, a faded note, and a
 * pair linked by see_also so we can assert reference remapping. */
function seedSource() {
  createPersona(paths, {
    username: "cinderlatch",
    project: "pantheon",
    cwd: "/work/pantheon",
    platform: "linux",
    description: "one-shot patcher",
    expertise: ["mcp", "argv-passthrough"],
    owns: ["src/mcp/tools.ts"],
    mode: "fresh",
    color: "blue",
  });
  const gotcha = appendEntry(paths, "cinderlatch", {
    text: "Gotcha: profile flag must be forwarded before spawn.",
    summary: "profile-flag-forward",
    kind: "gotcha",
    topic: "spawn",
  });
  const note = appendEntry(paths, "cinderlatch", {
    text: "Follow-up note referencing the gotcha.",
    summary: "followup-note",
    kind: "note",
    topic: "spawn",
    see_also: [gotcha.id],
  });
  // Fade the note so we can assert status is preserved across merge.
  updateEntry(paths, "cinderlatch", note.id, { status: "faded" });
  return { gotchaId: gotcha.id, noteId: note.id };
}

test("mergePersona folds source memory into target and drops source by default", () => {
  seedTarget();
  seedSource();
  const result = mergePersona({ paths, from: "cinderlatch", into: "vellumpike" });

  expect(result.source).toBe("cinderlatch");
  expect(result.merged_entries).toBe(2);
  expect(result.source_dropped).toBe(true);

  // Target now holds its own entry plus the two merged ones.
  const summaries = loadStore(paths, "vellumpike").entries.map((e) => e.summary).sort();
  expect(summaries).toEqual(
    ["Target's own rule: bun for everything.", "followup-note", "profile-flag-forward"].sort(),
  );

  // Source is gone from the registry and its memory file removed.
  expect(readPersona(paths, "cinderlatch")).toBeNull();
  expect(listPersonas(paths).map((p) => p.username)).toEqual(["vellumpike"]);
});

test("mergePersona preserves status and original date of imported entries", () => {
  seedTarget();
  seedSource();
  const sourceNote = loadStore(paths, "cinderlatch").entries.find(
    (e) => e.summary === "followup-note",
  )!;

  mergePersona({ paths, from: "cinderlatch", into: "vellumpike" });

  const mergedNote = loadStore(paths, "vellumpike").entries.find(
    (e) => e.summary === "followup-note",
  )!;
  expect(mergedNote.status).toBe("faded"); // faded stays faded
  expect(mergedNote.date).toBe(sourceNote.date); // original date preserved
  expect(mergedNote.topic).toBe("spawn"); // topic preserved
});

test("mergePersona regenerates ids and remaps internal references", () => {
  seedTarget();
  const { gotchaId } = seedSource();
  // Force a slug collision: give the target an entry that already
  // occupies `spawn/profile-flag-forward` (distinct stored summary so we
  // can still find the import by its exact summary). The imported gotcha
  // must then get a fresh suffixed id, and the note's see_also must be
  // remapped to that NEW id rather than the stale source id.
  appendEntry(paths, "vellumpike", {
    text: "Target's own spawn gotcha.",
    summary: "Profile Flag Forward",
    kind: "gotcha",
    topic: "spawn",
  });

  const result = mergePersona({ paths, from: "cinderlatch", into: "vellumpike" });
  expect(result.remapped_refs).toBe(1);

  const entries = loadStore(paths, "vellumpike").entries;
  const mergedGotcha = entries.find((e) => e.summary === "profile-flag-forward")!;
  const mergedNote = entries.find((e) => e.summary === "followup-note")!;

  // New id differs from the source id (collision forced a suffix)...
  expect(mergedGotcha.id).not.toBe(gotchaId);
  // ...and the note's see_also points at the NEW id, not the stale one.
  expect(mergedNote.see_also).toEqual([mergedGotcha.id]);
  expect(mergedNote.see_also).not.toContain(gotchaId);
});

test("mergePersona unions owns + expertise into target (dedup, order-stable)", () => {
  seedTarget();
  seedSource();
  const result = mergePersona({ paths, from: "cinderlatch", into: "vellumpike" });

  // target first, then source extras; "mcp" dedup'd.
  expect(result.persona.expertise).toEqual(["typescript", "mcp", "argv-passthrough"]);
  expect(result.persona.owns).toEqual(["/repos/pantheon", "src/mcp/tools.ts"]);
  // Target keeps its own identity fields.
  expect(result.persona.description).toBe("lead implementer");
  expect(result.persona.color).toBe("purple");
});

test("mergePersona union_profile:false leaves target profile untouched", () => {
  seedTarget();
  seedSource();
  const result = mergePersona({
    paths,
    from: "cinderlatch",
    into: "vellumpike",
    union_profile: false,
  });
  expect(result.persona.expertise).toEqual(["typescript", "mcp"]);
  expect(result.persona.owns).toEqual(["/repos/pantheon"]);
});

test("mergePersona drop_source:false keeps the source intact", () => {
  seedTarget();
  seedSource();
  const result = mergePersona({
    paths,
    from: "cinderlatch",
    into: "vellumpike",
    drop_source: false,
  });
  expect(result.source_dropped).toBe(false);
  expect(readPersona(paths, "cinderlatch")).not.toBeNull();
  // Source memory still there too.
  expect(loadStore(paths, "cinderlatch").entries.length).toBe(2);
});

test("mergePersona skips forgotten source entries", () => {
  seedTarget();
  const { gotchaId } = seedSource();
  // Tombstone the gotcha; it should not be carried into the target.
  updateEntry(paths, "cinderlatch", gotchaId, { status: "forgotten" });

  const result = mergePersona({ paths, from: "cinderlatch", into: "vellumpike" });
  expect(result.skipped_forgotten).toBe(1);
  expect(result.merged_entries).toBe(1);

  const summaries = loadStore(paths, "vellumpike").entries.map((e) => e.summary);
  expect(summaries).not.toContain("profile-flag-forward");
});

test("mergePersona errors merge_into_self when from === into", () => {
  seedTarget();
  let err: unknown;
  try {
    mergePersona({ paths, from: "vellumpike", into: "vellumpike" });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("merge_into_self");
});

test("mergePersona errors not_registered when a handle is missing", () => {
  seedTarget();
  let err: unknown;
  try {
    mergePersona({ paths, from: "ghost", into: "vellumpike" });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("not_registered");
});
