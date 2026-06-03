import {
  ChatError,
  getMessageById,
  getMessageBySeq,
  incarnationBase,
  promoteInPlace,
  type ChatErrorCode,
  type PromoteFields,
} from "../../chat/index.ts";
import { writeRestRequest, confirmSummon } from "../../lifecycle/index.ts";
import {
  getSchema as getRegisteredSchema,
  validatePayload,
} from "../../schemas/index.ts";
import { buildResumeSummary } from "../../resume/index.ts";
import { openChatDb } from "../../storage/index.ts";
import {
  listPersonas,
  readPersona,
  transitionClaim,
} from "../../identity/index.ts";
import { getResponseTemplate, PANTHEON_FETCH_BIN } from "../../responses/templates.ts";
import {
  writeStatuslineSidecar,
  deleteStatuslineSidecar,
} from "../../cli/statusline-sidecar.ts";
import {
  asBoolean,
  asNumber,
  asObject,
  asString,
  asStringArray,
  asStringRequired,
  type Handler,
  ToolError,
} from "../types.ts";

function requireRouter(ctx: Parameters<Handler>[1]) {
  if (!ctx.chat) {
    throw new ToolError(
      "chat_unavailable",
      "Chat router is not attached to this context. Did the MCP server boot fail to wire it?",
    );
  }
  return ctx.chat;
}

/** Pattern that recognizes UUID-shape or UUID-prefix strings (4+ hex
 * chars, possibly with hyphens). Used to detect when a caller passed
 * an `agent_id` where a `username` was expected so the error can
 * educate instead of just saying "offline." */
const AGENT_ID_LIKE = /^[0-9a-f][0-9a-f-]{3,}$/i;
const AGENT_ID_PREFIX_MIN_LEN = 4;

/** Resolve a DM `target` to one of four outcomes:
 *
 *   - `ok`: caller passed a live username, send proceeds.
 *   - `agent_id_for_username`: caller passed something that resolves
 *     to a live `agent_id` (full UUID or hex prefix matching exactly
 *     one live subscriber). We DO NOT auto-translate — pantheon's
 *     contract is that `target` is a username. The error teaches the
 *     caller the correct username and they retry.
 *   - `ambiguous_agent_id`: a hex prefix matched 2+ live subscribers.
 *   - `agent_id_not_live`: target is UUID-shaped but no live match.
 *   - `recipient_offline`: target doesn't match any of the above —
 *     treated as a plain unknown username (today's behavior).
 *
 * The "no auto-translate" decision is deliberate (Leandro): senders
 * should learn to use usernames. Accepting agent_id silently would
 * paper over the confusion. */
type DMResolution =
  | { kind: "ok" }
  | { kind: "error"; code: ChatErrorCode; message: string; extra?: Record<string, unknown> };

function resolveDMTarget(
  router: ReturnType<typeof requireRouter>,
  target: string,
  paths: Parameters<Handler>[1]["paths"] | null,
): DMResolution {
  const online = router.onlineUsernames();
  if (online.has(target.toLowerCase())) return { kind: "ok" };

  // Could the target be an agent_id (or prefix) that the caller
  // copied from a watcher line?
  if (AGENT_ID_LIKE.test(target) && target.length >= AGENT_ID_PREFIX_MIN_LEN) {
    const matches = router.findLiveByAgentIdPrefix(target);
    if (matches.length === 1) {
      const sub = matches[0]!;
      return {
        kind: "error",
        code: "agent_id_not_username",
        message:
          `'${target}' looks like an agent_id, not a username. The live subscriber ` +
          `behind that id is '${sub.username}' — pass that as \`target\` instead. ` +
          `(Pantheon DM addressing is by username, not by id — agent_ids are session-scoped ` +
          `and rotate; usernames are durable.)`,
        extra: { target, resolved_username: sub.username },
      };
    }
    if (matches.length > 1) {
      return {
        kind: "error",
        code: "ambiguous_agent_id",
        message:
          `'${target}' is an agent_id prefix that matches ${matches.length} live subscribers ` +
          `(${matches.map((s) => `'${s.username}'`).join(", ")}). Pass one of those usernames ` +
          `as \`target\` instead.`,
        extra: { target, candidates: matches.map((s) => s.username) },
      };
    }
    // UUID-shaped but no live match. Could be a stale id the caller
    // copied from history; could be a malformed username.
    return {
      kind: "error",
      code: "agent_id_not_live",
      message:
        `'${target}' looks like an agent_id but no live subscriber matches. ` +
        `Pantheon DM addressing is by username (e.g. 'righthand'), not by agent_id. ` +
        `Did the agent_id you copied belong to a session that has since exited?`,
      extra: { target },
    };
  }

  // Inverse false-offline: the bare CANONICAL handle isn't live, but
  // suffixed sibling incarnations of the SAME persona ARE (the unsuffixed
  // holder left and `reclaimCanonicalHandles` hasn't promoted a sibling
  // cross-process yet, or the persona simply never logged in unsuffixed).
  // There is genuinely no canonical session to deliver to — the send
  // fails as offline EITHER WAY — but rather than a bare "offline", name
  // the live siblings so the sender can re-address one directly. This is
  // a better message, not a delivery change. A target that is itself
  // suffixed (`righthand2`) has `incarnationBase(target) !== target`, so
  // it skips this block and falls through to the normal offline path.
  if (incarnationBase(target).toLowerCase() === target.toLowerCase()) {
    const sibs = router.liveSiblings(target).filter((s) => !s.is_canonical);
    if (sibs.length > 0) {
      const roster = sibs
        .map((s) => `'${s.username}'${s.status ? ` — ${s.status}` : ""}`)
        .join("; ");
      return {
        kind: "error",
        code: "recipient_offline",
        message:
          `'${target}' (canonical) isn't currently in chat, but ${sibs.length} sibling ` +
          `incarnation(s) of the same persona ARE live: ${roster}. There's no canonical ` +
          `session to deliver to — DM one of them directly by its exact handle ` +
          `(e.g. target:"${sibs[0]!.username}"). Pantheon has no offline-DM queue; ` +
          `nothing was persisted.`,
        extra: {
          target,
          canonical_offline: true,
          candidates: sibs.map((s) => s.username),
        },
      };
    }
  }

  // Doesn't look like an agent_id — treat as an unknown username and
  // enrich the error with what we can learn about the name from the
  // persona registry. A registered-but-offline persona is the
  // informative case ("real handle, just not connected") and changes
  // the caller's next move from "fix the typo" to "wait or fall back
  // to global broadcast". (Case mismatch is already handled upstream:
  // `onlineUsernames` lowercases both sides, so a case-mismatched
  // live target resolves as `ok` before reaching here.)
  let registered: { username: string } | null = null;
  if (paths) {
    try {
      const persona = readPersona(paths, target);
      if (persona) registered = { username: persona.username };
    } catch {
      // ignore — fall through to generic message
    }
  }
  if (registered) {
    return {
      kind: "error",
      code: "recipient_offline",
      message:
        `Cannot DM '${registered.username}' — registered persona but not currently in chat. ` +
        `Pantheon has no offline-DM queue; the message was NOT persisted. Retry once they ` +
        `connect (watch \`list_agents\`), or use \`scope:"global"\` to leave a public message ` +
        `they'll see when they next come online.`,
      extra: { target, registered: true },
    };
  }
  return {
    kind: "error",
    code: "recipient_offline",
    message:
      `Cannot DM '${target}' — not currently in chat and no registered persona by that name. ` +
      `Pantheon has no offline-DM queue; the message was NOT persisted. Likely a typo or a ` +
      `stale handle copied from old history — check \`list_agents\` for current usernames, ` +
      `or use \`scope:"project"\`/\`"global"\` to broadcast.`,
    extra: { target, registered: false },
  };
}

