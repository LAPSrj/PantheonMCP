import { test, expect } from "bun:test";
import {
  DEFAULT_CONTEXT_THRESHOLDS,
  detectWindowFromModel,
  parseThresholdsFromEnv,
  renderThresholdMessage,
  selectThreshold,
  shouldResetFired,
} from "../context-thresholds.ts";

test("parseThresholdsFromEnv: unset → defaults (3-step ladder)", () => {
  expect(parseThresholdsFromEnv({})).toEqual(DEFAULT_CONTEXT_THRESHOLDS);
});

test("parseThresholdsFromEnv: blank → defaults", () => {
  expect(parseThresholdsFromEnv({ PANTHEON_CONTEXT_THRESHOLDS: "  " })).toEqual(
    DEFAULT_CONTEXT_THRESHOLDS,
  );
});

test("parseThresholdsFromEnv: parses fractions + :block, sorts ascending", () => {
  const r = parseThresholdsFromEnv({
    PANTHEON_CONTEXT_THRESHOLDS: "0.85,0.50,0.70:block",
  });
  expect(r).toEqual([
    { fraction: 0.5, block: false },
    { fraction: 0.7, block: true },
    { fraction: 0.85, block: false },
  ]);
});

test("parseThresholdsFromEnv: invalid entries are dropped, valid kept", () => {
  const r = parseThresholdsFromEnv({
    PANTHEON_CONTEXT_THRESHOLDS: "0.5,abc,2.0,0.8:block",
  });
  expect(r).toEqual([
    { fraction: 0.5, block: false },
    { fraction: 0.8, block: true },
  ]);
});

test("parseThresholdsFromEnv: all-invalid → defaults", () => {
  const r = parseThresholdsFromEnv({
    PANTHEON_CONTEXT_THRESHOLDS: "abc,2.0,-1",
  });
  expect(r).toEqual(DEFAULT_CONTEXT_THRESHOLDS);
});

test("detectWindowFromModel: [1m] suffix → 1M", () => {
  expect(detectWindowFromModel("claude-opus-4-7[1m]")).toBe(1_000_000);
  expect(detectWindowFromModel("Claude-Sonnet-4-6[1M]")).toBe(1_000_000);
});

test("detectWindowFromModel: regular id → 200k", () => {
  expect(detectWindowFromModel("claude-opus-4-7")).toBe(200_000);
  expect(detectWindowFromModel("anything")).toBe(200_000);
});

test("detectWindowFromModel: undefined model + override → override", () => {
  expect(detectWindowFromModel(undefined, "500000")).toBe(500_000);
});

test("detectWindowFromModel: nothing → null", () => {
  expect(detectWindowFromModel(undefined)).toBeNull();
  expect(detectWindowFromModel(undefined, "abc")).toBeNull();
});

test("selectThreshold: nothing fired, fraction below all → null", () => {
  const r = selectThreshold(DEFAULT_CONTEXT_THRESHOLDS, 0.3, []);
  expect(r).toBeNull();
});

test("selectThreshold: fraction above 0.7 not yet fired → 0.7", () => {
  const r = selectThreshold(DEFAULT_CONTEXT_THRESHOLDS, 0.72, []);
  expect(r).toEqual({ fraction: 0.7, block: false });
});

test("selectThreshold: 0.5 already fired, fraction past 0.7 → 0.7", () => {
  const r = selectThreshold(DEFAULT_CONTEXT_THRESHOLDS, 0.72, [0.5]);
  expect(r).toEqual({ fraction: 0.7, block: false });
});

test("selectThreshold: highest matching threshold wins (climb past two at once)", () => {
  const r = selectThreshold(DEFAULT_CONTEXT_THRESHOLDS, 0.9, []);
  expect(r).toEqual({ fraction: 0.85, block: false });
});

test("selectThreshold: every step fired, fraction at 0.95 → null (no new)", () => {
  const r = selectThreshold(DEFAULT_CONTEXT_THRESHOLDS, 0.95, [0.5, 0.7, 0.85]);
  expect(r).toBeNull();
});

test("shouldResetFired: empty fired → false", () => {
  expect(shouldResetFired(0.1, [])).toBe(false);
});

test("shouldResetFired: fraction dropped below lowest fired → true", () => {
  expect(shouldResetFired(0.4, [0.5, 0.7])).toBe(true);
});

test("shouldResetFired: fraction still above lowest fired → false", () => {
  expect(shouldResetFired(0.6, [0.5, 0.7])).toBe(false);
});

test("renderThresholdMessage: non-block renders additionalContext + systemMessage", () => {
  const msg = renderThresholdMessage(
    { fraction: 0.7, block: false },
    0.72,
    144_000,
    200_000,
  );
  expect(msg.additionalContext).toContain("[pantheon]");
  expect(msg.additionalContext).toContain("72%");
  expect(msg.additionalContext).toContain("mcp__pantheon__append_memory");
  expect(msg.blockReason).toBeUndefined();
  expect(msg.systemMessage).toContain("pantheon:");
});

test("renderThresholdMessage: block renders blockReason, no additionalContext", () => {
  const msg = renderThresholdMessage(
    { fraction: 0.85, block: true },
    0.86,
    172_000,
    200_000,
  );
  expect(msg.blockReason).toContain("STOP");
  expect(msg.blockReason).toContain("mcp__pantheon__rest");
  expect(msg.blockReason).toContain("86%");
  expect(msg.additionalContext).toBeUndefined();
});
