import { ADAPTERS_IN_PRIORITY, generic } from "./adapters/index.ts";
import type { Adapter } from "./types.ts";

export interface PickOptions {
  /** Adapters to skip during detection. Used by the tmux-escape path
   * to fall through to the host terminal's adapter. */
  skip?: string[];
}

/** Walks the priority list and returns the first adapter that
 * recognises the host. `generic` is the catch-all, so this never
 * returns null. */
export function pickAdapter(
  env: NodeJS.ProcessEnv = process.env,
  opts: PickOptions = {},
): Adapter {
  const skip = new Set(opts.skip ?? []);
  for (const adapter of ADAPTERS_IN_PRIORITY) {
    if (skip.has(adapter.name)) continue;
    if (adapter.detect(env)) return adapter;
  }
  return generic;
}
