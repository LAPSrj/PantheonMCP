import { mutateJsonAtomic, readJson, type Paths } from "../storage/index.ts";
import {
  applyDecision,
  decideNextSplit,
  freshTab,
  paneCount,
  type SplitDecision,
  type TabGeometry,
} from "./pane-geometry.ts";

/** Per-window record. `tabCount` is best-effort — the user can close
 * tabs externally; on next spawn the registry reconciles by appending
 * to history without trusting the count.
 *
 * `geometryByTab` stores per-tab `TabGeometry` (column-major pane
 * indices) so the wt adapter's default-split policy can decide BOTH
 * direction and which pane to focus before the split. Replaces the
 * older `panesByTab: Record<number, number>` (which only knew counts,
 * not positions). `panesByTab` is computed on the fly from
 * `geometryByTab` for any callers still asking. Same best-effort
 * caveat: panes closed via the user's mouse aren't visible to
 * pantheon — registry can drift. Document and accept; this isn't a
 * window-server. */
export interface WindowRecord {
  tabCount: number;
  tabSpawnHistory: TabSpawn[];
  /** column-major pane geometry per tab_index. */
  geometryByTab?: Record<number, TabGeometry>;
}

export interface TabSpawn {
  /** ms timestamp. */
  when: number;
  summoner: string | null;
  persona: string;
  /** 0-based; populated when the spawn target chose split-pane and we
   * need to know which tab was split. Optional otherwise. */
  tab_index?: number;
}

export interface WindowRegistry {
  version: 1;
  windows: Record<string, WindowRecord>;
}

function emptyRegistry(): WindowRegistry {
  return { version: 1, windows: {} };
}

export function loadRegistry(paths: Paths): WindowRegistry {
  return readJson<WindowRegistry>(paths.windowsRegistryPath) ?? emptyRegistry();
}

/** Append a spawn record to a window's history. Idempotency is not
 * possible here (spawns are real events); concurrent writes go through
 * `mutateJsonAtomic`'s fingerprint guard.
 *
 * `mode` drives the per-tab geometry bookkeeping:
 *   - `"new-tab"` / `"new-window"` → seed a fresh `TabGeometry` for the
 *     tab (single implicit pane, index 0).
 *   - `"split-pane"` → apply `decision` to the existing tab's geometry,
 *     extending columns/rows per the policy.
 *
 * `decision` is the resolved `SplitDecision` (target_pane_id +
 * direction) that the wt adapter actually emitted. The spawn handler
 * computes it via `decideNextSplit(currentGeometry)` BEFORE invoking
 * the adapter, so the registry can persist the post-split state
 * deterministically. Pass `decision: null` for non-split spawns. */
export function recordSpawn(
  paths: Paths,
  windowName: string,
  spawn: Omit<TabSpawn, "when"> & {
    when?: number;
    mode?: "split-pane" | "new-tab" | "new-window";
    decision?: SplitDecision | null;
  },
): WindowRecord {
  let updated!: WindowRecord;
  mutateJsonAtomic<WindowRegistry>(paths.windowsRegistryPath, (current) => {
    const reg = current ?? emptyRegistry();
    const prev = reg.windows[windowName] ?? {
      tabCount: 0,
      tabSpawnHistory: [],
      geometryByTab: {},
    };
    const entry: TabSpawn = {
      when: spawn.when ?? Date.now(),
      summoner: spawn.summoner,
      persona: spawn.persona,
      ...(spawn.tab_index !== undefined ? { tab_index: spawn.tab_index } : {}),
    };
    const tabIndex = spawn.tab_index ?? 0;
    const geometryByTab = { ...(prev.geometryByTab ?? {}) };
    if (spawn.mode === "split-pane") {
      const current = geometryByTab[tabIndex] ?? freshTab();
      const decision = spawn.decision ?? decideNextSplit(current);
      geometryByTab[tabIndex] = applyDecision(current, decision);
    } else {
      // new-tab / new-window seed a fresh single-pane tab.
      geometryByTab[tabIndex] = freshTab();
    }
    updated = {
      tabCount: prev.tabCount + 1,
      tabSpawnHistory: [...prev.tabSpawnHistory, entry],
      geometryByTab,
    };
    return {
      ...reg,
      windows: { ...reg.windows, [windowName]: updated },
    };
  });
  return updated;
}

/** Read the best-effort pane count for a tab in a named window. Used
 * by the wt adapter's default split-direction policy. Returns 0 when
 * the window or tab isn't tracked yet. */
export function predictPaneCount(
  paths: Paths,
  windowName: string,
  tab_index: number = 0,
): number {
  const g = getTabGeometry(paths, windowName, tab_index);
  return g ? paneCount(g) : 0;
}

/** Read the persisted geometry for a tab. Returns null when the
 * window/tab isn't tracked yet (pre-split policy uses `freshTab()`
 * as the implicit base). */
export function getTabGeometry(
  paths: Paths,
  windowName: string,
  tab_index: number,
): TabGeometry | null {
  const state = getWindowState(paths, windowName);
  if (!state) return null;
  return state.geometryByTab?.[tab_index] ?? null;
}

export function getWindowState(
  paths: Paths,
  windowName: string,
): WindowRecord | null {
  const reg = loadRegistry(paths);
  return reg.windows[windowName] ?? null;
}

/** Best-effort prediction of the next tab index in a window. Used by
 * `split-pane` requests that don't supply `tab_index`. */
export function predictNextTabIndex(
  paths: Paths,
  windowName: string,
): number {
  const state = getWindowState(paths, windowName);
  return state?.tabCount ?? 0;
}

/** Mark a spawn as ended. Decrements `tabCount` (clamped to 0) so the
 * registry reflects the current tab count after the user (or `exit`)
 * closed a tab. The spawn history entry stays in place — it's the
 * audit trail, not a live count. No-op when no record exists for
 * this window. */
export function recordExit(
  paths: Paths,
  windowName: string,
): WindowRecord | null {
  let updated: WindowRecord | null = null;
  mutateJsonAtomic<WindowRegistry>(paths.windowsRegistryPath, (current) => {
    const reg = current ?? emptyRegistry();
    const prev = reg.windows[windowName];
    if (!prev) return undefined;
    updated = {
      tabCount: Math.max(0, prev.tabCount - 1),
      tabSpawnHistory: prev.tabSpawnHistory,
      ...(prev.geometryByTab !== undefined ? { geometryByTab: prev.geometryByTab } : {}),
    };
    return {
      ...reg,
      windows: { ...reg.windows, [windowName]: updated },
    };
  });
  return updated;
}
