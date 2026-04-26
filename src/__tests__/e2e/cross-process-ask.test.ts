import { test, expect, beforeEach, afterEach } from "bun:test";
import { call, makeFixture, type E2EFixture } from "./harness.ts";

let fix: E2EFixture;

beforeEach(() => {
  fix = makeFixture();
});

afterEach(() => {
  fix.cleanup();
});

test("cross-process ask: procA asks procB; procB answers; procA's promise resolves", async () => {
  // Both register + login chat.
  await call(fix.procA, "register", { username: "alpha", project: "p", cwd: "/a", claim_after: true });
  await call(fix.procB, "register", { username: "beta", project: "p", cwd: "/b", claim_after: true });
  await call(fix.procA, "login", { username: "alpha", project: "p", transient: false });
  await call(fix.procB, "login", { username: "beta", project: "p", transient: false });

  // Fire ask from procA targeting beta. The ask polls SQLite for the
  // answer row; meanwhile procB's answer call writes the row.
  const askPromise = call(fix.procA, "ask", {
    target: "beta",
    text: "what's the plan?",
    timeout_ms: 5000,
  });

  // Give procA a tick to write the ask row before procB checks for it.
  await new Promise((r) => setTimeout(r, 50));

  // procB pulls the ask via check_messages, finds the correlation_id,
  // answers.
  const checkB = await call(fix.procB, "check_messages");
  const askMsg = (checkB.payload.messages as Array<{ ask_id: string | null; text: string }>)
    .find((m) => m.ask_id !== null);
  expect(askMsg).toBeDefined();
  await call(fix.procB, "answer", { correlation_id: askMsg!.ask_id!, text: "ship the watcher" });

  const result = await askPromise;
  expect(result.payload.status).toBe("answered");
  expect(result.payload.text).toBe("ship the watcher");
  expect(result.payload.from).toBe("beta");
});

test("cross-process ask: target disconnects → respondent_disconnected", async () => {
  await call(fix.procA, "register", { username: "alpha", project: "p", cwd: "/a", claim_after: true });
  await call(fix.procB, "register", { username: "beta", project: "p", cwd: "/b", claim_after: true });
  await call(fix.procA, "login", { username: "alpha", project: "p", transient: false });
  const loginB = await call(fix.procB, "login", { username: "beta", project: "p", transient: false });

  const askPromise = call(fix.procA, "ask", {
    target: "beta",
    text: "?",
    timeout_ms: 10_000,
  });
  // Give the ask a moment to start polling.
  await new Promise((r) => setTimeout(r, 50));

  // Force-evict beta's presence row (simulate logout / heartbeat lapse
  // past prune grace) by directly DELETing.
  fix.procB.db.run("DELETE FROM subscribers WHERE agent_id = ?", [loginB.payload.agent_id as string]);

  const result = await askPromise;
  expect(result.payload.status).toBe("timeout");
  expect(result.payload.reason).toBe("respondent_disconnected");
});

test("cross-process ask: target stays silent → no_response after timeout", async () => {
  await call(fix.procA, "register", { username: "alpha", project: "p", cwd: "/a", claim_after: true });
  await call(fix.procB, "register", { username: "beta", project: "p", cwd: "/b", claim_after: true });
  await call(fix.procA, "login", { username: "alpha", project: "p", transient: false });
  await call(fix.procB, "login", { username: "beta", project: "p", transient: false });

  // Tight timeout so the test runs fast. The poll interval is 250ms;
  // a 600ms timeout gives 2 polls before timing out.
  const result = await call(fix.procA, "ask", {
    target: "beta",
    text: "?",
    timeout_ms: 600,
  });
  expect(result.payload.status).toBe("timeout");
  expect(result.payload.reason).toBe("no_response");
});
