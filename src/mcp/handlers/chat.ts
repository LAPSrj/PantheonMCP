import { ToolError, type Handler } from "../types.ts";

const NOT_IMPLEMENTED_NOTE =
  "Chat handlers require the chat router layer (§11c). Schemas are registered so the surface is visible; handlers will land when the chat router lands. The `<silent-event>` XML wrapper for ambient events also lives in that layer (§7).";

const notYet =
  (toolName: string): Handler =>
  async (_args, _ctx) => {
    throw new ToolError(
      "not_implemented",
      `${toolName} is not yet wired in this build. ${NOT_IMPLEMENTED_NOTE}`,
      { layer: "chat-router-§11c" },
    );
  };

export const login: Handler = notYet("login");
export const logout: Handler = notYet("logout");
export const send_message: Handler = notYet("send_message");
export const ask: Handler = notYet("ask");
export const answer: Handler = notYet("answer");
export const set_mode: Handler = notYet("set_mode");
export const update_status: Handler = notYet("update_status");
export const check_messages: Handler = notYet("check_messages");
export const list_agents: Handler = notYet("list_agents");
export const find_role: Handler = notYet("find_role");
