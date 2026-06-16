import { test, expect } from "bun:test";
import { TOOLS } from "../tools.ts";

test("TOOLS includes the full surface (no missing names from §11b)", () => {
  const names = new Set(TOOLS.map((t) => t.name));
  const required = [
    // identity
    "whoami",
    "register",
    "claim",
    "manifest",
    "become",
    "update_profile",
    "unregister",
    "list",
    "session_info",
    // memory
    "get_memory",
    "append_memory",
    "update_memory",
    "set_memory",
    "recall_memory",
    "fade_memory",
    "forget_memory",
    "list_memory",
    // spawn
    "summon",
    "summon_any",
    "conjure",
    "conjure_any",
    // lifecycle
    "allow_rest",
    "rest",
    "extend_rest",
    "exit",
    // chat
    "login",
    "logout",
    "send_message",
    "ask",
    "answer",
    "set_mode",
    "update_status",
    "check_messages",
    "list_agents",
    "find_role",
  ];
  for (const name of required) {
    expect(names.has(name)).toBe(true);
  }
});

test("every tool has a non-empty description and an inputSchema object", () => {
  for (const t of TOOLS) {
    expect(t.description.length).toBeGreaterThan(0);
    expect(typeof t.inputSchema).toBe("object");
    expect(t.inputSchema.type).toBe("object");
  }
});

test("the deprecated idle aliases are fully removed", () => {
  for (const name of ["allow_idle", "idle", "extend_idle"]) {
    expect(TOOLS.find((t) => t.name === name)).toBeUndefined();
  }
});

test("register schema notes claim_after defaults FALSE (identity-leak fix)", () => {
  const register = TOOLS.find((t) => t.name === "register")!;
  expect(register.description).toContain("identity-leak fix");
  const props = register.inputSchema.properties as Record<string, { description?: string }>;
  expect(props.claim_after?.description).toContain("DEFAULT FALSE");
});
