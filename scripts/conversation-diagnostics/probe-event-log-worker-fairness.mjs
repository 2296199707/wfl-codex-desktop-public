import assert from "node:assert/strict";
import process from "node:process";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

const RUNS = 3;
const PER_RUNTIME_QUEUE_HIGH_BYTES = 3 * 1024 * 1024;
const PER_RUNTIME_QUEUE_LOW_BYTES = 2 * 1024 * 1024;
const PER_RUNTIME_QUEUE_HARD_BYTES = 4 * 1024 * 1024;
const PER_RUNTIME_QUEUE_HIGH_MESSAGES = 48;
const PER_RUNTIME_QUEUE_LOW_MESSAGES = 32;
const PER_RUNTIME_QUEUE_HARD_MESSAGES = 64;

async function main() {
  const floodRuns = [];
  const slowRuns = [];
  for (let run = 1; run <= RUNS; run += 1) {
    floodRuns.push(await runFloodScenario());
    slowRuns.push(await runSlowScenario());
  }
  const queue = verifyQueueWatermarks();

  const fifoTerminal = floodRuns.map((run) => run.fifo.target.completedAtMs);
  const fairTerminal = floodRuns.map((run) => run.fair.target.completedAtMs);
  const singleWorkerTerminal = slowRuns.map(
    (run) => run.singleFair.target.completedAtMs,
  );
  const isolatedTerminal = slowRuns.map(
    (run) => run.isolated.target.completedAtMs,
  );
  assert.ok(Math.max(...fairTerminal) < Math.min(...fifoTerminal) / 10);
  assert.ok(
    Math.max(...isolatedTerminal) < Math.min(...singleWorkerTerminal) / 10,
  );

  console.log(JSON.stringify({
    ok: true,
    probe: "event-log-worker-fairness",
    productionCodeExercised: false,
    storageIoSimulated: true,
    externalNetworkAccessed: false,
    rescueWindowAccessed: false,
    topologyFinding: {
      currentBackendProcess: "shared-by-all-user-runtimes",
      currentBridgeAndStateDirectory: "per-user-runtime",
      proposedStorageOwnership:
        "one-lazy-sidecar-and-database-per-active-managed-user-runtime; worker-thread-for-legacy-single-user-only",
    },
    floodScenario: {
      runs: RUNS,
      accountAEvents: 64,
      accountAEventBytes: 64 * 1024,
      accountBTerminalEvents: 1,
      fifoTerminalCompletedMs: range(fifoTerminal),
      fairTerminalCompletedMs: range(fairTerminal),
      fifoMaxConsecutiveWhilePeerPending: range(
        floodRuns.map((run) => run.fifo.maxConsecutiveWhilePeerPending),
      ),
      fairMaxConsecutiveWhilePeerPending: range(
        floodRuns.map((run) => run.fair.maxConsecutiveWhilePeerPending),
      ),
      accountOrderViolations: 0,
    },
    nonPreemptibleScenario: {
      runs: RUNS,
      accountAFirstTransactionMs: 50,
      singleFairWorkerTerminalCompletedMs: range(singleWorkerTerminal),
      isolatedRuntimeExecutorsTerminalCompletedMs: range(isolatedTerminal),
      conclusion: "round-robin cannot preempt a transaction already running",
    },
    queueWatermarks: queue,
    invariants: {
      preservePerAccountSourceOrder: true,
      neverReorderTerminalAheadOfEarlierSameAccountEvents: true,
      pauseOnlyNoisyRuntimeSourceAtHighWater: true,
      neverDropAcceptedBusinessEvent: true,
      resumeBelowLowWater: true,
    },
  }, null, 2));
}

async function runFloodScenario() {
  const jobs = [
    ...Array.from({ length: 64 }, (_, index) => ({
      id: `account-a-${index + 1}`,
      accountId: "account-a",
      sequence: index + 1,
      type: index === 63 ? "turn/completed" : "item/delta",
      bytes: 64 * 1024,
      serviceMs: 3,
    })),
    {
      id: "account-b-terminal",
      accountId: "account-b",
      sequence: 1,
      type: "turn/completed",
      bytes: 256,
      serviceMs: 1,
    },
  ];
  const fifo = await executeOneWorker("fifo", jobs);
  const fair = await executeOneWorker("round-robin", jobs);
  assertAccountOrder(fifo.completed);
  assertAccountOrder(fair.completed);
  return {
    fifo: summarizeExecution(fifo, "account-b-terminal"),
    fair: summarizeExecution(fair, "account-b-terminal"),
  };
}

