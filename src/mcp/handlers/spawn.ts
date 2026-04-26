import { ToolError, type Handler } from "../types.ts";

const NOT_IMPLEMENTED_NOTE =
  "Spawn-family handlers (summon / summon_any / conjure / conjure_any) require the launcher adapters layer (§11a). Schemas are registered so the surface is visible; handlers will land when launcher adapters do.";

const notYet =
  (toolName: string): Handler =>
  async (_args, _ctx) => {
    throw new ToolError(
      "not_implemented",
      `${toolName} is not yet wired in this build. ${NOT_IMPLEMENTED_NOTE}`,
      { layer: "launcher-adapters-§11a" },
    );
  };

export const summon: Handler = notYet("summon");
export const summon_any: Handler = notYet("summon_any");
export const conjure: Handler = notYet("conjure");
export const conjure_any: Handler = notYet("conjure_any");
