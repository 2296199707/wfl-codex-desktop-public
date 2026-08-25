import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexGoalRecoveryStore,
  goalConnectivityRetryDelay,
  restoreCodexGoals,
  scanCodexGoalRollouts,
} from "../lib/codex-goal-recovery.mjs";

const THREAD_A = "019f9a25-c0a0-7322-975b-7ace22b4b60f";
const THREAD_B = "019fa7df-572b-76b3-9678-777c2cde1102";

test("backs off connectivity retries from 15 seconds to a 15 minute cap", () => {
  const noJitter = { random: () => 0.5 };
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 20].map((attempt) => goalConnectivityRetryDelay(attempt, noJitter)),
    [15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 900_000],
  );
  assert.equal(goalConnectivityRetryDelay(1, { random: () => 0 }), 13_500);
  assert.equal(goalConnectivityRetryDelay(7, { random: () => 1 }), 990_000);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 8].map((attempt) => goalConnectivityRetryDelay(
      attempt,
      { frequency: "fast", random: () => 0.5 },
    )),
    [10_000, 20_000, 30_000, 60_000, 120_000, 300_000],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5, 8].map((attempt) => goalConnectivityRetryDelay(
      attempt,
      { frequency: "patient", random: () => 0.5 },
    )),
    [60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000],
  );
  assert.equal(goalConnectivityRetryDelay(1, { frequency: "invalid", random: () => 0.5 }), 15_000);
});

