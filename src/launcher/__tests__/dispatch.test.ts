import { test, expect } from "bun:test";
import { resolveSpawnPlan } from "../dispatch.ts";
import { wt, tmux, alacritty, generic, kitty } from "../adapters/index.ts";
import { AdapterError, type SpawnArgs } from "../types.ts";

function args(over: Partial<SpawnArgs> = {}): SpawnArgs {
  return {
    exec_command: "claude",
    exec_args: [],
    exec_env: {},
    cwd: "/work",
    tab_title: "vellumpike",
    ...over,
  };
}

// --- mode resolution ---

test("resolveSpawnPlan picks the requested mode when supported", () => {
  const plan = resolveSpawnPlan(
    args({ target: { mode: "split-pane", split: "vertical" } }),
    { adapter: wt },
  );
  expect(plan.resolved_mode).toBe("split-pane");
  expect(plan.adapter).toBe("wt");
  expect(plan.downgrade_note).toBeUndefined();
});

test("resolveSpawnPlan downgrades when adapter lacks the requested mode", () => {
  // alacritty supports only `new-window`; ask for split-pane, expect
  // downgrade to new-window with a note.
  const plan = resolveSpawnPlan(
    args({ target: { mode: "split-pane" } }),
    { adapter: alacritty, env: {} },
  );
  expect(plan.resolved_mode).toBe("new-window");
  expect(plan.downgrade_note).toContain("split-pane requested");
  expect(plan.downgrade_note).toContain("downgraded");
});

