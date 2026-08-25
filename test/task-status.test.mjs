import assert from "node:assert/strict";
import test from "node:test";
import { TaskStatusTracker } from "../lib/task-status.mjs";

test("tracks task phases, approval waits, and completion without sensitive details", () => {
  let now = 1000;
  const tracker = new TaskStatusTracker(() => now);
  assert.equal(tracker.snapshot().status, "idle");

  tracker.start({ threadId: "thread-1" });
  now = 2000;
  tracker.started({ threadId: "thread-1", turn: { id: "turn-1" } });
  tracker.notification({
    method: "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution" } },
  });
  assert.equal(tracker.snapshot().phase, "command");

  tracker.serverRequest({ id: 7, params: { threadId: "thread-1", command: "secret command" } });
  const waiting = tracker.snapshot();
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.phase, "approval");
  assert.equal(Object.hasOwn(waiting, "command"), false);

  tracker.serverResponse(7);
  assert.equal(tracker.snapshot().status, "running");
  now = 3000;
  tracker.notification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  });
  const completed = tracker.snapshot();
  assert.equal(completed.status, "completed");
  assert.equal(completed.finishedAt, 3000);
});

test("binds execution context to the active turn without exposing it in task snapshots", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-permission", cwd: "/srv/project" });
  assert.equal(tracker.setExecutionContext({
    threadId: "thread-permission",
    context: {
      cwd: "/srv/project",
      sandboxMode: "read-only",
      approvalPolicy: "ask",
    },
  }), true);
  tracker.started({ threadId: "thread-permission", turn: { id: "turn-permission" } });

  assert.deepEqual(
    tracker.executionContext({ threadId: "thread-permission", turnId: "turn-permission" }),
    {
      cwd: "/srv/project",
      sandboxMode: "read-only",
      approvalPolicy: "ask",
    },
  );
  assert.equal(Object.hasOwn(tracker.snapshot("thread-permission"), "executionContext"), false);

  tracker.moveThread("thread-permission", "thread-permission-native");
  assert.deepEqual(
    tracker.executionContext({ threadId: "thread-permission-native", turnId: "turn-permission" }),
    {
      cwd: "/srv/project",
      sandboxMode: "read-only",
      approvalPolicy: "ask",
    },
  );
  tracker.notification({
    method: "turn/completed",
    params: {
      threadId: "thread-permission-native",
      turn: { id: "turn-permission", status: "completed" },
    },
  });
  assert.equal(
    tracker.executionContext({ threadId: "thread-permission-native", turnId: "turn-permission" }),
    null,
  );
});

test("clears a deleted thread's turn and thread permission contexts together", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-delete", cwd: "/srv/delete" });
  tracker.setExecutionContext({
    threadId: "thread-delete",
    context: { cwd: "/srv/delete", sandboxMode: "workspace-write", approvalPolicy: "never" },
  });
  tracker.started({ threadId: "thread-delete", turn: { id: "turn-delete" } });
  assert.ok(tracker.executionContext({ threadId: "thread-delete", turnId: "turn-delete" }));
  assert.ok(tracker.threadExecutionContext({ threadId: "thread-delete" }));

  assert.equal(tracker.clearThreadExecutionContexts("thread-delete"), true);
  assert.equal(tracker.executionContext({ threadId: "thread-delete", turnId: "turn-delete" }), null);
  assert.equal(tracker.threadExecutionContext({ threadId: "thread-delete" }), null);
  assert.equal(tracker.executionContext({ threadId: "thread-delete" }), null);
});

