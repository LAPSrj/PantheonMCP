import { test, expect } from "bun:test";
import {
  renderStore,
  ACTIVE_BUDGET_BYTES,
  CORE_BUDGET_BYTES,
} from "../render.ts";
import {
  PIN_FULL_BUDGET_BYTES,
  ALWAYS_SUMMARY_BUDGET_BYTES,
  TOPIC_FULL_BUDGET_BYTES,
  FADED_PER_TOPIC,
  RENDER_TOTAL_BUDGET_BYTES,
} from "../budgets.ts";
import type { MemoryEntry, MemoryStore } from "../types.ts";

function entry(
  over: Partial<MemoryEntry> & { id: string; date: string; text: string },
): MemoryEntry {
  return {
    summary: over.summary ?? `summary for ${over.id}`,
    status: "active",
    ...over,
  } as MemoryEntry;
}

function store(entries: MemoryEntry[]): MemoryStore {
  return { version: 1, entries };
}

const day = (n: number): string => `2026-04-${String(n).padStart(2, "0")}T00:00:00.000Z`;

// --- empty / forgotten ---

test("renderStore prints first-session message when nothing exists", () => {
  const r = renderStore(store([]));
  expect(r.text).toContain("first session");
  expect(r.warning).toBeNull();
});

test("forgotten omitted by default; surfaces under HIDDEN with include_forgotten", () => {
  const e = entry({ id: "chat/ghost", date: day(1), text: "x", status: "forgotten", topic: "chat", kind: "rule" });
  const noForgotten = renderStore(store([e]), { loaded_topics: ["chat"] });
  expect(noForgotten.text).not.toContain("ghost");

  const withForgotten = renderStore(store([e]), {
    loaded_topics: ["chat"],
    include_forgotten: true,
  });
  expect(withForgotten.text).toContain("HIDDEN");
  expect(withForgotten.text).toContain("ghost");
});

// --- topic-scoped load ---

test("a declared topic renders FULL; an undeclared topic is a menu count only", () => {
  const a = entry({ id: "chat/a", date: day(1), text: "the chat body", topic: "chat", kind: "rule" });
  const b = entry({ id: "launcher/b", date: day(2), text: "the launcher body", topic: "launcher", kind: "fact" });
  const r = renderStore(store([a, b]), { loaded_topics: ["chat"] });

  // chat is loaded → full body present.
  expect(r.text).toContain("TOPIC: chat");
  expect(r.text).toContain("the chat body");
  // launcher is NOT loaded → menu count, no body.
  expect(r.text).toContain("NOT LOADED");
  expect(r.text).toContain("launcher(1)");
  expect(r.text).not.toContain("the launcher body");
});

test("untopiced legacy entries are always loaded (implicit bucket)", () => {
  // Untyped legacy → note → renders as a summary line under (untopiced).
  const legacyNote = entry({ id: "old-note", date: day(1), text: "legacy body", summary: "legacy summary" });
  // A durable legacy entry with no topic renders FULL under (untopiced).
  const legacyDurable = entry({ id: "old-rule", date: day(2), text: "durable legacy body", kind: "fact" });
  const r = renderStore(store([legacyNote, legacyDurable]));
  expect(r.text).toContain("(untopiced)");
  expect(r.text).toContain("legacy summary");
  expect(r.text).toContain("durable legacy body");
});

// --- pins ---

test("pinned entries render FULL regardless of declared topics", () => {
  const p = entry({ id: "chat/pin", date: day(1), text: "pinned body", topic: "chat", kind: "rule", pin: true });
  // chat not loaded, but the pin shows full anyway.
  const r = renderStore(store([p]), { loaded_topics: ["other"] });
  expect(r.text).toContain("PINNED");
  expect(r.text).toContain("pinned body");
});

test("legacy core entries still render as pinned (pre-migration tolerance)", () => {
  const c = entry({ id: "c1", date: day(1), text: "core body", core: true });
  const r = renderStore(store([c]));
  expect(r.text).toContain("PINNED");
  expect(r.text).toContain("core body");
});