test("resolveSpawnPlan errors unsupported_capability under target.strict", () => {
  let err: unknown;
  try {
    resolveSpawnPlan(
      args({ target: { mode: "split-pane", strict: true } }),
      { adapter: alacritty, env: {} },
    );
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(AdapterError);
  expect((err as AdapterError).code).toBe("unsupported_capability");
});

// --- env-knob shim ---

test("resolveSpawnPlan honors PANTHEON_TAB_TARGET when target.mode omitted", () => {
  const plan = resolveSpawnPlan(args(), {
    adapter: wt,
    env: { PANTHEON_TAB_TARGET: "same" },
  });
  expect(plan.resolved_mode).toBe("new-tab-here");
});

test("resolveSpawnPlan still recognises legacy SUMMON_MCP_TAB_TARGET", () => {
  const plan = resolveSpawnPlan(args(), {
    adapter: wt,
    env: { SUMMON_MCP_TAB_TARGET: "new" },
  });
  expect(plan.resolved_mode).toBe("new-window");
});

test("PANTHEON_TAB_TARGET wins over SUMMON_MCP_TAB_TARGET", () => {
  const plan = resolveSpawnPlan(args(), {
    adapter: wt,
    env: {
      PANTHEON_TAB_TARGET: "same",
      SUMMON_MCP_TAB_TARGET: "new",
    },
  });
  expect(plan.resolved_mode).toBe("new-tab-here");
});

// --- tmux escape ---

test("escape_tmux dispatches to the host terminal's adapter", () => {
  const plan = resolveSpawnPlan(
    args({ target: { mode: "new-window", escape_tmux: true } }),
    { env: { WT_SESSION: "x", TMUX: "/x" } },
  );
  expect(plan.adapter).toBe("wt");
});

test("default (escape_tmux: false) stays inside tmux when TMUX is set", () => {
  const plan = resolveSpawnPlan(
    args({ target: { mode: "new-tab-here" } }),
    { env: { TMUX: "/x" } },
  );
  expect(plan.adapter).toBe("tmux");
});

// --- adapter-specific plan shapes ---

test("WT adapter emits wt.exe argv with the resolved window arg", () => {
  const plan = resolveSpawnPlan(
    args({ target: { mode: "new-tab-window", window: "summon-vellumpike" } }),
    { adapter: wt },
  );
  expect(plan.command).toBe("wt.exe");
  expect(plan.args.slice(0, 2)).toEqual(["-w", "summon-vellumpike"]);
  expect(plan.args).toContain("new-tab");
  expect(plan.args).toContain("--title");
  expect(plan.args).toContain("vellumpike");
  expect(plan.args).toContain("-d");
  expect(plan.args).toContain("/work");
  expect(plan.args).toContain("claude");
});

test("WT adapter sets requires_stderr_probe on split-pane", () => {
  const plan = resolveSpawnPlan(
    args({ target: { mode: "split-pane", window: "win" } }),
    { adapter: wt },
  );
  expect(plan.requires_stderr_probe).toBe(true);
});

test("WT adapter applies named color hex when persona color set", () => {
  const plan = resolveSpawnPlan(
    args({ color: "purple", target: { mode: "new-tab-here" } }),
    { adapter: wt },
  );
  expect(plan.args).toContain("--tabColor");
  expect(plan.args).toContain("#b48ead");
});

test("WT adapter (WSL target): drops -d <cwd>, wraps in wsl.exe + bash -lc", () => {
  const plan = resolveSpawnPlan(
    args({
      cwd: "/home/leandro/builder/nyus",
      exec_command: "claude",
      exec_args: ["--print", "go"],
      exec_env: { PANTHEON_USERNAME: "swoopfinch", PANTHEON_REST_TIMEOUT: "3600" },
      wsl_distro: "Ubuntu-22.04",
      target: { mode: "new-tab-window", window: "image-gallery-finish" },
    }),
    { adapter: wt },
  );
  expect(plan.command).toBe("wt.exe");
  // Crucially: NO `-d /home/leandro/builder/nyus` arg (would error 0x8007010b on wt.exe).
  const dIdx = plan.args.indexOf("-d");
  // The only "-d" allowed is the wsl.exe distro flag, not wt.exe's cwd flag.
  if (dIdx !== -1) {
    expect(plan.args[dIdx + 1]).toBe("Ubuntu-22.04");
  }
  // Inner wsl invocation present.
  expect(plan.args).toContain("wsl.exe");
  expect(plan.args).toContain("Ubuntu-22.04");
  expect(plan.args).toContain("bash");
  expect(plan.args).toContain("-lc");
  // The bash -lc payload contains cd + exec + env exports.
  const bashLcIdx = plan.args.indexOf("-lc");
  const inner = plan.args[bashLcIdx + 1] as string;
  expect(inner).toContain("cd '/home/leandro/builder/nyus'");
  expect(inner).toContain("exec 'claude' '--print' 'go'");
  expect(inner).toContain("export PANTHEON_USERNAME='swoopfinch'");
  expect(inner).toContain("export PANTHEON_REST_TIMEOUT='3600'");
});

test("WT adapter (split-pane WSL target): same wsl wrap, no -d", () => {
  const plan = resolveSpawnPlan(
    args({
      cwd: "/home/leandro/monitor/nyus",
      wsl_distro: "Ubuntu-22.04",
      target: {
        mode: "split-pane",
        window: "image-gallery-finish",
        split: "horizontal",
      },
    }),
    { adapter: wt },
  );
  expect(plan.args).toContain("split-pane");
  expect(plan.args).toContain("-H");
  expect(plan.args).toContain("wsl.exe");
  // The persona's cwd shows up in the inner bash, NOT in a wt.exe -d.
  const bashLcIdx = plan.args.indexOf("-lc");
  const inner = plan.args[bashLcIdx + 1] as string;
  expect(inner).toContain("cd '/home/leandro/monitor/nyus'");
});

test("WT adapter default split direction: vertical when ≤1 existing pane", () => {
  const plan = resolveSpawnPlan(
    args({
      target: { mode: "split-pane", window: "win" },
      // existing_pane_count not set → treat as fresh
    }),
    { adapter: wt },
  );
  expect(plan.args).toContain("-V");
  expect(plan.args).not.toContain("-H");
});

test("WT adapter default split direction: horizontal once 2+ panes exist", () => {
  const plan = resolveSpawnPlan(
    args({
      target: { mode: "split-pane", window: "win" },
      existing_pane_count: 2,
    }),
    { adapter: wt },
  );
  expect(plan.args).toContain("-H");
  expect(plan.args).not.toContain("-V");
});

test("WT adapter caller-explicit split overrides existing_pane_count default", () => {
  const plan = resolveSpawnPlan(
    args({
      target: { mode: "split-pane", window: "win", split: "vertical" },
      existing_pane_count: 5, // would default to horizontal
    }),
    { adapter: wt },
  );
  expect(plan.args).toContain("-V");
});

test("tmux adapter emits tmux new-window or split-window argv", () => {
  const here = resolveSpawnPlan(
    args({ target: { mode: "new-tab-here" } }),
    { adapter: tmux },
  );
  expect(here.command).toBe("tmux");
  expect(here.args[0]).toBe("new-window");
  expect(here.args).toContain("-c");
  expect(here.args).toContain("/work");
  expect(here.args).toContain("-n");
  expect(here.args).toContain("vellumpike");

  const split = resolveSpawnPlan(
    args({ target: { mode: "split-pane", split: "horizontal" } }),
    { adapter: tmux },
  );
  expect(split.args[0]).toBe("split-window");
  expect(split.args).toContain("-h");
  expect(split.requires_stderr_probe).toBe(true);
});

test("kitty adapter emits @ launch with --type window/tab/os-window", () => {
  const tab = resolveSpawnPlan(
    args({ target: { mode: "new-tab-window", window: "wp" } }),
    { adapter: kitty },
  );
  expect(tab.args[0]).toBe("@");
  expect(tab.args[1]).toBe("launch");
  expect(tab.args).toContain("--type");
  expect(tab.args).toContain("tab");

  const split = resolveSpawnPlan(
    args({ target: { mode: "split-pane", split: "vertical" } }),
    { adapter: kitty },
  );
  expect(split.args).toContain("--location");
  expect(split.args).toContain("vsplit");
});

test("generic adapter just spawns the exec command directly", () => {
  const plan = resolveSpawnPlan(
    args({ exec_command: "/usr/bin/claude", exec_args: ["--resume"] }),
    { adapter: generic },
  );
  expect(plan.command).toBe("/usr/bin/claude");
  expect(plan.args).toEqual(["--resume"]);
  expect(plan.cwd).toBe("/work");
});

// --- stub adapters fall through gracefully ---

test("stub adapter (e.g. wezterm) downgrades into generic 'new-window'", () => {
  const plan = resolveSpawnPlan(
    args({ target: { mode: "split-pane" } }),
    { env: { WEZTERM_PANE: "x" } },
  );
  // wezterm is detected but its buildSpawnPlan throws
  // adapter_not_implemented; downgrade ladder doesn't help (every mode
  // throws), so we fall through to `generic`.
  expect(plan.adapter).toBe("generic");
  expect(plan.downgrade_note).toContain("fell through to generic");
});