/** Apply the DM resolver and throw a ChatError on any non-ok
 * outcome. No-op when scope isn't `"dm"` or no target is set. */
function assertDMRecipient(
  router: ReturnType<typeof requireRouter>,
  scope: string,
  target: string | undefined,
  paths: Parameters<Handler>[1]["paths"] | null,
): void {
  if (scope !== "dm" || !target) return;
  const result = resolveDMTarget(router, target, paths);
  if (result.kind === "error") {
    throw new ChatError(result.code, result.message, result.extra ?? {});
  }
}

/** Soft clone-addressing hint for a DM that DID deliver. When `target`
 * is a bare CANONICAL handle (unsuffixed) that has live suffixed sibling
 * incarnations, the message still goes to whichever session holds the
 * unsuffixed slot — but the sender may have meant a sibling. Returns an
 * advisory string for the response `hints` array; null when there's
 * nothing to flag. Deliver-and-inform, never block — it mirrors the
 * existing project-broadcast hint pattern rather than the agent-id
 * teaching errors. A suffixed target (`righthand2`) is already specific,
 * so it's never hinted. */
function cloneAddressingHint(
  router: ReturnType<typeof requireRouter>,
  scope: string,
  target: string | undefined,
): string | null {
  if (scope !== "dm" || !target) return null;
  if (incarnationBase(target).toLowerCase() !== target.toLowerCase()) return null;
  const clones = router.liveSiblings(target).filter((s) => !s.is_canonical);
  if (clones.length === 0) return null;
  const roster = clones.map((s) => `'${s.username}'`).join(", ");
  const plural = clones.length === 1 ? "" : "s";
  return (
    `Delivered to canonical '${target}'. It has ${clones.length} live clone${plural} ` +
    `(same persona, different session${plural}): ${roster}. If this was meant for a ` +
    `sibling, re-send with the sibling's exact username.`
  );
}

/** Reject a `target` supplied on a non-`dm` send. A `target` paired
 * with `scope:"project"`/`"global"` is silently ignored by delivery —
 * the watcher's project/global visibility filter (`isVisibleRow`)
 * never reads `target_username` — so the message broadcasts to the
 * WHOLE scope instead of the one intended recipient. That is a
 * confidentiality + inbox-noise leak that looks like a successful DM
 * to the sender (the send returns ok). Catch it at the source with a
 * teaching error rather than letting the misdirected broadcast land. */
function assertTargetScopeConsistent(
  scope: string,
  target: string | undefined,
): void {
  if (target && scope !== "dm") {
    throw new ChatError(
      "target_requires_dm",
      `\`target: "${target}"\` is only valid with \`scope: "dm"\`. You sent ` +
        `\`scope: "${scope}"\`, which ignores \`target\` and broadcasts to the ` +
        `entire ${scope} scope — every agent there would see this message. ` +
        `Use \`scope: "dm", target: "${target}"\` to reach only them, or drop ` +
        `\`target\` if you intended a public broadcast.`,
      { scope, target },
    );
  }
}

/** Parse `@handle` mentions out of `text` and classify each one
 * against the live (cross-process) subscriber set. The sender's own
 * handle is dropped. Returns parallel buckets the warning helpers
 * below consume — keeping the parse in one place so we don't re-walk
 * the regex for each hint. */
type MentionScan = {
  /** Lowercased handle → the live subscriber's project, for mentions
   * that match a live user OTHER than the sender. */
  liveByProject: Map<string, string>;
  /** Lowercased handles that look like a mention but don't match any
   * live subscriber and aren't the sender. */
  unknown: Set<string>;
};

