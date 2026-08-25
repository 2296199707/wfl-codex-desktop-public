import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsDeviceStore } from "../lib/windows-device-store.mjs";

test("Windows device pairing is single-use and never persists plaintext credentials", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-windows-devices-"));
  let now = 1_000_000;
  try {
    const store = await new WindowsDeviceStore(stateDirectory, { now: () => now }).initialize();
    const pairing = await store.createPairing({
      userId: "user-a",
      pluginIds: ["windows-codex-remote", "creator-worker"],
      requestedBySessionId: "session-a",
    });
    const beforeConsume = await fs.readFile(path.join(stateDirectory, "windows-devices.json"), "utf8");
    assert.doesNotMatch(beforeConsume, new RegExp(pairing.code.replaceAll("-", ".?")));

    const paired = await store.consumePairing({
      code: pairing.code,
      name: "Personal PC",
      platform: "windows",
      agentVersion: "0.1.0",
      protocolVersion: 1,
    });
    assert.equal(paired.device.userId, "user-a");
    assert.equal(paired.device.epoch, 1);
    assert.deepEqual(paired.device.pluginIds, ["creator-worker", "windows-codex-remote"]);
    assert.equal(store.authenticate(paired.device.id, paired.token).id, paired.device.id);

    const afterConsume = await fs.readFile(path.join(stateDirectory, "windows-devices.json"), "utf8");
    assert.doesNotMatch(afterConsume, new RegExp(paired.token));
    assert.equal((await fs.stat(path.join(stateDirectory, "windows-devices.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(stateDirectory, "windows-device-pepper"))).mode & 0o777, 0o600);

    await assert.rejects(store.consumePairing({
      code: pairing.code,
      name: "Replay PC",
      platform: "windows",
      agentVersion: "0.1.0",
      protocolVersion: 1,
    }), /无效或已过期/);
    assert.equal(store.snapshot("user-b").devices.length, 0);

    now += 100;
    const revoked = await store.revoke("user-a", paired.device.id);
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.epoch, 2);
    assert.throws(() => store.authenticate(paired.device.id, paired.token), /认证失败/);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("expired pairing codes and cross-user device operations are rejected", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-windows-devices-"));
  let now = 2_000_000;
  try {
    const store = await new WindowsDeviceStore(stateDirectory, { now: () => now }).initialize();
    const pairing = await store.createPairing({
      userId: "user-a",
      pluginIds: ["windows-codex-remote"],
      ttlMs: 60_000,
    });
    now += 60_001;
    await assert.rejects(store.consumePairing({
      code: pairing.code,
      name: "Late PC",
      platform: "windows",
      agentVersion: "0.1.0",
      protocolVersion: 1,
    }), /无效或已过期/);

    const fresh = await store.createPairing({
      userId: "user-a",
      pluginIds: ["creator-worker"],
    });
    const paired = await store.consumePairing({
      code: fresh.code,
      name: "Creator PC",
      platform: "windows",
      agentVersion: "0.1.0",
      protocolVersion: 1,
    });
    await assert.rejects(store.revoke("user-b", paired.device.id), /设备不存在/);
    const changed = await store.revokePlugin("user-a", "creator-worker");
    assert.equal(changed[0].status, "revoked");
    assert.equal(changed[0].epoch, 2);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("Windows device store survives restart with hashes only", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-windows-devices-"));
  try {
    const first = await new WindowsDeviceStore(stateDirectory).initialize();
    const pairing = await first.createPairing({
      userId: "user-restart",
      pluginIds: ["windows-codex-remote"],
    });
    const paired = await first.consumePairing({
      code: pairing.code,
      name: "Restart PC",
      platform: "windows",
      agentVersion: "0.1.0",
      protocolVersion: 1,
    });
    const second = await new WindowsDeviceStore(stateDirectory).initialize();
    assert.equal(second.authenticate(paired.device.id, paired.token).userId, "user-restart");
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("plugin revocation persists an empty revoked device and invalidates pending pairings", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-windows-devices-"));
  try {
    const first = await new WindowsDeviceStore(stateDirectory).initialize();
    const connectedPairing = await first.createPairing({
      userId: "user-revoked",
      pluginIds: ["windows-codex-remote"],
    });
    const paired = await first.consumePairing({
      code: connectedPairing.code,
      name: "Revoked PC",
      platform: "windows",
      agentVersion: "0.1.0",
      protocolVersion: 1,
    });
    const pending = await first.createPairing({
      userId: "user-revoked",
      pluginIds: ["windows-codex-remote"],
    });

    const changed = await first.revokePlugin("user-revoked", "windows-codex-remote");
    assert.equal(changed[0].status, "revoked");
    assert.deepEqual(changed[0].pluginIds, []);
    await assert.rejects(first.consumePairing({
      code: pending.code,
      name: "Stale grant PC",
      platform: "windows",
      agentVersion: "0.1.0",
      protocolVersion: 1,
    }), /无效或已过期/);

    const second = await new WindowsDeviceStore(stateDirectory).initialize();
    assert.deepEqual(second.get(paired.device.id)?.pluginIds, []);
    assert.equal(second.get(paired.device.id)?.status, "revoked");
    assert.throws(() => second.authenticate(paired.device.id, paired.token), /认证失败/);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("creating a new pairing invalidates the user's older outstanding code", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-windows-devices-"));
  try {
    const store = await new WindowsDeviceStore(stateDirectory).initialize();
    const older = await store.createPairing({
      userId: "user-a",
      pluginIds: ["windows-codex-remote"],
    });
    const current = await store.createPairing({
      userId: "user-a",
      pluginIds: ["creator-worker"],
    });
    await store.createPairing({
      userId: "user-b",
      pluginIds: ["windows-codex-remote"],
    });

    await assert.rejects(store.consumePairing({
      code: older.code,
      name: "Old code",
      platform: "windows",
      agentVersion: "0.1.0",
      protocolVersion: 1,
    }), /无效或已过期/);
    const paired = await store.consumePairing({
      code: current.code,
      name: "Current code",
      platform: "windows",
      agentVersion: "0.1.0",
      protocolVersion: 1,
    });
    assert.equal(paired.device.userId, "user-a");

    const persisted = JSON.parse(await fs.readFile(path.join(stateDirectory, "windows-devices.json"), "utf8"));
    assert.equal(persisted.pairings.length, 1);
    assert.equal(persisted.pairings[0].userId, "user-b");
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("Windows device capacity is bounded without consuming the pending pairing", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-windows-devices-"));
  try {
    const store = await new WindowsDeviceStore(stateDirectory).initialize();
    for (let index = 0; index < 10; index += 1) {
      const pairing = await store.createPairing({
        userId: "user-capacity",
        pluginIds: ["windows-codex-remote"],
      });
      await store.consumePairing({
        code: pairing.code,
        name: `PC ${index + 1}`,
        platform: "windows",
        agentVersion: "0.1.0",
        protocolVersion: 1,
      });
    }
    const pending = await store.createPairing({
      userId: "user-capacity",
      pluginIds: ["windows-codex-remote"],
    });
    await assert.rejects(store.consumePairing({
      code: pending.code,
      name: "PC 11",
      platform: "windows",
      agentVersion: "0.1.0",
      protocolVersion: 1,
    }), /最多配对 10 台/);

    const first = store.snapshot("user-capacity").devices.at(-1);
    await store.revoke("user-capacity", first.id);
    const admitted = await store.consumePairing({
      code: pending.code,
      name: "Replacement PC",
      platform: "windows",
      agentVersion: "0.1.0",
      protocolVersion: 1,
    });
    assert.equal(admitted.device.name, "Replacement PC");
    assert.equal(store.snapshot("user-capacity").devices.filter((device) => device.status === "active").length, 10);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});
