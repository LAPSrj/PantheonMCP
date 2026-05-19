import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  ConjuredLibrarian,
  librarianHandleFor,
  type LibrarianSpawnInput,
} from "../conjured-librarian.ts";
import { DreamError, type LibrarianSnapshot } from "../index.ts";

let tmpDir: string;
let paths: Paths;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-conjured-lib-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSnapshot(): LibrarianSnapshot {
  return {
    scope: "persona",
    target: "vellumpike",
    entries: [
      {
        id: "entry-1",
        summary: "Test entry",
        text: "Body text.",
        status: "active",
        date: "2026-05-19T00:00:00.000Z",
      },
    ],
  };
}

test("ConjuredLibrarian: spawner sees snapshot path; result file is parsed and returned", async () => {
  const librarian = new ConjuredLibrarian();
  const captured: LibrarianSpawnInput[] = [];
  const fakeSpawn = async (input: LibrarianSpawnInput): Promise<void> => {
    captured.push(input);
    // Extract result path from the prompt — it's named in the
    // "Result file (write here when done):" line.
    const match = input.prompt.match(/Result file[^:]*:\s*(\S+)/);
    expect(match).toBeTruthy();
    const resultPath = match![1]!;
    const result = {
      scope: "persona",
      target: "vellumpike",
      faded: 2,
      forgotten: 1,
      consolidated: 1,
      audit_entry_id: "dream-log-id",
      posture_summary: "Conservative pass.",
      notes: ["test note"],
    };
    fs.writeFileSync(resultPath, JSON.stringify(result), "utf8");
  };

  const result = await librarian.run(
    makeSnapshot(),
    {
      paths,
      defaultProject: "pantheon",
      defaultCwd: "/tmp",
      defaultPlatform: "linux",
      spawn: fakeSpawn,
      poll_interval_ms: 10,
    },
    { timeout_ms: 5000 },
  );

  expect(result.scope).toBe("persona");
  expect(result.target).toBe("vellumpike");
  expect(result.faded).toBe(2);
  expect(result.forgotten).toBe(1);
  expect(result.consolidated).toBe(1);
  expect(result.audit_entry_id).toBe("dream-log-id");
  expect(result.notes).toEqual(["test note"]);

  expect(captured).toHaveLength(1);
  expect(captured[0]!.username).toBe("librarian-vellumpike");
  expect(captured[0]!.preExisting).toBe(false);
});

test("ConjuredLibrarian: librarianHandleFor returns librarian-<target>", () => {
  expect(librarianHandleFor(makeSnapshot())).toBe("librarian-vellumpike");
  expect(
    librarianHandleFor({
      scope: "project",
      target: "pantheon",
      entries: [],
    }),
  ).toBe("librarian-pantheon");
});

test("ConjuredLibrarian: timeout fires librarian_timeout when result file never appears", async () => {
  const librarian = new ConjuredLibrarian();
  const noopSpawn = async () => {
    // Don't write a result file → orchestrator times out.
  };

  await expect(
    librarian.run(
      makeSnapshot(),
      {
        paths,
        defaultProject: "pantheon",
        defaultCwd: "/tmp",
        defaultPlatform: "linux",
        spawn: noopSpawn,
        poll_interval_ms: 10,
      },
      { timeout_ms: 100 },
    ),
  ).rejects.toThrow(DreamError);
});

test("ConjuredLibrarian: malformed result file fails invalid_plan", async () => {
  const librarian = new ConjuredLibrarian();
  const badSpawn = async (input: LibrarianSpawnInput) => {
    const match = input.prompt.match(/Result file[^:]*:\s*(\S+)/);
    const resultPath = match![1]!;
    // Missing required `consolidated` field.
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        scope: "persona",
        target: "vellumpike",
        faded: 0,
        forgotten: 0,
      }),
      "utf8",
    );
  };

  await expect(
    librarian.run(
      makeSnapshot(),
      {
        paths,
        defaultProject: "pantheon",
        defaultCwd: "/tmp",
        defaultPlatform: "linux",
        spawn: badSpawn,
        poll_interval_ms: 10,
      },
      { timeout_ms: 2000 },
    ),
  ).rejects.toThrow(/schema validation/);
});

test("ConjuredLibrarian: partial-write JSON triggers polling, eventually parses", async () => {
  const librarian = new ConjuredLibrarian();
  const slowSpawn = async (input: LibrarianSpawnInput) => {
    const match = input.prompt.match(/Result file[^:]*:\s*(\S+)/);
    const resultPath = match![1]!;
    // First write a partial (invalid) JSON, then finish a moment later.
    fs.writeFileSync(resultPath, "{ \"scope\": \"per", "utf8");
    setTimeout(() => {
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          scope: "persona",
          target: "vellumpike",
          faded: 0,
          forgotten: 0,
          consolidated: 0,
        }),
        "utf8",
      );
    }, 30);
  };

  const result = await librarian.run(
    makeSnapshot(),
    {
      paths,
      defaultProject: "pantheon",
      defaultCwd: "/tmp",
      defaultPlatform: "linux",
      spawn: slowSpawn,
      poll_interval_ms: 5,
    },
    { timeout_ms: 2000 },
  );
  expect(result.scope).toBe("persona");
});

test("ConjuredLibrarian: snapshot file is written before spawn fires", async () => {
  const librarian = new ConjuredLibrarian();
  let snapshotPath: string | undefined;
  const fakeSpawn = async (input: LibrarianSpawnInput) => {
    // Extract snapshot path; verify it exists + content matches.
    const snapMatch = input.prompt.match(/Snapshot file[^:]*:\s*(\S+)/);
    expect(snapMatch).toBeTruthy();
    snapshotPath = snapMatch![1]!;
    expect(fs.existsSync(snapshotPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    expect(parsed.scope).toBe("persona");
    expect(parsed.target).toBe("vellumpike");
    expect(parsed.entries).toHaveLength(1);
    // Synthesize result.
    const resultMatch = input.prompt.match(/Result file[^:]*:\s*(\S+)/);
    const resultPath = resultMatch![1]!;
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        scope: "persona",
        target: "vellumpike",
        faded: 0,
        forgotten: 0,
        consolidated: 0,
      }),
      "utf8",
    );
  };

  await librarian.run(
    makeSnapshot(),
    {
      paths,
      defaultProject: "pantheon",
      defaultCwd: "/tmp",
      defaultPlatform: "linux",
      spawn: fakeSpawn,
      poll_interval_ms: 10,
    },
    { timeout_ms: 2000 },
  );
  expect(snapshotPath).toBeDefined();
});