test("pinned over budget collapses oldest to summary + warns", () => {
  const body = "p".repeat(4000); // 3 × 4KB = 12KB > 10KB pin budget
  const entries = [1, 2, 3].map((i) =>
    entry({ id: `git/p${i}`, date: day(i), text: body, topic: "git", kind: "rule", pin: true }),
  );
  const r = renderStore(store(entries));
  expect(r.warning).toContain("collapsed to summary");
  // newest stays full.
  expect(r.text).toMatch(/\[git\/p3\][\s\S]*?pppp/);
  // oldest collapsed.
  expect(r.text).toMatch(/\[git\/p1\][\s\S]*?collapsed/);
});

// --- always band ---

test("always topic renders as SUMMARY every session, regardless of loaded topics", () => {
  const a = entry({ id: "always/bun", date: day(1), text: "we use bun not npm in full", summary: "use bun never npm", topic: "always", kind: "fact" });
  const r = renderStore(store([a]), { loaded_topics: [] });
  expect(r.text).toContain("ALWAYS");
  expect(r.text).toContain("use bun never npm");
  // summary only — full text body not inlined.
  expect(r.text).not.toContain("we use bun not npm in full");
});

// --- notes last-5 per topic ---

test("only the last 5 notes per topic render; older are not inlined", () => {
  const entries: MemoryEntry[] = [];
  for (let i = 1; i <= 8; i++) {
    entries.push(entry({ id: `chat/n${i}`, date: day(i), text: `note ${i}`, topic: "chat", kind: "note" }));
  }
  const r = renderStore(store(entries), { loaded_topics: ["chat"] });
  // newest 5 (n4..n8) present, oldest 3 (n1..n3) absent.
  expect(r.text).toContain("[chat/n8]");
  expect(r.text).toContain("[chat/n4]");
  expect(r.text).not.toContain("[chat/n3]");
});

// --- due reminders ---

test("due reminders surface in a top block regardless of topic; future ones don't", () => {
  const nowMs = Date.parse(day(15));
  const dueNow = entry({ id: "lifecycle/r1", date: day(1), text: "ping Leandro now", topic: "lifecycle", kind: "reminder", due: Date.parse(day(10)) });
  const future = entry({ id: "lifecycle/r2", date: day(1), text: "ping later", topic: "lifecycle", kind: "reminder", due: Date.parse(day(20)) });
  const r = renderStore(store([dueNow, future]), { loaded_topics: [], now: nowMs });
  expect(r.text).toContain("DUE REMINDERS");
  expect(r.text).toContain("ping Leandro now");
  expect(r.text).not.toContain("ping later");
});

test("open (no-due) reminder always surfaces", () => {
  const open = entry({ id: "lifecycle/r3", date: day(1), text: "open reminder", topic: "lifecycle", kind: "reminder" });
  const r = renderStore(store([open]), { now: Date.parse(day(15)) });
  expect(r.text).toContain("DUE REMINDERS");
  expect(r.text).toContain("open reminder");
});

// --- delivered handoffs (A ∩ H ≠ ∅) ---

test("handoff is delivered only when its topic is loaded", () => {
  const h = entry({ id: "memory/h1", date: day(1), text: "resume the build here", topic: "memory", kind: "handoff" });
  const notLoaded = renderStore(store([h]), { loaded_topics: ["chat"] });
  expect(notLoaded.text).not.toContain("DELIVERED HANDOFFS");

  const loaded = renderStore(store([h]), { loaded_topics: ["memory"] });
  expect(loaded.text).toContain("DELIVERED HANDOFFS");
  expect(loaded.text).toContain("resume the build here");
});

// --- only_core peer-inspection ---

test("only_core renders pinned + always, skips declared topics", () => {
  const pin = entry({ id: "git/p", date: day(1), text: "pinned body", topic: "git", kind: "rule", pin: true });
  const always = entry({ id: "always/a", date: day(1), text: "full always text", summary: "always summary", topic: "always", kind: "fact" });
  const topical = entry({ id: "chat/c", date: day(1), text: "chat topic body", topic: "chat", kind: "rule" });
  const r = renderStore(store([pin, always, topical]), { only_core: true, loaded_topics: ["chat"] });
  expect(r.text).toContain("pinned body");
  expect(r.text).toContain("always summary");
  expect(r.text).not.toContain("chat topic body");
});

// --- status NEVER auto-mutates ---