test("clears only the requested thread's private permission context", () => {
  const tracker = new TaskStatusTracker();
  for (const [threadId, cwd] of [["thread-a", "/srv/a"], ["thread-b", "/srv/b"]]) {
    tracker.start({ threadId, cwd });
    tracker.setExecutionContext({
      threadId,
      context: { cwd, sandboxMode: "read-only", approvalPolicy: "ask" },
    });
    tracker.started({ threadId, turn: { id: `${threadId}-turn` } });
  }
  tracker.clearThreadExecutionContexts("thread-a");
  assert.equal(tracker.executionContext({ threadId: "thread-a", turnId: "thread-a-turn" }), null);
  assert.deepEqual(
    tracker.executionContext({ threadId: "thread-b", turnId: "thread-b-turn" }),
    { cwd: "/srv/b", sandboxMode: "read-only", approvalPolicy: "ask" },
  );
});

test("keeps queued work active across transport loss and starts it without losing wait time", () => {
  let now = 1_000;
  const tracker = new TaskStatusTracker(() => now);
  tracker.queued({
    threadId: "thread-queued",
    cwd: "/srv/project-queued",
    clientSubmissionId: "submission-queued",
  });
  assert.equal(tracker.snapshot("thread-queued").status, "queued");
  assert.equal(tracker.snapshot("thread-queued").queuedAt, 1_000);
  assert.equal(tracker.submissionIsQueued("thread-queued", "submission-queued"), true);
  assert.equal(tracker.hasActiveTasks(), true);

  now = 2_000;
  tracker.bridgeStatus("offline");
  assert.equal(tracker.snapshot("thread-queued").status, "queued");
  assert.equal(tracker.snapshot("thread-queued").phase, "reconnecting");

  now = 3_000;
  tracker.start({
    threadId: "thread-queued",
    cwd: "/srv/project-queued",
    clientSubmissionId: "submission-queued",
  });
  const started = tracker.snapshot("thread-queued");
  assert.equal(started.status, "running");
  assert.equal(started.phase, "starting");
  assert.equal(started.queuedAt, 1_000);
  assert.equal(started.startedAt, 3_000);
});

test("reports interrupted and failed turns", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-2" });
  tracker.stopping({ threadId: "thread-2", turnId: "turn-2" });
  assert.equal(tracker.snapshot().status, "stopping");
  tracker.notification({
    method: "turn/completed",
    params: { threadId: "thread-2", turn: { id: "turn-2", status: "interrupted" } },
  });
  assert.equal(tracker.snapshot().status, "interrupted");

  tracker.start({ threadId: "thread-3" });
  tracker.notification({ method: "error", params: { threadId: "thread-3", willRetry: false } });
  assert.equal(tracker.snapshot().status, "failed");
});

test("a late interrupt error cannot resurrect an already completed turn", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-stop", turnId: "turn-stop" });
  tracker.stopping({ threadId: "thread-stop", turnId: "turn-stop" });
  tracker.notification({
    method: "turn/completed",
    params: { threadId: "thread-stop", turn: { id: "turn-stop", status: "interrupted" } },
  });
  tracker.interruptFailed({ threadId: "thread-stop", turnId: "turn-stop" });
  assert.equal(tracker.snapshot().status, "interrupted");

  tracker.start({ threadId: "thread-running", turnId: "turn-running" });
  tracker.stopping({ threadId: "thread-running", turnId: "turn-running" });
  tracker.interruptFailed({ threadId: "thread-running", turnId: "turn-running" });
  assert.equal(tracker.snapshot().status, "running");

  tracker.start({ threadId: "thread-new", turnId: "turn-new" });
  tracker.stopping({ threadId: "thread-new", turnId: "turn-new" });
  tracker.interruptFailed({ threadId: "thread-old", turnId: "turn-old" });
  assert.equal(tracker.snapshot().status, "stopping");
  assert.equal(tracker.snapshot().turnId, "turn-new");
});

test("reports official context compaction items as a compacting task", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-compact" });
  tracker.started({ threadId: "thread-compact", turn: { id: "turn-compact" } });
  tracker.notification({
    method: "item/started",
    params: {
      threadId: "thread-compact",
      turnId: "turn-compact",
      item: { id: "item-compact", type: "contextCompaction" },
    },
  });
  assert.equal(tracker.snapshot().status, "running");
  assert.equal(tracker.snapshot().phase, "compacting");

  tracker.notification({
    method: "turn/completed",
    params: {
      threadId: "thread-compact",
      turn: { id: "turn-compact", status: "completed" },
    },
  });
  assert.equal(tracker.snapshot().status, "completed");
});

