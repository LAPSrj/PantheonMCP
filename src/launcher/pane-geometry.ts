/** §11a / split-pane geometry policy.
 *
 * Tracks per-tab pane layout and decides where the next split lands
 * so multi-pane summons grow into a balanced grid instead of
 * column-narrowing all the way out.
 *
 * **Unified rule** (Leandro-confirmed sequence n=1..9 grows
 * [1] → [1,1] → [2,1] → [2,2] → [2,2,1] → [2,2,2] → [3,2,2] →
 * [3,3,2] → [3,3,3]; n=10+ continues by adding a 4th row to the
 * leftmost-smallest column):
 *
 *   Add a new COLUMN if `cols < 3` AND every existing column has
 *   `row_count >= cols` (the layout is a balanced rectangle wanting
 *   to grow wider). Otherwise add a ROW to the leftmost column with
 *   the smallest row count.
 *
 * The decision returns BOTH:
 *   - which pane (by wt pane index) to focus before the split, AND
 *   - the split direction (V for new column / H for new row).
 *
 * The wt adapter emits `focus-pane -t <id> ; split-pane -V|-H ; ...`
 * to land on the right target.
 *
 * **Tree-structured panes vs grid**: WT's pane model is a binary
 * tree, not a grid, so a "new column" at n=4→5 is implemented by
 * focusing the TOP pane of the rightmost column and splitting `-V`
 * (carving the new column out of the right half of that pane). The
 * geometry tracker reflects that one-pane half-narrowing as a fresh
 * column with row_count=1; the affected top pane stays in its
 * original column. */

/** wt.exe assigns pane indices in creation order. We track them in
 * column/row position so the next split can target the right one. */
export type PaneId = number;

/** Per-tab geometry state persisted in the window registry.
 *
 * `columns` is column-major: `columns[c][r]` is the wt pane index
 * at column `c`, row `r` (0-based, top-to-bottom). The first pane in
 * a fresh tab is index 0; subsequent splits increment.
 *
 * `next_pane_id` is the index wt.exe will assign on the next split.
 * Always equal to the flattened pane count today, but tracked
 * explicitly so future external-pane events (manual `wt focus-pane`
 * after a user split) can be reconciled without mis-numbering. */
export interface TabGeometry {
  columns: PaneId[][];
  next_pane_id: number;
}

/** Decision returned by `decideNextSplit` — describes which pane to
 * focus before the split and which direction the split goes. */
export interface SplitDecision {
  /** Side-by-side new column ('V') or stacked new row ('H'). */
  direction: "V" | "H";
  /** wt.exe pane index to `focus-pane -t <id>` before split-pane. */
  target_pane_id: PaneId;
  /** Column index that will gain a pane (existing or new). */
  target_col: number;
  /** Row index within `target_col` after the split lands. New
   * columns: 0. New rows: previous row_count of that column. */
  target_row: number;
  /** Diagnostic: human-readable reason. */
  reason: string;
}

/** Empty tab — the very first spawn into a brand-new wt tab.
 * Returned by `freshTab()`; callers persist it as the tab's initial
 * state. The first pane (index 0) is created BY wt when the tab
 * opens, NOT by a split-pane subcommand, so `freshTab()` already
 * contains it. */
export function freshTab(): TabGeometry {
  return { columns: [[0]], next_pane_id: 1 };
}

/** Pure-logic decision — given a tab's current columns, where does
 * the next pane go? Implements the unified rule documented at the
 * top of this file. */
export function decideNextSplit(geometry: TabGeometry): SplitDecision {
  const cols = geometry.columns.length;
  const rowCounts = geometry.columns.map((c) => c.length);
  const allRowsAtLeastCols = rowCounts.every((r) => r >= cols);

  if (cols < 3 && allRowsAtLeastCols) {
    // Add a new COLUMN. Focus the TOP pane of the rightmost column
    // and split `-V` so wt carves the new column out of its right half.
    const targetCol = cols - 1;
    const topPaneId = geometry.columns[targetCol]![0]!;
    return {
      direction: "V",
      target_pane_id: topPaneId,
      target_col: cols, // new column index will be cols (after append)
      target_row: 0,
      reason: `add column (cols=${cols} < 3, all rows >= cols)`,
    };
  }

  // Add a ROW to the leftmost column with the smallest row count.
  let minRows = rowCounts[0]!;
  let targetCol = 0;
  for (let i = 1; i < rowCounts.length; i++) {
    if (rowCounts[i]! < minRows) {
      minRows = rowCounts[i]!;
      targetCol = i;
    }
  }
  // Focus the BOTTOM pane of that column; `split-pane -H` stacks the
  // new pane below it.
  const col = geometry.columns[targetCol]!;
  const bottomPaneId = col[col.length - 1]!;
  return {
    direction: "H",
    target_pane_id: bottomPaneId,
    target_col: targetCol,
    target_row: col.length, // appending below current bottom
    reason: `add row to col ${targetCol} (smallest row_count=${minRows})`,
  };
}

/** Apply a decision to the geometry. Caller persists the result
 * after a successful split. New pane gets `geometry.next_pane_id`. */
export function applyDecision(
  geometry: TabGeometry,
  decision: SplitDecision,
): TabGeometry {
  const newId = geometry.next_pane_id;
  if (decision.direction === "V") {
    return {
      columns: [...geometry.columns, [newId]],
      next_pane_id: newId + 1,
    };
  }
  // Append to the target column.
  return {
    columns: geometry.columns.map((col, i) =>
      i === decision.target_col ? [...col, newId] : col,
    ),
    next_pane_id: newId + 1,
  };
}

/** Total pane count in the tab. Convenience for diagnostics + the
 * older `existing_pane_count` API surface. */
export function paneCount(geometry: TabGeometry): number {
  let n = 0;
  for (const c of geometry.columns) n += c.length;
  return n;
}

/** Compact `[2,2,1]`-style row-count summary. Used in window-registry
 * descriptions and split logs. */
export function shape(geometry: TabGeometry): number[] {
  return geometry.columns.map((c) => c.length);
}
