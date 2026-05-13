import {
  IdentityError,
  PERMISSION_MODES,
  forkPersona,
  listPersonas,
  patchPersona,
  personasForCwd,
  readPersona,
  transitionBecome,
  transitionClaim,
  transitionManifest,
  transitionRegister,
  transitionUnregister,
  type PermissionMode,
} from "../../identity/index.ts";
import { loadStore } from "../../memory/index.ts";
import { buildResumeSummary } from "../../resume/index.ts";
import {
  type Handler,
  ToolError,
  asBoolean,
  asString,
  asStringArray,
  asStringRequired,
} from "../types.ts";

function isPermissionModeArg(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as readonly string[]).includes(v);
}

export const whoami: Handler = async (args, ctx) => {
  const cwd = asString(args.cwd) ?? process.cwd();
  const matches = personasForCwd(ctx.paths, cwd);
  return {
    cwd,
    matches: matches.map((p) => ({
      username: p.username,
      project: p.project,
      description: p.description,
      expertise: p.expertise,
      owns: p.owns,
    })),
    claimed_username: ctx.session.claimedUsername,
    summoned_session: ctx.summoner_username !== null,
    hint: hintFor(matches),
  };
};

function hintFor(matches: { username: string }[]): string {
  if (matches.length === 0) {
    return "No registrations for this cwd. Invent a fresh, creative, distinctive name and call `register`.";
  }
  if (matches.length === 1) {
    return `Sole registration for this cwd is '${matches[0]!.username}'. If that's you, call \`claim({ username })\`.`;
  }
  return "Multiple registrations for this cwd. Ask the human which one you are, or pass a `hint` to `manifest`.";
}

export const register: Handler = async (args, ctx) => {
  const username = asStringRequired(args.username, "username");
  const project = asStringRequired(args.project, "project");
  const cwd = asString(args.cwd) ?? process.cwd();
  const result = transitionRegister(
    ctx.paths,
    ctx.session,
    {
      username,
      project,
      cwd,
      platform: (asString(args.platform) as never) ?? ctx.platform,
      ...(asString(args.wsl_distro) !== undefined ? { wsl_distro: asString(args.wsl_distro)! } : {}),
      ...(asString(args.launch_command) !== undefined
        ? { launch_command: asString(args.launch_command)! }
        : {}),
      ...(asStringArray(args.launch_args) !== undefined
        ? { launch_args: asStringArray(args.launch_args)! }
        : {}),
      ...(asString(args.description) !== undefined
        ? { description: asString(args.description)! }
        : {}),
      ...(asStringArray(args.expertise) !== undefined
        ? { expertise: asStringArray(args.expertise)! }
        : {}),
      ...(asStringArray(args.owns) !== undefined ? { owns: asStringArray(args.owns)! } : {}),
      ...(asString(args.mode) !== undefined ? { mode: asString(args.mode) as never } : {}),
      ...(asString(args.color) !== undefined ? { color: asString(args.color) as never } : {}),
      ...(asStringArray(args.channels) !== undefined
        ? { channels: asStringArray(args.channels)! }
        : {}),
      ...(asBoolean(args.remote_control) !== undefined
        ? { remote_control: asBoolean(args.remote_control)! }
        : {}),
      ...(isPermissionModeArg(args.permission_mode)
        ? { permission_mode: args.permission_mode }
        : {}),
    },
    {
      ...(asBoolean(args.force) !== undefined ? { force: asBoolean(args.force)! } : {}),
      // §13 identity-leak fix: claim_after defaults FALSE.
      claim_after: asBoolean(args.claim_after) ?? false,
    },
  );
  return {
    persona: result.persona,
    claimed: result.claimed,
    ...(result.note ? { note: result.note } : {}),
  };
};

export const claim: Handler = async (args, ctx) => {
  const username = asStringRequired(args.username, "username");
  const persona = transitionClaim(ctx.paths, ctx.session, username);
  const memory = loadStore(ctx.paths, persona.username);
  return {
    persona,
    memory: { entries: memory.entries.length, version: memory.version },
    resume_summary: buildResumeSummary(ctx.paths, persona.username, {
      project: persona.project,
    }),
  };
};

