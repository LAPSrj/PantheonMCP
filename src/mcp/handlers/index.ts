import type { Handler } from "../types.ts";
import * as identity from "./identity.ts";
import * as memory from "./memory.ts";
import * as lifecycle from "./lifecycle.ts";
import * as spawn from "./spawn.ts";
import * as chat from "./chat.ts";
import * as schemas from "./schemas.ts";

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
  // Cross-session force_rest / force_exit (companion to block_self_exit).
  force_rest: lifecycle.force_rest,
  force_exit: lifecycle.force_exit,
  force_rest_any: lifecycle.force_rest_any,
  force_exit_any: lifecycle.force_exit_any,
  // Legacy aliases (deprecated; one-release migration window).
  allow_idle: lifecycle.allow_idle,
  idle: lifecycle.idle,
  extend_idle: lifecycle.extend_idle,

  // Spawn (§11a)
  summon: spawn.summon,
  summon_any: spawn.summon_any,
  conjure: spawn.conjure,
  conjure_any: spawn.conjure_any,

  // Chat (§11c)
  login: chat.login,
  logout: chat.logout,
  send_message: chat.send_message,
  send_structured: chat.send_structured,
  ask: chat.ask,
  answer: chat.answer,
  set_mode: chat.set_mode,
  update_status: chat.update_status,
  check_messages: chat.check_messages,
  list_agents: chat.list_agents,
  find_role: chat.find_role,
  get_message: chat.get_message,

  // Schema registry
  register_schema: schemas.register_schema,
  unregister_schema: schemas.unregister_schema,
  list_schemas: schemas.list_schemas,
  get_schema: schemas.get_schema,
};
