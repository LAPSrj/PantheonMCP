/** §6 HIGH — auto-context-percent nudge.
 *
 * Real CC plugin integration would expose the actual context
 * percent via a hook. Until that lands, this module uses a
 * **surrogate signal** combining (a) tool calls since the last
 * memory save and (b) wall-clock time since the last save.
 * Either signal crossing a threshold raises the pressure level.
 *
 * Threshold ladder (per the brainstorm doc):
 *   - low         — quiet, no hint.
 *   - soft_hint   — analog of 70%: gentle reminder to save state.
 *   - strong_nudge — analog of 85%: explicit "save before you lose context."
 *   - save_now    — analog of 95%: "save NOW + handoff" — agent should
 *                   write a handoff entry and prepare to rest.
 *
 * Surfaces in tool-call response `hints` field — the same surface
 * `send_message` uses for the staleness nudge. Per-session state
 * lives on `HandlerContext` (created by `createContext`); reset on
 * memory writes.
 *
 * Override thresholds via env (testing): `PANTHEON_PRESSURE_SOFT_TOOLS`,
 * `PANTHEON_PRESSURE_STRONG_TOOLS`, `PANTHEON_PRESSURE_SAVE_TOOLS`,
 * `PANTHEON_PRESSURE_SOFT_MIN`, `PANTHEON_PRESSURE_STRONG_MIN`,
 * `PANTHEON_PRESSURE_SAVE_MIN`, `PANTHEON_PRESSURE_FRESHNESS_FLOOR_MIN`.
 *
 * Freshness floor: when a memory-write tool fired within
 * `freshness_floor_minutes` (default 30), ALL tiers suppress to `low`.
 * The hint should not hammer an agent right after they save — the
 * trigger uses real wall-clock elapsed time as a context-budget proxy,
 * and a recent save resets that proxy to zero. The floor closes a
 * narrow window where tool_call_count had crossed a threshold but
 * elapsed time hadn't yet caught up. */

export type PressureLevel = "low" | "soft_hint" | "strong_nudge" | "save_now";

export interface PressureState {
  /** Tool calls since the last memory save (append/update/set/snapshot). */
  toolCallsSinceLastSave: number;
  /** ms-epoch of the last memory save. Initialized to context creation. */
  lastSaveAt: number;
}

export interface PressureThresholds {
  soft_tools: number;
  strong_tools: number;
  save_tools: number;
  /** Minutes since last save. */
  soft_minutes: number;
  strong_minutes: number;
  save_minutes: number;
  /** Minutes since last save below which ALL tiers suppress to `low`.
   * Prevents firing immediately after a save when tool-call count was
   * elevated. Default 30. */
  freshness_floor_minutes: number;
}

const DEFAULTS: PressureThresholds = {
  soft_tools: 50,
  strong_tools: 100,
  save_tools: 150,
  soft_minutes: 120, // 2 hours
  strong_minutes: 240, // 4 hours
  save_minutes: 480, // 8 hours
  freshness_floor_minutes: 30,
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  // 0 is valid (it disables the threshold — useful for the freshness
  // floor, where 0 means "no floor"). Negative values fall back.
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveThresholds(): PressureThresholds {
  return {
    soft_tools: envInt("PANTHEON_PRESSURE_SOFT_TOOLS", DEFAULTS.soft_tools),
    strong_tools: envInt("PANTHEON_PRESSURE_STRONG_TOOLS", DEFAULTS.strong_tools),
    save_tools: envInt("PANTHEON_PRESSURE_SAVE_TOOLS", DEFAULTS.save_tools),
    soft_minutes: envInt("PANTHEON_PRESSURE_SOFT_MIN", DEFAULTS.soft_minutes),
    strong_minutes: envInt("PANTHEON_PRESSURE_STRONG_MIN", DEFAULTS.strong_minutes),
    save_minutes: envInt("PANTHEON_PRESSURE_SAVE_MIN", DEFAULTS.save_minutes),
    freshness_floor_minutes: envInt(
      "PANTHEON_PRESSURE_FRESHNESS_FLOOR_MIN",
      DEFAULTS.freshness_floor_minutes,
    ),
  };
}

/** Tools that count as "memory save" — they reset the pressure
 * counter when they succeed. The activity tracker on each tool
 * dispatch checks this set and calls `markMemorySave()` accordingly.
 *
 * Includes per-persona memory writes, project-memory writes, and
 * notebook writes (per-persona + project). `fade_memory` /
 * `forget_memory` and their project variants are NOT included —
 * those are metadata-only mutations (status changes), not content
 * writes, and shouldn't reset the "you've saved state" signal. */
const SAVE_TOOLS: ReadonlySet<string> = new Set([
  // Per-persona memory writes
  "append_memory",
  "update_memory",
  "set_memory",
  "snapshot_memory",
  // Project-memory writes (parallel to per-persona — also add content)
  "append_project_memory",
  "append_project_memory_any",
  "update_project_memory",
  "update_project_memory_any",
  // Notebook writes (per-persona + project — add long-form content)
  "notebook_write_page",
  "project_notebook_write_page",
  "project_notebook_write_page_any",
  // Lifecycle
  "rest", // rest with handoff slot also acts as a save
]);

export function isSaveTool(toolName: string): boolean {
  return SAVE_TOOLS.has(toolName);
}

/** Compute the pressure level from current state + thresholds. */
export function computePressure(
  state: PressureState,
  now: number = Date.now(),
  thresholds: PressureThresholds = resolveThresholds(),
): PressureLevel {
  const elapsedMin = (now - state.lastSaveAt) / 60_000;
  // Freshness floor — suppress every tier when a memory-write fired
  // recently. The tool-call counter was reset by `markMemorySave()`,
  // but if the previous-pressure-window hadn't expired yet we'd still
  // emit a stale-feeling hint right after the save. The floor closes
  // that window.
  if (elapsedMin < thresholds.freshness_floor_minutes) return "low";
  const tools = state.toolCallsSinceLastSave;
  if (tools >= thresholds.save_tools || elapsedMin >= thresholds.save_minutes) {
    return "save_now";
  }
  if (tools >= thresholds.strong_tools || elapsedMin >= thresholds.strong_minutes) {
    return "strong_nudge";
  }
  if (tools >= thresholds.soft_tools || elapsedMin >= thresholds.soft_minutes) {
    return "soft_hint";
  }
  return "low";
}

/** Render a hint string for the surfaced response. Null when the
 * level is `low` (no hint). */
export function pressureHint(
  level: PressureLevel,
  state: PressureState,
  now: number = Date.now(),
): string | null {
  if (level === "low") return null;
  const elapsedMin = Math.round((now - state.lastSaveAt) / 60_000);
  const tools = state.toolCallsSinceLastSave;
  switch (level) {
    case "soft_hint":
      return (
        `context_pressure: soft hint — ${tools} tool calls and ${elapsedMin}m since your last memory save. ` +
        `Worth a quick \`append_memory\` if you've learned anything since then; not urgent.`
      );
    case "strong_nudge":
      return (
        `context_pressure: STRONG NUDGE — ${tools} tool calls and ${elapsedMin}m since your last memory save. ` +
        `Save state now. Future-you needs a handoff entry capturing what you learned this session before context fills.`
      );
    case "save_now":
      return (
        `context_pressure: SAVE NOW — ${tools} tool calls and ${elapsedMin}m since your last memory save. ` +
        `Write a \`kind: "handoff"\` core memory entry IMMEDIATELY. ` +
        `If a peer needs the work, call \`rest({ handoff: { for, text } })\` — atomic memory + DM. ` +
        `You're at risk of context exhaustion.`
      );
  }
}
