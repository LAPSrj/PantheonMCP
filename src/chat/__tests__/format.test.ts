import { test, expect } from "bun:test";
import {
  guestMarker,
  modeMarker,
  priorityTag,
  renderSender,
  SILENT_KINDS,
  wrapSilentEvent,
} from "../format.ts";
import type { Message, Subscriber } from "../types.ts";

function msg(over: Partial<Message> & Pick<Message, "id" | "from_agent_id" | "scope" | "text">): Message {
  return {
    seq: 1,
    ts: 0,
    mentions: [],
    from_project: "p",
    from_username_inline: null,
    ...over,
  } as Message;
}

function sub(over: Partial<Subscriber> & { username: string }): Subscriber {
  return {
    agent_id: "fake",
    transient: false,
    project: "p",
    status: "",
    mode: "all",
    connected_at: 0,
    last_seen: 0,
    status_updated_at: 0,
    promoted_at: null,
    ...over,
  };
}

test("priorityTag: required reply for an ask targeting receiver", () => {
  const m = msg({
    id: "m",
    from_agent_id: "asker",
    scope: "dm",
    target: "vellumpike",
    text: "?",
    ask_id: "ask-1",
  });
  expect(priorityTag(m, sub({ username: "vellumpike" }))).toBe("[required reply]");
});

test("priorityTag: likely reply for a DM to receiver", () => {
  const m = msg({
    id: "m",
    from_agent_id: "x",
    scope: "dm",
    target: "vellumpike",
    text: "ping",
  });
  expect(priorityTag(m, sub({ username: "vellumpike" }))).toBe("[likely reply]");
});

test("priorityTag: maybe reply for a project mention", () => {
  const m = msg({
    id: "m",
    from_agent_id: "x",
    scope: "project",
    text: "@vellumpike ?",
    mentions: ["vellumpike"],
  });
  expect(priorityTag(m, sub({ username: "vellumpike" }))).toBe("[maybe reply]");
});

test("priorityTag: no reply for a project chatter", () => {
  const m = msg({ id: "m", from_agent_id: "x", scope: "project", text: "general chat" });
  expect(priorityTag(m, sub({ username: "vellumpike" }))).toBe("[no reply]");
});

test("wrapSilentEvent emits the XML wrapper with a no-output directive", () => {
  const out = wrapSilentEvent("alpha joined p", { kind: "join", count: 1 });
  expect(out).toContain("<silent-event");
  expect(out).toContain('kind="join"');
  expect(out).toContain("count=1");
  expect(out).toContain("produce no output");
  expect(out).toContain("</silent-event>");
});

test("SILENT_KINDS covers the system kinds that should be wrapped", () => {
  for (const k of ["join", "leave", "keepalive", "promotion", "handle_recycled", "profile_update"] as const) {
    expect(SILENT_KINDS.has(k)).toBe(true);
  }
});

test("renderSender returns asterisked guest handle from from_username_inline", () => {
  const m = msg({
    id: "m",
    from_agent_id: "g",
    scope: "project",
    text: "x",
    from_username_inline: "leandro",
  });
  expect(renderSender(m, () => null)).toBe("leandro*");
});

test("renderSender resolves persona handle via lookup", () => {
  const m = msg({ id: "m", from_agent_id: "agent-1", scope: "project", text: "x" });
  expect(renderSender(m, (id) => (id === "agent-1" ? "vellumpike" : null))).toBe("vellumpike");
});

test("modeMarker / guestMarker stack at format time", () => {
  expect(modeMarker("quiet")).toBe("[Q]");
  expect(modeMarker("all")).toBe("");
  expect(guestMarker(true)).toBe("[G]");
  expect(guestMarker(false)).toBe("");
});
