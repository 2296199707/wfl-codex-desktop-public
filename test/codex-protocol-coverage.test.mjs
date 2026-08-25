import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CODEX_CLIENT_NOTIFICATION_COVERAGE,
  CODEX_PROTOCOL_BASELINE,
  CODEX_PROTOCOL_COVERAGE,
  CODEX_PROTOCOL_COVERAGE_STATES,
  CODEX_SERVER_NOTIFICATION_COVERAGE,
  CODEX_SERVER_REQUEST_COVERAGE,
  codexClientNotificationCoverageSnapshot,
  codexProtocolCoverageSnapshot,
  codexServerNotificationCoverageSnapshot,
  codexServerRequestCoverageSnapshot,
} from "../lib/codex-protocol-coverage.mjs";

const serverSource = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
const baselineMethods = JSON.parse(
  await fs.readFile(
    new URL("./fixtures/codex-app-server-0.149.0-client-methods.json", import.meta.url),
    "utf8",
  ),
);
const baselineServerMethods = JSON.parse(
  await fs.readFile(
    new URL("./fixtures/codex-app-server-0.149.0-server-methods.json", import.meta.url),
    "utf8",
  ),
);
const baselineNotifications = JSON.parse(
  await fs.readFile(
    new URL("./fixtures/codex-app-server-0.149.0-notifications.json", import.meta.url),
    "utf8",
  ),
);
const baselineSchemaManifest = JSON.parse(
  await fs.readFile(
    new URL("./fixtures/codex-app-server-0.149.0-schema-manifest.json", import.meta.url),
    "utf8",
  ),
);

test("Codex app-server protocol inventory is complete and unique", () => {
  assert.equal(CODEX_PROTOCOL_BASELINE, "codex-cli 0.149.0");
  assert.equal(baselineMethods.baseline, CODEX_PROTOCOL_BASELINE);
  assert.equal(baselineMethods.command, "codex app-server generate-ts --experimental");
  assert.deepEqual(
    CODEX_PROTOCOL_COVERAGE.map((entry) => entry.method).sort(),
    [...baselineMethods.methods].sort(),
  );
  assert.equal(
    new Set(CODEX_PROTOCOL_COVERAGE.map((entry) => entry.method)).size,
    CODEX_PROTOCOL_COVERAGE.length,
  );
  for (const entry of CODEX_PROTOCOL_COVERAGE) {
    assert.match(entry.method, /^[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)*$/);
    assert.ok(CODEX_PROTOCOL_COVERAGE_STATES.has(entry.state), `${entry.method}: ${entry.state}`);
    assert.ok(entry.surface.length > 2);
    assert.ok(["codex-native", "wfl-compatible"].includes(entry.origin));
    assert.equal(entry.origin === "wfl-compatible", entry.state === "custom-equivalent");
  }
  assert.ok(baselineMethods.stableMethods.includes("externalAgentConfig/import/recordHistory"));
});

test("Codex app-server initiated request inventory is complete and unique", () => {
  assert.equal(baselineServerMethods.baseline, CODEX_PROTOCOL_BASELINE);
  assert.deepEqual(
    CODEX_SERVER_REQUEST_COVERAGE.map((entry) => entry.method).sort(),
    [...baselineServerMethods.methods].sort(),
  );
  assert.equal(
    new Set(CODEX_SERVER_REQUEST_COVERAGE.map((entry) => entry.method)).size,
    CODEX_SERVER_REQUEST_COVERAGE.length,
  );
  const snapshot = codexServerRequestCoverageSnapshot();
  assert.equal(snapshot.total, 11);
  assert.equal(snapshot.counts.browser, 5);
  assert.equal(snapshot.counts.internal, 1);
  assert.equal(snapshot.counts.deferred, 5);
});

