import { installedWslDistros, isWslDistroInstalled } from "../../launcher/index.ts";
import { ToolError } from "../types.ts";

/** Write-time guard shared by `register` / `conjure` / `update_profile`:
 * reject a persona pinned to a WSL distro that isn't installed on this
 * machine. The `wsl_distro` field's whole purpose is the `wsl.exe -d
 * <distro>` launch arg, so a bad value is a latent
 * `WSL_E_DISTRO_NOT_FOUND` at every future summon.
 *
 * No-op when: the platform isn't `wsl`, no distro was supplied (omitting
 * it is valid — summons then inherit the summoner's running distro), or
 * enumeration is unavailable (`installedWslDistros` → null, i.e. can't
 * verify, so don't block). */
export function assertWslDistroInstalled(
  distro: string | undefined,
  platform: string,
  env: NodeJS.ProcessEnv,
): void {
  if (platform !== "wsl" || !distro) return;
  const installed = installedWslDistros(env);
  if (installed === null) return;
  if (!isWslDistroInstalled(distro, installed)) {
    throw new ToolError(
      "wsl_distro_not_found",
      `wsl_distro '${distro}' is not installed on this machine. ` +
        `Installed distros: ${installed.join(", ") || "(none)"}. ` +
        `Omit wsl_distro to inherit the summoner's running distro at spawn ` +
        `time, or pass one of the installed names.`,
      { configured: distro, installed },
    );
  }
}
