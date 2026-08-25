import assert from "node:assert/strict";
import test from "node:test";
import { ThirdPartySubagentSettlementQueue } from "../lib/third-party-subagent-settlement-queue.mjs";

test("settlements stay ordered until the parent becomes deliverable", async () => {
  const attempts = [];
  let ready = false;
  const queue = new ThirdPartySubagentSettlementQueue({
    deliver: async (settlement) => {
      attempts.push(settlement.childId);
      if (!ready) return "defer";
      return "delivered";
    },
  });

  queue.enqueue("parent", { childId: "child-a" });
  queue.enqueue("parent", { childId: "child-b" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attempts, ["child-a"]);

  ready = true;
  queue.notify("parent");
  await queue.flush("parent");
  assert.deepEqual(attempts, ["child-a", "child-a", "child-b"]);
  assert.equal(queue.pending.size, 0);
});

test("different parent threads can flush settlements concurrently", async () => {
  const entered = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = new ThirdPartySubagentSettlementQueue({
    deliver: async (settlement) => {
      entered.push(settlement.childId);
      await gate;
      return "delivered";
    },
  });

  queue.enqueue("parent-a", { childId: "child-a" });
  queue.enqueue("parent-b", { childId: "child-b" });
  for (let attempt = 0; attempt < 50 && entered.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(new Set(entered), new Set(["child-a", "child-b"]));
  release();
  await Promise.all([queue.flush("parent-a"), queue.flush("parent-b")]);
  assert.equal(queue.pending.size, 0);
});

test("a dropped settlement does not block later settlements", async () => {
  const errors = [];
  const delivered = [];
  const queue = new ThirdPartySubagentSettlementQueue({
    deliver: async (settlement) => {
      if (settlement.childId === "child-a") return "drop";
      delivered.push(settlement.childId);
      return "delivered";
    },
    onError: (error, settlement) => errors.push([error.code, settlement.childId]),
  });

  queue.enqueue("parent", { childId: "child-a" });
  queue.enqueue("parent", { childId: "child-b" });
  await queue.flush("parent");
  assert.deepEqual(delivered, ["child-b"]);
  assert.deepEqual(errors, [["SUBAGENT_SETTLEMENT_DROPPED", "child-a"]]);
  assert.equal(queue.pending.size, 0);
});