function scanMentions(
  router: ReturnType<typeof requireRouter>,
  text: string,
  senderAgentId: string,
): MentionScan {
  const liveByProject = new Map<string, string>();
  const unknown = new Set<string>();
  const self = router.getByAgentId(senderAgentId);
  const selfHandle = self?.username.toLowerCase();
  // Cross-process snapshot keyed by lowercased username → project.
  // Iterate publicList() (no project filter) so we see every project's
  // subscribers, not just the sender's.
  const liveByHandle = new Map<string, string>();
  for (const peer of router.publicList()) {
    liveByHandle.set(peer.username.toLowerCase(), peer.project);
  }
  // Conservative regex: `@<handle>` where handle starts with a letter
  // and contains only letters/digits/_-. Email addresses ("foo@bar")
  // are excluded by the leading word-boundary requirement.
  const re = /(?:^|[^\w])@([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const candidate = match[1]!.toLowerCase();
    if (selfHandle && candidate === selfHandle) continue;
    const project = liveByHandle.get(candidate);
    if (project !== undefined) {
      liveByProject.set(candidate, project);
    } else {
      unknown.add(candidate);
    }
  }
  return { liveByProject, unknown };
}

/** Heuristic warning: a project-scope broadcast addressed to exactly
 * one live peer via `@username` mention is almost always a misdirected
 * DM. Caller-decides — don't block. */
function singleMentionWarning(
  scan: MentionScan,
  senderProject: string,
): string | null {
  // Only consider mentions on the SAME project — cross-project mentions
  // have their own dedicated warning that explains the routing issue.
  const samePeers: string[] = [];
  for (const [handle, project] of scan.liveByProject) {
    if (project === senderProject) samePeers.push(handle);
  }
  if (samePeers.length !== 1) return null;
  const handle = samePeers[0]!;
  return (
    `Heuristic: project broadcast addressed to exactly one peer (@${handle}). ` +
    `If you meant to reach only them, use \`scope:"dm", target:"${handle}"\`. ` +
    `Ignore if you intended public visibility.`
  );
}

/** Warning when project-scope text @-mentions one or more live peers
 * on a DIFFERENT project. Project broadcasts never cross projects, so
 * those mentions are pure annotation — the peer won't see the message.
 * Returns a single hint listing every cross-project handle + their
 * actual project so the sender can pick the right scope to retry on. */
function crossProjectMentionWarning(
  scan: MentionScan,
  senderProject: string,
): string | null {
  const crossings: Array<{ handle: string; project: string }> = [];
  for (const [handle, project] of scan.liveByProject) {
    if (project !== senderProject) crossings.push({ handle, project });
  }
  if (crossings.length === 0) return null;
  const list = crossings
    .map((c) => `@${c.handle} (project '${c.project}')`)
    .join(", ");
  const firstHandle = crossings[0]!.handle;
  return (
    `Cross-project mention: ${list} — they are NOT subscribed to project ` +
    `'${senderProject}', so this broadcast won't reach them. Project scope ` +
    `delivers ONLY to peers on the same project; @-mentions are annotation, ` +
    `not routing. Use \`scope:"global"\` for cross-project reach, or ` +
    `\`scope:"dm", target:"${firstHandle}"\` to DM one of them directly.`
  );
}

/** Soft warning when a project-scope broadcast mentions exactly one
 * `@handle` that doesn't match any live subscriber anywhere. Almost
 * always either a typo or a DM intent against someone who's offline —
 * the broadcast will be delivered to the project as written, but the
 * mentioned peer won't be notified by name. Fires only on a single
 * unknown mention so a passing reference like "ask @bobby when he's
 * back, but @alice and @gamma should also know" doesn't trip it. */
function unknownMentionWarning(scan: MentionScan): string | null {
  // Don't double up with the cross-project / single-mention warnings.
  if (scan.liveByProject.size > 0) return null;
  if (scan.unknown.size !== 1) return null;
  const handle = [...scan.unknown][0]!;
  return (
    `Heuristic: project broadcast mentions @${handle}, but no live subscriber ` +
    `by that name is in chat. If you meant a DM, the recipient is currently ` +
    `offline (pantheon has no offline-DM queue). If you meant a public ` +
    `broadcast, check the handle spelling.`
  );
}

/** Warn when a project-scope broadcast has no other live subscribers
 * on the sender's project — the message will be persisted but no
 * watcher will pick it up. */
function emptyProjectWarning(
  router: ReturnType<typeof requireRouter>,
  senderAgentId: string,
): string | null {
  const me = router.getByAgentId(senderAgentId);
  if (!me) return null;
  const peers = router
    .publicList(me.project)
    .filter((p) => p.username.toLowerCase() !== me.username.toLowerCase());
  if (peers.length > 0) return null;
  return (
    `No other live subscribers on project '${me.project}' — this broadcast was persisted ` +
    `but no peer will see it until someone logs in. Consider DMing a specific peer, or ` +
    `posting on \`scope:"global"\` if the message warrants cross-project reach.`
  );
}

export const login: Handler = async (args, ctx) => {
  const username = asStringRequired(args.username, "username");
  const project = asStringRequired(args.project, "project");
  const status = asString(args.status) ?? "";
  const transient = asBoolean(args.transient) ?? false;
  const promote = asObject(args.promote);
  const router = requireRouter(ctx);

  // Same-session re-login idempotence guard. Without this, /compact (or
  // any bootstrap-reminder loop that re-fires `login` from a session
  // already holding a chat subscriber) walks the in-memory subscriber
  // map, sees its OWN row, hits `subscriber_taken`, and auto-suffixes
  // against itself — producing the stuck-canonical-handle accumulator
  // pattern (`<base>2`, `<base>3`, ...) where every collision is the
  // session colliding with its prior incarnation in the same MCP
  // process. The cross-MCP-process auto-suffix path (legitimate) still
  // fires below; this guard is strictly local to this MCP session.
  const existingAgentId = ctx.chat_agent_id;
  if (existingAgentId) {
    const existing = router.getByAgentId(existingAgentId);
    if (existing) {
      if (existing.username.toLowerCase() !== username.toLowerCase()) {
        throw new ToolError(
          "already_logged_in",
          `This MCP session is already logged in as '${existing.username}'. Call \`logout\` first if you really intend to switch identities — login does not silently rename.`,
          {
            current_username: existing.username,
            current_agent_id: existingAgentId,
            requested: username,
          },
        );
      }
      // Same handle, same session — return the existing subscriber.
      // Apply the caller-supplied status if it changed (mirrors
      // update_status's effect; bypasses the topic cooldown since
      // bootstrap-reminder re-logins arrive without an implicit
      // cadence).
      if (status && status !== existing.status) {
        try {
          router.update(existingAgentId, { status });
          router.markStatusChanged(existingAgentId);
        } catch {
          // best-effort — never fail an idempotent re-login on a
          // status-update hiccup.
        }
      }
      // Refresh the statusline sidecar — a re-login (e.g. post-/compact
      // re-bootstrap) may carry a fresh status, and the sidecar may
      // have been swept since the original login.
      writeStatuslineSidecar(ctx.paths, ctx.claude_session_id, {
        persona: ctx.session.claimedUsername ?? existing.username,
        chat: existing.username,
        status: existing.status ?? "",
      });
      const supportsChannels = asBoolean(args.supports_channels) ?? false;
      const claimed = ctx.session.claimedUsername;
      const resumeSummary =
        !existing.transient && claimed
          ? buildResumeSummary(ctx.paths, claimed)
          : null;
      const noteTemplate = supportsChannels ? "login-note-channels" : "login-note";
      let note: string;
      try {
        note = getResponseTemplate(noteTemplate, {
          agent_id: existing.agent_id,
          username: existing.username,
          project: existing.project,
          fetch_bin: PANTHEON_FETCH_BIN,
        });
      } catch {
        note = supportsChannels
          ? `Logged in as ${existing.username}. Channels ARE enabled — peer messages arrive inline as <channel source="pantheon" ...>...</channel> tags. No watcher needed.`
          : `Logged in as ${existing.username}. ` +
            `Run pantheon-fetch --agent-id ${existing.agent_id} --loop to start the watcher.`;
      }
      // Idempotence prelude: tell the agent this was a no-op so it
      // doesn't spawn a redundant Monitor watcher (the existing one
      // is still attached to the same agent_id).
      note =
        `Already logged in as '${existing.username}' on this MCP session — re-login is a no-op (same agent_id, same chat subscriber). ` +
        `Your existing chat watcher is still attached; do NOT spawn a second one.\n\n` +
        note;
      return {
        ok: true,
        agent_id: existing.agent_id,
        username: existing.username,
        project: existing.project,
        transient: existing.transient,
        channels_enabled: existing.supports_channels,
        promoted: false,
        already_logged_in: true,
        ...(resumeSummary
          ? { resume_summary: { ...resumeSummary, last_status: existing.status || null } }
          : {}),
        note,
      };
    }
    // ctx.chat_agent_id was set but no longer points to a live
    // subscriber (e.g. another path removed it). Clear the dangling
    // pointer and fall through to the normal add path so a fresh
    // subscriber is created cleanly.
    ctx.setChatAgentId(null);
  }

  // §10 / §11c persona-owner-allowed: when the caller has already
  // claimed this handle as a persona, the chat-add must accept it
  // (otherwise registered personas can never join chat under their
  // own name — the original bug E2E surfaced).
  let claimedPersona = ctx.session.claimedUsername;

  // Auto-claim shortcut: if the session is unclaimed AND the requested
  // username matches a registered persona whose cwd == this process's
  // cwd, claim it transparently. Lets agents skip an explicit
  // `manifest`/`claim` and go straight to `login` without hitting
  // `registered_persona` rejection. Cwd-match is the safety gate —
  // without it, any agent could claim any registered name by guessing.
  let autoClaimed = false;
  if (!claimedPersona) {
    const persona = readPersona(ctx.paths, username);
    if (persona && persona.cwd === process.cwd()) {
      try {
        transitionClaim(ctx.paths, ctx.session, username);
        claimedPersona = ctx.session.claimedUsername;
        autoClaimed = true;
      } catch {
        // best-effort — fall through to manual error path on failure
      }
    }
  }
  // The MCP server's request handler injects `supports_channels`
  // into args after detecting `claude/channel` experimental
  // capability on the client. Plumb to the subscriber so the
  // dispatch path can branch between channel push and the Monitor
  // watcher fallback.
  const supportsChannels = asBoolean(args.supports_channels) ?? false;
  let subscriber;
  let autoSuffixed: { intended: string; assigned: string } | null = null;
  try {
    subscriber = router.add({
      username,
      project,
      transient,
      status,
      supports_channels: supportsChannels,
      ...(claimedPersona === username ? { claimed_persona: claimedPersona } : {}),
    });
  } catch (err) {
    const e = err as { code?: string; message?: string; extra?: Record<string, unknown> };
    const code = e.code ?? "";
    const reason = e.extra?.["reason"] as string | undefined;

    // Auto-suffix path: when the caller is the persona-owner and the
    // exact-match conflict is "another live subscriber holds my
    // canonical handle", silently take the next sibling-incarnation
    // slot (`<base>2`, `<base>3`, ...). Persona identity stays
    // canonical — only the chat handle is suffixed. The agent gets a
    // rename-aware `note` so it knows what happened, peers see the
    // suffixed handle in the join broadcast, and the admin console
    // shows it in the roster.
    //
    // Restricted to `subscriber_taken` (exact-match): we DO NOT
    // auto-suffix `registered_persona` (handle is reserved by a
    // DIFFERENT persona — caller has no claim to it),
    // `username_prefix_collision`, or `subscriber_prefix_collision`
    // (caller's intended handle isn't <peer><N>; auto-renaming would
    // change their intent radically).
    //
    // Two shapes of caller qualify:
    //   1. canonical login — `login({username: <persona>})` with the
    //      persona claimed: `claimedPersona === username`.
    //   2. explicit-suffix login — a summoned agent whose bootstrap
    //      embeds `chat_username_suffix`, so it logs in as
    //      `<persona><N>` while its session still claims the canonical
    //      `<persona>`: `incarnationBase(username) === claimedPersona`.
    // Both walk the SAME next-free-numeric scan rooted at the CANONICAL
    // base. Scanning from the already-suffixed `username` would
    // double-concatenate (`righthand2` -> `righthand22`) instead of
    // falling through to the next sibling slot (`righthand5`).
    // `canonicalBase` is non-null only when one of the two shapes
    // applies — it doubles as the qualifying gate and the scan root.
    const canonicalBase: string | null =
      claimedPersona && claimedPersona === username
        ? claimedPersona
        : claimedPersona && incarnationBase(username) === claimedPersona
          ? claimedPersona
          : null;
    if (
      code === "username_taken" &&
      reason === "subscriber_taken" &&
      canonicalBase !== null
    ) {
      const suggested = router.nextAvailableIncarnation(canonicalBase, {
        claimed_persona: canonicalBase,
      });
      if (suggested) {
        try {
          subscriber = router.add({
            username: suggested,
            project,
            transient,
            status,
            supports_channels: supportsChannels,
            claimed_persona: canonicalBase,
          });
          // `intended` is the CANONICAL persona handle — the
          // auto-suffix note and join broadcast describe it as the
          // registry identity. For an explicit-suffix retry the
          // requested `username` was already `<persona><N>`; reporting
          // that as the canonical handle would be wrong.
          autoSuffixed = { intended: canonicalBase, assigned: suggested };
        } catch {
          // Suffix race — a peer claimed the same suffix between our
          // walk and our add. Fall through to the manual-options
          // error path below; the agent retries.
        }
      }
    }

    if (!subscriber) {
      // Enrich `username_taken` (and the related `already_registered` /
      // `username_prefix_collision`) with structured remediation
      // options when auto-suffix didn't apply or didn't succeed.
      //
      // We DO NOT auto-evict the existing session — that other
      // session may be load-bearing. Three options:
      //   1. close the OTHER session
      //   2. close THIS pane
      //   3. re-summon with --chat-username-suffix to pick a numbered alias
      if (
        code === "username_taken" ||
        code === "already_registered" ||
        code === "username_prefix_collision"
      ) {
        // Root the next-free-numeric scan on the CANONICAL base, never
        // on an already-suffixed handle — scanning from `righthand2`
        // would suggest `righthand22` (double-concat). Prefer the
        // claimed persona; otherwise strip any digit suffix off the
        // conflicting handle so a guest collision still roots cleanly.
        const conflictingHandle = (e.extra?.["conflicting"] as string | undefined) ?? username;
        const baseForSuffix = claimedPersona ?? incarnationBase(conflictingHandle);
        const suggestedSuffix = router.nextAvailableIncarnation(baseForSuffix, {
          ...(claimedPersona ? { claimed_persona: claimedPersona } : {}),
        });
        throw new ToolError(
          code,
          `Cannot log into chat as '${username}': ${e.message}`,
          {
            ...(e.extra ?? {}),
            options: [
              `Close the OTHER session (the one already chatting as '${username}'), then retry login from this pane.`,
              "Close THIS pane if the other session is the intended one.",
              suggestedSuffix
                ? `Re-summon this persona with \`--chat-username-suffix ${suggestedSuffix.slice(baseForSuffix.length)}\` (or \`--chat-username-suffix auto\`) to chat as '${suggestedSuffix}' — your persona identity stays canonical.`
                : "Re-summon this persona with `--chat-username-suffix <N>` to chat under a numbered alias.",
            ],
            ...(suggestedSuffix ? { suggested_suffix: suggestedSuffix } : {}),
            do_not_auto_logout:
              "DO NOT call `logout` — that would evict the other session, which may be doing real work.",
          },
        );
      }
      throw err;
    }
  }
  // Bind this MCP session to the new chat subscriber so subsequent
  // chat handlers (send_message, ask, set_mode, …) can resolve it
  // without re-authenticating.
  ctx.setChatAgentId(subscriber.agent_id);

  // Summon boot-verification (§14 companion): if this process was
  // spawned by a summon, confirm the matching summons row by its nonce
  // so the summoner's verify-sweep sees the agent came up. Keyed on the
  // PANTHEON_SUMMON_ID env (not the username), so it's correct even
  // when this login auto-suffixed to a sibling handle. Idempotent — a
  // presence-lapse re-login won't churn an already-confirmed row.
  // Best-effort: a confirm failure must never break login.
  const summonId = ctx.spawn_env.PANTHEON_SUMMON_ID;
  if (summonId) {
    try {
      const db = router.chatDb();
      if (db) confirmSummon(db, summonId, subscriber.agent_id);
    } catch {
      // best-effort
    }
  }

  // Tombstone reclaim broadcast (§10 / §11c).
  router.consumeTombstoneAndBroadcast(username, subscriber.agent_id);

  // Broadcast `join` system event to project scope. When the chat
  // handle was auto-suffixed (canonical handle was held by a peer),
  // include the rename marker so admin console + peers see it as a
  // sibling-incarnation rather than a fresh agent.
  const joinText = autoSuffixed
    ? `${subscriber.username} joined ${project} (sibling-incarnation of ${autoSuffixed.intended} — canonical handle held by another live session).`
    : `${subscriber.username}${transient ? "*" : ""} joined ${project}.`;
  router.addMessage({
    from_agent_id: "system",
    scope: "project",
    project,
    text: joinText,
    system: true,
    system_kind: "join",
  });

  let promoted = false;
  if (promote && transient) {
    const fields: PromoteFields = {
      project: asStringRequired(promote.project, "promote.project"),
      description: asStringRequired(promote.description, "promote.description"),
      expertise: asStringArray(promote.expertise) ?? [],
      owns: asStringArray(promote.owns) ?? [],
      ...(asString(promote.cwd) !== undefined ? { cwd: asString(promote.cwd)! } : {}),
    };
    promoteInPlace({
      paths: ctx.paths,
      router,
      agent_id: subscriber.agent_id,
      fields,
      default_cwd: process.cwd(),
      platform: ctx.platform,
    });
    promoted = true;
  }

  // §6 HIGH stale-MCP-proxy mitigation: pull the login note from
  // daemon-resolved templates so a daemon restart picks up edits.
  // When channels are enabled, swap to the channels-enabled template
  // so the agent doesn't pointlessly start a Monitor watcher.
  let note: string;
  const noteTemplate = supportsChannels ? "login-note-channels" : "login-note";
  try {
    note = getResponseTemplate(noteTemplate, {
      agent_id: subscriber.agent_id,
      username: subscriber.username,
      project: subscriber.project,
      fetch_bin: PANTHEON_FETCH_BIN,
    });
  } catch {
    note = supportsChannels
      ? `Logged in as ${subscriber.username}. Channels ARE enabled — peer messages arrive inline as <channel source="pantheon" ...>...</channel> tags. No watcher needed.`
      : `Logged in as ${subscriber.username}. ` +
        `Run pantheon-fetch --agent-id ${subscriber.agent_id} --loop to start the watcher.`;
  }
  // Auto-suffix prelude: gives the agent enough context to know it's
  // running as an incarnation rather than the canonical handle, and
  // tells the human that this was an automatic decision (not a
  // manual `--chat-username-suffix` choice). The original `note`
  // (login template) follows verbatim — the agent still gets the
  // standard channels/watcher guidance.
  if (autoSuffixed) {
    note =
      `Logged in as '${autoSuffixed.assigned}' — your canonical handle '${autoSuffixed.intended}' is currently held by another live session, ` +
      `so pantheon auto-assigned the next sibling-incarnation slot. Persona identity stays canonical (registry entry is still '${autoSuffixed.intended}'); ` +
      `only the chat-display handle is suffixed. Peers and the admin console see you as '${autoSuffixed.assigned}'. ` +
      `If the canonical handle frees up later (the other session logs out), a fresh login will reclaim it. ` +
      `No action needed — continue your work.\n\n` +
      note;
  }
  // Auto-claim prelude: when login transitioned the session from
  // `unclaimed` to `claimed_persona` on the caller's behalf, surface
  // it so the agent doesn't think they're a guest. Persona identity
  // is now canonical for this session — memory writes, rest, and
  // session_info reflect that.
  if (autoClaimed) {
    note =
      `Auto-claimed persona '${username}' (registered at this cwd). Your session is now in 'claimed_persona' state — ` +
      `memory, rest_timeout, and session_info all reflect persona identity rather than guest. ` +
      `Skipping manual \`manifest\`/\`claim\` is fine when the registered persona's cwd matches the running process; ` +
      `pantheon does the transition for you.\n\n` +
      note;
  }
  // Remanifest signal: if this process was spawned by an OLD session's
  // `remanifest` call, PANTHEON_REMANIFEST_OF carries that old session's
  // chat agent_id. Now that we (the NEW session) have successfully
  // logged in, write a rest_requests(exit) row addressed to the old.
  // The old's prune-tick will consume it and close its tab. We clear
  // the env var so a re-login during the same MCP process (e.g.
  // post-/compact) doesn't re-fire the signal.
  let remanifest_signal_sent: string | null = null;
  const remanifestOf = process.env.PANTHEON_REMANIFEST_OF;
  if (remanifestOf && router.chatDb()) {
    try {
      writeRestRequest(router.chatDb()!, {
        target_agent_id: remanifestOf,
        from_agent_id: subscriber.agent_id,
        kind: "exit",
        reason: `remanifest_complete: ${subscriber.username} is up`,
      });
      remanifest_signal_sent = remanifestOf;
    } catch {
      // Best-effort — if the write fails the old session stays alive,
      // which is a graceful failure mode (no orphan; user can close
      // the old tab manually).
    }
    // One-shot: clear so any later login() in this process doesn't
    // re-signal the (now possibly-gone) old session.
    delete process.env.PANTHEON_REMANIFEST_OF;
  }

  // Resume summary for non-guest logins — gives the agent a compact
  // view of session-relevant memory state on reconnect (audit B.5).
  // Skipped for guests (no persona file → nothing to summarize).
  const resumeSummary =
    !subscriber.transient && claimedPersona
      ? buildResumeSummary(ctx.paths, claimedPersona)
      : null;

  // Re-surface the handoff text in the login response when the agent's
  // initial bootstrap is gone (e.g. post-/compact re-bootstrap). The
  // env var is set by spawnPersona; we keep it set across logins.
  const remanifestHandoffEnv = process.env.PANTHEON_REMANIFEST_HANDOFF;

  // Statusline sidecar — drop a per-CC-session file the CC statusline
  // command can `cat` to render the tab-owner row. persona is the
  // canonical registry handle; chat is the live (possibly
  // auto-suffixed) handle; status is the current chat status.
  // Best-effort + no-op when not in a CC session.
  writeStatuslineSidecar(ctx.paths, ctx.claude_session_id, {
    persona: claimedPersona ?? subscriber.username,
    chat: subscriber.username,
    status: subscriber.status ?? "",
  });

  return {
    ok: true,
    agent_id: subscriber.agent_id,
    username: subscriber.username,
    project: subscriber.project,
    transient: subscriber.transient,
    channels_enabled: supportsChannels,
    promoted,
    ...(autoSuffixed
      ? {
          auto_suffixed: {
            intended: autoSuffixed.intended,
            assigned: autoSuffixed.assigned,
          },
        }
      : {}),
    ...(autoClaimed ? { auto_claimed: true } : {}),
    ...(resumeSummary
      ? { resume_summary: { ...resumeSummary, last_status: subscriber.status || null } }
      : {}),
    ...(remanifest_signal_sent
      ? {
          remanifest: {
            signaled_exit_to: remanifest_signal_sent,
            ...(remanifestHandoffEnv
              ? { handoff: remanifestHandoffEnv }
              : {}),
          },
        }
      : remanifestHandoffEnv
        ? { remanifest: { handoff: remanifestHandoffEnv } }
        : {}),
    note,
  };
};

export const logout: Handler = async (_args, ctx) => {
  if (ctx.block_self_exit) {
    const summoner = ctx.summoner_username ?? "your summoner";
    return {
      error: "self_exit_blocked",
      message:
        "`logout` blocked: this session was summoned with block_self_exit=true. " +
        `Only ${summoner} (or any peer via force_rest) can release you. ` +
        "Closing chat unilaterally would also defeat supervision.",
      summoner_username: ctx.summoner_username,
    };
  }
  const router = requireRouter(ctx);
  const agentId = ctx.chat_agent_id;
  if (!agentId) {
    return { ok: false, error: "not_logged_in" };
  }
  const removed = router.remove(agentId);
  if (removed) {
    router.addMessage({
      from_agent_id: "system",
      scope: "project",
      project: removed.project,
      text: `${removed.username}${removed.transient ? "*" : ""} left ${removed.project}.`,
      system: true,
      system_kind: "leave",
    });
  }
  ctx.setChatAgentId(null);
  deleteStatuslineSidecar(ctx.paths, ctx.claude_session_id);
  return { ok: true, removed: removed?.username ?? null };
};

/** Bumped from 15→60min per Yapsmith's revamp: the staleness nudge
 * was the engine of the over-broadcast pattern (52 status updates
 * from one agent in ~31h, ~5min cadence). Lengthening the threshold
 * + softening the copy is the lever — peers see current status via
 * `list_agents` so the nudge isn't load-bearing for visibility. */
export const STATUS_STALE_MS = 60 * 60 * 1000;

export const send_message: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const text = asStringRequired(args.text, "text");
  const scope = (asString(args.scope) ?? "project") as "project" | "dm" | "global";
  const target = asString(args.target);
  const replyTo = asString(args.reply_to);
  if (scope === "dm" && !target) {
    throw new ChatError("missing_target", "scope='dm' requires a target username.");
  }
  // Inverse guard: a `target` on a non-dm send is a misdirected DM —
  // reject before it broadcasts to the whole scope.
  assertTargetScopeConsistent(scope, target);
  // DM delivery contract: refuse the send when the recipient isn't
  // online (no offline-DM queue). Also catches the agent-id-as-target
  // confusion and surfaces an educational error instead of the
  // generic recipient_offline.
  assertDMRecipient(router, scope, target, ctx.paths);
  const msg = router.addMessage({
    from_agent_id: agentId,
    scope,
    text,
    // `target` only ever rides a dm-scope row — the guard above
    // rejects it on any other scope, so it can never persist stale.
    ...(scope === "dm" && target !== undefined ? { target } : {}),
    ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
  });
  // Optional staleness nudge — surfaces in the response `hints` field
  // when the sender's status hasn't changed in STATUS_STALE_MS. Copy
  // is intentionally TOPIC-vs-sub-task framing so it doesn't pull
  // agents into the per-step changelog anti-pattern the original
  // 15-min nudge produced.
  const hints: string[] = [];
  const me = router.getByAgentId(agentId);
  if (me) {
    const elapsed = Date.now() - me.status_updated_at;
    if (elapsed >= STATUS_STALE_MS) {
      const minutes = Math.round(elapsed / 60_000);
      hints.push(
        `Status unchanged for ${minutes}m. Update only if your TOPIC has shifted ` +
          `('Building auth' → 'Reviewing infra'), not for sub-tasks within the same topic. ` +
          `Otherwise leave it; peers see it via list_agents.`,
      );
    }
  }
  // Project-broadcast clarity warnings.
  if (scope === "project" && me) {
    const empty = emptyProjectWarning(router, agentId);
    if (empty) hints.push(empty);
    const scan = scanMentions(router, text, agentId);
    const crossProject = crossProjectMentionWarning(scan, me.project);
    if (crossProject) hints.push(crossProject);
    const singleMention = singleMentionWarning(scan, me.project);
    if (singleMention) hints.push(singleMention);
    const unknown = unknownMentionWarning(scan);
    if (unknown) hints.push(unknown);
  }
  // Clone-addressing soft hint: DM to a canonical handle with live
  // siblings delivered to the canonical, but flag the siblings.
  const cloneHint = cloneAddressingHint(router, scope, target);
  if (cloneHint) hints.push(cloneHint);
  return {
    ok: true,
    message_id: msg.id,
    seq: msg.seq,
    mentions: msg.mentions,
    ...(hints.length > 0 ? { hints } : {}),
  };
};

