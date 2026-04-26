import {
  appendEntry,
  loadStore,
  type AppendInput,
} from "../memory/index.ts";
import type { Paths } from "../storage/index.ts";
import { createPersona, readPersona } from "./registry.ts";
import { IdentityError, type Persona } from "./types.ts";

/** §6 MEDIUM persona forking. Clones a persona's profile (everything
 * except `cwd`, which the caller supplies) and optionally its memory
 * (default `true`) into a fresh handle.
 *
 * Per §12-H confirmation:
 * - Memory entries are deep-copied with REGENERATED IDs so the fork
 *   and original can mutate independently without ID collisions.
 *   Forks are snapshots, not live mirrors.
 * - Chat history references the original `agent_id`, so the fork
 *   starts with empty chat participation. Existing message rows
 *   stay attributed to the original persona.
 *
 * The pure identity-layer function performs the persona create +
 * (optional) memory clone. The chat-router-side collision check
 * (subscribers + tombstones) is the responsibility of the MCP
 * `fork` handler, which has the router in `ctx.chat`. */
export interface ForkOptions {
  paths: Paths;
  from: string;
  to: string;
  cwd: string;
  copy_memory?: boolean;
  pid?: number;
  now?: () => number;
}

export interface ForkResult {
  persona: Persona;
  copied_entries: number;
  source: string;
}

export function forkPersona(options: ForkOptions): ForkResult {
  const source = readPersona(options.paths, options.from);
  if (!source) {
    throw new IdentityError(
      "not_registered",
      `Source persona '${options.from}' is not registered.`,
    );
  }

  const copyMemory = options.copy_memory ?? true;

  // Profile deep copy except cwd. Server-managed bookkeeping fields
  // (last_summoned_at, summon_count, registered_at) are reset by
  // createPersona — the fork is a fresh registration.
  const created = createPersona(
    options.paths,
    {
      username: options.to,
      project: source.project,
      cwd: options.cwd,
      platform: source.platform,
      ...(source.wsl_distro !== undefined ? { wsl_distro: source.wsl_distro } : {}),
      launch_command: source.launch_command,
      launch_args: [...source.launch_args],
      description: source.description,
      expertise: [...source.expertise],
      owns: [...source.owns],
      mode: source.mode,
      color: source.color,
      provisional: source.provisional,
    },
    {
      ...(options.pid !== undefined ? { pid: options.pid } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    },
  );

  let copied = 0;
  if (copyMemory) {
    const sourceStore = loadStore(options.paths, source.username);
    for (const entry of sourceStore.entries) {
      // appendEntry slugifies a fresh id derived from summary/text,
      // so collisions auto-resolve via the slug-suffix loop.
      const input: AppendInput = {
        text: entry.text,
        summary: entry.summary,
      };
      if (entry.details !== undefined) input.details = entry.details;
      if (entry.kind !== undefined) input.kind = entry.kind;
      if (entry.core) input.core = entry.core;
      if (entry.summoner_username !== undefined)
        input.summoner_username = entry.summoner_username;
      appendEntry(options.paths, options.to, input);
      copied++;
    }
  }

  return {
    persona: created,
    copied_entries: copied,
    source: source.username,
  };
}
