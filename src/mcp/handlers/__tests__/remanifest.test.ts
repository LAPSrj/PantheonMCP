import { test, expect } from "bun:test";
import { resolveRemanifestTarget } from "../remanifest.ts";

/** Truth table for the remanifest target resolver. The asymmetry
 * matters: pantheon-spawned sessions split-pane in their named
 * window; manually-started WT sessions get a new tab in the user's
 * current WT window via WT_SESSION; everything else falls through to
 * mode-only new-tab-here. */

test("pantheon-spawned + inherit_pane: split-pane in the named window from spawn_metadata", () => {
  const target = resolveRemanifestTarget(
    true,
    { window_name: "pantheon-vellumpike" },
    {} as NodeJS.ProcessEnv,
  );
  expect(target).toEqual({
    window: "pantheon-vellumpike",
    mode: "split-pane",
  });
});

test("pantheon-spawned + inherit_pane=false: falls through to WT_SESSION when set", () => {
  const target = resolveRemanifestTarget(
    false,
    { window_name: "pantheon-vellumpike" },
    { WT_SESSION: "abc-123" } as unknown as NodeJS.ProcessEnv,
  );
  expect(target).toEqual({ window: "abc-123", mode: "new-tab-here" });
});

test("manually-started + WT_SESSION set: new tab in that WT window", () => {
  const target = resolveRemanifestTarget(
    true,
    null,
    {
      WT_SESSION: "1ce2bbcd-4f5a-4d76-95c1-aaaaaaaaaaaa",
    } as unknown as NodeJS.ProcessEnv,
  );
  expect(target).toEqual({
    window: "1ce2bbcd-4f5a-4d76-95c1-aaaaaaaaaaaa",
    mode: "new-tab-here",
  });
});

test("manually-started + no WT_SESSION: mode-only new-tab-here fallback", () => {
  const target = resolveRemanifestTarget(true, null, {} as NodeJS.ProcessEnv);
  expect(target).toEqual({ mode: "new-tab-here" });
  expect(target.window).toBeUndefined();
});

test("spawn_metadata present but window_name missing (defensive): WT_SESSION wins", () => {
  // Should never happen — window_name is required on SpawnMetadata —
  // but `?.` is in the resolver in case the type widens later.
  const target = resolveRemanifestTarget(
    true,
    { window_name: "" } as unknown as Parameters<
      typeof resolveRemanifestTarget
    >[1],
    { WT_SESSION: "fallback-guid" } as unknown as NodeJS.ProcessEnv,
  );
  // Empty window_name is falsy → falls through to WT_SESSION.
  expect(target).toEqual({ window: "fallback-guid", mode: "new-tab-here" });
});

test("mode value is always a valid SpawnMode enum entry (never 'new-tab')", () => {
  const validModes = new Set(["new-window", "new-tab-here", "new-tab-window", "split-pane"]);
  // Spot-check the three branches.
  for (const t of [
    resolveRemanifestTarget(true, { window_name: "w" }, {} as NodeJS.ProcessEnv),
    resolveRemanifestTarget(true, null, { WT_SESSION: "x" } as unknown as NodeJS.ProcessEnv),
    resolveRemanifestTarget(true, null, {} as NodeJS.ProcessEnv),
  ]) {
    expect(validModes.has(t.mode)).toBe(true);
  }
});
