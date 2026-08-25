import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  CodexTokenUsageTracker,
  extractOfficialTokenUsage,
  OpsTrafficStore,
} from "../lib/ops-traffic-store.mjs";

test("traffic store persists only normalized metadata and restores without double counting", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-traffic-");
  let now = Date.UTC(2026, 6, 20, 12, 0, 0);
  try {
    const store = await new OpsTrafficStore(directory, { now: () => now }).initialize();
    await store.record({
      kind: "http", operation: "/api/projects", method: "GET", statusCode: 200,
      status: "success", success: true, durationMs: 25, responseBytes: 100,
      userId: "u-0123456789abcdef", username: "owner", body: "prompt-secret",
      query: "token=secret", threadId: "thread-secret",
    });
    await store.record({
      kind: "turn", operation: "turn/completed", status: "completed", success: true,
      durationMs: 1500, userId: "u-0123456789abcdef", username: "owner", response: "answer-secret",
    });
    await store.record({
      kind: "usage", operation: "thread/tokenUsage/updated", status: "reported", success: true,
      userId: "u-0123456789abcdef", username: "owner", threadId: "thread-secret",
      tokenUsage: {
        inputTokens: 10, cachedInputTokens: 4, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 15,
      },
    });
    const summary = store.summary("24h");
    assert.equal(summary.requests, 1);
    assert.equal(summary.turns, 1);
    assert.deepEqual(summary.tokenUsage, {
      available: true,
      source: "codex",
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 5,
      reasoningOutputTokens: 2,
      totalTokens: 15,
    });
    assert.equal(store.logs({ category: "api" }).length, 1);
    assert.equal(store.logs({ category: "rpc" }).length, 1);
    assert.equal(store.logs({ category: "api", before: now }).length, 0);
    await store.flush();
    const stored = await fs.readFile(path.join(directory, "ops-traffic.ndjson"), "utf8");
    assert.doesNotMatch(stored, /prompt-secret|answer-secret|thread-secret|token=secret/);
    assert.equal((await fs.stat(path.join(directory, "ops-traffic.ndjson"))).mode & 0o777, 0o600);

    const restored = await new OpsTrafficStore(directory, { now: () => now }).initialize();
    assert.deepEqual(restored.summary("24h"), summary);
    assert.equal(restored.rankings()[0].totalTokens, 15);
    assert.deepEqual(restored.monthlyUserUsage("u-0123456789abcdef"), {
      periodStart: Date.UTC(2026, 6, 1),
      resetsAt: Date.UTC(2026, 7, 1),
      available: true,
      reportingStatus: "reported",
      source: "codex",
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 5,
      reasoningOutputTokens: 2,
      totalTokens: 15,
    });
    assert.equal(restored.weeklyUserUsage("u-0123456789abcdef").totalTokens, 15);
    assert.equal(restored.fiveHourUserUsage("u-0123456789abcdef").totalTokens, 15);
    assert.equal(restored.lifetimeUserUsage("u-0123456789abcdef").totalTokens, 15);
    assert.equal(restored.sevenDayUserUsage("u-0123456789abcdef").totalTokens, 15);
    assert.equal(restored.todayUserUsage("u-0123456789abcdef").totalTokens, 15);
    assert.equal((await fs.stat(path.join(directory, "ops-user-totals.json"))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("traffic store rejects unsafe operations and reports unavailable provider usage", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-traffic-safe-");
  const userId = "u-0123456789abcdef";
  try {
    const store = await new OpsTrafficStore(directory).initialize();
    await assert.rejects(store.record({ kind: "http", operation: "/api/test?key=secret" }), /Invalid/);
    await store.record({ kind: "turn", operation: "turn/completed", status: "completed", success: true, userId });
    assert.deepEqual(store.summary().tokenUsage, {
      available: false,
      source: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
    });
    assert.equal(store.monthlyUserUsage(userId).reportingStatus, "missing");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("token extraction accepts only the official Codex notification shape", () => {
  const params = officialUsage({
    last: usage(9, 3, 4, 2, 13),
    total: usage(90, 30, 40, 20, 130),
  });
  assert.deepEqual(extractOfficialTokenUsage(params), {
    last: usage(9, 3, 4, 2, 13),
    total: usage(90, 30, 40, 20, 130),
  });
  assert.equal(extractOfficialTokenUsage({ usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 } }), null);
  assert.equal(extractOfficialTokenUsage(officialUsage({
    last: { inputTokens: -1, cachedInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0, totalTokens: 13 },
    total: usage(90, 30, 40, 20, 130),
  })), null);
});

test("official Token tracker deduplicates snapshots and fills missed notification deltas", () => {
  const tracker = new CodexTokenUsageTracker({ maxThreads: 2 });
  assert.deepEqual(tracker.consume(officialUsage({
    threadId: "thread-a",
    last: usage(10, 4, 5, 2, 15),
    total: usage(100, 40, 50, 20, 150),
  })), usage(10, 4, 5, 2, 15));
  assert.equal(tracker.consume(officialUsage({
    threadId: "thread-a",
    last: usage(10, 4, 5, 2, 15),
    total: usage(100, 40, 50, 20, 150),
  })), null);
  assert.deepEqual(tracker.consume(officialUsage({
    threadId: "thread-a",
    last: usage(12, 5, 7, 3, 19),
    total: usage(125, 50, 60, 25, 185),
  })), usage(25, 10, 10, 5, 35));

  assert.deepEqual(tracker.consume(officialUsage({
    threadId: "thread-b",
    last: usage(2, 1, 3, 1, 5),
    total: usage(2, 1, 3, 1, 5),
  })), usage(2, 1, 3, 1, 5));
  tracker.consume(officialUsage({
    threadId: "thread-c",
    last: usage(3, 1, 4, 2, 7),
    total: usage(3, 1, 4, 2, 7),
  }));
  assert.equal(tracker.threadTotals.size, 2);
  assert.equal(tracker.threadTotals.has("thread-a"), false);

  assert.deepEqual(tracker.consume(officialUsage({
    threadId: "thread-b",
    last: usage(1, 0, 1, 0, 2),
    total: usage(1, 0, 1, 0, 2),
  })), usage(1, 0, 1, 0, 2));
  assert.equal(tracker.consume(officialUsage({ threadId: "", last: usage(1, 0, 1, 0, 2) })), null);
});

test("inactive traffic store reloads current data during writer takeover", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-traffic-activation-");
  try {
    const active = await new OpsTrafficStore(directory).initialize();
    const candidate = await new OpsTrafficStore(directory, { writeOnInitialize: false }).initialize();
    await active.record({ kind: "rpc", operation: "thread/list", status: "success", success: true });
    assert.equal(candidate.summary().rpcCalls, 0);
    await candidate.activate();
    assert.equal(candidate.summary().rpcCalls, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("weekly traffic rollups do not double count raw records after restart", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-traffic-rollup-");
  let now = Date.UTC(2026, 6, 20, 10, 0, 0);
  try {
    const store = await new OpsTrafficStore(directory, { now: () => now }).initialize();
    await store.record({ kind: "http", operation: "/api/projects", status: "success", success: true });
    now += 2 * 60 * 60 * 1000;
    await store.record({ kind: "http", operation: "/api/account", status: "success", success: true });
    assert.equal(store.summary("7d").requests, 2);
    await store.flush();
    const restored = await new OpsTrafficStore(directory, { now: () => now }).initialize();
    assert.equal(restored.summary("7d").requests, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("completed daily aggregates persist before raw retention expires", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-traffic-daily-");
  let now = Date.UTC(2026, 6, 20, 10, 0, 0);
  try {
    const store = await new OpsTrafficStore(directory, { now: () => now }).initialize();
    await store.record({
      kind: "usage", operation: "thread/tokenUsage/updated", status: "reported", success: true,
      userId: "u-0123456789abcdef", username: "owner",
      tokenUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
    now += 25 * 60 * 60 * 1000;
    await store.record({ kind: "http", operation: "/api/account", status: "success", success: true });
    const restored = await new OpsTrafficStore(directory, { now: () => now }).initialize();
    assert.equal(restored.summary("7d").tokenUsage.totalTokens, 5);
    assert.equal(restored.rankings()[0].totalTokens, 5);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("lifetime Token totals migrate daily history and survive seven-day expiry and restart", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-traffic-lifetime-");
  let now = Date.UTC(2026, 6, 20, 10, 0, 0);
  const userId = "u-0123456789abcdef";
  try {
    const active = await new OpsTrafficStore(directory, { now: () => now }).initialize();
    await active.record({
      kind: "usage", operation: "thread/tokenUsage/updated", status: "reported", success: true,
      userId, username: "owner", tokenUsage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
    });
    assert.equal(active.lifetimeUserUsage(userId).totalTokens, 5);
    assert.equal(active.sevenDayUserUsage(userId).totalTokens, 5);
    assert.equal(active.todayUserUsage(userId).totalTokens, 5);

    now = Date.UTC(2026, 6, 21, 1, 0, 0);
    await active.record({ kind: "http", operation: "/api/account", status: "success", success: true, userId });
    await active.flush();
    await fs.rm(path.join(directory, "ops-user-totals.json"));

    const migrated = await new OpsTrafficStore(directory, { now: () => now }).initialize();
    assert.equal(migrated.lifetimeUserUsage(userId).totalTokens, 5);
    assert.equal(migrated.todayUserUsage(userId).reportingStatus, "idle");

    now = Date.UTC(2026, 6, 28, 2, 0, 0);
    await migrated.record({ kind: "http", operation: "/api/account", status: "success", success: true, userId });
    assert.equal(migrated.lifetimeUserUsage(userId).totalTokens, 5);
    assert.equal(migrated.sevenDayUserUsage(userId).reportingStatus, "idle");
    await migrated.record({
      kind: "usage", operation: "thread/tokenUsage/updated", status: "reported", success: true,
      userId, username: "owner", tokenUsage: { inputTokens: 6, outputTokens: 1, totalTokens: 7 },
    });
    assert.equal(migrated.lifetimeUserUsage(userId).totalTokens, 12);
    assert.equal(migrated.sevenDayUserUsage(userId).totalTokens, 7);
    assert.equal(migrated.todayUserUsage(userId).totalTokens, 7);
    await migrated.flush();

    const restored = await new OpsTrafficStore(directory, { now: () => now }).initialize();
    assert.equal(restored.lifetimeUserUsage(userId).totalTokens, 12);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("monthly user usage resets on the UTC calendar-month boundary", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-traffic-monthly-");
  let now = Date.UTC(2026, 6, 31, 23, 0, 0);
  const userId = "u-0123456789abcdef";
  try {
    const store = await new OpsTrafficStore(directory, { now: () => now }).initialize();
    await store.record({
      kind: "usage", operation: "thread/tokenUsage/updated", status: "reported", success: true,
      userId, username: "owner",
      tokenUsage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
    });
    assert.equal(store.monthlyUserUsage(userId).totalTokens, 50);
    now = Date.UTC(2026, 7, 1, 1, 0, 0);
    await store.record({ kind: "http", operation: "/api/account", status: "success", success: true, userId });
    assert.deepEqual(store.monthlyUserUsage(userId), {
      periodStart: Date.UTC(2026, 7, 1),
      resetsAt: Date.UTC(2026, 8, 1),
      available: false,
      reportingStatus: "idle",
      source: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("five-hour usage rolls forward while weekly usage resets on UTC Monday", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-traffic-windows-");
  let now = Date.UTC(2026, 6, 20, 10, 0, 0);
  const userId = "u-0123456789abcdef";
  try {
    const store = await new OpsTrafficStore(directory, { now: () => now }).initialize();
    await store.record({
      kind: "usage", operation: "thread/tokenUsage/updated", status: "reported", success: true,
      userId, username: "owner", tokenUsage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
    });
    assert.equal(store.fiveHourUserUsage(userId).totalTokens, 50);
    assert.equal(store.weeklyUserUsage(userId).totalTokens, 50);

    now += 5 * 60 * 60 * 1000 + 1;
    assert.equal(store.fiveHourUserUsage(userId).available, false);
    assert.equal(store.fiveHourUserUsage(userId).reportingStatus, "idle");
    assert.equal(store.weeklyUserUsage(userId).totalTokens, 50);

    now = Date.UTC(2026, 6, 27, 0, 0, 1);
    await store.record({ kind: "http", operation: "/api/account", status: "success", success: true, userId });
    assert.equal(store.weeklyUserUsage(userId).available, false);
    assert.equal(store.weeklyUserUsage(userId).reportingStatus, "idle");
    assert.equal(store.monthlyUserUsage(userId).totalTokens, 50);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function usage(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens) {
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

function officialUsage({ threadId = "thread-test", last, total = last }) {
  return { threadId, turnId: "turn-test", tokenUsage: { last, total, modelContextWindow: 200_000 } };
}
