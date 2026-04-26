import { test, expect } from "bun:test";
import { TombstoneMap } from "../tombstones.ts";

test("add → get returns the tombstone within TTL", () => {
  let now = 0;
  const t = new TombstoneMap({ ttl_ms: 1000, clock: () => now });
  t.add("ghost", "agent-1");
  now = 500;
  const got = t.get("ghost");
  expect(got).not.toBeNull();
  expect(got?.username).toBe("ghost");
  expect(got?.prior_agent_id).toBe("agent-1");
});

test("get returns null after TTL elapses", () => {
  let now = 0;
  const t = new TombstoneMap({ ttl_ms: 1000, clock: () => now });
  t.add("ghost", "agent-1");
  now = 1001;
  expect(t.get("ghost")).toBeNull();
});

test("get is case-insensitive on the handle lookup", () => {
  let now = 0;
  const t = new TombstoneMap({ ttl_ms: 1000, clock: () => now });
  t.add("Vellumpike", "a-1");
  expect(t.get("vellumpike")).not.toBeNull();
  expect(t.get("VELLUMPIKE")).not.toBeNull();
});

test("delete removes a tombstone", () => {
  const t = new TombstoneMap({ ttl_ms: 1000 });
  t.add("ghost", "a-1");
  t.delete("ghost");
  expect(t.get("ghost")).toBeNull();
});

test("prune sweeps expired entries and reports count", () => {
  let now = 0;
  const t = new TombstoneMap({ ttl_ms: 1000, clock: () => now });
  t.add("a", "x");
  t.add("b", "y");
  now = 500;
  t.add("c", "z");
  now = 1100;
  // a, b expired; c still valid (vacated at 500, TTL 1000, now 1100 → 600 elapsed).
  expect(t.prune()).toBe(2);
  expect(t.size()).toBe(1);
  expect(t.get("c")).not.toBeNull();
});
