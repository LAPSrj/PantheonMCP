import {
  isProjectSingleAgent,
  readProjectConfig,
  resolvePaths,
  setProjectSingleAgent,
  setProjectDescription,
} from "../storage/index.ts";
import { assertSingleAgentLockable, IdentityError } from "../identity/index.ts";
import { EXIT_CODES } from "./exit-codes.ts";

const USAGE = `pantheon project — per-project policy

Usage:
  pantheon project single-agent <project> [--off]
      Lock <project> to a single persona (one persona, many sessions).
      Pass --off to unlock. Enabling requires the project to already hold
      at most ONE persona — unregister the extras first. Once locked,
      every persona-creation path (register / conjure / summon / fork /
      merge / promote) is refused while a persona already exists, and
      sessions in the project see a trimmed MCP tool surface.

  pantheon project describe <project> <text...>
      Set the project's ≤160-char description. Pass --clear to remove it.

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
      if (!off) {
        try {
          assertSingleAgentLockable(paths, project);
        } catch (err) {
          if (err instanceof IdentityError) {
            process.stderr.write(`pantheon project: ${err.message}\n`);
            return EXIT_CODES.USER_ERROR;
          }
          throw err;
        }
      }
      setProjectSingleAgent(paths, project, !off);
      process.stdout.write(
        `pantheon: project '${project}' single_agent=${!off}\n`,
      );
      return EXIT_CODES.SUCCESS;
    }

    case "describe": {
      const project = args[1];
      if (!project || project.startsWith("-")) {
        process.stderr.write("pantheon project: describe requires a <project> name\n");
        return EXIT_CODES.USER_ERROR;
      }
      const rest = args.slice(2);
      const clear = rest.includes("--clear");
      const text = clear ? null : rest.filter((a) => a !== "--clear").join(" ");
      if (!clear && (text === null || text.length === 0)) {
        process.stderr.write("pantheon project: describe requires <text...> or --clear\n");
        return EXIT_CODES.USER_ERROR;
      }
      try {
        setProjectDescription(paths, project, text);
      } catch (err) {
        process.stderr.write(`pantheon project: ${(err as Error).message}\n`);
        return EXIT_CODES.USER_ERROR;
      }
      process.stdout.write(
        clear
          ? `pantheon: project '${project}' description cleared\n`
          : `pantheon: project '${project}' description set\n`,
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
          `  description: ${cfg.description ?? "(none)"}\n` +
          `  config: ${JSON.stringify(cfg)}\n`,
      );
      return EXIT_CODES.SUCCESS;
    }

    default:
      process.stderr.write(`pantheon project: unknown action '${sub}'. Run \`pantheon project --help\`.\n`);
      return EXIT_CODES.USER_ERROR;
  }
}
