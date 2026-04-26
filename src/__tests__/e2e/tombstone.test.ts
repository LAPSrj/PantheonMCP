import { test, expect, beforeEach, afterEach } from "bun:test";
import { call, makeFixture, type E2EFixture } from "./harness.ts";

let fix: E2EFixture;

beforeEach(() => {
  fix = makeFixture();
});

afterEach(() => {
  fix.cleanup();
});

test("guest disconnect → reclaim within 30s emits handle_recycled", async () => {
  // Guest "delta" joins via procA.
  const first = await call(fix.procA, "login", {
    username: "delta",
    project: "p",
    transient: true,
  });
  expect(first.ok).toBe(true);

  // Disconnect.
  await call(fix.procA, "logout");

  // Verify the tombstone is in place.
  expect(fix.procA.ctx.chat!.tombstones.get("delta")).not.toBeNull();

  // Reconnect within the window — same handle, fresh agent_id.
  const second = await call(fix.procA, "login", {
    username: "delta",
    project: "p",
    transient: true,
  });
  expect(second.ok).toBe(true);
  expect((second.payload.agent_id as string) !== (first.payload.agent_id as string)).toBe(true);

  // Tombstone consumed.
  expect(fix.procA.ctx.chat!.tombstones.get("delta")).toBeNull();

  // The handle_recycled broadcast landed in the project chat.
  const { queryMessages } = await import("../../chat/index.ts");
  const msgs = queryMessages(fix.procA.db, { scope: "project" });
  expect(msgs.some((m) => m.kind === "handle_recycled" && m.text.includes("delta"))).toBe(true);
});

test("after tombstone TTL elapses, the handle is freely available", async () => {
  // Custom router with a short tombstone TTL so we don't wait 30s in tests.
  const { ChatRouter, TombstoneMap } = await import("../../chat/index.ts");
  const tombstones = new TombstoneMap({ ttl_ms: 10 });
  const router = new ChatRouter({ paths: fix.paths, db: fix.procA.db, tombstones });

  router.add({ username: "delta", project: "p", transient: true });
  router.remove(router.getByUsername("delta")!.agent_id);
  expect(router.tombstones.get("delta")).not.toBeNull();

  // Wait past the TTL.
  await new Promise((r) => setTimeout(r, 20));

  expect(router.tombstones.get("delta")).toBeNull();
  // Anyone can re-take the handle now.
  const fresh = router.add({ username: "delta", project: "p", transient: false });
  expect(fresh.transient).toBe(false);
});