/** Caller-typed structured chat send (D.6 audit reshape).
 *
 * Posts a message with a free-form `kind` plus an arbitrary JSON
 * `payload`. Kind + payload are stored alongside the message text so
 * receivers see the kind tag in the watcher line and can pull the
 * full structured payload via `get_message`.
 *
 * Pantheon stays neutral on the value space: kinds and payload shapes
 * are owned by the consumer (e.g. a takt-starter agent registers its
 * own kinds like `pushback` / `evidence_cite`). Optional `schema_id`
 * references a registered JSON schema; validation is opt-in and
 * happens at the schema-registry layer when wired (currently
 * unimplemented — schema_id is accepted but ignored). */
export const send_structured: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const kind = asStringRequired(args.kind, "kind");
  if (!kind.trim()) {
    throw new ToolError("invalid_kind", "`kind` must be a non-empty string.");
  }
  // SystemKind values are reserved for system messages — refuse to
  // let a caller smuggle a system_kind into the user-message channel.
  const reserved = new Set([
    "join", "leave", "rename", "project_change", "status_update",
    "status_digest", "keepalive", "promotion", "handle_recycled",
    "profile_update",
  ]);
  if (reserved.has(kind)) {
    throw new ToolError(
      "reserved_kind",
      `'${kind}' is a reserved system kind. Pick a different name for your structured message kind.`,
      { reserved: Array.from(reserved) },
    );
  }
  const payload = args.payload;
  if (payload === undefined) {
    throw new ToolError(
      "missing_payload",
      "`payload` is required. Pass an object (or array, string, number, boolean, null) — pantheon stores it verbatim.",
    );
  }
  // Reject payloads that don't survive a round-trip — undefined values
  // inside an object, functions, etc. Doing the JSON.stringify here
  // also bounds the on-disk size up front rather than at persist time.
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload);
  } catch (err) {
    throw new ToolError(
      "invalid_payload",
      `Payload could not be serialized to JSON: ${(err as Error).message}`,
    );
  }
  if (payloadJson === undefined) {
    throw new ToolError(
      "invalid_payload",
      "Payload serialized to undefined (likely a bare function or symbol). Pass JSON-compatible data.",
    );
  }
  // 64 KB soft cap — keeps a single structured message from blowing
  // out the watcher buffer or chat-history table. Larger blobs belong
  // in memory `details` (5 MB) and a chat message that references the
  // memory id.
  const PAYLOAD_MAX_BYTES = 64 * 1024;
  if (Buffer.byteLength(payloadJson, "utf8") > PAYLOAD_MAX_BYTES) {
    throw new ToolError(
      "payload_too_large",
      `Payload exceeds ${PAYLOAD_MAX_BYTES} bytes. Store the bulk in memory \`details\` and reference its id in the payload.`,
      { max_bytes: PAYLOAD_MAX_BYTES },
    );
  }

  const text = asString(args.text) ?? `[${kind}]`;
  const scope = (asString(args.scope) ?? "project") as "project" | "dm" | "global";
  const target = asString(args.target);
  const replyTo = asString(args.reply_to);
  const schemaId = asString(args.schema_id);

  // Schema validation: when the caller passes a schema_id, look it up
  // in the registry and validate the payload. Unknown schema_id is a
  // hard error — the caller meant to validate but wrote a typo (or
  // hasn't registered the schema yet); silently skipping would be
  // worse than the false-negative of refusing the send.
  let schemaValidated = false;
  if (schemaId !== undefined) {
    const senderProject =
      (ctx.chat_agent_id && ctx.chat?.getSubscriberProject(ctx.chat_agent_id)) ||
      null;
    if (!senderProject) {
      throw new ToolError(
        "no_project_scope",
        "send_structured with schema_id requires a chat login (schemas are project-scoped).",
      );
    }
    const routerDb = ctx.chat?.chatDb() ?? null;
    if (!routerDb) {
      throw new ToolError(
        "no_chat_router",
        "Schema lookup requires chat.db (router has no SQLite handle).",
      );
    }
    const stored = getRegisteredSchema(routerDb, senderProject, schemaId);
    if (!stored) {
      throw new ToolError(
        "schema_not_found",
        `Schema '${schemaId}' is not registered in project '${senderProject}' (or the legacy fallback). Register it first with \`register_schema\`, or omit \`schema_id\` to send without validation.`,
        { schema_id: schemaId, project: senderProject },
      );
    }
    const errors = validatePayload(payload, stored.schema);
    if (errors.length > 0) {
      throw new ToolError(
        "schema_validation_failed",
        `Payload failed validation against schema '${schemaId}': ${errors
          .slice(0, 5)
          .map((e) => `${e.path || "/"} — ${e.message}`)
          .join("; ")}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ""}`,
        { schema_id: schemaId, errors },
      );
    }
    schemaValidated = true;
  }

  if (scope === "dm" && !target) {
    throw new ChatError("missing_target", "scope='dm' requires a target username.");
  }
  // Inverse guard: a `target` on a non-dm send is a misdirected DM —
  // reject before it broadcasts to the whole scope.
  assertTargetScopeConsistent(scope, target);
  // Same offline-DM contract as `send_message`: refuse rather than
  // silently persist a message the recipient will never see. Also
  // catches the agent-id-as-target confusion with an educational
  // error.
  assertDMRecipient(router, scope, target, ctx.paths);

  const msg = router.addMessage({
    from_agent_id: agentId,
    scope,
    text,
    user_kind: kind,
    payload,
    // `target` only ever rides a dm-scope row — the guard above
    // rejects it on any other scope, so it can never persist stale.
    ...(scope === "dm" && target !== undefined ? { target } : {}),
    ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
  });
  const hints: string[] = [];
  if (scope === "project") {
    const me = router.getByAgentId(agentId);
    if (me) {
      const empty = emptyProjectWarning(router, agentId);
      if (empty) hints.push(empty);
      const scan = scanMentions(router, text, agentId);
      const crossProject = crossProjectMentionWarning(scan, me.project);
      if (crossProject) hints.push(crossProject);
      const singleMention = singleMentionWarning(scan, me.project);
      if (singleMention) hints.push(singleMention);
      const unknown = unknownMentionWarning(scan);
      if (unknown) hints.push(unknown);
    }
  }
  // Clone-addressing soft hint (same as send_message): a DM to a
  // canonical handle with live siblings delivered, but flag the siblings.
  const cloneHint = cloneAddressingHint(router, scope, target);
  if (cloneHint) hints.push(cloneHint);
  return {
    ok: true,
    message_id: msg.id,
    seq: msg.seq,
    kind,
    mentions: msg.mentions,
    ...(schemaId !== undefined ? { schema_id: schemaId, schema_validated: schemaValidated } : {}),
    ...(hints.length > 0 ? { hints } : {}),
  };
};

