import {
  IdentityError,
  createPersona,
  type Persona,
  type PersonaCreate,
} from "../identity/index.ts";
import type { Paths } from "../storage/index.ts";
import type { ChatRouter } from "./router.ts";
import { ChatError } from "./types.ts";

export interface PromoteFields {
  project: string;
  description: string;
  expertise: string[];
  owns: string[];
  cwd?: string;
}

/** §10 promote-in-place. Validate guest → validate fields → exclusive
 * registry create (force: false) → flip subscriber `transient: false`
 * → broadcast `system_kind: "promotion"`. agent_id stays the same;
 * chat thread is preserved; on registry race-loss the guest stays a
 * guest with no rollback (nothing else mutated). */
export function promoteInPlace(args: {
  paths: Paths;
  router: ChatRouter;
  agent_id: string;
  fields: PromoteFields;
  default_cwd: string;
  platform: PersonaCreate["platform"];
}): Persona {
  const sub = args.router.getByAgentId(args.agent_id);
  if (!sub) {
    throw new ChatError(
      "not_logged_in",
      `Agent '${args.agent_id}' is not logged in to chat.`,
    );
  }
  if (!sub.transient) {
    throw new ChatError(
      "not_a_guest",
      `Agent '${sub.username}' is already a registered persona — promote requires a guest session.`,
    );
  }
  validateFields(args.fields);

  const cwd = args.fields.cwd ?? args.default_cwd;

  let persona: Persona;
  try {
    persona = createPersona(
      args.paths,
      {
        username: sub.username,
        project: args.fields.project,
        cwd,
        platform: args.platform,
        description: args.fields.description,
        expertise: args.fields.expertise,
        owns: args.fields.owns,
      },
      { force: false },
    );
  } catch (err) {
    if (
      err instanceof IdentityError &&
      (err.code === "username_taken_other_cwd" ||
        err.code === "username_prefix_collision" ||
        err.code === "digit_suffix_reserved" ||
        err.code === "reserved_username" ||
        err.code === "invalid_username")
    ) {
      throw new ChatError(
        "already_registered",
        `Promote failed: ${err.message}`,
        { underlying: err.code, ...err.extra },
      );
    }
    throw err;
  }

  // Flip the subscriber state SECOND. Per §10 reconciler note: if this
  // half fails, the next request from agent_id sees the registry
  // entry and self-corrects.
  args.router.flipToPromoted(args.agent_id);

  // Broadcast `promotion` to project scope.
  args.router.addMessage({
    from_agent_id: "system",
    scope: "project",
    project: persona.project,
    text: `${persona.username} promoted from guest to persona (project: ${persona.project}).`,
    system: true,
    system_kind: "promotion",
    system_actor: "system",
  });

  return persona;
}

function validateFields(fields: PromoteFields): void {
  const missing: string[] = [];
  if (!fields.project || fields.project.length === 0) missing.push("project");
  if (!fields.description || fields.description.length === 0) missing.push("description");
  if (!Array.isArray(fields.expertise) || fields.expertise.length === 0) missing.push("expertise");
  if (!Array.isArray(fields.owns) || fields.owns.length === 0) missing.push("owns");
  if (missing.length > 0) {
    throw new ChatError(
      "promote_validation_failed",
      `Promote requires non-empty fields: ${missing.join(", ")}.`,
      { missing },
    );
  }
}
