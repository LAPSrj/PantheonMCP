import type { Handler } from "../types.ts";
import * as identity from "./identity.ts";
import * as memory from "./memory.ts";
import * as lifecycle from "./lifecycle.ts";
import * as spawn from "./spawn.ts";
import * as chat from "./chat.ts";
import * as schemas from "./schemas.ts";
import * as projectMemory from "./project-memory.ts";
import * as history from "./history.ts";
import * as remanifestMod from "./remanifest.ts";
import * as dreamMod from "./dream.ts";
import * as watcher from "./watcher.ts";
import * as project from "./project.ts";

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
  merge: identity.merge,
  session_info: identity.session_info,

  // Memory (personal — SELF-ONLY; cross-persona reads are the `_any` variants)
  get_memory: memory.get_memory,
  get_memory_any: memory.get_memory_any,
  list_topics: memory.list_topics,
  load_memory: memory.load_memory,
  get_instructions: memory.get_instructions,
  append_memory: memory.append_memory,
  update_memory: memory.update_memory,
  amend_memory: memory.amend_memory,
  set_memory: memory.set_memory,
  recall_memory: memory.recall_memory,
  recall_memory_any: memory.recall_memory_any,
  fade_memory: memory.fade_memory,
  forget_memory: memory.forget_memory,
  list_memory: memory.list_memory,
  list_memory_any: memory.list_memory_any,
  find_memory: memory.find_memory,
  find_memory_any: memory.find_memory_any,
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

  // Project memory (shared across all agents in a project)
  append_project_memory: projectMemory.append_project_memory,
  append_project_memory_any: projectMemory.append_project_memory_any,
  update_project_memory: projectMemory.update_project_memory,
  update_project_memory_any: projectMemory.update_project_memory_any,
  forget_project_memory: projectMemory.forget_project_memory,
  forget_project_memory_any: projectMemory.forget_project_memory_any,
  fade_project_memory: projectMemory.fade_project_memory,
  fade_project_memory_any: projectMemory.fade_project_memory_any,
  restore_project_memory: projectMemory.restore_project_memory,
  restore_project_memory_any: projectMemory.restore_project_memory_any,
  get_project_memory: projectMemory.get_project_memory,
  get_project_memory_any: projectMemory.get_project_memory_any,
  recall_project_memory: projectMemory.recall_project_memory,
  recall_project_memory_any: projectMemory.recall_project_memory_any,
  list_project_memory: projectMemory.list_project_memory,
  list_project_memory_any: projectMemory.list_project_memory_any,
  get_project_memory_details: projectMemory.get_project_memory_details,
  get_project_memory_details_any: projectMemory.get_project_memory_details_any,

  // Conversation-history search (CC JSONLs — NOT durable storage)
  list_conversations: history.list_conversations,
  list_conversations_any: history.list_conversations_any,
  search_history: history.search_history,
  search_history_any: history.search_history_any,
  get_history_message: history.get_history_message,
  get_history_message_any: history.get_history_message_any,
  get_history_conversation: history.get_history_conversation,
  get_history_conversation_any: history.get_history_conversation_any,
  validate_user_quote: history.validate_user_quote,

  // Remanifest (spawn fresh incarnation of self; old exits when new logs in)
  remanifest: remanifestMod.remanifest,

  // Dream (librarian-driven memory cleanup; persona or project)
  dream: dreamMod.dream,

  // Watcher kind (orphan-detected watch lanes — arm/claim/close)
  arm_watcher: watcher.arm_watcher,
  claim_watcher: watcher.claim_watcher,
  close_watcher: watcher.close_watcher,

  // Project policy (list / edit description + single-agent lock)
  list_projects_any: project.list_projects_any,
  edit_project: project.edit_project,
  edit_project_any: project.edit_project_any,
};
