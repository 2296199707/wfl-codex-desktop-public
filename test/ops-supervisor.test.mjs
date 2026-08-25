import assert from "node:assert/strict";
import test from "node:test";
import { OpsSupervisor } from "../lib/ops-supervisor.mjs";

test("operations supervisor records only redacted state transitions", async () => {
  const events = [];
  const alerts = [];
  const snapshots = [
    snapshot("healthy", "healthy", "running"),
    snapshot("offline", "offline", "failed"),
    snapshot("healthy", "healthy", "completed"),
  ];
  const supervisor = new OpsSupervisor({
    snapshot: async () => snapshots.shift(),
    eventStore: { record: async (event) => events.push(event) },
    alertManager: { evaluate: async (signal) => alerts.push(signal) },
  });
  await supervisor.poll();
  await supervisor.poll();
  await supervisor.poll();
  assert.deepEqual(events.map((event) => event.type), [
    "service.gateway_abnormal",
    "service.codex_abnormal",
    "deployment.failed",
    "service.gateway_recovered",
    "service.codex_recovered",
    "deployment.completed",
  ]);
  assert.equal(alerts.length, 3);
  assert.doesNotMatch(JSON.stringify(events), /prompt|thread|environment/i);
});

function snapshot(gatewayStatus, codexStatus, release) {
  return {
    gatewayStatus,
    codexStatus,
    codexReady: codexStatus === "offline" ? 0 : 1,
    codexTotal: 1,
    deployments: { release, appUpdate: "idle", codexUpdate: "idle" },
    alertSignal: { gatewayStatus },
  };
}
