import assert from "node:assert/strict";
import test from "node:test";
import { OpsMonitor } from "../lib/ops-monitor.mjs";

test("ops monitor records bounded normalized resource history", async () => {
  let now = 0;
  const persisted = [];
  const cpuSnapshots = [
    { idle: 100, total: 200 },
    { idle: 120, total: 240 },
    { idle: 130, total: 280 },
    { idle: 160, total: 340 },
  ];
  const networkSnapshots = [
    { rxBytes: 100, txBytes: 50 },
    { rxBytes: 1_100, txBytes: 550 },
    { rxBytes: 3_100, txBytes: 1_550 },
  ];
  const monitor = new OpsMonitor({
    now: () => now,
    cpuTimes: () => cpuSnapshots.shift(),
    memoryUsage: () => ({ usedBytes: 75, totalBytes: 100 }),
    diskUsage: async () => ({ usedBytes: 150, totalBytes: 100 }),
    networkUsage: async () => networkSnapshots.shift(),
    intervalMs: 1_000,
    maxSamples: 2,
    onSample: async (sample) => persisted.push(sample.at),
  });

  const first = await monitor.sample();
  assert.equal(first.cpuPercent, 50);
  assert.equal(first.memory.percent, 75);
  assert.deepEqual(first.disk, { usedBytes: 100, totalBytes: 100, percent: 100 });
  assert.deepEqual(first.network, { rxBytesPerSecond: 0, txBytesPerSecond: 0 });

  now = 500;
  assert.deepEqual(await monitor.sample(), first);
  assert.equal(monitor.history().length, 1);

  now = 1_000;
  const second = await monitor.sample();
  assert.deepEqual(second.network, { rxBytesPerSecond: 1000, txBytesPerSecond: 500 });
  now = 2_000;
  await monitor.sample();
  assert.deepEqual(monitor.history().map((sample) => sample.at), [1_000, 2_000]);

  const snapshot = monitor.history();
  snapshot[0].cpuPercent = 999;
  assert.notEqual(monitor.history()[0].cpuPercent, 999);
  assert.deepEqual(persisted, [0, 1_000, 2_000]);
});
