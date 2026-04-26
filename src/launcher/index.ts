export {
  type Adapter,
  type Capability,
  type SpawnArgs,
  type SpawnMode,
  type SpawnPlan,
  type SpawnTarget,
  type AdapterErrorCode,
  AdapterError,
  DOWNGRADE_LADDER,
} from "./types.ts";

export { pickAdapter, type PickOptions } from "./detect.ts";
export { resolveSpawnPlan, type ResolveOptions } from "./dispatch.ts";

export {
  ADAPTERS_IN_PRIORITY,
  wt,
  kitty,
  tmux,
  generic,
  wezterm,
  iterm2,
  gnome,
  terminal_app,
  alacritty,
} from "./adapters/index.ts";

export {
  loadRegistry,
  recordSpawn,
  getWindowState,
  predictNextTabIndex,
  type WindowRegistry,
  type WindowRecord,
  type TabSpawn,
} from "./window-registry.ts";
