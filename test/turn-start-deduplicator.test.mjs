import assert from "node:assert/strict";
import test from "node:test";
import {
  ThreadStartDeduplicator,
  TurnStartDeduplicator,
  findTurnByClientMessageId,
} from "../lib/turn-start-deduplicator.mjs";

test("concurrent new-thread retries share one thread/start request", async () => {
  let starts = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deduplicator = new ThreadStartDeduplicator();
  const startThread = async () => {
    starts += 1;
    await gate;
    return { thread: { id: "thread-new" } };
  };

  const first = deduplicator.run("client-thread-1", startThread);
  const second = deduplicator.run("client-thread-1", startThread);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(starts, 1);
  assert.strictEqual(firstResult, secondResult);
  assert.equal(firstResult.thread.id, "thread-new");
});

test("failed new-thread requests can be retried with the same request ID", async () => {
  let starts = 0;
  const deduplicator = new ThreadStartDeduplicator();
  await assert.rejects(
    deduplicator.run("client-thread-retry", async () => {
      starts += 1;
      throw new Error("temporary failure");
    }),
    /temporary failure/,
  );
  const result = await deduplicator.run("client-thread-retry", async () => {
    starts += 1;
    return { thread: { id: "thread-retried" } };
  });

  assert.equal(starts, 2);
  assert.equal(result.thread.id, "thread-retried");
});

test("concurrent turn retries share one turn/start request", async () => {
  let starts = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deduplicator = new TurnStartDeduplicator(async (method) => {
    assert.equal(method, "thread/read");
    return { thread: { turns: [] } };
  });
  const params = { threadId: "thread-1", clientUserMessageId: "client-1" };
  const startTurn = async () => {
    starts += 1;
    await gate;
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  };

  const first = deduplicator.run(params, startTurn);
  const second = deduplicator.run(params, startTurn);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(starts, 1);
  assert.equal(firstResult.turn.id, "turn-1");
  assert.strictEqual(firstResult, secondResult);
});

test("a proven unmaterialized shell can skip the duplicate snapshot read", async () => {
  let reads = 0;
  const deduplicator = new TurnStartDeduplicator(async () => {
    reads += 1;
    throw new Error("snapshot read should not run");
  });
  let starts = 0;
  const result = await deduplicator.run(
    { threadId: "thread-new", clientUserMessageId: "client-first" },
    async () => {
      starts += 1;
      return { turn: { id: "turn-first" } };
    },
    { skipRead: true },
  );

  assert.equal(reads, 0);
  assert.equal(starts, 1);
  assert.equal(result.turn.id, "turn-first");
});

test("turn snapshot reads remain enabled by default", async () => {
  let reads = 0;
  const deduplicator = new TurnStartDeduplicator(async () => {
    reads += 1;
    throw new Error("thread/read timed out");
  });

  await assert.rejects(
    deduplicator.run(
      { threadId: "thread-1", clientUserMessageId: "client-1" },
      async () => ({ turn: { id: "unexpected" } }),
    ),
    /thread\/read timed out/,
  );
  assert.equal(reads, 1);
});

test("an existing client message returns its turn without starting another", async () => {
  const existingTurn = {
    id: "turn-existing",
    items: [{ type: "userMessage", clientId: "client-existing", content: [] }],
  };
  const deduplicator = new TurnStartDeduplicator(async () => ({ thread: { turns: [existingTurn] } }));
  let starts = 0;
  const result = await deduplicator.run(
    { threadId: "thread-1", clientUserMessageId: "client-existing" },
    async () => {
      starts += 1;
      return { turn: { id: "unexpected" } };
    },
  );

  assert.equal(starts, 0);
  assert.strictEqual(result.turn, existingTurn);
  assert.strictEqual(findTurnByClientMessageId({ turns: [existingTurn] }, "client-existing"), existingTurn);
});

test("an unmaterialized new thread starts its first turn without a snapshot", async () => {
  const deduplicator = new TurnStartDeduplicator(async () => {
    throw new Error(
      "thread thread-new is not materialized yet; includeTurns is unavailable before first user message",
    );
  });
  let starts = 0;
  const result = await deduplicator.run(
    { threadId: "thread-new", clientUserMessageId: "client-first" },
    async () => {
      starts += 1;
      return { turn: { id: "turn-first" } };
    },
  );

  assert.equal(starts, 1);
  assert.equal(result.turn.id, "turn-first");
});

test("a known empty shell can bypass only its missing rollout snapshot", async () => {
  const deduplicator = new TurnStartDeduplicator(async () => {
    throw new Error("no rollout found for thread id thread-empty-shell");
  });
  let starts = 0;
  const result = await deduplicator.run(
    { threadId: "thread-empty-shell", clientUserMessageId: "client-first" },
    async () => {
      starts += 1;
      return { turn: { id: "turn-first" } };
    },
    { allowUnmaterializedReadFailure: true },
  );

  assert.equal(starts, 1);
  assert.equal(result.turn.id, "turn-first");
});

test("a known empty shell can bypass a native thread-not-found snapshot", async () => {
  const deduplicator = new TurnStartDeduplicator(async () => {
    throw new Error("thread not found: thread-empty-shell");
  });
  let starts = 0;
  const result = await deduplicator.run(
    { threadId: "thread-empty-shell", clientUserMessageId: "client-first" },
    async () => {
      starts += 1;
      return { turn: { id: "turn-first" } };
    },
    { allowUnmaterializedReadFailure: true },
  );

  assert.equal(starts, 1);
  assert.equal(result.turn.id, "turn-first");
});

test("snapshot failures unrelated to materialization do not start a turn", async () => {
  const deduplicator = new TurnStartDeduplicator(async () => {
    throw new Error("thread/read timed out");
  });
  let starts = 0;

  await assert.rejects(
    deduplicator.run(
      { threadId: "thread-1", clientUserMessageId: "client-1" },
      async () => {
        starts += 1;
        return { turn: { id: "unexpected" } };
      },
    ),
    /thread\/read timed out/,
  );
  assert.equal(starts, 0);
});
