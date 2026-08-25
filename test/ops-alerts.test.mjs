import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  isPublicAddress,
  OpsAlertManager,
  OpsAlertStore,
  resolvePublicWebhookTarget,
  validateWebhookUrl,
} from "../lib/ops-alerts.mjs";
import { OpsEventStore } from "../lib/ops-event-store.mjs";

test("alert settings encrypt webhook URLs and expose only the destination host", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-alert-settings-");
  try {
    const store = await new OpsAlertStore(directory).initialize();
    const secretUrl = "https://hooks.example.test/private/path?token=webhook-secret";
    const settings = await store.updateSettings({ webhookUrl: secretUrl });
    assert.deepEqual(settings.webhook, { configured: true, host: "hooks.example.test" });
    assert.doesNotMatch(JSON.stringify(settings), /private|webhook-secret/);
    assert.doesNotMatch(await fs.readFile(path.join(directory, "ops-alerts.enc.json"), "utf8"), /private|webhook-secret/);
    assert.equal((await fs.stat(path.join(directory, "ops-alerts.key"))).mode & 0o777, 0o600);

    const candidate = await new OpsAlertStore(directory).initialize({ writeOnInitialize: false });
    await store.updateSettings({ webhookUrl: "https://new-hooks.example.test/ops" });
    assert.equal(candidate.publicSettings().webhook.host, "hooks.example.test");
    await candidate.activate();
    assert.equal(candidate.publicSettings().webhook.host, "new-hooks.example.test");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("webhook validation and resolution reject local, private, and reserved targets", async () => {
  assert.throws(() => validateWebhookUrl("http://hooks.example.test/x"), /HTTPS/);
  assert.throws(() => validateWebhookUrl("https://127.0.0.1/x"), /本机|内网/);
  assert.throws(() => validateWebhookUrl("https://[::1]/x"), /本机|内网/);
  assert.throws(() => validateWebhookUrl("https://[::ffff:127.0.0.1]/x"), /本机|内网/);
  assert.equal(isPublicAddress("8.8.8.8", 4), true);
  assert.equal(isPublicAddress("10.0.0.1", 4), false);
  assert.equal(isPublicAddress("::ffff:127.0.0.1", 6), false);
  await assert.rejects(
    resolvePublicWebhookTarget("https://hooks.example.test/x", async () => [{ address: "192.168.1.5", family: 4 }]),
    /private or reserved/,
  );
  await assert.rejects(
    resolvePublicWebhookTarget("https://hooks.example.test/x", async () => [{ address: "::ffff:127.0.0.1", family: 6 }]),
    /private or reserved/,
  );
  assert.deepEqual(
    await resolvePublicWebhookTarget("https://hooks.example.test/x", async () => [{ address: "8.8.8.8", family: 4 }]),
    { address: "8.8.8.8", family: 4 },
  );
});

test("alerts require consecutive failures, recover once, and respect notification state", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-ops-alert-manager-");
  let now = 10_000;
  const sent = [];
  try {
    const eventStore = await new OpsEventStore(directory, { now: () => now }).initialize();
    const store = await new OpsAlertStore(directory, { now: () => now }).initialize();
    await store.updateSettings({
      webhookUrl: "https://hooks.example.test/ops",
      rules: { disk_usage: { consecutive: 2, cooldownMinutes: 60, thresholdPercent: 80 } },
    });
    const manager = new OpsAlertManager({
      store,
      eventStore,
      now: () => now,
      notifier: { send: async (_url, payload) => sent.push(payload) },
    });
    const healthy = { diskPercent: 10, memoryPercent: 10, codexReady: 1, codexTotal: 1, gatewayStatus: "healthy", releaseFailed: false };
    await manager.evaluate({ ...healthy, diskPercent: 85 });
    assert.equal(manager.snapshot().active, 0);
    now += 10_000;
    await manager.evaluate({ ...healthy, diskPercent: 86 });
    assert.equal(manager.snapshot().active, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, "triggered");

    now += 10_000;
    await manager.evaluate(healthy);
    assert.equal(manager.snapshot().active, 0);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].status, "recovered");
    assert.deepEqual(eventStore.query().map((event) => event.type), ["alert.recovered", "alert.triggered"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
