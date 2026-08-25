import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const EXPECTED_VERSION = (
  process.env.WFL_CODEX_CONTRACT_VERSION || "0.146.0"
).trim();
const REQUIRED_STABLE_REQUESTS = Object.freeze([
  "thread/list",
  "thread/read",
  "thread/resume",
  "thread/start",
  "thread/unsubscribe",
  "turn/interrupt",
  "turn/start",
  "turn/steer",
]);
const REQUIRED_NOTIFICATIONS = Object.freeze([
  "item/agentMessage/delta",
  "item/completed",
  "item/started",
  "turn/completed",
  "turn/started",
]);
const EXPERIMENTAL_HISTORY_REQUESTS = Object.freeze([
  "thread/items/list",
  "thread/turns/list",
]);
const WFL_DURABILITY_FIELDS = Object.freeze([
  "clientSubmissionId",
  "eventCursor",
  "eventLogGeneration",
]);
const START_IDEMPOTENCY_FIELDS = Object.freeze([
  "clientSubmissionId",
  "idempotencyKey",
]);

function runCodex(args) {
  const result = spawnSync("codex", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(
    result.error,
    undefined,
    `codex ${args.join(" ")} could not start: ${result.error?.message}`,
  );
  assert.equal(
    result.status,
    0,
    `codex ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function generateSchema(directory, experimental) {
  fs.mkdirSync(directory, { mode: 0o700 });
  const args = ["app-server", "generate-json-schema"];
  if (experimental) args.push("--experimental");
  args.push("--out", directory);
  runCodex(args);
  const clientRequestPath = path.join(directory, "ClientRequest.json");
  const notificationPath = path.join(directory, "ServerNotification.json");
  assert.ok(fs.existsSync(clientRequestPath));
  assert.ok(fs.existsSync(notificationPath));
  return {
    clientRequestPath,
    notificationPath,
    clientRequest: JSON.parse(fs.readFileSync(clientRequestPath, "utf8")),
    notification: JSON.parse(fs.readFileSync(notificationPath, "utf8")),
  };
}

function collectMethods(schema) {
  const methods = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    const method = value.properties?.method;
    if (method && Array.isArray(method.enum)) {
      for (const entry of method.enum) {
        if (typeof entry === "string") methods.add(entry);
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  return [...methods].sort();
}

function collectPropertyNames(schema) {
  const names = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.properties && typeof value.properties === "object") {
      for (const name of Object.keys(value.properties)) names.add(name);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  return names;
}

function digest(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

const versionOutput = runCodex(["--version"]).stdout.trim();
const versionMatch = versionOutput.match(/\b(\d+\.\d+\.\d+)\b/);
assert.ok(versionMatch, `could not parse Codex version: ${versionOutput}`);
assert.equal(
  versionMatch[1],
  EXPECTED_VERSION,
  `this probe freezes ${EXPECTED_VERSION}; found ${versionMatch[1]}`,
);

const help = runCodex(["app-server", "--help"]).stdout;
for (const transport of [
  "stdio://",
  "unix://",
  "ws://IP:PORT",
  "off",
]) {
  assert.ok(help.includes(transport), `missing transport ${transport}`);
}
for (const authMode of ["capability-token", "signed-bearer-token"]) {
  assert.ok(help.includes(authMode), `missing WebSocket auth ${authMode}`);
}

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "wfl-codex-contract-"),
);
fs.chmodSync(temporaryRoot, 0o700);

try {
  const stable = generateSchema(path.join(temporaryRoot, "stable"), false);
  const experimental = generateSchema(
    path.join(temporaryRoot, "experimental"),
    true,
  );
  const stableRequests = collectMethods(stable.clientRequest);
  const experimentalRequests = collectMethods(experimental.clientRequest);
  const stableNotifications = collectMethods(stable.notification);
  const experimentalNotifications = collectMethods(experimental.notification);
  const stableRequestSet = new Set(stableRequests);
  const experimentalRequestSet = new Set(experimentalRequests);
  const stableNotificationSet = new Set(stableNotifications);

  for (const method of REQUIRED_STABLE_REQUESTS) {
    assert.ok(stableRequestSet.has(method), `stable method missing: ${method}`);
  }
  for (const method of REQUIRED_NOTIFICATIONS) {
    assert.ok(
      stableNotificationSet.has(method),
      `stable notification missing: ${method}`,
    );
  }
  for (const method of EXPERIMENTAL_HISTORY_REQUESTS) {
    assert.equal(
      stableRequestSet.has(method),
      false,
      `${method} unexpectedly entered the stable schema`,
    );
    assert.ok(
      experimentalRequestSet.has(method),
      `experimental method missing: ${method}`,
    );
  }

  const stableDefinitions = stable.clientRequest.definitions || {};
  const experimentalDefinitions = experimental.clientRequest.definitions || {};
  const stableThreadStart = stableDefinitions.ThreadStartParams;
  const stableTurnStart = stableDefinitions.TurnStartParams;
  const experimentalThreadStart = experimentalDefinitions.ThreadStartParams;
  const experimentalTurnStart = experimentalDefinitions.TurnStartParams;
  assert.ok(stableThreadStart?.properties);
  assert.ok(stableTurnStart?.properties?.clientUserMessageId);
  assert.ok(experimentalThreadStart?.properties);
  assert.ok(experimentalTurnStart?.properties?.clientUserMessageId);
  assert.deepEqual(
    stableTurnStart.properties.clientUserMessageId.type,
    ["string", "null"],
  );

  const stableProperties = collectPropertyNames(stable.clientRequest);
  const experimentalProperties = collectPropertyNames(
    experimental.clientRequest,
  );
  for (const field of WFL_DURABILITY_FIELDS) {
    assert.equal(stableProperties.has(field), false);
    assert.equal(experimentalProperties.has(field), false);
  }
  for (const field of START_IDEMPOTENCY_FIELDS) {
    assert.equal(Object.hasOwn(stableThreadStart.properties, field), false);
    assert.equal(Object.hasOwn(stableTurnStart.properties, field), false);
    assert.equal(
      Object.hasOwn(experimentalThreadStart.properties, field),
      false,
    );
    assert.equal(
      Object.hasOwn(experimentalTurnStart.properties, field),
      false,
    );
  }

  const ackOrReplayRequests = experimentalRequests.filter((method) => (
    /(?:^|\/)(?:ack|acknowledge|replay)(?:$|\/)/i.test(method)
    || /events?\/range/i.test(method)
  ));
  assert.deepEqual(ackOrReplayRequests, []);

  console.log(JSON.stringify({
    ok: true,
    baseline: {
      expectedVersion: EXPECTED_VERSION,
      actualVersion: versionMatch[1],
      versionOutput,
    },
    transportHelp: {
      stdio: help.includes("stdio://"),
      unixSocket: help.includes("unix://"),
      websocket: help.includes("ws://IP:PORT"),
      off: help.includes("off"),
      capabilityTokenAuth: help.includes("capability-token"),
      signedBearerTokenAuth: help.includes("signed-bearer-token"),
      maturityEncodedInSchema: false,
    },
    protocol: {
      stableRequestCount: stableRequests.length,
      experimentalRequestCount: experimentalRequests.length,
      stableNotificationCount: stableNotifications.length,
      experimentalNotificationCount: experimentalNotifications.length,
      requiredStableRequests: REQUIRED_STABLE_REQUESTS,
      requiredNotifications: REQUIRED_NOTIFICATIONS,
      experimentalOnlyHistoryRequests: EXPERIMENTAL_HISTORY_REQUESTS,
      clientUserMessageId: {
        present: true,
        type: stableTurnStart.properties.clientUserMessageId.type,
        documentedAsIdempotencyKeyBySchema: false,
      },
      wflDurabilityFieldsAbsent: WFL_DURABILITY_FIELDS,
      startIdempotencyFieldsAbsent: START_IDEMPOTENCY_FIELDS,
      ackOrReplayRequests,
    },
    artifacts: {
      stableClientRequestSha256: digest(stable.clientRequestPath),
      stableNotificationSha256: digest(stable.notificationPath),
      experimentalClientRequestSha256: digest(
        experimental.clientRequestPath,
      ),
      experimentalNotificationSha256: digest(
        experimental.notificationPath,
      ),
      retainedFiles: 0,
    },
    limits: {
      validatesProtocolShapeForInstalledVersion: true,
      validatesRuntimeDeliverySemantics: false,
      validatesTransportMaturity: false,
      validatesQueueCapacityOrOverloadBehavior: false,
      provesUpstreamTurnStartIdempotency: false,
      readsProductionConversationState: false,
      startsAppServer: false,
      touchesRescueWindow: false,
    },
  }, null, 2));
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