export const ask: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const target = asStringRequired(args.target, "target");
  const text = asStringRequired(args.text, "text");
  const timeoutMs = asNumber(args.timeout_ms) ?? 30_000;
  // Same delivery contract as DM: ask-to-offline never resolves
  // (no peer is there to answer), so it would time out after
  // `timeout_ms` seconds with no signal. Fail fast instead — the
  // caller learns the recipient isn't around without burning the
  // timeout budget. The resolver also catches agent-id-as-target
  // confusion and emits an educational error.
  assertDMRecipient(router, "dm", target, ctx.paths);
  const result = await router.ask({
    from_agent_id: agentId,
    target_username: target,
    text,
    timeout_ms: timeoutMs,
  });
  // AskResult is already a discriminated union — answered vs timeout
  // (with reason). Surface the shape directly so callers can branch
  // on `status` + `reason`.
  if (result.status === "timeout") {
    return { status: "timeout", reason: result.reason, target };
  }
  return result;
};

export const answer: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const correlationId = asStringRequired(args.correlation_id, "correlation_id");
  const text = asStringRequired(args.text, "text");
  const msg = router.answer({
    from_agent_id: agentId,
    correlation_id: correlationId,
    text,
  });
  return { ok: true, message_id: msg.id };
};

export const set_mode: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const mode = asStringRequired(args.mode, "mode") as "all" | "quiet" | "project" | "dm";
  router.setMode(agentId, mode);
  return { mode };
};