test("persists Goal recovery snapshots with private file permissions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-goal-store-"));
  try {
    const store = await new CodexGoalRecoveryStore(directory, { now: () => 123_000 }).initialize();
    await store.upsert(goal(THREAD_A, { objective: "Finish the release" }));
    await store.updateSettings({ unlimitedRetry: true, retryFrequency: "patient" });
    await store.bootstrap([]);

    const restored = await new CodexGoalRecoveryStore(directory).initialize();
    assert.equal(restored.needsBootstrap(), false);
    assert.deepEqual(restored.settingsSnapshot(), { unlimitedRetry: true, retryFrequency: "patient" });
    assert.deepEqual(restored.snapshot().map(({ observedAt, ...record }) => record), [{
      ...goal(THREAD_A, { objective: "Finish the release" }),
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 0,
      updatedAt: 0,
    }]);
    assert.equal((await fs.stat(path.join(directory, "codex-goal-recovery.json"))).mode & 0o777, 0o600);

    assert.equal(await restored.remove(THREAD_A), true);
    assert.deepEqual(restored.snapshot(), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("does not downgrade a newer terminal Goal when an older update arrives late", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-goal-monotonic-"));
  try {
    const store = await new CodexGoalRecoveryStore(directory, { now: () => 10_000 }).initialize();
    const terminal = await store.upsert(
      goal(THREAD_A, { status: "complete", updatedAt: 200 }),
      { observedAt: 10_000 },
    );
    const delayed = await store.upsert(
      goal(THREAD_A, { status: "active", updatedAt: 100 }),
      { observedAt: 11_000 },
    );
    assert.equal(terminal.status, "complete");
    assert.equal(delayed.status, "complete");
    assert.equal(store.get(THREAD_A).updatedAt, 200);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("recovers the latest explicit Goal state from rollout history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-goal-rollout-"));
  const sessionDirectory = path.join(directory, "sessions", "2026", "07", "28");
  try {
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(path.join(sessionDirectory, "rollout-first.jsonl"), [
      rollout("2026-07-28T10:00:00.000Z", {
        type: "thread_goal_updated",
        threadId: THREAD_A,
        goal: goal(THREAD_A, { objective: "Old objective" }),
      }),
      rollout("2026-07-28T10:01:00.000Z", {
        type: "thread_goal_updated",
        threadId: THREAD_B,
        goal: goal(THREAD_B, { objective: "Cleared objective" }),
      }),
      "",
    ].join("\n"));
    await fs.writeFile(path.join(sessionDirectory, "rollout-second.jsonl"), [
      rollout("2026-07-28T10:02:00.000Z", {
        type: "thread_goal_updated",
        threadId: THREAD_A,
        goal: goal(THREAD_A, { objective: "Latest objective", status: "paused" }),
      }),
      rollout("2026-07-28T10:03:00.000Z", {
        type: "thread_goal_cleared",
        threadId: THREAD_B,
      }),
      JSON.stringify({
        timestamp: "2026-07-28T10:04:00.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          output: `embedded ${JSON.stringify({ type: "thread_goal_updated", threadId: THREAD_B })}`,
        },
      }),
      "",
    ].join("\n"));

    const result = await scanCodexGoalRollouts(directory);
    assert.equal(result.scannedFiles, 2);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.records.map((record) => ({
      threadId: record.threadId,
      objective: record.objective,
      status: record.status,
    })), [{
      threadId: THREAD_A,
      objective: "Latest objective",
      status: "paused",
    }]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restores missing native Goals and resumes only active unloaded threads", async () => {
  const calls = [];
  const nativeGoals = new Map([
    [THREAD_B, goal(THREAD_B, { objective: "Paused natively", status: "paused" })],
  ]);
  const result = await restoreCodexGoals([
    goal(THREAD_A, { objective: "Keep working" }),
    goal(THREAD_B, { objective: "Stale shadow", status: "active" }),
  ], {
    request: async (method, params) => {
      calls.push([method, structuredClone(params)]);
      if (method === "thread/goal/get") return { goal: nativeGoals.get(params.threadId) || null };
      if (method === "thread/goal/set") {
        const restored = goal(params.threadId, params);
        nativeGoals.set(params.threadId, restored);
        return { goal: restored };
      }
      if (method === "thread/read") return { thread: { id: params.threadId, status: { type: "notLoaded" } } };
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      throw new Error(`Unexpected request: ${method}`);
    },
  });

  assert.deepEqual(result, {
    checked: 2,
    restored: 1,
    reactivated: 0,
    resumed: 1,
    alreadyActive: 0,
    manuallyPaused: 0,
    inactive: 1,
    failed: 0,
  });
  assert.deepEqual(calls.filter(([method]) => method === "thread/resume"), [[
    "thread/resume",
    { threadId: THREAD_A, excludeTurns: true },
  ]]);
  assert.equal(nativeGoals.get(THREAD_B).objective, "Paused natively");
});

test("does not duplicate a Goal turn that the task tracker still reports running", async () => {
  const failures = [];
  const calls = [];
  const result = await restoreCodexGoals([
    goal(THREAD_A),
    goal(THREAD_B),
  ], {
    request: async (method, params) => {
      calls.push([method, params.threadId]);
      if (params.threadId === THREAD_B) throw new Error("thread missing");
      if (method === "thread/goal/get") return { goal: goal(THREAD_A) };
      if (method === "thread/read") {
        return { thread: { id: THREAD_A, status: { type: "active", activeFlags: ["waitingOnApproval"] } } };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    isThreadRunning: (threadId) => threadId === THREAD_A,
    onFailure: async (record, error) => failures.push([record.threadId, error.message]),
  });

  assert.equal(result.alreadyActive, 1);
  assert.equal(result.resumed, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(failures, [[THREAD_B, "thread missing"]]);
  assert.equal(calls.some(([method]) => method === "thread/resume"), false);
});

test("resumes a loaded Goal thread when the task tracker is idle", async () => {
  const calls = [];
  const result = await restoreCodexGoals([
    goal(THREAD_A, { status: "usageLimited", updatedAt: 42 }),
  ], {
    request: async (method, params) => {
      calls.push([method, structuredClone(params)]);
      if (method === "thread/goal/get") {
        return { goal: goal(THREAD_A, { status: "usageLimited", updatedAt: 42 }) };
      }
      if (method === "thread/goal/set") {
        return { goal: goal(THREAD_A, { status: params.status, updatedAt: 43 }) };
      }
      if (method === "thread/read") {
        return { thread: { id: THREAD_A, status: { type: "active", activeFlags: [] } } };
      }
      if (method === "thread/resume") return { thread: { id: THREAD_A } };
      throw new Error(`Unexpected request: ${method}`);
    },
    canReactivateUsageLimited: async () => true,
    isThreadRunning: () => false,
  });

  assert.equal(result.reactivated, 1);
  assert.equal(result.resumed, 1);
  assert.equal(result.alreadyActive, 0);
  assert.deepEqual(calls.map(([method]) => method), [
    "thread/goal/get",
    "thread/goal/set",
    "thread/read",
    "thread/resume",
  ]);
});

test("reactivates only Goals suspended for a connectivity outage", async () => {
  const calls = [];
  const nativeGoals = new Map([
    [THREAD_A, goal(THREAD_A, { status: "paused" })],
    [THREAD_B, goal(THREAD_B, { status: "paused", objective: "Paused by user" })],
  ]);
  const result = await restoreCodexGoals([
    goal(THREAD_A, {
      status: "paused",
      resumeWhenAvailable: true,
      suspendedReason: "provider-unavailable",
      retryAttempts: 2,
      nextRetryAt: 999_000,
      lastError: "API offline",
    }),
    goal(THREAD_B, { status: "paused", objective: "Paused by user" }),
  ], {
    request: async (method, params) => {
      calls.push([method, structuredClone(params)]);
      if (method === "thread/goal/get") return { goal: nativeGoals.get(params.threadId) || null };
      if (method === "thread/goal/set") {
        const current = nativeGoals.get(params.threadId);
        const updated = { ...current, ...params };
        nativeGoals.set(params.threadId, updated);
        return { goal: updated };
      }
      if (method === "thread/read") return { thread: { id: params.threadId, status: { type: "notLoaded" } } };
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      throw new Error(`Unexpected request: ${method}`);
    },
  });

  assert.equal(result.reactivated, 1);
  assert.equal(result.resumed, 1);
  assert.equal(result.inactive, 1);
  assert.deepEqual(calls.filter(([method]) => method === "thread/goal/set"), [[
    "thread/goal/set",
    { threadId: THREAD_A, status: "active" },
  ]]);
  assert.equal(nativeGoals.get(THREAD_B).status, "paused");
});

test("persists retry intent until real progress clears the suspension", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-goal-retry-"));
  try {
    const store = await new CodexGoalRecoveryStore(directory, { now: () => 10_000 }).initialize();
    await store.upsert(goal(THREAD_A));
    const suspended = await store.suspendForConnectivity(
      goal(THREAD_A, { status: "paused" }),
      { error: "connection reset", retryDelayMs: 30_000 },
    );
    assert.equal(suspended.resumeWhenAvailable, true);
    assert.equal(suspended.failureKind, "connectivity");
    assert.equal(suspended.retryAttempts, 1);
    assert.equal(suspended.nextRetryAt, 40_000);
    assert.equal(suspended.lastError, "connection reset");

    const rescheduled = await store.rescheduleConnectivitySuspension(
      THREAD_A,
      { retryDelayMs: 60_000, observedAt: 10_500 },
    );
    assert.equal(rescheduled.retryAttempts, 1);
    assert.equal(rescheduled.nextRetryAt, 70_500);

    const {
      resumeWhenAvailable,
      suspendedReason,
      failureKind,
      retryAttempts,
      nextRetryAt,
      lastError,
      ...nativeGoal
    } = goal(THREAD_A, { status: "active" });
    const nativeUpdate = await store.upsert(nativeGoal, { observedAt: 11_000 });
    assert.equal(nativeUpdate.resumeWhenAvailable, true);
    assert.equal(nativeUpdate.retryAttempts, 1);

    const cleared = await store.clearConnectivitySuspension(THREAD_A, { observedAt: 12_000 });
    assert.equal(cleared.resumeWhenAvailable, false);
    assert.equal(cleared.failureKind, null);
    assert.equal(cleared.retryAttempts, 0);
    assert.equal(cleared.nextRetryAt, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("persists non-connectivity failures without arming automatic recovery", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-goal-failure-kind-"));
  try {
    const store = await new CodexGoalRecoveryStore(directory, { now: () => 25_000 }).initialize();
    await store.upsert(goal(THREAD_A));
    for (const [failureKind, error] of [
      ["authentication", "401 invalid API key"],
      ["quota", "usage limit exceeded"],
      ["rate-limit", "429 rate limited"],
      ["unknown", "unclassified provider failure"],
    ]) {
      const suspended = await store.suspendForFailure(
        goal(THREAD_A, { status: "paused" }),
        { failureKind, error, retryDelayMs: 30_000 },
      );
      assert.equal(suspended.failureKind, failureKind);
      assert.equal(suspended.resumeWhenAvailable, false);
      assert.equal(suspended.suspendedReason, null);
      assert.equal(suspended.nextRetryAt, null);
      assert.match(suspended.lastError, new RegExp(error.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    }
    const reopened = await new CodexGoalRecoveryStore(directory).initialize();
    const record = reopened.get(THREAD_A);
    assert.equal(record.failureKind, "unknown");
    assert.equal(record.resumeWhenAvailable, false);
    assert.equal(record.nextRetryAt, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("persists useful connectivity errors without credentials", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-goal-redaction-"));
  try {
    const store = await new CodexGoalRecoveryStore(directory).initialize();
    const secrets = [
      "sk-goalRecoverySecret123456",
      "bearer-goal-secret",
      "query-goal-secret",
      "url-goal-user",
      "url-goal-password",
    ];
    const suspended = await store.suspendForConnectivity(goal(THREAD_A), {
      error: [
        "429 rate limited",
        `Authorization: Bearer ${secrets[1]}`,
        `api_key=${secrets[2]}`,
        `https://${secrets[3]}:${secrets[4]}@api.example.test/v1`,
        secrets[0],
      ].join(" · "),
      retryDelayMs: 10_000,
    });

    assert.equal(suspended.resumeWhenAvailable, true);
    assert.match(suspended.lastError, /429 rate limited/);
    assert.match(suspended.lastError, /\[REDACTED\]/);
    for (const secret of secrets) assert.doesNotMatch(suspended.lastError, new RegExp(secret));
    const persisted = await fs.readFile(path.join(directory, "codex-goal-recovery.json"), "utf8");
    for (const secret of secrets) assert.doesNotMatch(persisted, new RegExp(secret));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("persists manual pause, provider switching, and resume audit without connectivity auto-resume", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-goal-manual-pause-"));
  let now = 20_000;
  const before = {
    kind: "managed",
    id: "p-before",
    label: "Primary API",
    model: "gpt-before",
  };
  const after = {
    kind: "official",
    id: "openai",
    label: "OpenAI 官方账号",
    model: "gpt-after",
    accountId: "oa-1234567890abcdef",
    accountLabel: "masked@example.com",
    credentialStatus: "valid",
    quotaUsedPercent: 41,
  };
  try {
    const store = await new CodexGoalRecoveryStore(directory, { now: () => now }).initialize();
    await store.upsert(goal(THREAD_A));
    await store.suspendForConnectivity(
      goal(THREAD_A, { status: "paused" }),
      { error: "offline", retryDelayMs: 30_000 },
    );

    const pausing = await store.beginManualPause(goal(THREAD_A), {
      mode: "after-turn",
      pending: true,
      provider: before,
    });
    assert.equal(pausing.manualPauseState, "pausing");
    assert.equal(pausing.manualPauseMode, "after-turn");
    assert.equal(pausing.resumeWhenAvailable, false);
    assert.equal(pausing.nextRetryAt, null);
    assert.deepEqual(pausing.providerBefore, {
      ...before,
      accountId: null,
      accountLabel: null,
      credentialStatus: null,
      quotaUsedPercent: null,
    });

    now = 21_000;
    const nativePaused = await store.upsert(goal(THREAD_A, { status: "paused" }));
    assert.equal(nativePaused.manualPauseState, "pausing");
    const paused = await store.finishManualPause(THREAD_A);
    assert.equal(paused.manualPauseState, "paused");
    assert.equal(paused.manualPausedAt, 21_000);

    now = 22_000;
    const switched = await store.recordManualProviderSwitch(THREAD_A, after);
    assert.deepEqual(switched.providerAfter, after);
    assert.equal(switched.providerSwitchedAt, 22_000);

    const restored = await new CodexGoalRecoveryStore(directory, { now: () => now }).initialize();
    assert.equal(restored.get(THREAD_A).manualPauseState, "paused");
    assert.equal(restored.get(THREAD_A).resumeWhenAvailable, false);

    now = 23_000;
    const resumed = await restored.finishManualResume(goal(THREAD_A), { provider: after });
    assert.equal(resumed.manualPauseState, null);
    assert.equal(resumed.manualResumedAt, 23_000);
    assert.deepEqual(resumed.providerBefore.id, "p-before");
    assert.deepEqual(resumed.providerAfter.accountId, "oa-1234567890abcdef");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restart recovery reasserts a manual pause instead of resuming the Goal", async () => {
  const calls = [];
  const stored = goal(THREAD_A, {
    manualPauseState: "pausing",
    manualPauseMode: "immediate",
    manualPauseRequestedAt: 10_000,
  });
  const observed = [];
  const result = await restoreCodexGoals([stored], {
    request: async (method, params) => {
      calls.push([method, structuredClone(params)]);
      if (method === "thread/goal/get") return { goal: goal(THREAD_A) };
      if (method === "thread/goal/set") {
        return { goal: goal(THREAD_A, { status: params.status }) };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    onGoal: async (value) => observed.push(value),
  });

  assert.equal(result.manuallyPaused, 1);
  assert.equal(result.resumed, 0);
  assert.equal(result.inactive, 1);
  assert.deepEqual(calls, [
    ["thread/goal/get", { threadId: THREAD_A }],
    ["thread/goal/set", { threadId: THREAD_A, status: "paused" }],
  ]);
  assert.equal(observed[0].manualPauseState, "paused");
  assert.equal(observed[0].manualPauseMode, "immediate");
  assert.equal(observed[0].resumeWhenAvailable, false);
});

test("never turns usage or token budget limits into connectivity retries", async () => {
  for (const status of ["usageLimited", "budgetLimited", "blocked", "complete"]) {
    const calls = [];
    const result = await restoreCodexGoals([
      goal(THREAD_A, {
        status,
        resumeWhenAvailable: true,
        suspendedReason: "provider-unavailable",
        retryAttempts: 9,
      }),
    ], {
      request: async (method) => {
        calls.push(method);
        if (method === "thread/goal/get") return { goal: goal(THREAD_A, { status }) };
        throw new Error(`Unexpected request: ${method}`);
      },
    });
    assert.equal(result.reactivated, 0);
    assert.equal(result.resumed, 0);
    assert.equal(result.inactive, 1);
    assert.deepEqual(calls, ["thread/goal/get"]);
  }
});

test("reactivates a usage-limited Goal only after the current provider is verified", async () => {
  const calls = [];
  const observed = [];
  const result = await restoreCodexGoals([
    goal(THREAD_A, { status: "usageLimited", updatedAt: 42 }),
  ], {
    request: async (method, params) => {
      calls.push([method, structuredClone(params)]);
      if (method === "thread/goal/get") {
        return { goal: goal(THREAD_A, { status: "usageLimited", updatedAt: 42 }) };
      }
      if (method === "thread/goal/set") {
        return { goal: goal(THREAD_A, { status: params.status, updatedAt: 43 }) };
      }
      if (method === "thread/read") {
        return { thread: { id: THREAD_A, status: { type: "notLoaded" } } };
      }
      if (method === "thread/resume") return { thread: { id: THREAD_A } };
      throw new Error(`Unexpected request: ${method}`);
    },
    canReactivateUsageLimited: async (stored, nativeGoal) => {
      assert.equal(stored.status, "usageLimited");
      assert.equal(nativeGoal.status, "usageLimited");
      return true;
    },
    onGoal: async (value) => observed.push(value),
  });

  assert.equal(result.reactivated, 1);
  assert.equal(result.resumed, 1);
  assert.equal(result.inactive, 0);
  assert.deepEqual(calls.map(([method]) => method), [
    "thread/goal/get",
    "thread/goal/set",
    "thread/read",
    "thread/resume",
  ]);
  assert.equal(observed[0].status, "active");
});

function goal(threadId, overrides = {}) {
  return {
    threadId,
    objective: "Long-running objective",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 0,
    updatedAt: 0,
    resumeWhenAvailable: false,
    suspendedReason: null,
    failureKind: null,
    retryAttempts: 0,
    nextRetryAt: null,
    lastError: null,
    ...overrides,
  };
}

function rollout(timestamp, payload) {
  return JSON.stringify({ timestamp, type: "event_msg", payload });
}
