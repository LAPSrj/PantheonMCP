import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("WT adapter (WSL target): drops -d <cwd>, wraps in wsl.exe + bash -l <script>", () => {
  // Redirect script writes to a tmp dir so we can read what got written.
  const tmpScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-wt-script-"));
  const prev = process.env.PANTHEON_WT_SCRIPT_DIR;
  process.env.PANTHEON_WT_SCRIPT_DIR = tmpScriptDir;
  try {
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
    // Crucially: NO `-d /home/leandro/builder/nyus` (would error 0x8007010b on wt.exe).
    const dIdx = plan.args.indexOf("-d");
    if (dIdx !== -1) {
      expect(plan.args[dIdx + 1]).toBe("Ubuntu-22.04");
    }
    // wsl.exe + bash + -l + <script-path>, NOT bash + -lc + <inline>.
    expect(plan.args).toContain("wsl.exe");
    expect(plan.args).toContain("Ubuntu-22.04");
    expect(plan.args).toContain("bash");
    expect(plan.args).toContain("-l");
    expect(plan.args).not.toContain("-lc");
    // The wt.exe argv must NOT contain a literal `;` (wt.exe parses `;` as
    // a subcommand separator and fragments the spawn — see semaphoremole's
    // 0x80070002 report). With the script-file approach there's no shell
    // metacharacter in argv at all.
    for (const arg of plan.args) {
      expect(arg).not.toContain(";");
    }
    // The script path is the last arg; read it and verify the body.
    const scriptPath = plan.args[plan.args.length - 1] as string;
    expect(scriptPath.startsWith(tmpScriptDir)).toBe(true);
    expect(scriptPath.endsWith(".sh")).toBe(true);
    const body = fs.readFileSync(scriptPath, "utf8");
    expect(body).toContain("#!/usr/bin/env bash");
    expect(body).toContain(`rm -f -- "$0"`);
    expect(body).toContain("cd '/home/leandro/builder/nyus'");
    // Sentinel-gated graceful-exit wrapper: claude runs as a child
    // (no `exec`) so bash can read $? and remap 143 → 0 when pantheon
    // wrote the sentinel. External SIGTERMs without the sentinel
    // surface the real 143 and keep the tab open.
    expect(body).toContain("'claude' '--print' 'go'");
    expect(body).not.toContain("exec 'claude'");
    expect(body).toContain(`__pantheon_ec=$?`);
    expect(body).toContain(`PANTHEON_EXIT_SENTINEL`);
    expect(body).toContain(`exit "$__pantheon_ec"`);
    expect(body).toContain("export PANTHEON_USERNAME='swoopfinch'");
    expect(body).toContain("export PANTHEON_REST_TIMEOUT='3600'");
  } finally {
    if (prev === undefined) delete process.env.PANTHEON_WT_SCRIPT_DIR;
    else process.env.PANTHEON_WT_SCRIPT_DIR = prev;
    fs.rmSync(tmpScriptDir, { recursive: true, force: true });
  }
});

test("WT adapter (split-pane WSL target): same script-file wrap, no -d, no inline bash", () => {
  const tmpScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-wt-script-"));
  const prev = process.env.PANTHEON_WT_SCRIPT_DIR;
  process.env.PANTHEON_WT_SCRIPT_DIR = tmpScriptDir;
  try {
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
    expect(plan.args).toContain("-l");
    expect(plan.args).not.toContain("-lc");
    for (const arg of plan.args) {
      expect(arg).not.toContain(";");
    }
    const scriptPath = plan.args[plan.args.length - 1] as string;
    const body = fs.readFileSync(scriptPath, "utf8");
    expect(body).toContain("cd '/home/leandro/monitor/nyus'");
  } finally {
    if (prev === undefined) delete process.env.PANTHEON_WT_SCRIPT_DIR;
    else process.env.PANTHEON_WT_SCRIPT_DIR = prev;
    fs.rmSync(tmpScriptDir, { recursive: true, force: true });
  }
});

test("WT adapter (WSL target): script body carries forward summoner PATH", () => {
  const tmpScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-wt-script-"));
  const prevDir = process.env.PANTHEON_WT_SCRIPT_DIR;
  const prevPath = process.env.PATH;
  process.env.PANTHEON_WT_SCRIPT_DIR = tmpScriptDir;
  process.env.PATH = "/custom/bin:/usr/local/bin:/usr/bin";
  try {
    const plan = resolveSpawnPlan(
      args({
        cwd: "/work",
        wsl_distro: "Ubuntu-22.04",
        target: { mode: "new-tab-window" },
      }),
      { adapter: wt },
    );
    const scriptPath = plan.args[plan.args.length - 1] as string;
    const body = fs.readFileSync(scriptPath, "utf8");
    // PATH carry-forward must precede user env exports (so user-supplied
    // PATH in exec_env, if any, wins).
    expect(body).toContain("export PATH='/custom/bin:/usr/local/bin:/usr/bin'");
    const pathIdx = body.indexOf("export PATH=");
    const cdIdx = body.indexOf("cd '/work'");
    expect(pathIdx).toBeLessThan(cdIdx);
  } finally {
    if (prevDir === undefined) delete process.env.PANTHEON_WT_SCRIPT_DIR;
    else process.env.PANTHEON_WT_SCRIPT_DIR = prevDir;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    fs.rmSync(tmpScriptDir, { recursive: true, force: true });
  }
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

// --- hosts without a dedicated adapter ---

test("WezTerm-like host without a dedicated adapter resolves via generic", () => {
  // Pantheon doesn't ship a WezTerm-specific adapter; the detect
  // ladder skips past WEZTERM_PANE and lands on `generic`. The user
  // gets a basic `new-window` spawn rather than an error.
  const plan = resolveSpawnPlan(
    args({ target: { mode: "split-pane" } }),
    { env: { WEZTERM_PANE: "x" } },
  );
  expect(plan.adapter).toBe("generic");
});