/** 10-minute topic cooldown — per Yapsmith's chat-mcp revamp,
 * back-to-back status changes are rejected unless `confirmed: true`.
 * The rejection is the prompt to re-evaluate ("topic shift or
 * sub-task?") rather than a hard ban. */
export const STATUS_TOPIC_COOLDOWN_MS = 10 * 60 * 1000;

export const update_status: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const patch: { status?: string; project?: string; username?: string } = {};
  const status = asString(args.status);
  const project = asString(args.project);
  const username = asString(args.username);
  const confirmed = asBoolean(args.confirmed) ?? false;
  if (status !== undefined) patch.status = status;
  if (project !== undefined) patch.project = project;
  if (username !== undefined) patch.username = username;
  // §6 LOW status-with-metadata — accepts a structured `meta`
  // object; null clears. Only the supplied fields update; existing
  // metadata is preserved when meta is omitted.
  const metaArg = asObject(args.meta);
  let metaPatch: { task?: string; blocker?: string; eta?: string } | "clear" | undefined;
  if (args.meta === null) {
    metaPatch = "clear";
  } else if (metaArg !== undefined) {
    metaPatch = {};
    if (asString(metaArg.task) !== undefined) metaPatch.task = asString(metaArg.task)!;
    if (asString(metaArg.blocker) !== undefined) metaPatch.blocker = asString(metaArg.blocker)!;
    if (asString(metaArg.eta) !== undefined) metaPatch.eta = asString(metaArg.eta)!;
  }

  // Topic-cooldown gate: when the caller is changing status (not just
  // renaming/switching project, not idempotent, and there was a prior
  // user-set status to begin with), reject if the prior status was
  // set within the cooldown window. `confirmed: true` bypasses
  // ("I read the rejection and this really IS a topic shift").
  // Empty prev.status (login-default) skips — the first real status
  // is never a "rapid re-update."
  if (status !== undefined && !confirmed) {
    const prev = router.getByAgentId(agentId);
    if (prev && prev.status !== "" && prev.status !== status) {
      const elapsed = Date.now() - prev.status_updated_at;
      if (elapsed < STATUS_TOPIC_COOLDOWN_MS) {
        const remaining = STATUS_TOPIC_COOLDOWN_MS - elapsed;
        const elapsedMin = Math.round(elapsed / 60_000);
        const remainingSec = Math.round(remaining / 1000);
        throw new ToolError(
          "topic_cooldown_active",
          `topic_cooldown_active: status was last updated ${elapsedMin}m ago. ` +
            `update_status is for TOPIC shifts (e.g., "Building auth" → "Reviewing infra"), ` +
            `not for sub-tasks within the same topic. If this really is a new topic, ` +
            `re-call with confirmed:true. Otherwise leave the previous status — peers see it ` +
            `via list_agents. Cooldown ends in ~${remainingSec}s.`,
          {
            previous_status: prev.status,
            previous_status_updated_at: prev.status_updated_at,
            cooldown_remaining_ms: remaining,
          },
        );
      }
    }
  }

  const sub = router.update(agentId, patch);
  // §6 LOW status_meta — apply directly to the in-memory subscriber
  // (per-process, like supports_channels — not persisted in
  // SQLite). list_agents reads it back for dashboard rendering.
  if (metaPatch === "clear") {
    delete sub.status_meta;
  } else if (metaPatch !== undefined) {
    const prev = sub.status_meta ?? {};
    sub.status_meta = {
      ...prev,
      ...(metaPatch.task !== undefined ? { task: metaPatch.task } : {}),
      ...(metaPatch.blocker !== undefined ? { blocker: metaPatch.blocker } : {}),
      ...(metaPatch.eta !== undefined ? { eta: metaPatch.eta } : {}),
    };
  }
  // Per Yapsmith's revamp: do NOT addMessage(system_kind: "status_update")
  // here. Status changes accumulate via markStatusChanged and get
  // batched into the periodic status_digest sweep (daemon-tick).
  if (patch.status !== undefined) {
    router.markStatusChanged(agentId);
  }
  // Refresh the statusline sidecar so the CC statusline picks up the
  // new status without a chat.db read. persona/chat are unchanged
  // here; we re-derive them from the (possibly renamed) subscriber.
  writeStatuslineSidecar(ctx.paths, ctx.claude_session_id, {
    persona: ctx.session.claimedUsername ?? sub.username,
    chat: sub.username,
    status: sub.status ?? "",
  });
  return {
    username: sub.username,
    project: sub.project,
    status: sub.status,
    ...(sub.status_meta ? { meta: sub.status_meta } : {}),
  };
};

