import fs from "node:fs";
import { listPersonas } from "../identity/index.ts";
import { loadStore } from "../memory/index.ts";
import { CURRENT_SCHEMA_VERSION, openChatDb, resolvePaths, type Paths } from "../storage/index.ts";
import { listActive } from "../chat/index.ts";

/** Aggregated health-check result. `ok: false` means at least one
 * `errors` entry fired; `warnings` don't fail the check. */
export interface DoctorReport {
  ok: boolean;
  paths: Paths;
  errors: string[];
  warnings: string[];
  info: Array<{ check: string; result: string }>;
}

export function runDoctor(env: NodeJS.ProcessEnv = process.env): DoctorReport {
  const paths = resolvePaths(env);
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: DoctorReport["info"] = [];

  // 1. Paths exist (data dir is auto-created on first use; warn if absent
  // since it suggests no daemon has booted yet).
  const dataDirExists = fs.existsSync(paths.dataDir);
  info.push({ check: "data_dir", result: dataDirExists ? `present at ${paths.dataDir}` : `missing (${paths.dataDir}) — no daemon has booted in this $XDG_DATA_HOME yet` });
  if (!dataDirExists) warnings.push(`data dir missing: ${paths.dataDir}`);

  const personasDirExists = fs.existsSync(paths.personasDir);
  info.push({ check: "personas_dir", result: personasDirExists ? `present at ${paths.personasDir}` : `missing` });

  const stateDirExists = fs.existsSync(paths.stateDir);
  info.push({ check: "state_dir", result: stateDirExists ? `present at ${paths.stateDir}` : `missing` });

  // 2. Chat DB schema version.
  if (fs.existsSync(paths.chatDbPath)) {
    try {
      const db = openChatDb(paths.chatDbPath);
      try {
        const row = db
          .query("SELECT MAX(version) AS v FROM schema_version")
          .get() as { v: number | null };
        const version = row.v ?? 0;
        info.push({
          check: "chat_db_schema",
          result: `version ${version} (expected ${CURRENT_SCHEMA_VERSION})`,
        });
        if (version !== CURRENT_SCHEMA_VERSION) {
          errors.push(
            `chat.db schema version ${version} != expected ${CURRENT_SCHEMA_VERSION}; ` +
              `re-open the daemon to apply pending migrations.`,
          );
        }
        // 5. Presence: count active subscribers.
        const active = listActive(db);
        info.push({ check: "presence", result: `${active.length} active session(s)` });
      } finally {
        db.close();
      }
    } catch (err) {
      errors.push(`failed to open chat.db: ${(err as Error).message}`);
    }
  } else {
    info.push({ check: "chat_db", result: "missing — daemon has never run" });
    warnings.push(`chat.db missing: ${paths.chatDbPath}`);
  }

  // 3. Personas dir scannable; each <handle>.json parses + lints.
  if (personasDirExists) {
    try {
      const personas = listPersonas(paths);
      info.push({ check: "personas", result: `${personas.length} registered` });
      for (const persona of personas) {
        // 4. Memory file lint per persona.
        try {
          const store = loadStore(paths, persona.username);
          if (store.version !== 1) {
            errors.push(`memory file for '${persona.username}' has invalid version ${store.version}`);
          }
        } catch (err) {
          errors.push(`memory file for '${persona.username}' failed to load: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      errors.push(`personas dir scan failed: ${(err as Error).message}`);
    }
  }

  // 6. Daemon discoverability — placeholder until §15 daemon model lands.
  info.push({
    check: "daemon",
    result: "no daemon mode (single-process MCP server today; §15 future singleton not yet shipped)",
  });

  return {
    ok: errors.length === 0,
    paths,
    errors,
    warnings,
    info,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`pantheon doctor — ${report.ok ? "HEALTHY ✓" : "ISSUES ✗"}`);
  lines.push(`data root: ${report.paths.dataDir}`);
  lines.push(`state root: ${report.paths.stateDir}`);
  lines.push("");
  lines.push("Checks:");
  for (const i of report.info) {
    lines.push(`  ✓ ${i.check}: ${i.result}`);
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of report.warnings) lines.push(`  ⚠ ${w}`);
  }
  if (report.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const e of report.errors) lines.push(`  ✗ ${e}`);
  }
  return lines.join("\n") + "\n";
}