test("renderStore does not mutate entry status under any tier", () => {
  const big = "x".repeat(5000);
  const e1 = entry({ id: "chat/e1", date: day(1), text: big, topic: "chat", kind: "rule" });
  const e2 = entry({ id: "chat/e2", date: day(2), text: big, topic: "chat", kind: "rule" });
  const initial = JSON.stringify([e1, e2]);
  renderStore(store([e1, e2]), { loaded_topics: ["chat"] });
  expect(JSON.stringify([e1, e2])).toBe(initial);
});

// --- topic full-budget demotion ---

test("declared topic over full budget collapses oldest durable to summary", () => {
  const body = "t".repeat(5000); // 2 × 5KB = 10KB > 8KB topic budget
  const a = entry({ id: "chat/a", date: day(1), text: body, topic: "chat", kind: "rule" });
  const b = entry({ id: "chat/b", date: day(2), text: body, topic: "chat", kind: "rule" });
  const r = renderStore(store([a, b]), { loaded_topics: ["chat"] });
  expect(r.text).toMatch(/\[chat\/b\][\s\S]*?tttt/); // newest full
  expect(r.text).toMatch(/\[chat\/a\][\s\S]*?collapsed/); // oldest collapsed
});

// --- global render ceiling (spill-fix) ---

test("global ceiling collapses cross-topic full bodies once the shared budget is spent, and warns", () => {
  // Five topics each holding one 6 KB durable body. Each fits its own
  // 8 KB per-topic cap, so WITHOUT a global ceiling all five would render
  // full (~30 KB) — the multi-topic accumulation that spilled in the
  // incident. The shared 24 KB ceiling fills the earliest-budgeted topics
  // and forces the last one to summary.
  const body = "z".repeat(6000);
  const topics = ["t1", "t2", "t3", "t4", "t5"];
  const entries = topics.map((t, i) =>
    entry({ id: `${t}/e`, date: day(i + 1), text: body, topic: t, kind: "rule" }),
  );
  const r = renderStore(store(entries), { loaded_topics: topics });

  expect(r.warning).toContain("full-text ceiling");
  // earliest-budgeted topics render full…
  expect(r.text).toMatch(/\[t1\/e\][\s\S]*?zzzz/);
  // …the one past the ceiling collapses to summary (recoverable via recall).
  expect(r.text).toMatch(/\[t5\/e\][\s\S]*?collapsed/);
});

test("no global warning when the render fits under the ceiling", () => {
  const a = entry({ id: "chat/a", date: day(1), text: "small body", topic: "chat", kind: "rule" });
  const r = renderStore(store([a]), { loaded_topics: ["chat"] });
  expect(r.text).toContain("small body");
  expect(r.warning ?? "").not.toContain("full-text ceiling");
});

// --- faded subsection cap ---

test("faded subsection caps to newest-N per topic with a count of the rest", () => {
  const entries: MemoryEntry[] = [];
  for (let i = 1; i <= 8; i++) {
    entries.push(
      entry({ id: `chat/f${i}`, date: day(i), text: `faded ${i}`, topic: "chat", kind: "note", status: "faded" }),
    );
  }
  const r = renderStore(store(entries), { loaded_topics: ["chat"] });
  // newest FADED_PER_TOPIC shown (f8…f4), oldest hidden behind a count.
  expect(r.text).toContain("[chat/f8]");
  expect(r.text).toContain("[chat/f4]");
  expect(r.text).not.toContain("[chat/f3]");
  expect(r.text).toContain(`+${8 - FADED_PER_TOPIC} older faded`);
});

// --- constants ---

test("v2 budgets exported", () => {
  expect(PIN_FULL_BUDGET_BYTES).toBe(10240);
  expect(ALWAYS_SUMMARY_BUDGET_BYTES).toBe(8192);
  expect(TOPIC_FULL_BUDGET_BYTES).toBe(8192);
  expect(FADED_PER_TOPIC).toBe(5);
  // Default ceiling (no PANTHEON_RENDER_MAX_BYTES override in test env).
  expect(RENDER_TOTAL_BUDGET_BYTES).toBe(24 * 1024);
  // legacy aliases still resolve.
  expect(ACTIVE_BUDGET_BYTES).toBe(TOPIC_FULL_BUDGET_BYTES);
  expect(CORE_BUDGET_BYTES).toBe(PIN_FULL_BUDGET_BYTES);
});