export const manifest: Handler = async (args, ctx) => {
  const direct = asString(args.username);
  if (direct) {
    const persona = transitionClaim(ctx.paths, ctx.session, direct);
    const memory = loadStore(ctx.paths, persona.username);
    return {
      claimed: persona,
      reason: "explicit-username",
      memory_entries: memory.entries.length,
      resume_summary: buildResumeSummary(ctx.paths, persona.username, {
        project: persona.project,
      }),
    };
  }
  const cwd = asString(args.cwd) ?? process.cwd();
  const hint = asString(args.hint);
  const result = transitionManifest(ctx.paths, ctx.session, cwd, hint);
  if ("matched" in result) {
    const memory = loadStore(ctx.paths, result.matched.persona.username);
    return {
      claimed: result.matched.persona,
      reason: result.matched.reason,
      memory_entries: memory.entries.length,
      resume_summary: buildResumeSummary(
        ctx.paths,
        result.matched.persona.username,
        { project: result.matched.persona.project },
      ),
    };
  }
  if ("ambiguous" in result) {
    return {
      ambiguous: true,
      cwd,
      ...(hint ? { hint } : {}),
      candidates: result.ambiguous.matches.map((p) => ({
        username: p.username,
        description: p.description,
        expertise: p.expertise,
        owns: p.owns,
      })),
      next_step:
        "Multiple personas registered at this cwd. Pass a `hint` matching one of them, or call `claim({ username })` directly.",
    };
  }
  return {
    none: true,
    cwd,
    next_step: "No personas registered at this cwd. Invent a fresh handle and call `register`.",
  };
};

export const become: Handler = async (args, ctx) => {
  const username = asStringRequired(args.username, "username");
  const persona = transitionBecome(ctx.paths, ctx.session, username);
  const memory = loadStore(ctx.paths, persona.username);
  return {
    became: persona,
    memory_entries: memory.entries.length,
    note:
      "You're now wearing this persona for the duration of the session. cwd does NOT change — if the persona is registered at a different folder, you're 'wearing' the identity rather than physically working there.",
  };
};

export const update_profile: Handler = async (args, ctx) => {
  const username =
    asString(args.username) ??
    ctx.session.claimedUsername ??
    (() => {
      throw new ToolError("no_persona", "No claimed persona; pass `username` or call `claim` first.");
    })();
  const patch: Record<string, unknown> = {};
  if (asString(args.description) !== undefined) patch.description = asString(args.description);
  if (asStringArray(args.expertise) !== undefined) patch.expertise = asStringArray(args.expertise);
  if (asStringArray(args.owns) !== undefined) patch.owns = asStringArray(args.owns);
  if (asString(args.launch_command) !== undefined) patch.launch_command = asString(args.launch_command);
  if (asStringArray(args.launch_args) !== undefined)
    patch.launch_args = asStringArray(args.launch_args);
  if (asString(args.mode) !== undefined) patch.mode = asString(args.mode);
  if ("color" in args) patch.color = args.color === null ? null : asString(args.color);
  if (asStringArray(args.channels) !== undefined) patch.channels = asStringArray(args.channels);
  if (asBoolean(args.remote_control) !== undefined)
    patch.remote_control = asBoolean(args.remote_control);
  if ("permission_mode" in args) {
    if (args.permission_mode === null) {
      patch.permission_mode = null;
    } else if (isPermissionModeArg(args.permission_mode)) {
      patch.permission_mode = args.permission_mode;
    }
  }
  if ("wt_profile" in args) {
    if (args.wt_profile === null) {
      patch.wt_profile = null;
    } else if (typeof args.wt_profile === "string") {
      patch.wt_profile = args.wt_profile;
    }
  }
  const updated = patchPersona(ctx.paths, username, patch);

  // §6 HIGH — profile_update broadcast. When a profile-shaping field
  // changed (description/expertise/owns/color), emit a system event
  // to project peers so they can re-evaluate "who owns what" without
  // polling list_agents. The body summarizes what changed so the
  // status_digest-style ambient render is informative without
  // requiring a list call.
  const profileFieldsChanged = (
    "description" in patch ||
    "expertise" in patch ||
    "owns" in patch ||
    "color" in patch
  );
  if (profileFieldsChanged && ctx.chat) {
    const valueLines: string[] = [];
    if ("description" in patch) {
      valueLines.push(`  description: ${patch.description}`);
    }
    if ("expertise" in patch) {
      const exp = (patch.expertise as string[]) ?? [];
      valueLines.push(`  expertise: ${exp.length === 0 ? "(empty)" : exp.join(", ")}`);
    }
    if ("owns" in patch) {
      const owns = (patch.owns as string[]) ?? [];
      valueLines.push(`  owns: ${owns.length === 0 ? "(empty)" : owns.join(", ")}`);
    }
    if ("color" in patch) {
      valueLines.push(`  color: ${patch.color === null ? "(cleared)" : patch.color}`);
    }
    const broadcastText =
      valueLines.length === 0
        ? `${updated.username} updated profile.`
        : `${updated.username} updated profile:\n${valueLines.join("\n")}`;
    try {
      ctx.chat.addMessage({
        from_agent_id: "system",
        scope: "project",
        project: updated.project,
        text: broadcastText,
        system: true,
        system_kind: "profile_update",
      });
    } catch {
      // best-effort — never block update_profile on a chat hiccup
    }
  }

  // Conjure-bootstrap clear: once description / expertise / owns are all
  // supplied, drop the provisional flag.
  if (updated.provisional && updated.description && updated.expertise.length > 0 && updated.owns.length > 0) {
    return patchPersona(ctx.paths, username, { provisional: false });
  }
  return updated;
};