test("reports official collaboration items as subtask coordination", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-collaboration" });
  tracker.started({ threadId: "thread-collaboration", turn: { id: "turn-collaboration" } });
  tracker.notification({
    method: "item/started",
    params: {
      threadId: "thread-collaboration",
      turnId: "turn-collaboration",
      item: { id: "item-collaboration", type: "collabAgentToolCall", tool: "spawnAgent" },
    },
  });
  assert.equal(tracker.snapshot().status, "running");
  assert.equal(tracker.snapshot().phase, "collaboration");
});

test("moves active task state when an imported thread becomes native", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "import_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", turnId: "turn-native" });
  assert.equal(tracker.moveThread("import_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "thread-native"), true);
  assert.equal(tracker.snapshot("thread-native").turnId, "turn-native");
  tracker.notification({
    method: "turn/completed",
    params: { threadId: "thread-native", turn: { id: "turn-native", status: "completed" } },
  });
  assert.equal(tracker.snapshot("thread-native").status, "completed");
});

test("late and unrelated notifications cannot create ghost active tasks", () => {
  const tracker = new TaskStatusTracker(
    () => Date.now(),
    { allowSyntheticThreadActive: false },
  );

  tracker.notification({
    method: "thread/status/changed",
    params: { threadId: "persisted-active", status: { type: "active" } },
  });
  assert.equal(tracker.snapshot("persisted-active").status, "idle");

  tracker.notification({
    method: "item/started",
    params: { threadId: "unknown", turnId: "unknown-turn", item: { type: "commandExecution" } },
  });
  tracker.notification({
    method: "turn/completed",
    params: { threadId: "unknown", turn: { id: "unknown-turn", status: "completed" } },
  });
  tracker.serverRequest({ id: 9, params: { threadId: "unknown", turnId: "unknown-turn" } });
  assert.equal(tracker.hasActiveTasks(), false);
  assert.equal(tracker.snapshot().status, "idle");

  tracker.start({ threadId: "thread-late" });
  tracker.started({ threadId: "thread-late", turn: { id: "turn-finished" } });
  tracker.notification({
    method: "turn/completed",
    params: { threadId: "thread-late", turn: { id: "turn-finished", status: "completed" } },
  });
  tracker.notification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-late", turnId: "turn-finished" },
  });
  tracker.notification({ method: "thread/compacted", params: { threadId: "thread-late" } });
  assert.equal(tracker.hasActiveTasks(), false);
  assert.equal(tracker.snapshot("thread-late").status, "completed");
});

test("a replayed turn/started cannot resurrect the same terminal turn", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-replayed", turnId: "turn-replayed" });
  tracker.notification({
    method: "turn/completed",
    params: {
      threadId: "thread-replayed",
      turn: { id: "turn-replayed", status: "interrupted" },
    },
  });

  tracker.notification({
    method: "turn/started",
    params: {
      threadId: "thread-replayed",
      turn: { id: "turn-replayed", status: "inProgress" },
    },
  });

  assert.equal(tracker.snapshot("thread-replayed").status, "interrupted");
  assert.equal(tracker.hasActiveTasks(), false);
});

test("an app-server exit terminates tasks whose completion notification was lost", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-crashed" });
  tracker.started({ threadId: "thread-crashed", turn: { id: "turn-crashed" } });
  tracker.serverRequest({ id: 15, params: { threadId: "thread-crashed", turnId: "turn-crashed" } });

  tracker.bridgeStatus("offline");

  assert.equal(tracker.hasActiveTasks(), false);
  assert.equal(tracker.snapshot("thread-crashed").status, "failed");
  tracker.serverResponse(15);
  assert.equal(tracker.snapshot("thread-crashed").status, "failed");
});

