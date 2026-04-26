import { mutateJsonAtomic, readJson, type Paths } from "../storage/index.ts";

/** Per-window record. `tabCount` is best-effort — the user can close
 * tabs externally; on next spawn the registry reconciles by appending
 * to history without trusting the count.
 *
 * `panesByTab` tracks the per-tab pane count so the wt adapter's
 * default split-direction policy (vertical for the 1st split,
 * horizontal for the 2nd onward) can read it. Same best-effort
 * caveat: panes closed via the user's mouse aren't visible to
 * pantheon — registry can drift. Document and accept; this isn't
 * a window-server. */
export interface WindowRecord {
  tabCount: number;
  tabSpawnHistory: TabSpawn[];
  panesByTab?: Record<number, number>;
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
 * `mode` ("split-pane" vs other) drives the pane-count bookkeeping:
 * a split-pane spawn increments `panesByTab[tab_index]` (default
 * tab 0); other modes seed the new tab's pane count to 1. */
export function recordSpawn(
  paths: Paths,
  windowName: string,
  spawn: Omit<TabSpawn, "when"> & {
    when?: number;
    mode?: "split-pane" | "new-tab" | "new-window";
  },
): WindowRecord {
  let updated!: WindowRecord;
  mutateJsonAtomic<WindowRegistry>(paths.windowsRegistryPath, (current) => {
    const reg = current ?? emptyRegistry();
    const prev = reg.windows[windowName] ?? {
      tabCount: 0,
      tabSpawnHistory: [],
      panesByTab: {},
    };
    const entry: TabSpawn = {
      when: spawn.when ?? Date.now(),
      summoner: spawn.summoner,
      persona: spawn.persona,
      ...(spawn.tab_index !== undefined ? { tab_index: spawn.tab_index } : {}),
    };
    const tabIndex = spawn.tab_index ?? 0;
    const panesByTab = { ...(prev.panesByTab ?? {}) };
    if (spawn.mode === "split-pane") {
      panesByTab[tabIndex] = (panesByTab[tabIndex] ?? 1) + 1;
    } else {
      // new tab / new window — seed the pane count for this tab.
      panesByTab[tabIndex] = (panesByTab[tabIndex] ?? 0) + 1;
    }
    updated = {
      tabCount: prev.tabCount + 1,
      tabSpawnHistory: [...prev.tabSpawnHistory, entry],
      panesByTab,
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
  const state = getWindowState(paths, windowName);
  if (!state) return 0;
  return state.panesByTab?.[tab_index] ?? 0;
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
    };
    return {
      ...reg,
      windows: { ...reg.windows, [windowName]: updated },
    };
  });
  return updated;
}
