export {
  type Persona,
  type PersonaPatch,
  type PersonaCreate,
  type Platform,
  type SummonMode,
  type ClaudeColor,
  type IdentityErrorCode,
  type PermissionMode,
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  IdentityError,
} from "./types.ts";

export {
  validateUsername,
  readPersona,
  listPersonas,
  writePersona,
  deletePersona,
  prefixCollision,
  createPersona,
  patchPersona,
  stampSummoned,
  stampRested,
  personasForCwd,
} from "./registry.ts";

export { Session, type SessionState } from "./session-state.ts";

export {
  transitionClaim,
  transitionManifest,
  transitionRegister,
  transitionBecome,
  transitionUnregister,
  transitionPromote,
  transitionLoginGuest,
  transitionRestEnter,
  transitionRestExit,
  type ManifestResult,
  type ManifestMatch,
  type ManifestAmbiguous,
  type RegisterOptions,
  type RegisterResult,
} from "./transitions.ts";

export {
  forkPersona,
  type ForkOptions,
  type ForkResult,
} from "./fork.ts";
