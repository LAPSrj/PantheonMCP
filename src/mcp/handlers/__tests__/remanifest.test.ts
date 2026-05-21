import { test, expect } from "bun:test";
import { resolveRemanifestTarget } from "../remanifest.ts";

/** Truth table for the remanifest target resolver.
 *
 * Per Leandro 2026-05-21, remanifest ALWAYS opens a new tab in the
 * SAME window as the calling session — split-pane and new-window are
 * not reachable. The three branches differ only in HOW we identify
 * "the same window":
 *
 *   1. Pantheon-spawned: spawn_metadata.window_name (durable named
 *      window from the original summon).
 *   2. WT session without spawn_metadata: "current" → `-w 0` (the
 *      user's most-recently-used WT window; best-effort).
 *   3. Other adapters: mode-only — the adapter picks its own
 *      same-window semantics (tmux session, kitty OS window, etc.).
 *
 * WT_SESSION is used ONLY as a "we're in Windows Terminal" signal —
 * never as a window identifier (it's a per-session GUID, not a
 * window name; passing it to `-w` created a fresh named window each
 * call). */

test("pantheon-spawned: new-tab-here in the named window from spawn_metadata", () => {
  const target = resolveRemanifestTarget(
    { window_name: "pantheon-vellumpike" },
    {} as NodeJS.ProcessEnv,
  );
  expect(target).toEqual({
    window: "pantheon-vellumpike",
    mode: "new-tab-here",
  });
});

test("pantheon-spawned + WT_SESSION present: still uses the named window from spawn_metadata", () => {
  // spawn_metadata wins over WT_SESSION when both are available —
  // the named window is the deterministic signal.
  const target = resolveRemanifestTarget(
    { window_name: "pantheon-vellumpike" },
    { WT_SESSION: "abc-123" } as unknown as NodeJS.ProcessEnv,
  );
  expect(target).toEqual({
    window: "pantheon-vellumpike",
    mode: "new-tab-here",
  });
});

test("manually-started + WT_SESSION set: new tab in CURRENT WT window", () => {
  // Pre-fix this returned `{ window: WT_SESSION_GUID, mode: "new-tab-here" }`,
  // which made wt.exe create a fresh window named after the GUID
  // instead of targeting the user's current window.
  const target = resolveRemanifestTarget(
    null,
    {
      WT_SESSION: "1ce2bbcd-4f5a-4d76-95c1-aaaaaaaaaaaa",
    } as unknown as NodeJS.ProcessEnv,
  );
  expect(target).toEqual({ window: "current", mode: "new-tab-here" });
});

test("manually-started + no WT_SESSION: mode-only new-tab-here fallback", () => {
  const target = resolveRemanifestTarget(null, {} as NodeJS.ProcessEnv);
  expect(target).toEqual({ mode: "new-tab-here" });
  expect(target.window).toBeUndefined();
});

test("spawn_metadata present but window_name missing (defensive) + WT_SESSION: current WT window", () => {
  // Should never happen — window_name is required on SpawnMetadata —
  // but `?.` is in the resolver in case the type widens later.
  const target = resolveRemanifestTarget(
    { window_name: "" } as unknown as Parameters<
      typeof resolveRemanifestTarget
    >[0],
    { WT_SESSION: "fallback-guid" } as unknown as NodeJS.ProcessEnv,
  );
  // Empty window_name is falsy → falls through to WT branch.
  expect(target).toEqual({ window: "current", mode: "new-tab-here" });
});

test("WT_SESSION value is never used as a window identifier (post-fix regression guard)", () => {
  // Pre-fix the resolver passed WT_SESSION verbatim as target.window,
  // which wt.exe treated as a fresh window name. Ensure no branch
  // can produce a window value that equals the WT_SESSION input.
  const wtGuid = "DEAD-BEEF-1234-5678-9ABCDEF01234";
  for (const meta of [null, { window_name: "" }, { window_name: "named" }]) {
    const t = resolveRemanifestTarget(
      meta as unknown as Parameters<typeof resolveRemanifestTarget>[0],
      { WT_SESSION: wtGuid } as unknown as NodeJS.ProcessEnv,
    );
    expect(t.window).not.toBe(wtGuid);
  }
});

test("mode is ALWAYS new-tab-here (never split-pane, new-window, or new-tab-window)", () => {
  // Regression guard for the 2026-05-21 directive: remanifest never
  // opens a new window and never splits a pane. Every branch must
  // resolve to "new-tab-here".
  for (const t of [
    resolveRemanifestTarget({ window_name: "w" }, {} as NodeJS.ProcessEnv),
    resolveRemanifestTarget(null, { WT_SESSION: "x" } as unknown as NodeJS.ProcessEnv),
    resolveRemanifestTarget(null, {} as NodeJS.ProcessEnv),
    resolveRemanifestTarget(
      { window_name: "" } as unknown as Parameters<typeof resolveRemanifestTarget>[0],
      {} as NodeJS.ProcessEnv,
    ),
  ]) {
    expect(t.mode).toBe("new-tab-here");
  }
});