test("Codex notification inventories are complete, unique, and explicitly reviewed", () => {
  assert.equal(baselineNotifications.baseline, CODEX_PROTOCOL_BASELINE);
  assert.deepEqual(
    CODEX_SERVER_NOTIFICATION_COVERAGE.map((entry) => entry.method).sort(),
    [...baselineNotifications.experimental.server].sort(),
  );
  assert.deepEqual(
    CODEX_CLIENT_NOTIFICATION_COVERAGE.map((entry) => entry.method).sort(),
    [...baselineNotifications.experimental.client].sort(),
  );
  assert.equal(
    new Set(CODEX_SERVER_NOTIFICATION_COVERAGE.map((entry) => entry.method)).size,
    CODEX_SERVER_NOTIFICATION_COVERAGE.length,
  );
  assert.equal(
    new Set(CODEX_CLIENT_NOTIFICATION_COVERAGE.map((entry) => entry.method)).size,
    CODEX_CLIENT_NOTIFICATION_COVERAGE.length,
  );
  const serverSnapshot = codexServerNotificationCoverageSnapshot();
  const clientSnapshot = codexClientNotificationCoverageSnapshot();
  assert.equal(serverSnapshot.total, 77);
  assert.equal(serverSnapshot.counts.browser, 53);
  assert.equal(clientSnapshot.total, 1);
  assert.equal(serverSnapshot.counts.planned, 0);
  assert.ok(serverSnapshot.counts.deferred >= 10);
  assert.deepEqual(baselineNotifications.legacyServer, [
    "rawResponse/completed",
    "rawResponseItem/completed",
  ]);
});

test("stable and experimental generated schema surfaces stay separately pinned", () => {
  assert.equal(baselineSchemaManifest.baseline, CODEX_PROTOCOL_BASELINE);
  assert.match(baselineSchemaManifest.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Number.isFinite(Date.parse(baselineSchemaManifest.generatedAt)));
  assert.deepEqual(baselineSchemaManifest.stable.counts, {
    clientRequests: 95,
    serverRequests: 10,
    clientNotifications: 1,
    serverNotifications: 75,
  });
  assert.deepEqual(baselineSchemaManifest.experimental.counts, {
    clientRequests: 150,
    serverRequests: 11,
    clientNotifications: 1,
    serverNotifications: 75,
  });
  assert.equal(Object.keys(baselineSchemaManifest.stable.sha256).length, 6);
  assert.equal(Object.keys(baselineSchemaManifest.experimental.sha256).length, 6);
  assert.deepEqual(baselineSchemaManifest.typescript.stable.counts, {
    clientRequests: 98,
    serverRequests: 10,
    clientNotifications: 1,
    serverNotifications: 77,
  });
  assert.deepEqual(baselineSchemaManifest.typescript.experimental.counts, {
    clientRequests: 153,
    serverRequests: 11,
    clientNotifications: 1,
    serverNotifications: 77,
  });
  assert.deepEqual(baselineMethods.legacyMethods, [
    "getAuthStatus",
    "getConversationSummary",
    "gitDiffToRemote",
  ]);
  for (const digest of [
    ...Object.values(baselineSchemaManifest.stable.sha256),
    ...Object.values(baselineSchemaManifest.experimental.sha256),
    ...Object.values(baselineSchemaManifest.typescript.stable.sha256),
    ...Object.values(baselineSchemaManifest.typescript.experimental.sha256),
  ]) assert.match(digest, /^[a-f0-9]{64}$/);
});

test("installed Codex CLI and regenerated schemas match the reviewed baseline", { timeout: 20_000 }, () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/generate-codex-protocol-fixtures.mjs", "--check"],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /fixtures match codex-cli 0\.149\.0/);
});

test("browser-routed protocol methods stay visible in the server allowlist", () => {
  const allowlist = sourceSet("RPC_ALLOWLIST");
  const missing = CODEX_PROTOCOL_COVERAGE
    .filter((entry) => entry.state === "browser")
    .map((entry) => entry.method)
    .filter((method) => !allowlist.has(method));
  assert.deepEqual(missing, []);
});

