import fs from "node:fs";
import { openChatDb, resolvePaths } from "../storage/index.ts";
import type { JsonlRow } from "./dump-chat.ts";

export interface LoadChatOptions {
  file: string;
  /** When true, parses + validates rows but doesn't write. */
  dry_run?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface LoadChatResult {
  loaded: number;
  skipped_duplicate: number;
  skipped_invalid: number;
  errors: string[];
}

/** Re-import a dump-chat JSONL file. Per semaphoremole: caller-
 * supplied `seq` is IGNORED (SQLite assigns a fresh monotonic seq
 * via the COALESCE pattern in persistMessage). All other fields —
 * `id`, `ts`, `correlation_id`, `reply_to`, etc. — are preserved
 * verbatim. Duplicate `id` rows are SKIPPED (they're already in
 * the table; idempotent re-import). */
export function loadChat(options: LoadChatOptions): LoadChatResult {
  const result: LoadChatResult = {
    loaded: 0,
    skipped_duplicate: 0,
    skipped_invalid: 0,
    errors: [],
  };

  if (!fs.existsSync(options.file)) {
    result.errors.push(`File not found: ${options.file}`);
    return result;
  }
  const raw = fs.readFileSync(options.file, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const rows: JsonlRow[] = [];
  lines.forEach((line, idx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      result.skipped_invalid++;
      result.errors.push(`line ${idx + 1}: JSON parse failed: ${(err as Error).message}`);
      return;
    }
    const validation = validateJsonlRow(parsed);
    if (!validation.ok) {
      result.skipped_invalid++;
      result.errors.push(`line ${idx + 1}: ${validation.error}`);
      return;
    }
    rows.push(validation.row);
  });

  if (options.dry_run) return result;

  const paths = resolvePaths(options.env ?? process.env);
  const db = openChatDb(paths.chatDbPath);
  try {
    for (const row of rows) {
      // Check existing id to honor idempotent re-import semantics.
      // (PRIMARY KEY on `id` would also catch this but we want a
      // reportable count of skips, not an exception.)
      const existing = db
        .query("SELECT 1 AS x FROM messages WHERE id = ?")
        .get(row.id) as { x: number } | undefined;
      if (existing) {
        result.skipped_duplicate++;
        continue;
      }
      // Fresh seq via SELECT COALESCE(MAX(seq), 0) + 1 inside a
      // transaction (cross-process safe per the §11c design).
      db.transaction(() => {
        const next = db
          .query("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM messages")
          .get() as { s: number };
        db.run(
          `INSERT INTO messages (
             id, seq, ts, scope, project, target_username,
             from_agent_id, from_transient, from_username_inline,
             text, kind, reply_to, correlation_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            next.s,
            row.ts,
            row.scope,
            row.project,
            row.target_username,
            row.from_agent_id,
            row.from_transient,
            row.from_username_inline,
            row.text,
            row.kind,
            row.reply_to,
            row.correlation_id,
          ],
        );
      })();
      result.loaded++;
    }
  } finally {
    db.close();
  }

  return result;
}

interface ValidationResult {
  ok: boolean;
  error?: string;
  row: JsonlRow;
}

function validateJsonlRow(value: unknown): ValidationResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "row is not an object", row: {} as JsonlRow };
  }
  const v = value as Record<string, unknown>;
  for (const field of ["id", "ts", "scope", "from_agent_id", "text"] as const) {
    if (!(field in v)) {
      return { ok: false, error: `missing required field '${field}'`, row: {} as JsonlRow };
    }
  }
  if (typeof v.id !== "string") return { ok: false, error: "id must be string", row: {} as JsonlRow };
  if (typeof v.ts !== "number") return { ok: false, error: "ts must be number", row: {} as JsonlRow };
  if (typeof v.scope !== "string") return { ok: false, error: "scope must be string", row: {} as JsonlRow };
  if (typeof v.from_agent_id !== "string") return { ok: false, error: "from_agent_id must be string", row: {} as JsonlRow };
  if (typeof v.text !== "string") return { ok: false, error: "text must be string", row: {} as JsonlRow };
  return {
    ok: true,
    row: {
      id: v.id,
      ts: v.ts,
      scope: v.scope,
      project: (v.project as string | null) ?? null,
      target_username: (v.target_username as string | null) ?? null,
      from_agent_id: v.from_agent_id,
      from_transient: typeof v.from_transient === "number" ? v.from_transient : 0,
      from_username_inline: (v.from_username_inline as string | null) ?? null,
      text: v.text,
      kind: (v.kind as string | null) ?? null,
      reply_to: (v.reply_to as string | null) ?? null,
      correlation_id: (v.correlation_id as string | null) ?? null,
    },
  };
}