export const check_messages: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const agentId = requireAgentId(ctx);
  const limit = asNumber(args.limit) ?? 50;
  // §11c cross-process: checkMessages reads SQLite via the persisted
  // chat_cursor when a db is wired; falls back to the in-memory
  // recent buffer for in-process-only test routers.
  const result = router.checkMessages(agentId, limit);
  return {
    count: result.messages.length,
    more: result.more,
    messages: result.messages.map((m) => ({
      id: m.id,
      ts: m.ts,
      scope: m.scope,
      from_agent_id: m.from_agent_id,
      from_username_inline: m.from_username_inline ?? null,
      target: m.target ?? null,
      text: m.text,
      mentions: m.mentions,
      system_kind: m.system_kind ?? null,
      ask_id: m.ask_id ?? null,
      in_reply_to_ask: m.in_reply_to_ask ?? null,
    })),
  };
};

export const list_agents: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const project = asString(args.project);
  const list = router.publicList(project);
  return {
    count: list.length,
    agents: list,
  };
};

export const find_role: Handler = async (args, ctx) => {
  const router = requireRouter(ctx);
  const owns = asString(args.owns)?.toLowerCase();
  const expertise = asString(args.expertise)?.toLowerCase();
  const onlineOnly = asBoolean(args.online) ?? false;

  const personas = listPersonas(ctx.paths);
  // Use the cross-process presence snapshot; falls back to the
  // in-memory router map when no SQLite db is wired (test harnesses).
  const onlineUsernames = router.onlineUsernames();

  const filtered = personas.filter((p) => {
    if (onlineOnly && !onlineUsernames.has(p.username.toLowerCase())) return false;
    if (owns && !p.owns.some((o) => o.toLowerCase().includes(owns))) return false;
    if (expertise && !p.expertise.some((e) => e.toLowerCase().includes(expertise))) {
      return false;
    }
    return true;
  });

  return {
    count: filtered.length,
    personas: filtered.map((p) => ({
      username: p.username,
      project: p.project,
      description: p.description,
      expertise: p.expertise,
      owns: p.owns,
      online: onlineUsernames.has(p.username.toLowerCase()),
    })),
  };
};