test("delivery-unknown tasks remain active across disconnect until authoritative reconciliation", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({
    threadId: "thread-uncertain",
    clientSubmissionId: "client-message-uncertain",
  });
  tracker.deliveryUnknown({
    threadId: "thread-uncertain",
    clientSubmissionId: "client-message-uncertain",
  });
  tracker.serverRequest({
    id: 16,
    params: { threadId: "thread-uncertain" },
  });

  assert.equal(tracker.snapshot("thread-uncertain").status, "waiting");
  tracker.deliveryUnknown({
    threadId: "thread-uncertain",
    clientSubmissionId: "client-message-uncertain",
  });
  tracker.bridgeStatus("offline");

  const disconnected = tracker.snapshot("thread-uncertain");
  assert.equal(disconnected.status, "uncertain");
  assert.equal(disconnected.phase, "reconnecting");
  assert.equal(disconnected.finishedAt, null);
  assert.equal(tracker.hasActiveTasks(), true);
  assert.deepEqual(tracker.uncertainThreadIds(), ["thread-uncertain"]);
  assert.equal(
    tracker.submissionIsUncertain("thread-uncertain", "client-message-uncertain"),
    true,
  );
  assert.equal(
    tracker.submissionIsUncertain("thread-uncertain", "different-client-message"),
    false,
  );

  tracker.serverResponse(16);
  assert.equal(tracker.snapshot("thread-uncertain").status, "uncertain");
  tracker.started({
    threadId: "thread-uncertain",
    turn: { id: "turn-authoritative" },
  });
  assert.equal(tracker.snapshot("thread-uncertain").status, "running");
  assert.equal(tracker.snapshot("thread-uncertain").turnId, "turn-authoritative");

  tracker.notification({
    method: "turn/completed",
    params: {
      threadId: "thread-uncertain",
      turn: { id: "turn-authoritative", status: "completed" },
    },
  });
  assert.equal(tracker.snapshot("thread-uncertain").status, "completed");
  assert.equal(tracker.hasActiveTasks(), false);
});

test("authoritative thread status events recover and settle tasks when turn events were missed", () => {
  const tracker = new TaskStatusTracker();
  tracker.notification({
    method: "thread/status/changed",
    params: {
      threadId: "thread-lifecycle",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    },
  });
  assert.equal(tracker.snapshot("thread-lifecycle").status, "waiting");
  assert.equal(tracker.snapshot("thread-lifecycle").phase, "approval");

  tracker.notification({
    method: "thread/status/changed",
    params: {
      threadId: "thread-lifecycle",
      status: { type: "active", activeFlags: [] },
    },
  });
  assert.equal(tracker.snapshot("thread-lifecycle").status, "running");

  tracker.notification({
    method: "thread/status/changed",
    params: { threadId: "thread-lifecycle", status: { type: "idle" } },
  });
  assert.equal(tracker.snapshot("thread-lifecycle").status, "completed");

  tracker.notification({
    method: "thread/status/changed",
    params: { threadId: "thread-system-error", status: { type: "active", activeFlags: [] } },
  });
  tracker.notification({
    method: "thread/status/changed",
    params: { threadId: "thread-system-error", status: { type: "systemError" } },
  });
  assert.equal(tracker.snapshot("thread-system-error").status, "failed");
});

test("notifications from an older turn cannot mutate the active turn", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-shared" });
  tracker.started({ threadId: "thread-shared", turn: { id: "turn-old" } });
  tracker.start({ threadId: "thread-shared" });
  tracker.started({ threadId: "thread-shared", turn: { id: "turn-current" } });

  tracker.notification({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "thread-shared", turnId: "turn-old" },
  });
  tracker.notification({
    method: "turn/completed",
    params: { threadId: "thread-shared", turn: { id: "turn-old", status: "completed" } },
  });

  assert.equal(tracker.snapshot("thread-shared").status, "running");
  assert.equal(tracker.snapshot("thread-shared").phase, "working");
  assert.equal(tracker.snapshot("thread-shared").turnId, "turn-current");
});

