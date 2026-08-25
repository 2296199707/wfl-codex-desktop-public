import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  buildCodexProtocolCompatibility,
  inspectCodexProtocolCompatibility,
} from "../lib/codex-compatibility.mjs";

const fixtureRoot = new URL("./fixtures/", import.meta.url);
const [client, server, notifications, manifest] = await Promise.all([
  readFixture("codex-app-server-0.149.0-client-methods.json"),
  readFixture("codex-app-server-0.149.0-server-methods.json"),
  readFixture("codex-app-server-0.149.0-notifications.json"),
  readFixture("codex-app-server-0.149.0-schema-manifest.json"),
]);
const reviewedSurface = {
  clientRequests: client.methods,
  serverRequests: server.methods,
  clientNotifications: notifications.experimental.client,
  serverNotifications: notifications.experimental.server,
};

test("Codex compatibility snapshot reports the reviewed 0.149 surface", () => {
  const snapshot = buildCodexProtocolCompatibility({
    installedVersion: "codex-cli 0.149.0",
    reviewedSurface,
    detectedSurface: reviewedSurface,
    generatedAt: manifest.generatedAt,
    checkedAt: 1_785_350_000_000,
  });
  assert.equal(snapshot.state, "compatible");
  assert.equal(snapshot.compatible, true);
  assert.equal(snapshot.snapshotVersion, "0.149.0");
  assert.equal(snapshot.surfaces.clientRequests.reviewed, 153);
  assert.equal(snapshot.surfaces.serverRequests.reviewed, 11);
  assert.equal(snapshot.surfaces.serverNotifications.reviewed, 77);
  assert.equal(snapshot.surfaces.clientNotifications.reviewed, 1);
  assert.equal(snapshot.coverage.clientRequests.counts.planned, 0);
  assert.equal(snapshot.runtimeCapabilities.conversationSections, true);
  assert.equal(snapshot.runtimeCapabilities.pluginSearch, true);
  assert.deepEqual(snapshot.featureLimitations, []);
  assert.equal(snapshot.generatedAt, manifest.generatedAt);
  const processGroup = snapshot.deferredGroups.find((group) => group.surface === "High-risk process control");
  assert.equal(processGroup?.count, 4);
  assert.ok(processGroup?.replacements.some((entry) => (
    entry.method === "process/spawn" && entry.replacement === "command/exec"
  )));
});

test("Codex compatibility snapshot identifies added, removed, and unreviewed methods", () => {
  const detected = structuredClone(reviewedSurface);
  detected.clientRequests = detected.clientRequests
    .filter((method) => method !== "thread/read")
    .concat("thread/newMethod");
  const snapshot = buildCodexProtocolCompatibility({
    installedVersion: "codex-cli 0.149.0",
    reviewedSurface,
    detectedSurface: detected,
    generatedAt: manifest.generatedAt,
  });
  assert.equal(snapshot.state, "protocol-drift");
  assert.equal(snapshot.compatible, false);
  assert.equal(snapshot.partiallyCompatible, false);
  assert.equal(snapshot.compatibilityLevel, "blocked");
  assert.equal(snapshot.activationAllowed, false);
  assert.equal(snapshot.risk, "blocked");
  assert.equal(snapshot.criticalIssues[0]?.feature, "Conversation history");
  assert.deepEqual(snapshot.surfaces.clientRequests.added, ["thread/newMethod"]);
  assert.deepEqual(snapshot.surfaces.clientRequests.removed, ["thread/read"]);
});

test("a newer CLI remains partially compatible when its current method names match", () => {
  const snapshot = buildCodexProtocolCompatibility({
    installedVersion: "codex-cli 0.150.0",
    reviewedSurface,
    detectedSurface: reviewedSurface,
    generatedAt: manifest.generatedAt,
  });
  assert.equal(snapshot.state, "version-drift");
  assert.equal(snapshot.protocolReviewed, true);
  assert.equal(snapshot.versionReviewed, false);
  assert.equal(snapshot.compatible, false);
  assert.equal(snapshot.activationAllowed, true);
  assert.equal(snapshot.partiallyCompatible, true);
  assert.equal(snapshot.compatibilityLevel, "partial");
  assert.equal(snapshot.versionRelation, "newer");
  assert.equal(snapshot.versionDirection, "upward");
  assert.equal(snapshot.decisionRequired, true);
  assert.equal(snapshot.risk, "unreviewed");
});

