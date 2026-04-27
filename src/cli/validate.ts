import fs from "node:fs";
import { readJson } from "../storage/index.ts";
import type { Persona } from "../identity/index.ts";
import type { MemoryEntry, MemoryStore } from "../memory/index.ts";

/** Lint a hand-edited persona or memory JSON file. Returns a list
 * of human-readable errors (empty list = valid). */
export interface ValidateResult {
  ok: boolean;
  type: "persona" | "memory";
  errors: string[];
}

export type ValidateType = "persona" | "memory";

/** Detect file type from filename when `--type` isn't supplied. */
export function detectType(filePath: string): ValidateType | null {
  if (filePath.endsWith("memory.json")) return "memory";
  if (filePath.includes("/personas/") && filePath.endsWith(".json")) return "persona";
  return null;
}

export function validateFile(
  filePath: string,
  override?: ValidateType,
): ValidateResult {
  const type = override ?? detectType(filePath);
  if (!type) {
    return {
      ok: false,
      type: "persona",
      errors: [
        `Cannot detect file type from path '${filePath}'. ` +
          `Pass --type persona|memory.`,
      ],
    };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, type, errors: [`File not found: ${filePath}`] };
  }
  let data: unknown;
  try {
    data = readJson<unknown>(filePath);
  } catch (err) {
    return {
      ok: false,
      type,
      errors: [`Failed to parse JSON: ${(err as Error).message}`],
    };
  }
  if (data === null) {
    return { ok: false, type, errors: ["File is empty."] };
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, type, errors: ["Top-level value must be a JSON object."] };
  }
  const errors =
    type === "persona"
      ? validatePersonaShape(data as Record<string, unknown>)
      : validateMemoryShape(data as Record<string, unknown>);
  return { ok: errors.length === 0, type, errors };
}

const PERSONA_REQUIRED: Array<keyof Persona> = [
  "username",
  "project",
  "cwd",
  "platform",
  "launch_command",
  "launch_args",
  "description",
  "expertise",
  "owns",
  "mode",
  "registered_at",
  "registered_by_pid",
];

const PERSONA_PLATFORMS = new Set(["wsl", "windows", "mac", "linux"]);
const PERSONA_MODES = new Set(["fresh", "resume"]);

function validatePersonaShape(p: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const field of PERSONA_REQUIRED) {
    if (!(field in p)) errors.push(`missing required field '${String(field)}'`);
  }
  if (typeof p.username === "string" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(p.username)) {
    errors.push(`username '${p.username}' violates the 1-48 char alphanumeric/_/- rule`);
  }
  if (typeof p.platform === "string" && !PERSONA_PLATFORMS.has(p.platform)) {
    errors.push(`platform '${p.platform}' must be one of ${[...PERSONA_PLATFORMS].join("/")}`);
  }
  if (typeof p.mode === "string" && !PERSONA_MODES.has(p.mode)) {
    errors.push(`mode '${p.mode}' must be 'fresh' or 'resume'`);
  }
  if (Array.isArray(p.expertise)) {
    for (const e of p.expertise) {
      if (typeof e !== "string") errors.push("expertise entries must be strings");
    }
  } else if ("expertise" in p) {
    errors.push("expertise must be an array of strings");
  }
  if (Array.isArray(p.owns)) {
    for (const o of p.owns) {
      if (typeof o !== "string") errors.push("owns entries must be strings");
    }
  } else if ("owns" in p) {
    errors.push("owns must be an array of strings");
  }
  if (typeof p.last_summoned_at !== "number" && p.last_summoned_at !== null && p.last_summoned_at !== undefined) {
    errors.push("last_summoned_at must be number | null");
  }
  if ("channels" in p) {
    if (!Array.isArray(p.channels)) {
      errors.push("channels must be an array of strings if present");
    } else {
      for (const c of p.channels as unknown[]) {
        if (typeof c !== "string") errors.push("channels entries must be strings");
      }
    }
  }
  if ("remote_control" in p && typeof p.remote_control !== "boolean") {
    errors.push("remote_control must be boolean if present");
  }
  if ("permission_mode" in p && p.permission_mode !== null) {
    const valid = ["default", "acceptEdits", "plan", "bypassPermissions"];
    if (typeof p.permission_mode !== "string" || !valid.includes(p.permission_mode)) {
      errors.push(
        "permission_mode must be one of: default, acceptEdits, plan, bypassPermissions, or null",
      );
    }
  }
  return errors;
}

function validateMemoryShape(s: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (s.version !== 1) {
    errors.push(`version must be 1; got ${JSON.stringify(s.version)}`);
  }
  if (!Array.isArray(s.entries)) {
    errors.push("entries must be an array");
    return errors;
  }
  const entries = s.entries as unknown[];
  const ids = new Set<string>();
  entries.forEach((raw, idx) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`entries[${idx}]: must be an object`);
      return;
    }
    const e = raw as Record<string, unknown>;
    for (const field of ["id", "date", "summary", "text", "status"] as const) {
      if (!(field in e)) errors.push(`entries[${idx}]: missing required field '${field}'`);
    }
    if (typeof e.id !== "string" || e.id.length === 0) {
      errors.push(`entries[${idx}]: id must be non-empty string`);
    } else if (ids.has(e.id)) {
      errors.push(`entries[${idx}]: duplicate id '${e.id}'`);
    } else {
      ids.add(e.id);
    }
    if (typeof e.summary === "string" && e.summary.length > 240) {
      errors.push(`entries[${idx}] (id=${e.id}): summary > 240 chars (cap)`);
    }
    if (typeof e.details === "string" && Buffer.byteLength(e.details, "utf8") > 5 * 1024 * 1024) {
      errors.push(`entries[${idx}] (id=${e.id}): details > 5 MB (cap)`);
    }
    if (
      typeof e.status === "string" &&
      !["active", "faded", "forgotten"].includes(e.status)
    ) {
      errors.push(`entries[${idx}] (id=${e.id}): status must be active/faded/forgotten`);
    }
    if ("core" in e && typeof e.core !== "boolean") {
      errors.push(`entries[${idx}] (id=${e.id}): core must be boolean if present`);
    }
  });
  // Suppress unused type warnings on the imports — they're for documentation.
  void undefined as Persona | MemoryEntry | MemoryStore | undefined;
  return errors;
}
