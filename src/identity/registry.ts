import fs from "node:fs";
import path from "node:path";
import {
  ensureDataDirs,
  ensurePersonaDir,
  isProjectSingleAgent,
  memoryFilePath,
  personaDir,
  personaFilePath,
  readJson,
  writeJsonAtomic,
  type Paths,
} from "../storage/index.ts";
import {
  IdentityError,
  type Persona,
  type PersonaCreate,
  type PersonaPatch,
} from "./types.ts";

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const RESERVED_USERNAMES = new Set(["admin", "system", "pantheon"]);
const DIGIT_SUFFIX_RE = /\d+$/;

/** Validate a persona handle. Throws `IdentityError` with the
 * appropriate code on rejection. */
export function validateUsername(username: string): void {
  if (!USERNAME_RE.test(username)) {
    throw new IdentityError(
      "invalid_username",
      "Username must be 1-48 chars, alphanumeric/_/- only, starting alphanumeric.",
    );
  }
  if (RESERVED_USERNAMES.has(username.toLowerCase())) {
    throw new IdentityError(
      "reserved_username",
      `Username '${username}' is reserved (system/admin/pantheon). Pick something else.`,
    );
  }
  if (DIGIT_SUFFIX_RE.test(username)) {
    throw new IdentityError(
      "digit_suffix_reserved",
      `Username '${username}' ends in digits — that suffix space is reserved for sibling incarnations of an existing persona. Pick a non-digit-ending name.`,
    );
  }
}

/** Read a persona by handle. Returns `null` when no entry exists. */
export function readPersona(paths: Paths, username: string): Persona | null {
  return readJson<Persona>(personaFilePath(paths, username));
}

/** Walk the personas directory and return every entry. Entries that
 * fail to parse are silently skipped — operators sometimes hand-edit
 * these files and a typo shouldn't bring the whole registry down. */
