import assert from "node:assert/strict";
import test from "node:test";
import { calculateOpsHealth } from "../lib/ops-health.mjs";

test("health score is deterministic and does not penalize missing usage data", () => {
  const input = {
    services: { gateway: { status: "healthy" }, codex: { status: "healthy" } },
    traffic: { successRate: 100, turns: 0, turnErrors: 0, p95LatencyMs: null },
    resources: { memory: { percent: 20 }, disk: { percent: 30 } },
    network: { socketOpens: 0, socketCloses: 0 },
  };
  assert.deepEqual(calculateOpsHealth(input), calculateOpsHealth(input));
  assert.equal(calculateOpsHealth(input).score, 100);
});

test("health score applies critical service and disk caps", () => {
  const offline = calculateOpsHealth({
    services: { gateway: { status: "offline" }, codex: { status: "healthy" } },
    traffic: { successRate: 100 }, resources: { memory: { percent: 10 }, disk: { percent: 20 } },
  });
  assert.ok(offline.score <= 35);
  assert.match(offline.caps[0].reason, /网关/);

  const disk = calculateOpsHealth({
    services: { gateway: { status: "healthy" }, codex: { status: "healthy" } },
    traffic: { successRate: 100 }, resources: { memory: { percent: 10 }, disk: { percent: 98 } },
  });
  assert.ok(disk.score <= 40);
});