test("server-only, deferred, and unavailable client methods stay outside the browser allowlist", () => {
  const allowlist = sourceSet("RPC_ALLOWLIST");
  const exposed = CODEX_PROTOCOL_COVERAGE
    .filter((entry) => entry.state !== "browser" && allowlist.has(entry.method))
    .map((entry) => `${entry.method}:${entry.state}`);
  assert.deepEqual(exposed, []);
  for (const method of [
    "environment/add",
    "environment/info",
    "environment/status",
    "marketplace/add",
    "marketplace/remove",
    "marketplace/upgrade",
    "plugin/install",
    "plugin/installed",
    "plugin/list",
    "plugin/read",
    "plugin/uninstall",
    "process/kill",
    "process/resizePty",
    "process/spawn",
    "process/writeStdin",
    "thread/approveGuardianDeniedAction",
  ]) assert.equal(allowlist.has(method), false, method);
});

test("RPC permission bindings cannot accidentally expose deferred native installers", () => {
  const allowlist = sourceSet("RPC_ALLOWLIST");
  const permissionBindings = sourceMapKeys("CODEX_RPC_PERMISSIONS");
  for (const method of permissionBindings) {
    assert.equal(allowlist.has(method), true, `permission binding without allowlist review: ${method}`);
  }
  for (const method of [
    "marketplace/add",
    "marketplace/remove",
    "marketplace/upgrade",
    "plugin/install",
    "plugin/installed",
    "plugin/list",
    "plugin/read",
    "plugin/uninstall",
  ]) {
    assert.equal(permissionBindings.has(method), false, method);
  }
});

test("Guardian remains a read-only notification surface without a browser override", () => {
  const override = CODEX_PROTOCOL_COVERAGE.find(
    (entry) => entry.method === "thread/approveGuardianDeniedAction",
  );
  assert.equal(override?.state, "deferred");
  for (const method of [
    "guardianWarning",
    "item/autoApprovalReview/started",
    "item/autoApprovalReview/completed",
  ]) {
    const notification = CODEX_SERVER_NOTIFICATION_COVERAGE.find((entry) => entry.method === method);
    assert.equal(notification?.state, "browser");
    assert.equal(notification?.readOnly, true);
  }
});

test("coverage snapshot reports every reviewed method", () => {
  const snapshot = codexProtocolCoverageSnapshot();
  assert.equal(snapshot.total, CODEX_PROTOCOL_COVERAGE.length);
  assert.equal(
    Object.values(snapshot.counts).reduce((total, count) => total + count, 0),
    snapshot.total,
  );
  assert.ok(snapshot.counts.browser > 50);
  assert.equal(snapshot.counts.planned, 0);
  assert.equal(snapshot.counts.deferred, 51);
  assert.equal(snapshot.counts.internal, 21);
});

test("high-risk process APIs stay deferred behind the bounded terminal replacement", () => {
  const replacements = new Map([
    ["process/kill", "command/exec/terminate"],
    ["process/resizePty", "command/exec/resize"],
    ["process/spawn", "command/exec"],
    ["process/writeStdin", "command/exec/write"],
  ]);
  for (const [method, replacement] of replacements) {
    const entry = CODEX_PROTOCOL_COVERAGE.find((candidate) => candidate.method === method);
    assert.equal(entry?.state, "deferred");
    assert.equal(entry?.experimental, true);
    assert.equal(entry?.highRisk, true);
    assert.equal(entry?.replacement, replacement);
  }
});

test("deprecated thread rollback is not part of the active implementation plan", () => {
  const rollback = CODEX_PROTOCOL_COVERAGE.find((entry) => entry.method === "thread/rollback");
  assert.equal(rollback?.state, "deferred");
  assert.equal(rollback?.deprecated, true);
  assert.match(rollback?.replacement || "", /thread\/fork/);
});

function sourceSet(name) {
  const match = serverSource.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(match, `${name} declaration not found`);
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]));
}

function sourceMapKeys(name) {
  const match = serverSource.match(new RegExp(`const ${name} = new Map\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(match, `${name} declaration not found`);
  return new Set([...match[1].matchAll(/\[\s*"([^"]+)"/g)].map((entry) => entry[1]));
}
