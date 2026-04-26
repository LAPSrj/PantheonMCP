import type { Handler } from "../types.ts";
import * as identity from "./identity.ts";
import * as memory from "./memory.ts";
import * as lifecycle from "./lifecycle.ts";
import * as spawn from "./spawn.ts";
import * as chat from "./chat.ts";

/** Single registry of every implemented handler keyed by tool name.
 * Tools with no handler entry surface as `unknown_tool` from dispatch. */
export const HANDLERS: Record<string, Handler> = {
  // Identity
  whoami: identity.whoami,
  register: identity.register,
  claim: identity.claim,
  manifest: identity.manifest,
  become: identity.become,
  update_profile: identity.update_profile,
  unregister: identity.unregister,
  list: identity.list,
  fork: identity.fork,
  session_info: identity.session_info,

  // Memory
  get_memory: memory.get_memory,
  append_memory: memory.append_memory,
  update_memory: memory.update_memory,
  set_memory: memory.set_memory,
  recall_memory: memory.recall_memory,
  fade_memory: memory.fade_memory,
  forget_memory: memory.forget_memory,
  list_memory: memory.list_memory,
  find_memory: memory.find_memory,
  get_memory_details: memory.get_memory_details,
  snapshot_memory: memory.snapshot_memory,
  restore_memory: memory.restore_memory,
  list_snapshots: memory.list_snapshots,
  delete_snapshot: memory.delete_snapshot,

  // Lifecycle (rest family)
  allow_rest: lifecycle.allow_rest,
  rest: lifecycle.rest,
  extend_rest: lifecycle.extend_rest,
  exit: lifecycle.exit,
  // Legacy aliases (deprecated; one-release migration window).
  allow_idle: lifecycle.allow_idle,
  idle: lifecycle.idle,
  extend_idle: lifecycle.extend_idle,

  // Spawn (stubs — §11a)
  summon: spawn.summon,
  summon_any: spawn.summon_any,
  conjure: spawn.conjure,
  conjure_any: spawn.conjure_any,

  // Chat (stubs — §11c)
  login: chat.login,
  logout: chat.logout,
  send_message: chat.send_message,
  ask: chat.ask,
  answer: chat.answer,
  set_mode: chat.set_mode,
  update_status: chat.update_status,
  check_messages: chat.check_messages,
  list_agents: chat.list_agents,
  find_role: chat.find_role,
};