function requireAgentId(ctx: Parameters<Handler>[1]): string {
  if (!ctx.chat_agent_id) {
    throw new ToolError(
      "not_logged_in",
      "This call requires a chat session — `login` first.",
    );
  }
  return ctx.chat_agent_id;
}

/** Fetch the full text of a single chat message, by `message_id` OR by
 * the monotonic `seq` (pass exactly one). The recovery path for watcher
 * events that arrived truncated — pantheon stubs oversized messages, and
 * EVERY directed watcher line carries the row's `#<seq>` in its prefix so
 * that even when the CC Monitor harness truncates the line tail (its
 * ~500-char per-line cap), the seq survives in the head and the full body
 * is one `get_message({ seq })` away. Returns the row's full text +
 * metadata; throws `not_found` if neither coordinate matches. */
export const get_message: Handler = async (args, ctx) => {
  const messageId = asString(args.message_id);
  const seq = asNumber(args.seq);
  if (messageId === undefined && seq === undefined) {
    throw new ToolError(
      "invalid_args",
      "Provide either `message_id` or `seq`.",
    );
  }
  if (messageId !== undefined && seq !== undefined) {
    throw new ToolError(
      "invalid_args",
      "Provide only one of `message_id` or `seq`, not both.",
    );
  }
  // Open the chat DB read-only via the resolved path. The router's
  // private db handle isn't exposed; opening here keeps the handler
  // self-contained and works in test harnesses that wire a router
  // without a db just as cleanly (returns null → not_found).
  let db: ReturnType<typeof openChatDb> | null = null;
  try {
    db = openChatDb(ctx.paths.chatDbPath);
  } catch {
    throw new ToolError(
      "chat_unavailable",
      "Chat database is not available for read.",
    );
  }
  try {
    const row =
      messageId !== undefined
        ? getMessageById(db, messageId)
        : getMessageBySeq(db, seq!);
    if (!row) {
      const coord =
        messageId !== undefined ? `id '${messageId}'` : `seq ${seq}`;
      throw new ToolError(
        "not_found",
        `No message with ${coord}.`,
        messageId !== undefined ? { message_id: messageId } : { seq },
      );
    }
    let parsedPayload: unknown = null;
    if (row.payload !== null && row.payload !== undefined) {
      try {
        parsedPayload = JSON.parse(row.payload);
      } catch {
        // Stored payload is not valid JSON — surface the raw string
        // rather than dropping it. Should not happen via the supported
        // write path (send_structured stringifies before insert).
        parsedPayload = row.payload;
      }
    }
    return {
      ok: true,
      id: row.id,
      seq: row.seq,
      ts: row.ts,
      scope: row.scope,
      project: row.project,
      target_username: row.target_username,
      from_agent_id: row.from_agent_id,
      from_username_inline: row.from_username_inline,
      from_transient: row.from_transient === 1,
      text: row.text,
      kind: row.kind,
      reply_to: row.reply_to,
      correlation_id: row.correlation_id,
      user_kind: row.user_kind,
      payload: parsedPayload,
    };
  } finally {
    db.close();
  }
};
