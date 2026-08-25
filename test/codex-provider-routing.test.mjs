import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexProviderRoutingStore,
  normalizeProviderRoutingTarget,
  providerRoutingTargetKey,
} from "../lib/codex-provider-routing.mjs";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-routing-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const managed = {
  kind: "managed",
  id: "p-0123456789ab",
  label: "Assigned API",
  model: "gpt-5.2",
  credentialStatus: "configured",
  checkedAt: 1_000,
};

const official = {
  kind: "official",
  id: "oa-0123456789abcdef",
  label: "OpenAI official",
  accountId: "oa-0123456789abcdef",
  accountLabel: "person@example.com",
  credentialStatus: "valid",
  quotaUsedPercent: 24.6,
  checkedAt: 2_000,
};

test("routing settings default off and require an authorized two-target catalog", async (t) => {
  const store = await new CodexProviderRoutingStore(await temporaryDirectory(t), {
    now: () => 10_000,
  }).initialize();
  assert.deepEqual(store.settingsSnapshot(), {
    automaticFailover: false,
    priority: [],
    updatedAt: null,
  });

  await assert.rejects(
    store.updateSettings(
      { automaticFailover: true, priority: [managed.key || "managed:p-0123456789ab"] },
      { eligibleKeys: ["managed:p-0123456789ab"] },
    ),
    /至少需要两个/,
  );
  await assert.rejects(
    store.updateSettings(
      {
        automaticFailover: false,
        priority: ["managed:p-ffffffffffff"],
      },
      { eligibleKeys: ["managed:p-0123456789ab", "official:oa-0123456789abcdef"] },
    ),
    /未授权/,
  );

  const settings = await store.updateSettings({
    automaticFailover: true,
    priority: ["official:oa-0123456789abcdef"],
  }, {
    eligibleKeys: ["managed:p-0123456789ab", "official:oa-0123456789abcdef"],
  });
  assert.deepEqual(settings.priority, [
    "official:oa-0123456789abcdef",
    "managed:p-0123456789ab",
  ]);
  assert.equal(settings.automaticFailover, true);
});

test("thread bindings and audits persist without provider credentials", async (t) => {
  const directory = await temporaryDirectory(t);
  let now = 1_000;
  const store = await new CodexProviderRoutingStore(directory, { now: () => now }).initialize();
  await store.bindThread("thread-1", managed);
  now = 2_000;
  await store.bindThread("thread-1", official);
  await store.recordAudit({
    threadId: "thread-1",
    fromKey: "managed:p-0123456789ab",
    toKey: "official:oa-0123456789abcdef",
    reason: "connectivity",
    result: "switched",
    code: "target-ready",
    apiKey: "must-not-persist",
  });
  await store.recordAudit({
    threadId: "thread-1",
    fromKey: "official:oa-0123456789abcdef",
    toKey: "managed:p-0123456789ab",
    reason: "connectivity",
    result: "restored",
    code: "original-provider-restored",
  });
  await store.recordHealth("managed:p-0123456789ab", {
    status: "valid",
    code: "models-ready",
  });
  await store.setPendingFailover({
    threadId: "thread-1",
    currentKey: "official:oa-0123456789abcdef",
    reason: "quota",
    waitingForIdle: true,
  });

  const content = await fs.readFile(store.filePath, "utf8");
  assert.doesNotMatch(content, /must-not-persist/);
  assert.equal((await fs.stat(store.filePath)).mode & 0o777, 0o600);

  const restored = await new CodexProviderRoutingStore(directory, { now: () => 3_000 }).initialize();
  assert.equal(restored.getBinding("thread-1").accountLabel, "person@example.com");
  assert.equal(restored.snapshot().audit[0].result, "restored");
  assert.equal(restored.getHealth("managed:p-0123456789ab").status, "valid");
  assert.equal(restored.snapshot().pending.waitingForIdle, true);
});

test("routing target helpers reject forged target identifiers and normalize public state", () => {
  assert.equal(
    providerRoutingTargetKey("managed", "p-0123456789ab"),
    "managed:p-0123456789ab",
  );
  assert.throws(
    () => providerRoutingTargetKey("managed", "../../assigned"),
    /目标无效/,
  );
  assert.deepEqual(normalizeProviderRoutingTarget({
    ...official,
    eligible: true,
    active: true,
    secret: "not returned",
  }), {
    key: "official:oa-0123456789abcdef",
    kind: "official",
    id: "oa-0123456789abcdef",
    label: "OpenAI official",
    model: null,
    accountId: "oa-0123456789abcdef",
    accountLabel: "person@example.com",
    credentialStatus: "valid",
    quotaUsedPercent: 24.6,
    checkedAt: 2_000,
    eligible: true,
    active: true,
    disabledReason: null,
  });
});
