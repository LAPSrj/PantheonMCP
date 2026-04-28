/** Stop-hook context-fill threshold logic.
 *
 * Ported from summon-mcp's context-thresholds.ts. The Stop hook
 * (`pantheon context-check`) reads the agent's transcript, computes
 * actual token-usage / window-size as a fraction, and emits either
 * a CC `additionalContext` nudge or a `block` decision when a
 * configured threshold is crossed.
 *
 * Configure via the `PANTHEON_CONTEXT_THRESHOLDS` env var on the
 * pantheon mcpServers entry. Comma-separated `<fraction>[:block]`
 * pairs. Default ladder: 0.5 / 0.7 / 0.85 (all non-blocking).
 *
 *   PANTHEON_CONTEXT_THRESHOLDS=0.50,0.70:block,0.85
 *
 * `PANTHEON_CONTEXT_WINDOW` overrides the window size when the
 * model-id heuristic can't infer one (rare). */

export interface ContextThreshold {
  fraction: number;
  block: boolean;
}

export const DEFAULT_CONTEXT_THRESHOLDS: ContextThreshold[] = [
  { fraction: 0.5, block: false },
  { fraction: 0.7, block: false },
  { fraction: 0.85, block: false },
];

/** Disable kill-switch. Set `PANTHEON_CONTEXT_CHECK=off` (or
 * `0` / `false` / `disabled`, case-insensitive) on the pantheon
 * mcpServers entry to fully suppress the Stop-hook context warning.
 * When disabled, the MCP boot path skips writing the per-session
 * runtime env file, so the wrapper's fast-path returns `{}` without
 * spawning bun. */
export function isContextCheckDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.PANTHEON_CONTEXT_CHECK;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "disabled";
}

export function parseThresholdsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ContextThreshold[] {
  const raw = env.PANTHEON_CONTEXT_THRESHOLDS;
  if (!raw || !raw.trim()) return DEFAULT_CONTEXT_THRESHOLDS;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out: ContextThreshold[] = [];
  for (const part of parts) {
    const [fracStr, ...mods] = part.split(":");
    const fraction = Number(fracStr);
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
      process.stderr.write(
        `[pantheon] Ignoring invalid context threshold '${part}': fraction must be between 0 and 1.\n`,
      );
      continue;
    }
    const block = mods.includes("block");
    out.push({ fraction, block });
  }
  if (out.length === 0) return DEFAULT_CONTEXT_THRESHOLDS;
  out.sort((a, b) => a.fraction - b.fraction);
  return out;
}

/** Infer the context window from the model-id string CC reports
 * in transcript usage rows. The `[1m]` suffix marks 1M-context
 * variants (Opus 1M, Sonnet 1M); everything else defaults to 200k.
 * Returns null only when both inputs are absent. */
export function detectWindowFromModel(
  modelId: string | undefined,
  envOverride?: string,
): number | null {
  if (modelId && /\[1m\]/i.test(modelId)) return 1_000_000;
  if (modelId) return 200_000;
  if (envOverride) {
    const n = Number(envOverride);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export interface ThresholdMessage {
  additionalContext?: string;
  blockReason?: string;
  systemMessage?: string;
}

export function renderThresholdMessage(
  threshold: ContextThreshold,
  fraction: number,
  used: number,
  window: number,
): ThresholdMessage {
  const pct = Math.round(fraction * 100);
  const usedK = Math.round(used / 1000);
  const winK = Math.round(window / 1000);
  const stats = `${pct}% (~${usedK}k of ${winK}k tokens)`;
  if (threshold.block) {
    return {
      blockReason:
        `Context is at ${stats}. STOP and save handoff state NOW before the user types again. ` +
        `Run \`mcp__pantheon__append_memory({ text: "<concise note: what you were doing, key decisions this session, file paths touched, anything future-you needs to pick this up>" })\`, ` +
        `then \`mcp__pantheon__rest({ memory: "updated", authorized_by: "user" })\` if the work is done. ` +
        `If you continue without saving, auto-compact may erase intermediate reasoning.`,
      systemMessage: `pantheon: ${stats} — agent blocked to save state.`,
    };
  }
  return {
    additionalContext:
      `[pantheon] Context is at ${stats}. ` +
      `If you've made decisions, file changes, or coordination notes worth carrying forward, call \`mcp__pantheon__append_memory\` with a handoff note before continuing. ` +
      `Once context auto-compacts, intermediate reasoning is gone.`,
    systemMessage: `pantheon: ${stats} — reminded to save state.`,
  };
}

/** Pick the highest-fraction threshold that has been crossed AND
 * not yet fired this session. Returns null when nothing new applies. */
export function selectThreshold(
  thresholds: ContextThreshold[],
  fraction: number,
  fired: number[],
): ContextThreshold | null {
  const floor = fired.length > 0 ? Math.max(...fired) : -Infinity;
  let best: ContextThreshold | null = null;
  for (const t of thresholds) {
    if (t.fraction <= floor) continue;
    if (fraction < t.fraction) continue;
    if (!best || t.fraction > best.fraction) best = t;
  }
  return best;
}

/** Reset the fired ladder when current fraction dipped below the
 * lowest previously-fired threshold (i.e. context was compacted /
 * cleared). Lets the ladder fire again on the next climb. */
export function shouldResetFired(
  fraction: number,
  fired: number[],
): boolean {
  if (fired.length === 0) return false;
  const min = Math.min(...fired);
  return fraction < min;
}