test("late thread lifecycle events cannot settle or revive an identified turn", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-current", turnId: "turn-current" });
  tracker.started({ threadId: "thread-current", turn: { id: "turn-current" } });

  tracker.notification({
    method: "thread/status/changed",
    params: { threadId: "thread-current", status: { type: "idle" } },
  });
  tracker.notification({
    method: "thread/status/changed",
    params: { threadId: "thread-current", status: { type: "systemError" } },
  });
  assert.equal(tracker.snapshot("thread-current").status, "running");
  assert.equal(tracker.snapshot("thread-current").turnId, "turn-current");

  tracker.stopping({ threadId: "thread-current", turnId: "turn-current" });
  tracker.notification({
    method: "turn/started",
    params: {
      threadId: "thread-current",
      turn: { id: "turn-current", status: "inProgress" },
    },
  });
  tracker.notification({
    method: "thread/status/changed",
    params: { threadId: "thread-current", status: { type: "active", activeFlags: [] } },
  });
  assert.equal(tracker.snapshot("thread-current").status, "stopping");

  tracker.notification({
    method: "turn/completed",
    params: {
      threadId: "thread-current",
      turn: { id: "turn-current", status: "interrupted" },
    },
  });
  assert.equal(tracker.snapshot("thread-current").status, "interrupted");
});

test("a late newer turn cannot replace the Turn that is stopping", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-stop-fence", turnId: "turn-old" });
  tracker.stopping({ threadId: "thread-stop-fence", turnId: "turn-old" });

  tracker.notification({
    method: "turn/started",
    params: {
      threadId: "thread-stop-fence",
      turn: { id: "turn-new", status: "inProgress" },
    },
  });

  assert.equal(tracker.snapshot("thread-stop-fence").status, "stopping");
  assert.equal(tracker.snapshot("thread-stop-fence").turnId, "turn-old");

  tracker.notification({
    method: "turn/completed",
    params: {
      threadId: "thread-stop-fence",
      turn: { id: "turn-old", status: "interrupted" },
    },
  });
  assert.equal(tracker.snapshot("thread-stop-fence").status, "interrupted");
  assert.equal(tracker.hasActiveTasks(), false);

  // A genuinely new Turn is allowed after the old one has reached a
  // terminal state.
  tracker.notification({
    method: "turn/started",
    params: {
      threadId: "thread-stop-fence",
      turn: { id: "turn-new", status: "inProgress" },
    },
  });
  assert.equal(tracker.snapshot("thread-stop-fence").status, "running");
  assert.equal(tracker.snapshot("thread-stop-fence").turnId, "turn-new");
});

test("a delayed thread/closed event cannot complete an identified active Turn", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-close-fence" });
  tracker.started({ threadId: "thread-close-fence", turn: { id: "turn-close" } });

  tracker.notification({
    method: "thread/closed",
    params: { threadId: "thread-close-fence" },
  });
  assert.equal(tracker.snapshot("thread-close-fence").status, "running");
  assert.equal(tracker.snapshot("thread-close-fence").turnId, "turn-close");

  tracker.notification({
    method: "turn/completed",
    params: {
      threadId: "thread-close-fence",
      turn: { id: "turn-close", status: "interrupted" },
    },
  });
  assert.equal(tracker.snapshot("thread-close-fence").status, "interrupted");
});

