import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { OpsHistoryStore } from "../lib/ops-history-store.mjs";

test("operations history persists 24-hour raw metrics and seven-day hourly trends", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-history-");
  let now = Date.UTC(2026, 6, 20, 0, 0, 0);
  try {
    const store = await new OpsHistoryStore(directory, { now: () => now }).initialize();
    for (let hour = 0; hour < 30; hour += 1) {
      now = Date.UTC(2026, 6, 20, hour, 0, 0);
      await store.record(sample(now, 20 + hour));
      now += 30 * 60 * 1000;
      await store.record(sample(now, 21 + hour));
    }

    const raw = store.query("24h");
    assert.equal(raw.range, "24h");
    assert.ok(raw.samples.length <= 49);
    assert.ok(raw.samples.every((entry) => entry.at >= now - 24 * 60 * 60 * 1000));

    const weekly = store.query("7d");
    assert.equal(weekly.granularitySeconds, 3600);
    assert.ok(weekly.samples.length >= 29);
    assert.ok(weekly.samples[0].at < raw.samples[0].at);
    await store.flush();

    const restored = await new OpsHistoryStore(directory, { now: () => now }).initialize();
    assert.deepEqual(restored.query("24h"), raw);
    assert.deepEqual(restored.query("7d"), weekly);
    const mode = (await fs.stat(path.join(directory, "ops-metrics.ndjson"))).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an inactive history store reloads the latest samples when it becomes active", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-history-activation-");
  let now = 1_000;
  try {
    const active = await new OpsHistoryStore(directory, { now: () => now }).initialize();
    await active.record(sample(now, 10));
    const candidate = await new OpsHistoryStore(directory, {
      now: () => now,
      writeOnInitialize: false,
    }).initialize();

    now = 2_000;
    await active.record(sample(now, 20));
    assert.equal(candidate.latest().at, 1_000);
    await candidate.activate();
    assert.equal(candidate.latest().at, 2_000);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function sample(at, percent) {
  return {
    at,
    cpuPercent: percent,
    memory: { usedBytes: percent, totalBytes: 100, percent },
    disk: { usedBytes: percent, totalBytes: 100, percent },
  };
}
