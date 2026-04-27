import type { Adapter } from "../types.ts";
import { wt } from "./wt.ts";
import { kitty } from "./kitty.ts";
import { tmux } from "./tmux.ts";
import { generic } from "./generic.ts";
import { alacritty } from "./alacritty.ts";

/** Detection priority order per §5 / §11a. First detect-true wins.
 * `generic` is the universal fallback and detects true unconditionally.
 *
 * Hosts without a dedicated adapter (WezTerm, iTerm2, GNOME Terminal,
 * Apple Terminal, etc.) fall through to `generic` automatically — the
 * detect ladder skips past them and the user gets a basic spawn rather
 * than an error. When a real adapter for one of those hosts ships,
 * insert it in priority order. */
export const ADAPTERS_IN_PRIORITY: ReadonlyArray<Adapter> = [
  wt,
  kitty,
  tmux,
  alacritty,
  generic,
];

export { wt, kitty, tmux, alacritty, generic };