test("an older CLI remains partially compatible when core methods are present", () => {
  const detected = structuredClone(reviewedSurface);
  detected.clientRequests = detected.clientRequests.filter((method) => (
    ![
      "account/bedrock/discover",
      "account/bedrock/setup",
      "project/create",
      "project/delete",
      "project/import",
      "project/list",
      "project/move",
      "project/read",
      "project/update",
      "server/diagnostics",
      "thread/queue/add",
      "thread/queue/delete",
      "thread/queue/list",
      "thread/queue/reorder",
      "thread/queue/start",
      "thread/queue/update",
      "thread/revert",
    ].includes(method)
  ));
  const snapshot = buildCodexProtocolCompatibility({
    installedVersion: "codex-cli 0.147.0",
    reviewedSurface,
    detectedSurface: detected,
    generatedAt: manifest.generatedAt,
  });
  assert.equal(snapshot.activationAllowed, true);
  assert.equal(snapshot.partiallyCompatible, true);
  assert.equal(snapshot.compatibilityLevel, "partial");
  assert.equal(snapshot.versionRelation, "older");
  assert.equal(snapshot.versionDirection, "downward");
});

test("non-core method removal reports the limited feature without forcing rollback", () => {
  const detected = structuredClone(reviewedSurface);
  detected.clientRequests = detected.clientRequests.filter((method) => method !== "app/list");
  const snapshot = buildCodexProtocolCompatibility({
    installedVersion: "codex-cli 0.150.0",
    reviewedSurface,
    detectedSurface: detected,
    generatedAt: manifest.generatedAt,
  });
  assert.equal(snapshot.activationAllowed, true);
  assert.equal(snapshot.decisionRequired, true);
  assert.equal(snapshot.risk, "limited");
  assert.deepEqual(snapshot.limitations.map(({ feature, method, severity }) => ({ feature, method, severity })), [{
    feature: "Codex apps",
    method: "app/list",
    severity: "limited",
  }]);
});

test("the real retained 0.146 CLI exposes core chat but not 0.147-only capabilities", {
  timeout: 20_000,
  skip: !process.env.CODEX_DESKTOP_CODEX_0146_BIN,
}, async () => {
  const snapshot = await inspectCodexProtocolCompatibility({
    command: process.env.CODEX_DESKTOP_CODEX_0146_BIN,
    installedVersion: "codex-cli 0.146.0",
  });
  assert.equal(snapshot.activationAllowed, true);
  assert.equal(snapshot.runtimeCapabilities.detected, true);
  assert.equal(snapshot.runtimeCapabilities.conversationSections, false);
  assert.equal(snapshot.runtimeCapabilities.sectionPositionSort, false);
  assert.equal(snapshot.runtimeCapabilities.pluginSearch, false);
  assert.equal(snapshot.runtimeCapabilities.cursorMigration, true);
  assert.deepEqual(snapshot.featureLimitations.map((item) => item.feature), [
    "conversationSections",
    "pluginSearch",
  ]);
  assert.deepEqual(
    snapshot.limitations.map((item) => item.method).sort(),
    [
      "plugin/search",
      "thread/section/move",
      "threadSection/create",
      "threadSection/delete",
      "threadSection/list",
      "threadSection/update",
    ],
  );
});

test("installed Codex lightweight TypeScript probe matches the reviewed snapshot", { timeout: 20_000 }, async () => {
  const snapshot = await inspectCodexProtocolCompatibility();
  assert.equal(snapshot.installedVersion, "codex-cli 0.149.0");
  assert.equal(snapshot.compatible, true);
  assert.ok(snapshot.checkedAt > 0);
});

test("Codex update checks protocol compatibility before staging a backend", async () => {
  const source = await fs.readFile(new URL("../scripts/update-codex.mjs", import.meta.url), "utf8");
  const compatibility = source.indexOf("await inspectCodexProtocolCompatibility({");
  const staging = source.indexOf("\"--stage\", \"--operation-id\"");
  assert.ok(compatibility > 0);
  assert.ok(staging > compatibility);
  assert.match(source, /assertCodexActivationAllowed\(compatibility\)/);
  assert.match(source, /holdCodexInstallRecoveryForDecision/);
});

test("ordinary server application updates inspect the installed Codex protocol without requiring 0.149", async () => {
  const source = await fs.readFile(new URL("../scripts/quick-update-check.mjs", import.meta.url), "utf8");
  assert.match(source, /inspectCodexProtocolCompatibility/);
  assert.match(source, /assertCodexActivationAllowed\(compatibility\)/);
  assert.match(source, /runtimeCapabilities: compatibility\.runtimeCapabilities/);
  assert.doesNotMatch(source, /compatibility\.compatible\s*!==\s*true/);
});

async function readFixture(name) {
  return JSON.parse(await fs.readFile(new URL(name, fixtureRoot), "utf8"));
}
