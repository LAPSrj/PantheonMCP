import {
  isProjectSingleAgent,
  readProjectConfig,
  resolvePaths,
  setProjectSingleAgent,
} from "../storage/index.ts";
import { EXIT_CODES } from "./exit-codes.ts";

const USAGE = `pantheon project — per-project policy

Usage:
  pantheon project single-agent <project> [--off]
      Lock <project> to a single persona (one persona, many sessions).
      Pass --off to unlock. Once locked, every persona-creation path
      (register / conjure / summon / fork / merge / promote) is refused
      while a persona already exists, and sessions in the project see a
      trimmed MCP tool surface.

  pantheon project show <project>
      Print the project's config.
`;

/** `pantheon project ...` — manage per-project policy. Returns a
 * process exit code. */
export async function runProject({ args }: { args: string[] }): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(USAGE);
    return EXIT_CODES.SUCCESS;
  }

  const paths = resolvePaths();

  switch (sub) {
    case "single-agent": {
      const project = args[1];
      if (!project || project.startsWith("-")) {
        process.stderr.write("pantheon project: single-agent requires a <project> name\n");
        return EXIT_CODES.USER_ERROR;
      }
      const off = args.slice(2).includes("--off");
      setProjectSingleAgent(paths, project, !off);
      process.stdout.write(
        `pantheon: project '${project}' single_agent=${!off}\n`,
      );
      return EXIT_CODES.SUCCESS;
    }

    case "show": {
      const project = args[1];
      if (!project) {
        process.stderr.write("pantheon project: show requires a <project> name\n");
        return EXIT_CODES.USER_ERROR;
      }
      const cfg = readProjectConfig(paths, project);
      process.stdout.write(
        `project '${project}':\n` +
          `  single_agent: ${isProjectSingleAgent(paths, project)}\n` +
          `  config: ${JSON.stringify(cfg)}\n`,
      );
      return EXIT_CODES.SUCCESS;
    }

    default:
      process.stderr.write(`pantheon project: unknown action '${sub}'. Run \`pantheon project --help\`.\n`);
      return EXIT_CODES.USER_ERROR;
  }
}
