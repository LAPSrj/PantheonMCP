import { test, expect } from "bun:test";
import { pickAdapter } from "../detect.ts";

function envOnly(vars: Record<string, string>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

test("pickAdapter picks WT when WT_SESSION is set", () => {
  expect(pickAdapter(envOnly({ WT_SESSION: "x" })).name).toBe("wt");
});

test("pickAdapter picks kitty when KITTY_PID is set (and WT is not)", () => {
  expect(pickAdapter(envOnly({ KITTY_PID: "x" })).name).toBe("kitty");
  // KITTY_WINDOW_ID alone is also enough.
  expect(pickAdapter(envOnly({ KITTY_WINDOW_ID: "1" })).name).toBe("kitty");
});

test("pickAdapter picks wezterm / iterm2 / gnome / terminal_app / alacritty by env signature", () => {
  expect(pickAdapter(envOnly({ WEZTERM_PANE: "x" })).name).toBe("wezterm");
  expect(pickAdapter(envOnly({ ITERM_SESSION_ID: "x" })).name).toBe("iterm2");
  expect(pickAdapter(envOnly({ GNOME_TERMINAL_SCREEN: "x" })).name).toBe("gnome");
  expect(pickAdapter(envOnly({ TERM_PROGRAM: "Apple_Terminal" })).name).toBe("terminal_app");
  expect(pickAdapter(envOnly({ ALACRITTY_LOG: "x" })).name).toBe("alacritty");
});

test("pickAdapter picks tmux when TMUX is set and no higher-priority host", () => {
  expect(pickAdapter(envOnly({ TMUX: "/tmp/tmux" })).name).toBe("tmux");
});

test("pickAdapter falls back to generic when nothing matches", () => {
  expect(pickAdapter(envOnly({})).name).toBe("generic");
});

test("pickAdapter respects priority: WT beats kitty beats wezterm beats iterm2 beats tmux", () => {
  expect(
    pickAdapter(envOnly({ WT_SESSION: "x", KITTY_PID: "x", TMUX: "/x" })).name,
  ).toBe("wt");
  expect(pickAdapter(envOnly({ KITTY_PID: "x", TMUX: "/x" })).name).toBe("kitty");
});

test("pickAdapter skips named adapters when opts.skip is provided", () => {
  expect(
    pickAdapter(envOnly({ TMUX: "/x", GNOME_TERMINAL_SCREEN: "y" }), {
      skip: ["tmux"],
    }).name,
  ).toBe("gnome");
});
