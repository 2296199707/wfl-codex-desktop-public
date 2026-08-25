import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { OpsEventStore } from "../lib/ops-event-store.mjs";

test("operations events are sanitized, bounded, filtered, and restored", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-events-");
  let now = 1_000;
  try {
    const store = await new OpsEventStore(directory, { now: () => now, retentionMs: 10_000, maxEvents: 3, compactEvery: 2 }).initialize();
    await store.record({ type: "service.gateway_abnormal", severity: "critical", source: "gateway", title: "Gateway\nfailed", detail: "line\tone" });
    now += 1_000;
    await store.record({ type: "alert.triggered", severity: "warning", source: "alert", title: "Memory high" });
    now += 1_000;
    await store.record({ type: "deployment.completed", severity: "info", source: "deployment", title: "Release complete" });
    now += 1_000;
    await store.record({ type: "service.codex_recovered", severity: "info", source: "codex", title: "Codex ready" });

    assert.equal(store.query().length, 3);
    assert.deepEqual(store.query({ severity: "info" }).map((event) => event.type), ["service.codex_recovered", "deployment.completed"]);
    assert.equal(store.query({ limit: 1 })[0].title, "Codex ready");

    const restored = await new OpsEventStore(directory, { now: () => now, retentionMs: 10_000, maxEvents: 3 }).initialize();
    assert.deepEqual(restored.query(), store.query());
    assert.doesNotMatch(JSON.stringify(restored.query()), /\n|\t/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an inactive event store reloads events recorded before activation", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-events-activation-");
  let now = 1_000;
  try {
    const active = await new OpsEventStore(directory, { now: () => now }).initialize();
    await active.record({ type: "service.started", source: "system", title: "Started" });
    const candidate = await new OpsEventStore(directory, {
      now: () => now,
      writeOnInitialize: false,
    }).initialize();

    now = 2_000;
    await active.record({ type: "service.ready", source: "system", title: "Ready" });
    assert.equal(candidate.query().length, 1);
    await candidate.activate();
    assert.deepEqual(candidate.query().map((event) => event.type), ["service.ready", "service.started"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
