import { test, expect } from "bun:test";
import {
  parseWslDistroList,
  installedWslDistros,
  isWslDistroInstalled,
  resolveSpawnWslDistro,
} from "../wsl.ts";

// --- parseWslDistroList: real `wsl.exe -l -q` is UTF-16LE + CRLF ---

test("parseWslDistroList decodes UTF-16LE CRLF output into names", () => {
  const buf = Buffer.from("Ubuntu-22.04\r\nUbuntu-24.04\r\nDebian\r\ndocker-desktop\r\n", "utf16le");
  expect(parseWslDistroList(buf)).toEqual([
    "Ubuntu-22.04",
    "Ubuntu-24.04",
    "Debian",
    "docker-desktop",
  ]);
});

test("parseWslDistroList preserves internal spaces in a distro name", () => {
  const buf = Buffer.from("Ubuntu Dev\r\nDebian\r\n", "utf16le");
  expect(parseWslDistroList(buf)).toEqual(["Ubuntu Dev", "Debian"]);
});

test("parseWslDistroList tolerates LF-only and a missing trailing newline", () => {
  const buf = Buffer.from("Ubuntu-22.04\nDebian", "utf16le");
  expect(parseWslDistroList(buf)).toEqual(["Ubuntu-22.04", "Debian"]);
});

// --- installedWslDistros: PANTHEON_WSL_DISTROS test seam ---

test("installedWslDistros reads the PANTHEON_WSL_DISTROS comma seam", () => {
  const env = { PANTHEON_WSL_DISTROS: "Ubuntu-22.04, Debian ,docker-desktop" } as unknown as NodeJS.ProcessEnv;
  expect(installedWslDistros(env)).toEqual(["Ubuntu-22.04", "Debian", "docker-desktop"]);
});

test("installedWslDistros: empty seam string → no distros (not null)", () => {
  const env = { PANTHEON_WSL_DISTROS: "" } as unknown as NodeJS.ProcessEnv;
  expect(installedWslDistros(env)).toEqual([]);
});

// --- isWslDistroInstalled: case-insensitive ---

test("isWslDistroInstalled matches case-insensitively", () => {
  expect(isWslDistroInstalled("ubuntu-22.04", ["Ubuntu-22.04"])).toBe(true);
  expect(isWslDistroInstalled("Ubuntu", ["Ubuntu-22.04", "Debian"])).toBe(false);
});

// --- resolveSpawnWslDistro: every branch ---

const INSTALLED = ["Ubuntu-22.04", "Ubuntu-24.04", "Debian"];

test("resolve: unpinned persona inherits the summoner's running distro", () => {
  const r = resolveSpawnWslDistro({ configured: null, envDistro: "Ubuntu-22.04", installed: INSTALLED });
  expect(r.distro).toBe("Ubuntu-22.04");
  expect(r.warning).toBeUndefined();
  expect(r.unresolved).toBeUndefined();
});

test("resolve: undefined config behaves like cleared (inherit env)", () => {
  const r = resolveSpawnWslDistro({ configured: undefined, envDistro: "Debian", installed: INSTALLED });
  expect(r.distro).toBe("Debian");
});

test("resolve: cannot enumerate (installed=null) → pinned value passes through unblocked", () => {
  const r = resolveSpawnWslDistro({ configured: "Ubuntu", envDistro: "Ubuntu-22.04", installed: null });
  expect(r.distro).toBe("Ubuntu");
  expect(r.unresolved).toBeUndefined();
});

test("resolve: pinned + installed → used verbatim", () => {
  const r = resolveSpawnWslDistro({ configured: "Ubuntu-24.04", envDistro: "Ubuntu-22.04", installed: INSTALLED });
  expect(r.distro).toBe("Ubuntu-24.04");
  expect(r.warning).toBeUndefined();
});

test("resolve: pinned-but-missing self-heals to the running distro + warns", () => {
  // The Underwright case: pinned "Ubuntu", machine has "Ubuntu-22.04".
  const r = resolveSpawnWslDistro({ configured: "Ubuntu", envDistro: "Ubuntu-22.04", installed: INSTALLED });
  expect(r.distro).toBe("Ubuntu-22.04");
  expect(r.warning).toContain("Ubuntu");
  expect(r.unresolved).toBeUndefined();
});

test("resolve: pinned-but-missing, no valid fallback → unresolved (caller throws)", () => {
  const r = resolveSpawnWslDistro({ configured: "Ubuntu", envDistro: undefined, installed: INSTALLED });
  expect(r.distro).toBe("Ubuntu");
  expect(r.unresolved).toEqual({ configured: "Ubuntu", installed: INSTALLED });
});

test("resolve: pinned-bad where the running distro is equally bad → unresolved", () => {
  const r = resolveSpawnWslDistro({ configured: "Ubuntu", envDistro: "Ubuntu", installed: INSTALLED });
  expect(r.unresolved).toEqual({ configured: "Ubuntu", installed: INSTALLED });
});

test("resolve: pinned match is case-insensitive", () => {
  const r = resolveSpawnWslDistro({ configured: "ubuntu-22.04", envDistro: undefined, installed: INSTALLED });
  expect(r.distro).toBe("ubuntu-22.04");
  expect(r.unresolved).toBeUndefined();
});
