import { test, expect } from "bun:test";
import {
  renderStore,
  ACTIVE_BUDGET_BYTES,
  CORE_BUDGET_BYTES,
  CORE_HEAD_KEEP,
  CORE_TAIL_KEEP,
} from "../render.ts";
import type { MemoryEntry, MemoryStore } from "../types.ts";

function entry(over: Partial<MemoryEntry> & { id: string; date: string; text: string }): MemoryEntry {
  return {
    summary: over.summary ?? `summary for ${over.id}`,
    status: "active",
    ...over,
  } as MemoryEntry;
}

function store(entries: MemoryEntry[]): MemoryStore {
  return { version: 1, entries };
}

const day = (n: number): string => `2026-04-${String(n).padStart(2, "0")}T00:00:00.000Z`;

// --- empty / forgotten ---

test("renderStore prints first-session message when nothing exists", () => {
  const r = renderStore(store([]));
  expect(r.text).toContain("first session");
  expect(r.warning).toBeNull();
});

test("renderStore omits forgotten entries by default; includes with include_forgotten", () => {
  const e = entry({
    id: "ghost",
    date: day(1),
    text: "x",
    status: "forgotten",
  });
  const noForgotten = renderStore(store([e]));
  expect(noForgotten.text).not.toContain("ghost");

  const withForgotten = renderStore(store([e]), { include_forgotten: true });
  expect(withForgotten.text).toContain("HIDDEN");
  expect(withForgotten.text).toContain("ghost");
});

// --- Active tier 8KB budget ---

test("Active tier renders newest first; oldest collapses past 8KB", () => {
  const big = "x".repeat(3500); // 3 entries × 3.5KB = 10.5KB > 8KB
  const a = entry({ id: "a", date: day(1), text: big });
  const b = entry({ id: "b", date: day(2), text: big });
  const c = entry({ id: "c", date: day(3), text: big });
  const r = renderStore(store([a, b, c]));

  // c (newest) appears in full BEFORE b/a in the rendered text.
  const cIdx = r.text.indexOf("[c]");
  const bIdx = r.text.indexOf("[b]");
  const aIdx = r.text.indexOf("[a]");
  expect(cIdx).toBeLessThan(bIdx);
  expect(bIdx).toBeLessThan(aIdx);

  // c is full text (the body 'xxxxx' appears); a is collapsed.
  expect(r.text).toContain(big.slice(0, 100)); // some xxxxx body present
  expect(r.text).toMatch(/\[a\][\s\S]*?collapsed/);
});

test("Active tier always keeps newest entry full even if oversized", () => {
  const huge = "y".repeat(ACTIVE_BUDGET_BYTES + 1024);
  const e = entry({ id: "huge", date: day(1), text: huge });
  const r = renderStore(store([e]));
  expect(r.text).not.toContain("collapsed");
});

// --- Core tier middle-out ---

test("Core within budget renders all entries full; no warning", () => {
  const small = "z".repeat(500);
  const entries: MemoryEntry[] = [];
  for (let i = 1; i <= 5; i++) {
    entries.push(entry({ id: `c${i}`, date: day(i), text: small, core: true }));
  }
  const r = renderStore(store(entries));
  expect(r.warning).toBeNull();
  for (const e of entries) {
    expect(r.text).toContain(`[${e.id}]`);
    expect(r.text).not.toMatch(new RegExp(`\\[${e.id}\\][\\s\\S]*?collapsed`));
  }
});

test("Core over budget collapses middle entries from center outward; head+tail preserved", () => {
  // 12 core entries × 1.5KB = 18KB > 10KB.
  // head_keep=2, tail_keep=4 → middle indices 2..7 (6 entries).
  const body = "m".repeat(1500);
  const entries: MemoryEntry[] = [];
  for (let i = 1; i <= 12; i++) {
    entries.push(entry({ id: `c${i}`, date: day(i), text: body, core: true }));
  }
  const r = renderStore(store(entries));

  // Head (oldest 2) full.
  expect(r.text).toMatch(/\[c1\][\s\S]*?mmm/);
  expect(r.text).toMatch(/\[c2\][\s\S]*?mmm/);
  // Tail (newest 4 = c9..c12) full.
  for (const id of ["c9", "c10", "c11", "c12"]) {
    expect(r.text).toMatch(new RegExp(`\\[${id}\\][\\s\\S]*?mmm`));
  }
  // At least one middle (c3..c8) collapsed.
  const middle = ["c3", "c4", "c5", "c6", "c7", "c8"];
  const collapsed = middle.filter((id) =>
    new RegExp(`\\[${id}\\][\\s\\S]*?collapsed`).test(r.text),
  );
  expect(collapsed.length).toBeGreaterThan(0);
  // Loud warning surfaced.
  expect(r.warning).toContain("collapsed to summary");
});

test("Core: with fewer than head+tail entries, nothing is collapsed even over budget", () => {
  // head 2 + tail 4 = 6; here we have 5 entries each big, so middleEnd <= middleStart.
  const huge = "h".repeat(3000);
  const entries: MemoryEntry[] = [];
  for (let i = 1; i <= 5; i++) {
    entries.push(entry({ id: `c${i}`, date: day(i), text: huge, core: true }));
  }
  const r = renderStore(store(entries));
  for (const e of entries) {
    // No "collapsed" marker for any of them.
    expect(r.text).not.toMatch(new RegExp(`\\[${e.id}\\][\\s\\S]*?collapsed`));
  }
  // Warning still surfaces because we're over budget.
  expect(r.warning).toContain("exceeds 10 KB cap");
});

// --- status NEVER auto-mutates from render ---

test("renderStore does not mutate entry status under any tier", () => {
  const big = "x".repeat(5000);
  const e1 = entry({ id: "e1", date: day(1), text: big });
  const e2 = entry({ id: "e2", date: day(2), text: big });
  const initial = JSON.stringify([e1, e2]);
  renderStore(store([e1, e2]));
  expect(JSON.stringify([e1, e2])).toBe(initial);
});

// --- Index ordering ---

test("Index synopsis (faded non-core) is sorted newest first", () => {
  const e1 = entry({ id: "old", date: day(1), text: "x", status: "faded" });
  const e2 = entry({ id: "mid", date: day(5), text: "x", status: "faded" });
  const e3 = entry({ id: "new", date: day(10), text: "x", status: "faded" });
  const r = renderStore(store([e1, e2, e3]));
  const idxNew = r.text.indexOf("[new]");
  const idxMid = r.text.indexOf("[mid]");
  const idxOld = r.text.indexOf("[old]");
  expect(idxNew).toBeLessThan(idxMid);
  expect(idxMid).toBeLessThan(idxOld);
});

test("Index footer surfaces when faded list exceeds threshold", () => {
  const entries: MemoryEntry[] = [];
  for (let i = 1; i <= 60; i++) {
    entries.push(entry({ id: `f${i}`, date: day((i % 28) + 1), text: "x", status: "faded" }));
  }
  const r = renderStore(store(entries));
  expect(r.text).toContain("+10 more");
  expect(r.text).toContain("list_memory");
});

// --- Sanity on constants ---

test("budgets exported match §4 settled values", () => {
  expect(ACTIVE_BUDGET_BYTES).toBe(8192);
  expect(CORE_BUDGET_BYTES).toBe(10240);
  expect(CORE_HEAD_KEEP).toBe(2);
  expect(CORE_TAIL_KEEP).toBe(4);
});
