import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLAUDE_COMPONENT_VERSION,
  ClaudeComponentStatusStore,
  claudeComponentSnapshot,
  writeClaudeComponentDecision,
} from "../lib/claude-component.mjs";

test("Claude component is optional when neither managed nor bundled command exists", async (context) => {
  const root = await temporaryRoot(context);
  const snapshot = await claudeComponentSnapshot({
    appDirectory: path.join(root, "app"),
    runtimeDirectory: path.join(root, "runtime"),
  });
  assert.equal(snapshot.installed, false);
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.state, "not-installed");
  assert.equal(snapshot.reviewedVersion, CLAUDE_COMPONENT_VERSION);
});

test("an existing bundled Claude installation remains available", async (context) => {
  const root = await temporaryRoot(context);
  const appDirectory = path.join(root, "app");
  await executable(path.join(appDirectory, "node_modules", ".bin", "claude"));
  await json(path.join(appDirectory, "node_modules", "@anthropic-ai", "claude-code", "package.json"), {
    version: CLAUDE_COMPONENT_VERSION,
  });
  const snapshot = await claudeComponentSnapshot({
    appDirectory,
    runtimeDirectory: path.join(root, "runtime"),
  });
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.source, "bundled");
  assert.equal(snapshot.version, CLAUDE_COMPONENT_VERSION);
});

test("a managed optional Claude component takes precedence over the bundled fallback", async (context) => {
  const root = await temporaryRoot(context);
  const appDirectory = path.join(root, "app");
  const runtimeDirectory = path.join(root, "runtime");
  await executable(path.join(appDirectory, "node_modules", ".bin", "claude"));
  await json(path.join(appDirectory, "node_modules", "@anthropic-ai", "claude-code", "package.json"), {
    version: "2.1.219",
  });
  await executable(path.join(runtimeDirectory, "claude", "current", "claude"));
  await json(path.join(runtimeDirectory, "claude", "current", "component.json"), {
    version: CLAUDE_COMPONENT_VERSION,
  });
  const snapshot = await claudeComponentSnapshot({ appDirectory, runtimeDirectory });
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.source, "managed");
});

test("an owner-approved managed version stays usable while rollback remains available", async (context) => {
  const root = await temporaryRoot(context);
  const appDirectory = path.join(root, "app");
  const runtimeDirectory = path.join(root, "runtime");
  await executable(path.join(runtimeDirectory, "claude", "current", "claude"));
  await json(path.join(runtimeDirectory, "claude", "current", "component.json"), {
    version: "2.1.221",
    activationAllowed: true,
  });
  await writeClaudeComponentDecision(runtimeDirectory, {
    beforeVersion: CLAUDE_COMPONENT_VERSION,
    afterVersion: "2.1.221",
    previousSource: "managed",
    pendingAt: 1_785_350_000_000,
  });
  const snapshot = await claudeComponentSnapshot({ appDirectory, runtimeDirectory });
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.version, "2.1.221");
  assert.deepEqual(snapshot.pendingDecision, {
    beforeVersion: CLAUDE_COMPONENT_VERSION,
    afterVersion: "2.1.221",
    previousSource: "managed",
    pendingAt: 1_785_350_000_000,
  });
});

test("component installation status is exposed without making Codex unavailable", async (context) => {
  const root = await temporaryRoot(context);
  const store = new ClaudeComponentStatusStore(path.join(root, "state"), { now: () => 1234 });
  await store.write({
    phase: "downloading",
    version: CLAUDE_COMPONENT_VERSION,
    detail: "downloading",
    startedAt: 1000,
  });
  const snapshot = await claudeComponentSnapshot({
    appDirectory: path.join(root, "app"),
    runtimeDirectory: path.join(root, "runtime"),
    statusStore: store,
    now: () => 1234,
  });
  assert.equal(snapshot.state, "installing");
  assert.equal(snapshot.operation.status, "running");
  assert.equal(snapshot.operation.phase, "downloading");
});

test("a stale component worker becomes retryable instead of staying locked forever", async (context) => {
  const root = await temporaryRoot(context);
  const store = new ClaudeComponentStatusStore(path.join(root, "state"), { now: () => 1000 });
  await store.write({ phase: "verifying", startedAt: 1000 });
  const snapshot = await claudeComponentSnapshot({
    appDirectory: path.join(root, "app"),
    runtimeDirectory: path.join(root, "runtime"),
    statusStore: store,
    now: () => 1000 + 26 * 60_000,
  });
  assert.equal(snapshot.state, "failed");
  assert.equal(snapshot.operation.phase, "failed");
  assert.match(snapshot.operation.error, /超过时限/);
});

async function temporaryRoot(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-component-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function executable(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

async function json(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`);
}
