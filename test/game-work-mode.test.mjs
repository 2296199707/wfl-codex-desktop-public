import assert from "node:assert/strict";
import test from "node:test";

import {
  GAME_WORK_MODE_LEASE_MS,
  acceptGameWorkModeSignal,
  createGameWorkModeCommand,
  createGameWorkModeSignal,
  gameWorkModeChannelName,
  gameWorkModeIsolationEnabled,
  pruneGameWorkModeLeases,
  parseGameWorkModeCommand,
} from "../public/game-work-mode.js";

const binding = Object.freeze({
  hostWindowId: "host-window-1",
  editorInstanceId: "editor-window-1",
  sessionId: "map-session-1",
  threadId: "codex-thread-1",
  projectPath: "/srv/projects/game",
});

test("game work mode accepts only the intended host and exact conversation binding", () => {
  const leases = new Map();
  const signal = createGameWorkModeSignal({ ...binding, action: "enable" }, 1_000);
  assert.equal(gameWorkModeChannelName(binding.hostWindowId), "wfl-game-work-mode-v1:host-window-1");
  assert.equal(acceptGameWorkModeSignal(leases, signal, {
    hostWindowId: "other-window-1",
    now: 1_100,
  }).accepted, false);
  assert.equal(leases.size, 0);

  const accepted = acceptGameWorkModeSignal(leases, signal, {
    hostWindowId: binding.hostWindowId,
    now: 1_100,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.changed, true);
  assert.equal(leases.size, 1);
  assert.equal(gameWorkModeIsolationEnabled(leases, {
    hostWindowId: binding.hostWindowId,
    runtime: "codex",
    threadId: binding.threadId,
    projectPath: binding.projectPath,
    now: 1_200,
  }), true);
  for (const mismatch of [
    { runtime: "claude", threadId: binding.threadId, projectPath: binding.projectPath },
    { runtime: "codex", threadId: "codex-thread-2", projectPath: binding.projectPath },
    { runtime: "codex", threadId: binding.threadId, projectPath: "/srv/projects/other" },
  ]) {
    assert.equal(gameWorkModeIsolationEnabled(leases, {
      hostWindowId: binding.hostWindowId,
      now: 1_200,
      ...mismatch,
    }), false);
  }
});

test("heartbeats renew a bounded lease and expiry restores ordinary mode", () => {
  const leases = new Map();
  acceptGameWorkModeSignal(
    leases,
    createGameWorkModeSignal({ ...binding, action: "enable" }, 0),
    { hostWindowId: binding.hostWindowId, now: 100 },
  );
  const heartbeatAt = GAME_WORK_MODE_LEASE_MS - 100;
  const heartbeat = acceptGameWorkModeSignal(
    leases,
    createGameWorkModeSignal({ ...binding, action: "heartbeat" }, heartbeatAt),
    { hostWindowId: binding.hostWindowId, now: heartbeatAt },
  );
  assert.equal(heartbeat.changed, false);
  assert.equal(pruneGameWorkModeLeases(leases, heartbeatAt + GAME_WORK_MODE_LEASE_MS - 1), 0);
  assert.equal(pruneGameWorkModeLeases(leases, heartbeatAt + GAME_WORK_MODE_LEASE_MS), 1);
  assert.equal(gameWorkModeIsolationEnabled(leases, {
    hostWindowId: binding.hostWindowId,
    runtime: "codex",
    threadId: binding.threadId,
    projectPath: binding.projectPath,
    now: heartbeatAt + GAME_WORK_MODE_LEASE_MS,
  }), false);
});

test("one editor can stop without disabling another active editor", () => {
  const leases = new Map();
  const second = { ...binding, editorInstanceId: "editor-window-2", sessionId: "map-session-2" };
  for (const value of [binding, second]) {
    acceptGameWorkModeSignal(
      leases,
      createGameWorkModeSignal({ ...value, action: "enable" }, 2_000),
      { hostWindowId: binding.hostWindowId, now: 2_000 },
    );
  }
  assert.equal(leases.size, 2);
  const disabled = acceptGameWorkModeSignal(
    leases,
    createGameWorkModeSignal({ ...binding, action: "disable" }, 2_100),
    { hostWindowId: binding.hostWindowId, now: 2_100 },
  );
  assert.equal(disabled.changed, true);
  assert.equal(leases.size, 1);
  assert.equal(gameWorkModeIsolationEnabled(leases, {
    hostWindowId: binding.hostWindowId,
    runtime: "codex",
    threadId: binding.threadId,
    projectPath: binding.projectPath,
    now: 2_200,
  }), true);
});

test("invalid channel and incomplete signals are rejected", () => {
  assert.throws(() => gameWorkModeChannelName("short"), /Invalid game work mode host/u);
  assert.throws(
    () => createGameWorkModeSignal({ ...binding, projectPath: "relative", action: "enable" }),
    /Incomplete game work mode binding/u,
  );
  assert.equal(acceptGameWorkModeSignal(new Map(), { type: "other" }, {
    hostWindowId: binding.hostWindowId,
  }).accepted, false);
});

test("main-window commands require the complete target editor binding", () => {
  const command = createGameWorkModeCommand({ ...binding, action: "enable" }, 4_000);
  assert.deepEqual(parseGameWorkModeCommand(command, binding), command);
  assert.equal(parseGameWorkModeCommand(command, { ...binding, threadId: "codex-thread-2" }), null);
  assert.equal(parseGameWorkModeCommand({ ...command, action: "heartbeat" }, binding), null);
  assert.throws(
    () => createGameWorkModeCommand({ ...binding, sessionId: "", action: "disable" }),
    /Incomplete game work mode command/u,
  );
});
