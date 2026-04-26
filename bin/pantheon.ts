#!/usr/bin/env bun
/**
 * `pantheon` — multi-command CLI dispatcher.
 *
 * Subcommands:
 *   serve         Run the MCP server (stdio transport).
 *   fetch         Watcher loop — see bin/pantheon-fetch.ts for flags.
 *   doctor        Health check.
 *   dump-chat     Export chat history to JSONL.
 *   load-chat     Re-import a chat JSONL file.
 *   validate      Lint a hand-edited persona/memory JSON file.
 *
 * Exit codes (uniform across subcommands per §11d):
 *   0 success
 *   1 user error
 *   2 schema error
 *   3 daemon-not-running
 *   4 io error
 */
import { runMcpServer } from "../src/mcp/server.ts";
import { runDoctor, formatDoctorReport } from "../src/cli/doctor.ts";
import { dumpChat, rowsToJsonl } from "../src/cli/dump-chat.ts";
import { loadChat } from "../src/cli/load-chat.ts";
import { runFetch } from "../src/cli/fetch.ts";
import { runStatusline } from "../src/cli/statusline.ts";
import { validateFile, type ValidateType } from "../src/cli/validate.ts";
import { EXIT_CODES } from "../src/cli/exit-codes.ts";

const VERSION = "0.0.1";

const HELP = `pantheon — coordination layer for AI personas

Usage: pantheon <subcommand> [options]

Subcommands:
  serve                  Run the MCP server (stdio transport).
  fetch [...flags]       Watcher loop. See \`pantheon-fetch --help\`.
  doctor                 Health check on paths, schema, presence.
  dump-chat [...flags]   Export chat history to JSONL.
                         Flags: --since <ms_epoch> --persona <handle>
                                --out <file|->
  load-chat <file>       Re-import a JSONL file. SQLite assigns
                         fresh seqs; duplicate ids are skipped.
                         Flags: --dry-run
  validate <file>        Lint a hand-edited persona / memory JSON.
                         Flags: --type persona|memory
  statusline             Print a one-liner of connected agents.
                         Used by the CC plugin's statusline hook.

  --version              Print version.
  --help, -h             This message.

Exit codes: 0 success / 1 user error / 2 schema error /
            3 daemon-not-running / 4 io error
`;

function die(msg: string, code: number = EXIT_CODES.USER_ERROR): never {
  process.stderr.write(`pantheon: ${msg}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(HELP);
    process.exit(EXIT_CODES.SUCCESS);
  }
  if (sub === "--version") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(EXIT_CODES.SUCCESS);
  }

  const rest = argv.slice(1);

  switch (sub) {
    case "serve":
      await runMcpServer();
      return;

    case "fetch": {
      // Forward to the standalone watcher entry — keeps the existing
      // bin/pantheon-fetch.ts contract while letting `pantheon fetch`
      // be a discoverable subcommand. Direct in-process call —
      // no subprocess re-exec; standalone bin/pantheon-fetch.ts
      // calls into the same `runFetch` so both invocations share
      // one code path.
      const code = await runFetch({ args: rest });
      process.exit(code);
    }

    case "doctor": {
      const report = runDoctor();
      process.stdout.write(formatDoctorReport(report));
      process.exit(report.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.USER_ERROR);
    }

    case "dump-chat": {
      const opts = parseDumpChatArgs(rest);
      const dumpOpts: Parameters<typeof dumpChat>[0] = {};
      if (opts.since !== undefined) dumpOpts.since = opts.since;
      if (opts.persona !== undefined) dumpOpts.persona = opts.persona;
      const rows = dumpChat(dumpOpts);
      const jsonl = rowsToJsonl(rows);
      if (opts.out === "-" || opts.out === undefined) {
        process.stdout.write(jsonl);
      } else {
        try {
          const fs = await import("node:fs");
          fs.writeFileSync(opts.out, jsonl);
          process.stderr.write(`pantheon: wrote ${rows.length} message(s) to ${opts.out}\n`);
        } catch (err) {
          die(`failed to write ${opts.out}: ${(err as Error).message}`, EXIT_CODES.IO_ERROR);
        }
      }
      process.exit(EXIT_CODES.SUCCESS);
    }

    case "load-chat": {
      const opts = parseLoadChatArgs(rest);
      const result = loadChat(opts);
      process.stderr.write(
        `pantheon load-chat: loaded=${result.loaded} ` +
          `skipped_duplicate=${result.skipped_duplicate} ` +
          `skipped_invalid=${result.skipped_invalid}` +
          (opts.dry_run ? " (dry-run)" : "") +
          "\n",
      );
      for (const e of result.errors) {
        process.stderr.write(`  ! ${e}\n`);
      }
      const code = result.errors.length > 0
        ? EXIT_CODES.SCHEMA_ERROR
        : EXIT_CODES.SUCCESS;
      process.exit(code);
    }

    case "statusline": {
      const code = await runStatusline({ stdin: process.stdin });
      process.exit(code);
    }

    case "validate": {
      const opts = parseValidateArgs(rest);
      const r = validateFile(opts.file, opts.type);
      if (r.ok) {
        process.stdout.write(`pantheon validate: ${opts.file} (${r.type}) — VALID ✓\n`);
        process.exit(EXIT_CODES.SUCCESS);
      } else {
        process.stderr.write(`pantheon validate: ${opts.file} (${r.type}) — INVALID ✗\n`);
        for (const e of r.errors) {
          process.stderr.write(`  ✗ ${e}\n`);
        }
        process.exit(EXIT_CODES.SCHEMA_ERROR);
      }
    }

    default:
      die(`Unknown subcommand: '${sub}'. Run \`pantheon --help\`.`);
  }
}

function parseDumpChatArgs(argv: string[]): {
  since?: number;
  persona?: string;
  out?: string;
} {
  const out: { since?: number; persona?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--since": {
        const v = Number(argv[++i] ?? "");
        if (!Number.isFinite(v)) die("--since must be a number (ms epoch)");
        out.since = v;
        break;
      }
      case "--persona":
        out.persona = argv[++i] ?? "";
        if (!out.persona) die("--persona requires a value");
        break;
      case "--out":
        out.out = argv[++i] ?? "";
        if (!out.out) die("--out requires a value (file path or '-')");
        break;
      default:
        die(`Unknown dump-chat flag: ${a}`);
    }
  }
  return out;
}

function parseLoadChatArgs(argv: string[]): { file: string; dry_run: boolean } {
  let file = "";
  let dry_run = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") {
      dry_run = true;
    } else if (a.startsWith("--")) {
      die(`Unknown load-chat flag: ${a}`);
    } else if (!file) {
      file = a;
    } else {
      die(`Unexpected positional argument: ${a}`);
    }
  }
  if (!file) die("load-chat requires a file argument");
  return { file, dry_run };
}

function parseValidateArgs(argv: string[]): { file: string; type?: ValidateType } {
  let file = "";
  let type: ValidateType | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--type") {
      const t = argv[++i];
      if (t !== "persona" && t !== "memory") die("--type must be persona|memory");
      type = t;
    } else if (a.startsWith("--")) {
      die(`Unknown validate flag: ${a}`);
    } else if (!file) {
      file = a;
    } else {
      die(`Unexpected positional argument: ${a}`);
    }
  }
  if (!file) die("validate requires a file argument");
  if (type !== undefined) {
    return { file, type };
  }
  return { file };
}

main().catch((err) => {
  process.stderr.write(`pantheon: fatal: ${(err as Error).message ?? String(err)}\n`);
  process.exit(EXIT_CODES.USER_ERROR);
});