async function runSlowScenario() {
  const jobs = [
    {
      id: "account-a-slow",
      accountId: "account-a",
      sequence: 1,
      type: "item/delta",
      bytes: 64 * 1024,
      serviceMs: 50,
    },
    ...Array.from({ length: 15 }, (_, index) => ({
      id: `account-a-tail-${index + 2}`,
      accountId: "account-a",
      sequence: index + 2,
      type: index === 14 ? "turn/completed" : "item/delta",
      bytes: 4 * 1024,
      serviceMs: 1,
    })),
    {
      id: "account-b-terminal",
      accountId: "account-b",
      sequence: 1,
      type: "turn/completed",
      bytes: 256,
      serviceMs: 1,
    },
  ];
  const singleFair = await executeOneWorker("round-robin", jobs);
  const isolated = await executeIsolatedWorkers(jobs);
  assertAccountOrder(singleFair.completed);
  assertAccountOrder(isolated.completed);
  return {
    singleFair: summarizeExecution(singleFair, "account-b-terminal"),
    isolated: summarizeExecution(isolated, "account-b-terminal"),
  };
}

async function executeOneWorker(strategy, jobs) {
  const executor = await createExecutor();
  try {
    return await executor.run(strategy, jobs);
  } finally {
    await executor.close();
  }
}

async function executeIsolatedWorkers(jobs) {
  const accountJobs = new Map();
  for (const job of jobs) {
    if (!accountJobs.has(job.accountId)) accountJobs.set(job.accountId, []);
    accountJobs.get(job.accountId).push(job);
  }
  const executors = await Promise.all(
    [...accountJobs].map(async ([accountId, queued]) => ({
      accountId,
      queued,
      executor: await createExecutor(),
    })),
  );
  const startNs = process.hrtime.bigint() + 20_000_000n;
  try {
    const results = await Promise.all(executors.map(({ executor, queued }) => (
      executor.run("fifo", queued, startNs)
    )));
    return {
      strategy: "isolated-runtime-workers",
      completed: results
        .flatMap((result) => result.completed)
        .sort((left, right) => left.completedAtMs - right.completedAtMs),
      schedule: results
        .flatMap((result) => result.schedule)
        .sort((left, right) => left.startedAtMs - right.startedAtMs),
      maxConsecutiveWhilePeerPending: 1,
    };
  } finally {
    await Promise.all(executors.map(({ executor }) => executor.close()));
  }
}

async function createExecutor() {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { role: "executor" },
  });
  await waitForWorkerMessage(worker, (message) => message?.type === "ready");
  let nextRunId = 1;
  return {
    async run(strategy, jobs, suppliedStartNs = null) {
      const runId = nextRunId++;
      const startNs = suppliedStartNs
        ?? (process.hrtime.bigint() + 20_000_000n);
      worker.postMessage({
        type: "run",
        runId,
        strategy,
        jobs,
        startNs,
      });
      return waitForWorkerMessage(
        worker,
        (message) => message?.type === "result" && message.runId === runId,
      ).then((message) => message.result);
    },
    close() {
      return worker.terminate();
    },
  };
}