export function listPersonas(paths: Paths): Persona[] {
  ensureDataDirs(paths);
  const out: Persona[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(paths.personasDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const fullPath = path.join(paths.personasDir, name);
    try {
      const entry = readJson<Persona>(fullPath);
      if (entry) out.push(entry);
    } catch {
      // Skip unreadable entry — operator can fix via `pantheon validate`.
    }
  }
  return out;
}

/** Persist a persona via atomic-rename write. Idempotent under same
 * payload; callers wanting create-vs-update semantics should use
 * `createPersona` / `patchPersona` instead. */
export function writePersona(paths: Paths, entry: Persona): void {
  ensureDataDirs(paths);
  ensurePersonaDir(paths, entry.username);
  writeJsonAtomic(personaFilePath(paths, entry.username), entry);
}

/** Delete a persona's registry file. Memory + persona subdir untouched
 * by default — caller passes `dropMemory: true` to also unlink the
 * memory file. Returns `true` when the registry file existed. */
export function deletePersona(
  paths: Paths,
  username: string,
  opts: { dropMemory?: boolean } = {},
): boolean {
  let existed = true;
  try {
    fs.unlinkSync(personaFilePath(paths, username));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") existed = false;
    else throw err;
  }
  if (opts.dropMemory) {
    try {
      fs.unlinkSync(memoryFilePath(paths, username));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    try {
      fs.rmdirSync(personaDir(paths, username));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw err;
    }
  }
  return existed;
}

/** Run a 3-4 char prefix-collision check against the persistent
 * registry. Returns the colliding username or `null`.
 *
 * NOTE: the full collision check spans THREE sources:
 *   1. Persona registry (this function)
 *   2. Connected chat agents (subscriber map — chat router)
 *   3. Active tombstones (chat router)
 *
 * The chat router's `isHandleAvailable` composes this with its own
 * subscriber-map + tombstone reads. Don't add a chat-router peek
 * here; keep registry concerns isolated.
 */
export function prefixCollision(
  paths: Paths,
  username: string,
  ignoreSelf?: string,
): string | null {
  const lower = username.toLowerCase();
  const minOwn = Math.min(4, lower.length);
  for (const existing of listPersonas(paths)) {
    if (ignoreSelf && existing.username === ignoreSelf) continue;
    const exLower = existing.username.toLowerCase();
    const cmpLen = Math.min(minOwn, exLower.length, 4);
    if (cmpLen < 3) continue;
    if (exLower.slice(0, cmpLen) === lower.slice(0, cmpLen)) {
      return existing.username;
    }
  }
  return null;
}

const NOW: () => number = () => Date.now();

/** Create a persona registry entry.
 *
 * Default: enforces username rules, prefix-collision rule, and rejects
 * if a different cwd already holds the handle. Same `(handle, cwd)`
 * is treated as an idempotent update.
 *
 * `force: true` skips the cwd-mismatch + prefix-collision checks
 * (operator override). Per §13, `createPersona` does NOT touch
 * session state under any circumstance — `claim_after` lives on the
 * tool handler that wraps this. Callers wanting "create + claim"
 * compose explicitly.
 */
export function createPersona(
  paths: Paths,
  input: PersonaCreate,
  opts: { force?: boolean; pid?: number; now?: () => number } = {},
): Persona {
  validateUsername(input.username);

  // Single-agent project lock: a project flagged `single_agent` allows
  // exactly one persona. Block any path that would introduce a SECOND
  // distinct persona (register / conjure / summon / fork / merge /
  // promote all funnel through here). Re-registering the SAME handle —
  // idempotent update, or a force-overwrite from a new cwd — is fine
  // (still one persona). The lock wins over `force`: force overrides
  // name/cwd collisions, not project policy.
  if (isProjectSingleAgent(paths, input.project)) {
    const others = personasForProject(paths, input.project).filter(
      (p) => p.username !== input.username,
    );
    if (others.length > 0) {
      throw new IdentityError(
        "project_single_agent",
        `Project '${input.project}' is single-agent — persona '${others[0]!.username}' already holds it. ` +
          `Single-agent projects allow exactly one persona; run it in multiple sessions instead of creating another. ` +
          `To replace it, unregister '${others[0]!.username}' first.`,
        { project: input.project, existing: others[0]!.username },
      );
    }
  }

  const now = (opts.now ?? NOW)();
  const pid = opts.pid ?? process.pid;
  const existing = readPersona(paths, input.username);

  if (existing) {
    if (existing.cwd === input.cwd) {
      // Same cwd, same username — idempotent update preserving
      // server-managed fields. Mirrors summon-mcp createAgent semantics.
      const merged: Persona = {
        ...existing,
        ...stripUndefined(input),
        registered_at: existing.registered_at,
      };
      writePersona(paths, merged);
      return merged;
    }
    if (!opts.force) {
      throw new IdentityError(
        "username_taken_other_cwd",
        `Name '${input.username}' is registered to a different folder (${existing.cwd}). Pick another creative name, or pass force:true to replace.`,
        { registered_cwd: existing.cwd, registered_project: existing.project },
      );
    }
    // Falls through to overwrite below.
  } else if (!opts.force) {
    const collision = prefixCollision(paths, input.username);
    if (collision) {
      throw new IdentityError(
        "username_prefix_collision",
        `Name '${input.username}' shares a 3-4 char prefix with '${collision}'. Pick something more distinctive.`,
        { collides_with: collision },
      );
    }
  }

  const entry: Persona = {
    username: input.username,
    project: input.project,
    cwd: input.cwd,
    platform: input.platform,
    ...(input.wsl_distro !== undefined ? { wsl_distro: input.wsl_distro } : {}),
    launch_command: input.launch_command ?? "claude",
    launch_args: input.launch_args ?? [],
    description: input.description ?? "",
    expertise: input.expertise ?? [],
    owns: input.owns ?? [],
    mode: input.mode ?? "fresh",
    color: input.color ?? null,
    registered_at: now,
    registered_by_pid: pid,
    last_summoned_at: null,
    last_rested_at: null,
    rest_reason: null,
    resume_session_id: null,
    session_name: null,
    summon_count: 0,
    provisional: input.provisional ?? false,
    ...(input.channels !== undefined ? { channels: input.channels } : {}),
    ...(input.remote_control !== undefined ? { remote_control: input.remote_control } : {}),
    ...(input.permission_mode !== undefined ? { permission_mode: input.permission_mode } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(input.wt_profile !== undefined ? { wt_profile: input.wt_profile } : {}),
  };
  writePersona(paths, entry);
  return entry;
}

/** Apply a partial update to an existing persona. Throws
 * `not_registered` if no entry exists. */
export function patchPersona(
  paths: Paths,
  username: string,
  patch: PersonaPatch,
): Persona {
  const existing = readPersona(paths, username);
  if (!existing) {
    throw new IdentityError(
      "not_registered",
      `No registration found for '${username}'. Call register first.`,
    );
  }
  const merged: Persona = { ...existing, ...stripUndefined(patch) };
  writePersona(paths, merged);
  return merged;
}

export function stampSummoned(paths: Paths, username: string): void {
  const existing = readPersona(paths, username);
  if (!existing) return;
  existing.last_summoned_at = Date.now();
  existing.summon_count += 1;
  writePersona(paths, existing);
}

export function stampRested(
  paths: Paths,
  username: string,
  reason: string,
  sessionId: string | null,
): void {
  const existing = readPersona(paths, username);
  if (!existing) return;
  existing.last_rested_at = Date.now();
  existing.rest_reason = reason;
  if (sessionId) existing.resume_session_id = sessionId;
  writePersona(paths, existing);
}

export function personasForCwd(paths: Paths, cwd: string): Persona[] {
  return listPersonas(paths).filter((p) => p.cwd === cwd);
}

export function personasForProject(paths: Paths, project: string): Persona[] {
  return listPersonas(paths).filter((p) => p.project === project);
}

/** Guard for ENABLING a project's single-agent lock: the lock means
 * "exactly one persona", so it can only be turned on when the project
 * already holds at most one persona. With 2+ registered, refuse and name
 * them — the operator must unregister the extras first. Throws
 * `project_single_agent_conflict`. No-op on disable (count never blocks
 * unlocking). Used by BOTH the `pantheon project single-agent` CLI and
 * the `edit_project` MCP tools so the rule has one home. */
export function assertSingleAgentLockable(paths: Paths, project: string): void {
  const personas = personasForProject(paths, project);
  if (personas.length > 1) {
    const names = personas.map((p) => p.username).sort();
    throw new IdentityError(
      "project_single_agent_conflict",
      `Cannot lock project '${project}' to a single agent: ${personas.length} personas are registered ` +
        `(${names.join(", ")}). A single-agent project allows exactly one — unregister all but one first.`,
      { project, count: personas.length, personas: names },
    );
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
