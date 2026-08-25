import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsDeviceBroker } from "../lib/windows-device-broker.mjs";
import { WindowsDeviceStore } from "../lib/windows-device-store.mjs";

test("one Windows device cannot be leased by two threads", async () => {
  const fixture = await deviceFixture();
  try {
    const lease = fixture.broker.acquireLease(leaseInput(fixture.device.id, "thread-a"));
    assert.equal(lease.threadId, "thread-a");
    assert.throws(() => fixture.broker.acquireLease({
      ...leaseInput(fixture.device.id, "thread-b"),
      browserSessionId: "session-b",
    }), /另一个 Thread/);
    assert.throws(() => fixture.broker.acquireLease({
      ...leaseInput(fixture.device.id, "thread-a"),
      userId: "user-b",
    }), /离线/);
  } finally {
    await fixture.cleanup();
  }
});

test("call results must match user, device epoch, thread and lease epoch", async () => {
  const fixture = await deviceFixture();
  try {
    const lease = fixture.broker.acquireLease(leaseInput(fixture.device.id, "thread-a"));
    const resultPromise = fixture.broker.call({
      ...leaseInput(fixture.device.id, "thread-a"),
      leaseEpoch: lease.leaseEpoch,
      method: "codex.thread.resume",
      params: { projectId: "project-a", threadId: "thread-a" },
    });
    const call = JSON.parse(fixture.transport.messages.at(-1));
    assert.equal(call.context.deviceEpoch, fixture.device.epoch);
    assert.equal(call.context.threadId, "thread-a");
    assert.equal(fixture.broker.handleCallResult(fixture.connection.connectionId, {
      type: "callResult",
      callId: call.callId,
      ok: true,
      result: { thread: "wrong" },
      context: { ...call.context, threadId: "thread-b" },
    }), false);
    assert.equal(fixture.broker.handleCallResult(fixture.connection.connectionId, {
      type: "callResult",
      callId: call.callId,
      ok: true,
      result: { thread: "thread-a" },
      context: call.context,
    }), true);
    assert.deepEqual(await resultPromise, { thread: "thread-a" });
  } finally {
    await fixture.cleanup();
  }
});

test("released leases reject pending calls and discard late results", async () => {
  const fixture = await deviceFixture();
  try {
    const lease = fixture.broker.acquireLease(leaseInput(fixture.device.id, "thread-a"));
    const resultPromise = fixture.broker.call({
      ...leaseInput(fixture.device.id, "thread-a"),
      leaseEpoch: lease.leaseEpoch,
      method: "codex.thread.read",
      params: { projectId: "project-a", threadId: "thread-a" },
    });
    const call = JSON.parse(fixture.transport.messages.at(-1));
    fixture.broker.releaseLease({ ...leaseInput(fixture.device.id, "thread-a"), leaseEpoch: lease.leaseEpoch });
    await assert.rejects(resultPromise, /租约已结束/);
    assert.equal(fixture.broker.handleCallResult(fixture.connection.connectionId, {
      type: "callResult",
      callId: call.callId,
      ok: true,
      result: { stale: true },
      context: call.context,
    }), false);
  } finally {
    await fixture.cleanup();
  }
});

test("disconnects clear leases and never queue offline actions", async () => {
  let now = 5_000_000;
  const fixture = await deviceFixture({ now: () => now });
  try {
    const lease = fixture.broker.acquireLease(leaseInput(fixture.device.id, "thread-a"));
    const resultPromise = fixture.broker.call({
      ...leaseInput(fixture.device.id, "thread-a"),
      leaseEpoch: lease.leaseEpoch,
      method: "codex.projects.list",
      params: {},
    });
    now += 45_001;
    fixture.broker.sweepExpired();
    await assert.rejects(resultPromise, /断开|租约已结束/);
    assert.equal(fixture.transport.closed, true);
    assert.throws(() => fixture.broker.acquireLease(leaseInput(fixture.device.id, "thread-b")), /离线/);
  } finally {
    await fixture.cleanup();
  }
});

test("plugin authorization is rechecked for every lease and call", async () => {
  let authorized = true;
  const fixture = await deviceFixture({ isAuthorized: () => authorized });
  try {
    const lease = fixture.broker.acquireLease(leaseInput(fixture.device.id, "thread-a"));
    authorized = false;
    assert.throws(() => fixture.broker.call({
      ...leaseInput(fixture.device.id, "thread-a"),
      leaseEpoch: lease.leaseEpoch,
      method: "codex.projects.list",
      params: {},
    }), /未授权或未启用/);
  } finally {
    await fixture.cleanup();
  }
});

test("pending Windows Host calls are bounded per device", async () => {
  const fixture = await deviceFixture();
  try {
    const input = leaseInput(fixture.device.id, "thread-a");
    const lease = fixture.broker.acquireLease(input);
    const pending = Array.from({ length: 4 }, () => fixture.broker.call({
      ...input,
      leaseEpoch: lease.leaseEpoch,
      method: "codex.projects.list",
      params: {},
    }));
    assert.throws(() => fixture.broker.call({
      ...input,
      leaseEpoch: lease.leaseEpoch,
      method: "codex.projects.list",
      params: {},
    }), /同时调用过多/);
    fixture.broker.releaseLease({ ...input, leaseEpoch: lease.leaseEpoch });
    assert.equal((await Promise.allSettled(pending)).every((result) => result.status === "rejected"), true);
  } finally {
    await fixture.cleanup();
  }
});

function leaseInput(deviceId, threadId) {
  return {
    userId: "user-a",
    deviceId,
    pluginId: "windows-codex-remote",
    threadId,
    browserSessionId: "session-a",
    windowId: "window-a",
  };
}

async function deviceFixture({ now = () => 4_000_000, isAuthorized = () => true } = {}) {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-windows-broker-"));
  const store = await new WindowsDeviceStore(stateDirectory, { now }).initialize();
  const pairing = await store.createPairing({
    userId: "user-a",
    pluginIds: ["windows-codex-remote"],
  });
  const paired = await store.consumePairing({
    code: pairing.code,
    name: "Broker PC",
    platform: "windows",
    agentVersion: "0.1.0",
    protocolVersion: 1,
  });
  const transport = new FakeTransport();
  const broker = new WindowsDeviceBroker(store, {
    now,
    isPluginAuthorized: isAuthorized,
  });
  const connection = await broker.authenticateConnection({
    deviceId: paired.device.id,
    token: paired.token,
    transport,
    agentVersion: "0.1.0",
    protocolVersion: 1,
  });
  return {
    store,
    broker,
    device: paired.device,
    token: paired.token,
    transport,
    connection,
    cleanup: () => fs.rm(stateDirectory, { recursive: true, force: true }),
  };
}

class FakeTransport {
  constructor() {
    this.messages = [];
    this.closed = false;
  }

  send(message) {
    if (this.closed) throw new Error("closed");
    this.messages.push(message);
  }

  close(code, reason) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
}
