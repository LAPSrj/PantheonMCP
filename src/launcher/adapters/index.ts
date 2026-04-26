import type { Adapter } from "../types.ts";
import { wt } from "./wt.ts";
import { kitty } from "./kitty.ts";
import { tmux } from "./tmux.ts";
import { generic } from "./generic.ts";
import { alacritty } from "./alacritty.ts";
import { gnome, iterm2, terminal_app, wezterm } from "./stubs.ts";

/** Detection priority order per §5 / §11a. First detect-true wins.
 * `generic` is the universal fallback and detects true unconditionally. */
export const ADAPTERS_IN_PRIORITY: ReadonlyArray<Adapter> = [
  wt,
  kitty,
  wezterm,
  iterm2,
  tmux,
  gnome,
  terminal_app,
  alacritty,
  generic,
];

export { wt, kitty, wezterm, iterm2, tmux, gnome, terminal_app, alacritty, generic };
