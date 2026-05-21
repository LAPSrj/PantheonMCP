export {
  type DreamScope,
  type DreamPlan,
  type DreamPlanFade,
  type DreamPlanForget,
  type DreamPlanConsolidate,
  type DreamApplyResult,
  type DreamErrorCode,
  DreamError,
} from "./types.ts";

export {
  type Librarian,
  type LibrarianSnapshot,
  type LibrarianOptions,
  ClaudeCliLibrarian,
  DREAM_PLAN_SCHEMA,
  defaultLibrarianTimeout,
  parseAndValidateLibrarianOutput,
} from "./librarian.ts";

export {
  buildPersonaSnapshot,
  buildProjectSnapshot,
  applyPersonaPlan,
  applyProjectPlan,
  REFERENCE_KINDS,
  MAX_SNAPSHOT_ENTRIES,
  MAX_SNAPSHOT_BYTES,
  summarizePlan,
} from "./apply.ts";
