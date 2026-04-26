import { test, expect } from "bun:test";
import {
  freshTab,
  decideNextSplit,
  applyDecision,
  shape,
  paneCount,
  type TabGeometry,
} from "../pane-geometry.ts";

/** Drive `n` splits forward from a fresh tab and capture the
 * shape after each. Returns the array of [row counts] per pane count. */
function evolveTo(n: number): number[][] {
  let g: TabGeometry = freshTab();
  const states: number[][] = [shape(g)];
  for (let i = 0; i < n - 1; i++) {
    const d = decideNextSplit(g);
    g = applyDecision(g, d);
    states.push(shape(g));
  }
  return states;
}

test("freshTab() seeds the implicit pane 0 and next_pane_id=1", () => {
  const g = freshTab();
  expect(g.columns).toEqual([[0]]);
  expect(g.next_pane_id).toBe(1);
  expect(paneCount(g)).toBe(1);
});

test("Leandro-confirmed sequence n=1..9 grows [1] → [1,1] → [2,1] → [2,2] → [2,2,1] → [2,2,2] → [3,2,2] → [3,3,2] → [3,3,3]", () => {
  const states = evolveTo(9);
  expect(states).toEqual([
    [1],
    [1, 1],
    [2, 1],
    [2, 2],
    [2, 2, 1],
    [2, 2, 2],
    [3, 2, 2],
    [3, 3, 2],
    [3, 3, 3],
  ]);
});

test("n=10..12 continues by adding rows to leftmost-smallest column", () => {
  const states = evolveTo(12);
  expect(states[9]).toEqual([4, 3, 3]);
  expect(states[10]).toEqual([4, 4, 3]);
  expect(states[11]).toEqual([4, 4, 4]);
});

test("never grows beyond 3 columns even at high pane counts", () => {
  const states = evolveTo(20);
  for (const s of states) {
    expect(s.length).toBeLessThanOrEqual(3);
  }
});

test("n=2 (first split): direction V, focus pane 0, new column", () => {
  const g = freshTab();
  const d = decideNextSplit(g);
  expect(d.direction).toBe("V");
  expect(d.target_pane_id).toBe(0);
  expect(d.target_col).toBe(1);
  expect(d.target_row).toBe(0);
  expect(d.reason).toContain("add column");
});

test("n=3 (after [1,1]): direction H, focus bottom of col 0 (pane 0)", () => {
  let g = freshTab(); // [1]
  g = applyDecision(g, decideNextSplit(g)); // [1,1]
  const d = decideNextSplit(g);
  expect(d.direction).toBe("H");
  expect(d.target_col).toBe(0);
  expect(d.target_pane_id).toBe(0); // bottom of col 0 is pane 0
  expect(d.target_row).toBe(1);
  expect(d.reason).toContain("add row");
});

test("n=5 (after [2,2]): direction V, focus TOP of rightmost column", () => {
  let g = freshTab();
  for (let i = 0; i < 3; i++) g = applyDecision(g, decideNextSplit(g));
  expect(shape(g)).toEqual([2, 2]);
  const d = decideNextSplit(g);
  expect(d.direction).toBe("V");
  expect(d.target_col).toBe(2);
  // Top pane of rightmost (col 1) — that pane's index follows the
  // creation order: 0 (initial), 1 (col 1 top), 2 (col 0 row 1), 3 (col 1 row 1).
  expect(d.target_pane_id).toBe(1);
});

test("pane index assignment follows wt creation order across the full sequence", () => {
  let g = freshTab();
  // After every decision/apply, the new pane gets the next id.
  const newPaneIds: number[] = [];
  for (let i = 0; i < 8; i++) {
    const d = decideNextSplit(g);
    const newId = g.next_pane_id;
    g = applyDecision(g, d);
    newPaneIds.push(newId);
  }
  expect(newPaneIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  // After 8 splits we have 9 panes total.
  expect(paneCount(g)).toBe(9);
});

test("targets the LEFTMOST column when multiple columns tie for smallest row count", () => {
  // At [2,2,2] (n=6), all columns tied — should target col 0.
  let g = freshTab();
  for (let i = 0; i < 5; i++) g = applyDecision(g, decideNextSplit(g));
  expect(shape(g)).toEqual([2, 2, 2]);
  const d = decideNextSplit(g);
  expect(d.target_col).toBe(0);
  expect(d.direction).toBe("H");
});

test("at n=9 [3,3,3] the next add stays at 3 columns and grows row 4 in col 0", () => {
  let g = freshTab();
  for (let i = 0; i < 8; i++) g = applyDecision(g, decideNextSplit(g));
  expect(shape(g)).toEqual([3, 3, 3]);
  const d = decideNextSplit(g);
  // cols=3 → cols<3 fails → add row, not column.
  expect(d.direction).toBe("H");
  expect(d.target_col).toBe(0);
});

test("applyDecision (V) appends a new column with one pane", () => {
  const g = freshTab();
  const d = decideNextSplit(g);
  const next = applyDecision(g, d);
  expect(next.columns).toEqual([[0], [1]]);
  expect(next.next_pane_id).toBe(2);
});

test("applyDecision (H) inserts a pane at the bottom of the target column", () => {
  let g = freshTab(); // [1]
  g = applyDecision(g, decideNextSplit(g)); // [1,1]
  const d = decideNextSplit(g); // → add row to col 0
  const next = applyDecision(g, d);
  expect(next.columns).toEqual([[0, 2], [1]]);
  expect(next.next_pane_id).toBe(3);
});
