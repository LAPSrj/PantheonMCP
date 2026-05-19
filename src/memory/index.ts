export {
  type MemoryEntry,
  type MemoryStore,
  type MemoryStatus,
  type MemoryIndexEntry,
  type MemoryErrorCode,
  MemoryError,
} from "./types.ts";

export {
  appendEntry,
  getEntry,
  updateEntry,
  fadeEntry,
  forgetEntry,
  recallEntry,
  getDetails,
  setMemory,
  listIndex,
  findMemory,
  deriveSummary,
  DETAILS_MAX_BYTES,
  SUMMARY_MAX_CHARS,
  type AppendInput,
  type UpdateInput,
  type ListIndexFilter,
  type FindMemoryFilter,
  type FindMemoryHit,
} from "./operations.ts";

export {
  renderForPrompt,
  renderStore,
  type RenderOptions,
  type RenderResult,
  ACTIVE_BUDGET_BYTES,
  CORE_BUDGET_BYTES,
  CORE_HEAD_KEEP,
  CORE_TAIL_KEEP,
} from "./render.ts";

export { loadStore, mutateStore } from "./store.ts";

export {
  snapshotMemory,
  restoreMemory,
  listSnapshots,
  deleteSnapshot,
  validateLabel,
  type SnapshotMeta,
} from "./snapshots.ts";

export {
  REFERENCE_KINDS,
  forgetEntryWithLifecycleCoercion,
  type ForgetCoercionResult,
} from "./lifecycle.ts";

export {
  HANDOFF_TTL_MS,
  HANDOFF_KIND,
  defaultHandoffExpiresAt,
  buildHandoffSeed,
  expireHandoffs,
  expireHandoffsFor,
  type HandoffSeed,
} from "./handoffs.ts";