function waitForWorkerMessage(worker, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("worker fairness probe timed out"));
    }, 10_000);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      if (code === 0) return;
      cleanup();
      reject(new Error(`worker fairness executor exited with ${code}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

function runExecutor() {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  parentPort.on("message", (message) => {
    if (message?.type !== "run") return;
    const remainingMs = Number(message.startNs - process.hrtime.bigint()) / 1e6;
    if (remainingMs > 0) Atomics.wait(sleeper, 0, 0, remainingMs);
    const schedule = scheduleJobs(message.strategy, message.jobs);
    const completed = [];
    for (const job of schedule) {
      const startedAtMs = elapsedMs(message.startNs);
      Atomics.wait(sleeper, 0, 0, job.serviceMs);
      completed.push({
        ...job,
        startedAtMs,
        completedAtMs: elapsedMs(message.startNs),
      });
    }
    parentPort.postMessage({
      type: "result",
      runId: message.runId,
      result: {
        strategy: message.strategy,
        schedule: completed.map((job) => ({
          id: job.id,
          accountId: job.accountId,
          startedAtMs: job.startedAtMs,
        })),
        completed,
        maxConsecutiveWhilePeerPending:
          maxConsecutiveWhilePeerPending(schedule),
      },
    });
  });
  parentPort.postMessage({ type: "ready" });
}

function scheduleJobs(strategy, jobs) {
  if (strategy === "fifo") return [...jobs];
  assert.equal(strategy, "round-robin");
  const queues = new Map();
  for (const job of jobs) {
    if (!queues.has(job.accountId)) queues.set(job.accountId, []);
    queues.get(job.accountId).push(job);
  }
  const scheduled = [];
  while ([...queues.values()].some((queue) => queue.length)) {
    for (const queue of queues.values()) {
      if (queue.length) scheduled.push(queue.shift());
    }
  }
  return scheduled;
}

function maxConsecutiveWhilePeerPending(schedule) {
  const remaining = new Map();
  for (const job of schedule) {
    remaining.set(job.accountId, (remaining.get(job.accountId) ?? 0) + 1);
  }
  let previousAccount = null;
  let consecutive = 0;
  let maximum = 0;
  for (const job of schedule) {
    const peersPending = [...remaining].some(([accountId, count]) => (
      accountId !== job.accountId && count > 0
    ));
    if (job.accountId === previousAccount) consecutive += 1;
    else consecutive = 1;
    if (peersPending) maximum = Math.max(maximum, consecutive);
    remaining.set(job.accountId, remaining.get(job.accountId) - 1);
    previousAccount = job.accountId;
  }
  return maximum;
}

function verifyQueueWatermarks() {
  const queue = new RuntimeQueueBudget();
  let accepted = 0;
  while (!queue.paused) {
    const result = queue.enqueue({
      id: `queued-${accepted + 1}`,
      bytes: 64 * 1024,
    });
    assert.equal(result.accepted, true);
    accepted += 1;
  }
  assert.equal(queue.bytes, PER_RUNTIME_QUEUE_HIGH_BYTES);
  assert.equal(accepted, 48);
  assert.equal(queue.messages.length, 48);

  const peer = new RuntimeQueueBudget();
  const peerTerminal = peer.enqueue({
    id: "peer-terminal",
    bytes: 256,
  });
  assert.equal(peerTerminal.accepted, true);
  assert.equal(peer.paused, false);

  let drained = 0;
  while (queue.paused) {
    queue.dequeue();
    drained += 1;
  }
  assert.ok(queue.bytes <= PER_RUNTIME_QUEUE_LOW_BYTES);
  const resumed = queue.enqueue({ id: "resumed-event", bytes: 64 * 1024 });
  assert.equal(resumed.accepted, true);
  return {
    highWaterBytes: PER_RUNTIME_QUEUE_HIGH_BYTES,
    lowWaterBytes: PER_RUNTIME_QUEUE_LOW_BYTES,
    hardBytes: PER_RUNTIME_QUEUE_HARD_BYTES,
    highWaterMessages: PER_RUNTIME_QUEUE_HIGH_MESSAGES,
    lowWaterMessages: PER_RUNTIME_QUEUE_LOW_MESSAGES,
    hardMessages: PER_RUNTIME_QUEUE_HARD_MESSAGES,
    pausedAfterMessages: accepted,
    pausedRuntimeBytes: PER_RUNTIME_QUEUE_HIGH_BYTES,
    peerTerminalAcceptedWhileNoisyRuntimePaused: true,
    drainedMessagesBeforeResume: drained,
    acceptedEventsDropped: 0,
  };
}

class RuntimeQueueBudget {
  constructor() {
    this.messages = [];
    this.bytes = 0;
    this.paused = false;
  }

  enqueue(job) {
    assert.ok(Number.isSafeInteger(job.bytes) && job.bytes > 0);
    if (
      this.messages.length + 1 > PER_RUNTIME_QUEUE_HARD_MESSAGES
      || this.bytes + job.bytes > PER_RUNTIME_QUEUE_HARD_BYTES
    ) {
      return { accepted: false, action: "source-must-already-be-paused" };
    }
    this.messages.push(job);
    this.bytes += job.bytes;
    if (
      this.messages.length >= PER_RUNTIME_QUEUE_HIGH_MESSAGES
      || this.bytes >= PER_RUNTIME_QUEUE_HIGH_BYTES
    ) {
      this.paused = true;
    }
    return {
      accepted: true,
      action: this.paused ? "pause-source" : "continue",
    };
  }

  dequeue() {
    const job = this.messages.shift() ?? null;
    if (!job) return null;
    this.bytes -= job.bytes;
    if (
      this.messages.length <= PER_RUNTIME_QUEUE_LOW_MESSAGES
      && this.bytes <= PER_RUNTIME_QUEUE_LOW_BYTES
    ) {
      this.paused = false;
    }
    return job;
  }
}

function summarizeExecution(execution, targetId) {
  const target = execution.completed.find((job) => job.id === targetId);
  assert.ok(target);
  return {
    target: {
      id: target.id,
      startedAtMs: round(target.startedAtMs),
      completedAtMs: round(target.completedAtMs),
    },
    maxConsecutiveWhilePeerPending:
      execution.maxConsecutiveWhilePeerPending,
  };
}

function assertAccountOrder(completed) {
  const previous = new Map();
  for (const job of completed) {
    const last = previous.get(job.accountId) ?? 0;
    assert.equal(job.sequence, last + 1);
    previous.set(job.accountId, job.sequence);
  }
}

function elapsedMs(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

function range(values) {
  return {
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

if (!isMainThread) {
  assert.equal(workerData?.role, "executor");
  runExecutor();
} else {
  await main();
}
