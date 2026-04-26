import { test, expect } from "bun:test";
import {
  computePressure,
  isSaveTool,
  pressureHint,
  resolveThresholds,
  type PressureState,
} from "../context-pressure.ts";

function state(over: Partial<PressureState> = {}): PressureState {
  return {
    toolCallsSinceLastSave: 0,
    lastSaveAt: Date.now(),
    ...over,
  };
}

test("isSaveTool covers every memory-write tool", () => {
  for (const t of ["append_memory", "update_memory", "set_memory", "snapshot_memory", "rest"]) {
    expect(isSaveTool(t)).toBe(true);
  }
  for (const t of ["whoami", "send_message", "list_agents", "summon", "fade_memory"]) {
    expect(isSaveTool(t)).toBe(false);
  }
});

test("computePressure: low when both signals are well under thresholds", () => {
  expect(computePressure(state({ toolCallsSinceLastSave: 0 }))).toBe("low");
  expect(computePressure(state({ toolCallsSinceLastSave: 10 }))).toBe("low");
});

test("computePressure: tool-call thresholds raise the level", () => {
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

test("computePressure: takes the higher of the two signals", () => {
  const t = resolveThresholds();
  // High tool count, recent save → tool-count wins.
  expect(
    computePressure(state({ toolCallsSinceLastSave: t.save_tools, lastSaveAt: Date.now() })),
  ).toBe("save_now");
  // Low tool count, very old save → time wins.
  expect(
    computePressure(
      state({ toolCallsSinceLastSave: 0, lastSaveAt: Date.now() - (t.save_minutes + 10) * 60_000 }),
    ),
  ).toBe("save_now");
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
    expect(computePressure(state({ toolCallsSinceLastSave: 5 }))).toBe("soft_hint");
  } finally {
    if (prev === undefined) delete process.env.PANTHEON_PRESSURE_SOFT_TOOLS;
    else process.env.PANTHEON_PRESSURE_SOFT_TOOLS = prev;
  }
});
