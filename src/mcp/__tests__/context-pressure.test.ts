import { test, expect } from "bun:test";
import {
  computePressure,
  isSaveTool,
  pressureHint,
  resolveThresholds,
  type PressureState,
} from "../context-pressure.ts";

/** Build a state whose lastSaveAt is far enough in the past to clear
 * the 30-minute freshness floor. Tests that specifically exercise the
 * floor should pass an explicit `lastSaveAt`. */
function state(over: Partial<PressureState> = {}): PressureState {
  return {
    toolCallsSinceLastSave: 0,
    lastSaveAt: Date.now() - 60 * 60_000, // 60 min ago — past the 30-min floor
    ...over,
  };
}

test("isSaveTool covers every memory-write tool", () => {
  for (const t of [
    "append_memory",
    "update_memory",
    "set_memory",
    "snapshot_memory",
    "append_project_memory",
    "append_project_memory_any",
    "update_project_memory",
    "update_project_memory_any",
    "notebook_write_page",
    "project_notebook_write_page",
    "project_notebook_write_page_any",
    "rest",
  ]) {
    expect(isSaveTool(t)).toBe(true);
  }
  for (const t of [
    "whoami",
    "send_message",
    "list_agents",
    "summon",
    "fade_memory",
    "forget_memory",
    "fade_project_memory",
    "forget_project_memory",
    "notebook_delete_page",
    "notebook_restore_page",
  ]) {
    expect(isSaveTool(t)).toBe(false);
  }
});

test("computePressure: low when both signals are well under thresholds", () => {
  expect(computePressure(state({ toolCallsSinceLastSave: 0 }))).toBe("low");
  expect(computePressure(state({ toolCallsSinceLastSave: 10 }))).toBe("low");
});

test("computePressure: tool-call thresholds raise the level (past freshness floor)", () => {
  const t = resolveThresholds();
  expect(
    computePressure(state({ toolCallsSinceLastSave: t.soft_tools })),
  ).toBe("soft_hint");
  expect(
    computePressure(state({ toolCallsSinceLastSave: t.strong_tools })),
  ).toBe("strong_nudge");
  expect(
    computePressure(state({ toolCallsSinceLastSave: t.save_tools })),
  ).toBe("save_now");
});

test("computePressure: time-since-save thresholds raise the level independently", () => {
  const t = resolveThresholds();
  const now = Date.now();
  expect(
    computePressure(state({ lastSaveAt: now - (t.soft_minutes + 1) * 60_000 }), now),
  ).toBe("soft_hint");
  expect(
    computePressure(state({ lastSaveAt: now - (t.strong_minutes + 1) * 60_000 }), now),
  ).toBe("strong_nudge");
  expect(
    computePressure(state({ lastSaveAt: now - (t.save_minutes + 1) * 60_000 }), now),
  ).toBe("save_now");
});

test("computePressure: takes the higher of the two signals (past freshness floor)", () => {
  const t = resolveThresholds();
  // High tool count, save just past the floor → tool-count wins.
  const justPastFloor = Date.now() - (t.freshness_floor_minutes + 1) * 60_000;
  expect(
    computePressure(
      state({ toolCallsSinceLastSave: t.save_tools, lastSaveAt: justPastFloor }),
    ),
  ).toBe("save_now");
  // Low tool count, very old save → time wins.
  expect(
    computePressure(
      state({
        toolCallsSinceLastSave: 0,
        lastSaveAt: Date.now() - (t.save_minutes + 10) * 60_000,
      }),
    ),
  ).toBe("save_now");
});

// --- freshness floor ------------------------------------------------ //

test("computePressure: freshness floor suppresses ALL tiers when save is recent, regardless of tool count", () => {
  const t = resolveThresholds();
  const now = Date.now();
  const recentSave = now - 5 * 60_000; // 5 minutes ago — well under 30-min floor
  // Even at save_tools count, recent save → low.
  expect(
    computePressure(
      { toolCallsSinceLastSave: t.save_tools, lastSaveAt: recentSave },
      now,
    ),
  ).toBe("low");
  // At strong_tools too.
  expect(
    computePressure(
      { toolCallsSinceLastSave: t.strong_tools, lastSaveAt: recentSave },
      now,
    ),
  ).toBe("low");
  // And right at the floor boundary (29 min ago) — still floored.
  expect(
    computePressure(
      {
        toolCallsSinceLastSave: t.save_tools,
        lastSaveAt: now - 29 * 60_000,
      },
      now,
    ),
  ).toBe("low");
});

test("computePressure: just past the floor (31 min), tool-count signal fires normally", () => {
  const t = resolveThresholds();
  const now = Date.now();
  expect(
    computePressure(
      {
        toolCallsSinceLastSave: t.soft_tools,
        lastSaveAt: now - (t.freshness_floor_minutes + 1) * 60_000,
      },
      now,
    ),
  ).toBe("soft_hint");
});

test("pressureHint: low returns null", () => {
  expect(pressureHint("low", state())).toBeNull();
});

test("pressureHint: each level produces a distinctive escalating message", () => {
  const t = resolveThresholds();
  const soft = pressureHint("soft_hint", state({ toolCallsSinceLastSave: t.soft_tools }));
  const strong = pressureHint("strong_nudge", state({ toolCallsSinceLastSave: t.strong_tools }));
  const saveNow = pressureHint("save_now", state({ toolCallsSinceLastSave: t.save_tools }));
  expect(soft).toContain("soft hint");
  expect(soft).toContain("not urgent");
  expect(strong).toContain("STRONG NUDGE");
  expect(strong).toContain("Save state now");
  expect(saveNow).toContain("SAVE NOW");
  expect(saveNow).toContain("handoff");
});

test("env-overridden thresholds apply", () => {
  const prev = process.env.PANTHEON_PRESSURE_SOFT_TOOLS;
  process.env.PANTHEON_PRESSURE_SOFT_TOOLS = "5";
  try {
    expect(resolveThresholds().soft_tools).toBe(5);
    expect(
      computePressure(state({ toolCallsSinceLastSave: 5 })),
    ).toBe("soft_hint");
  } finally {
    if (prev === undefined) delete process.env.PANTHEON_PRESSURE_SOFT_TOOLS;
    else process.env.PANTHEON_PRESSURE_SOFT_TOOLS = prev;
  }
});

test("env-overridden freshness floor applies (0 disables the floor)", () => {
  const prev = process.env.PANTHEON_PRESSURE_FRESHNESS_FLOOR_MIN;
  process.env.PANTHEON_PRESSURE_FRESHNESS_FLOOR_MIN = "0";
  try {
    expect(resolveThresholds().freshness_floor_minutes).toBe(0);
    // With floor disabled, save_tools count fires immediately regardless of recency.
    const t = resolveThresholds();
    expect(
      computePressure({
        toolCallsSinceLastSave: t.save_tools,
        lastSaveAt: Date.now(),
      }),
    ).toBe("save_now");
  } finally {
    if (prev === undefined) {
      delete process.env.PANTHEON_PRESSURE_FRESHNESS_FLOOR_MIN;
    } else {
      process.env.PANTHEON_PRESSURE_FRESHNESS_FLOOR_MIN = prev;
    }
  }
});