test("delivery uncertainty preserves an in-flight stopping Turn", () => {
  const tracker = new TaskStatusTracker();
  tracker.start({ threadId: "thread-uncertain-stop", turnId: "turn-stop" });
  tracker.stopping({ threadId: "thread-uncertain-stop", turnId: "turn-stop" });

  tracker.deliveryUnknown({
    threadId: "thread-uncertain-stop",
    turnId: "turn-a-late-event",
  });

  const stopping = tracker.snapshot("thread-uncertain-stop");
  assert.equal(stopping.status, "stopping");
  assert.equal(stopping.phase, "reconciling");
  assert.equal(stopping.turnId, "turn-stop");

  tracker.notification({
    method: "turn/completed",
    params: {
      threadId: "thread-uncertain-stop",
      turn: { id: "turn-stop", status: "interrupted" },
    },
  });
  assert.equal(tracker.snapshot("thread-uncertain-stop").status, "interrupted");
  assert.equal(tracker.hasActiveTasks(), false);
});

test("keeps simultaneous conversation tasks isolated until each one finishes", () => {
  let now = 1000;
  const tracker = new TaskStatusTracker(() => now);
  tracker.start({ threadId: "thread-a" });
  tracker.started({ threadId: "thread-a", turn: { id: "turn-a" } });
  now = 2000;
  tracker.start({ threadId: "thread-b" });
  tracker.started({ threadId: "thread-b", turn: { id: "turn-b" } });

  assert.equal(tracker.snapshot("thread-a").status, "running");
  assert.equal(tracker.snapshot("thread-b").status, "running");
  assert.equal(tracker.snapshot().activeTasks, 2);
  assert.equal(tracker.hasActiveTasks(), true);
  assert.equal(tracker.hasOtherActiveTasks("thread-a"), true);
  assert.equal(tracker.hasOtherActiveTasks("thread-missing"), true);

  now = 3000;
  tracker.notification({
    method: "turn/completed",
    params: { threadId: "thread-b", turn: { id: "turn-b", status: "completed" } },
  });
  assert.equal(tracker.snapshot("thread-b").status, "completed");
  assert.equal(tracker.snapshot("thread-a").status, "running");
  assert.equal(tracker.snapshot().threadId, "thread-a");
  assert.equal(tracker.snapshot().activeTasks, 1);
  assert.equal(tracker.hasActiveTasks(), true);
  assert.equal(tracker.hasOtherActiveTasks("thread-a"), false);

  tracker.notification({
    method: "turn/completed",
    params: { threadId: "thread-a", turn: { id: "turn-a", status: "interrupted" } },
  });
  assert.equal(tracker.snapshot("thread-a").status, "interrupted");
  assert.equal(tracker.snapshot().activeTasks, 0);
  assert.equal(tracker.hasActiveTasks(), false);
});

test("lists bounded per-project task snapshots without collapsing concurrent threads", () => {
  let now = 10_000;
  const tracker = new TaskStatusTracker(() => now);
  for (let index = 0; index < 4; index += 1) {
    tracker.start({
      threadId: `thread-project-${index}`,
      turnId: `turn-project-${index}`,
      cwd: `/srv/projects/project-${index}`,
    });
    tracker.started({
      threadId: `thread-project-${index}`,
      turn: { id: `turn-project-${index}` },
      cwd: `/srv/projects/project-${index}`,
    });
    now += 10;
  }
  const active = tracker.list({ limit: 10 });
  assert.equal(active.activeTasks, 4);
  assert.equal(active.tasks.length, 4);
  assert.deepEqual(
    new Set(active.tasks.map((task) => task.cwd)),
    new Set([
      "/srv/projects/project-0",
      "/srv/projects/project-1",
      "/srv/projects/project-2",
      "/srv/projects/project-3",
    ]),
  );

  tracker.notification({
    method: "turn/completed",
    params: {
      threadId: "thread-project-2",
      turn: { id: "turn-project-2", status: "completed" },
    },
  });
  const afterCompletion = tracker.list({ limit: 3 });
  assert.equal(afterCompletion.activeTasks, 3);
  assert.equal(afterCompletion.tasks.length, 3);
  assert.equal(afterCompletion.tasks.every((task) => task.threadId !== "thread-project-2"), true);
});