export const unregister: Handler = async (args, ctx) => {
  const target = asString(args.username);
  if (target && target !== ctx.session.claimedUsername) {
    // Targeting someone else's persona — direct registry delete; session
    // claim untouched.
    const existed = readPersona(ctx.paths, target) !== null;
    if (!existed) {
      throw new IdentityError("not_registered", `No registration for '${target}'.`);
    }
    const keep = asBoolean(args.keep_memory) ?? false;
    const { deletePersona } = await import("../../identity/index.ts");
    deletePersona(ctx.paths, target, { dropMemory: !keep });
    return { unregistered: target, dropped_memory: !keep };
  }
  const result = transitionUnregister(ctx.paths, ctx.session, {
    keep_memory: asBoolean(args.keep_memory) ?? false,
  });
  return { ...result, dropped_memory: !(asBoolean(args.keep_memory) ?? false) };
};

export const list: Handler = async (args, ctx) => {
  const project = asString(args.project);
  const query = asString(args.query)?.toLowerCase();
  const all = listPersonas(ctx.paths);
  const filtered = all.filter((p) => {
    if (project && p.project !== project) return false;
    if (query) {
      const hay = `${p.username}|${p.description}|${p.expertise.join("|")}|${p.owns.join("|")}|${p.project}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
  return {
    count: filtered.length,
    entries: filtered.map((p) => ({
      username: p.username,
      project: p.project,
      cwd: p.cwd,
      description: p.description,
      expertise: p.expertise,
      owns: p.owns,
      last_summoned_at: p.last_summoned_at,
      last_rested_at: p.last_rested_at,
    })),
  };
};

export const fork: Handler = async (args, ctx) => {
  const from = asStringRequired(args.from, "from");
  const to = asStringRequired(args.to, "to");
  const cwd = asStringRequired(args.cwd, "cwd");
  const copyMemory = asBoolean(args.copy_memory) ?? true;

  // Per §11c: chat-side collision check belongs here in the handler
  // (ctx.chat exposes the subscribers + tombstones). The pure
  // forkPersona() runs the registry-side check via createPersona →
  // prefixCollision; here we cross-check the chat router so we don't
  // create a registry entry that immediately collides with an
  // online subscriber under that name.
  if (ctx.chat) {
    const live = ctx.chat.getByUsername(to);
    if (live) {
      throw new ToolError(
        "username_taken",
        `Handle '${to}' is currently held by an online chat agent — choose a different name for the fork.`,
      );
    }
  }

  return forkPersona({
    paths: ctx.paths,
    from,
    to,
    cwd,
    copy_memory: copyMemory,
  });
};

export const session_info: Handler = async (_args, ctx) => {
  return {
    session_id: ctx.session.id,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    state: ctx.session.state.kind,
    claimed_username: ctx.session.claimedUsername,
    guest_username: ctx.session.guestUsername,
    is_resting: ctx.session.isResting,
    summoner_username: ctx.summoner_username,
    allow_rest_authorized: ctx.allow_rest_authorized,
  };
};
