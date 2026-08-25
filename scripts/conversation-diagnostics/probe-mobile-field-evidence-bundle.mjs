import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_VERSION = "0.39.48-beta";
const CODEX_VERSION = "0.146.0";
const GATEWAY_POLICY_VERSION = 5;
const REQUIRED_SCENARIOS = [
  "foreground-idle",
  "background-2m",
  "lock-2m",
  "lock-10m",
  "wifi-cell-handoff",
  "airplane-recover",
  "refresh-active",
  "browser-process-reopen",
  "two-device-coobserve",
  "peer-close",
  "peer-hidden-active",
];
const TURN_SCENARIOS = new Set([
  "refresh-active",
  "peer-close",
  "peer-hidden-active",
]);
const TWO_DEVICE_SCENARIOS = new Set([
  "two-device-coobserve",
  "peer-close",
  "peer-hidden-active",
]);
const REQUIRED_FILES = [
  "manifest.json",
  "observer.ndjson",
  "gateway.ndjson",
  "backend.ndjson",
  "browser-a.ndjson",
  "browser-b.ndjson",
];
const TRACE_FILES = REQUIRED_FILES.filter((name) => name.endsWith(".ndjson"));
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set([
  "prompt",
  "reply",
  "text",
  "content",
  "toolOutput",
  "diff",
  "cookie",
  "authorization",
  "apiKey",
  "phone",
  "email",
  "accountId",
  "clientInstanceId",
  "windowInstanceId",
  "checkpointSlotId",
  "runtimeEpoch",
  "threadId",
  "turnId",
  "itemId",
  "clientSubmissionId",
  "ip",
  "remoteAddress",
  "projectPath",
]);
const ALLOWED_TRACE_KEYS = new Set([
  "schemaVersion",
  "captureId",
  "runId",
  "scenarioType",
  "surface",
  "layer",
  "event",
  "sequence",
  "atUnixMs",
  "atMonoMs",
  "traceId",
  "deviceRole",
  "deviceIdDigest",
  "networkPathDigest",
  "clientInstanceIdDigest",
  "windowInstanceIdDigest",
  "browserSocketId",
  "gatewayConnectionId",
  "gatewayUpstreamId",
  "backendConnectionId",
  "appServerInstanceId",
  "runtimeEpochDigest",
  "eventSequence",
  "method",
  "threadIdDigest",
  "turnIdDigest",
  "itemIdDigest",
  "clientSubmissionIdDigest",
  "visibility",
  "online",
  "closeCode",
  "closeReasonClass",
  "heartbeatOrdinal",
  "domNodeCount",
]);
const ALLOWED_LAYERS = new Set([
  "observer",
  "browser",
  "gateway",
  "backend",
  "app-server",
  "store",
  "dom",
]);

const requestedBundle = argumentValue("--bundle");
if (requestedBundle) {
  const result = validateBundleOnDisk(path.resolve(requestedBundle), {
    allowFixture: false,
  });
  console.log(JSON.stringify({
    ok: true,
    validator: "mobile-field-evidence-bundle",
    bundle: result,
    physicalityCryptographicallyProven: false,
    ownerAttestationRequired: true,
  }, null, 2));
} else {
  runFixtureProbe();
}

function runFixtureProbe() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "wfl-mobile-field-bundle-"),
  );
  fs.chmodSync(temporaryRoot, 0o700);
  try {
    writeSyntheticBundle(temporaryRoot);
    const loaded = loadBundleFromDisk(temporaryRoot);
    const positive = validateLoadedBundle(loaded, { allowFixture: true });
    assert.equal(positive.fixture, true);
    assert.equal(positive.fieldEvidenceAccepted, false);
    assert.equal(positive.scenarioRuns, REQUIRED_SCENARIOS.length * 3);

    const failures = [];
    expectSemanticFailure(loaded, "owner-attestation", (bundle) => {
      bundle.manifest.ownerAttestation.confirmedPhysicalDevices = false;
    }, failures);
    expectSemanticFailure(loaded, "same-device", (bundle) => {
      bundle.manifest.devices[1].deviceIdDigest =
        bundle.manifest.devices[0].deviceIdDigest;
    }, failures);
    expectSemanticFailure(loaded, "same-network", (bundle) => {
      bundle.manifest.devices[1].networkPathDigests =
        [...bundle.manifest.devices[0].networkPathDigests];
    }, failures);
    expectSemanticFailure(loaded, "missing-turn-layer", (bundle) => {
      const run = bundle.manifest.scenarios.find(
        (entry) => entry.scenarioType === "refresh-active",
      );
      bundle.rowsByFile["backend.ndjson"] = bundle.rowsByFile[
        "backend.ndjson"
      ].filter((row) => !(
        row.runId === run.runId && row.layer === "app-server"
      ));
    }, failures);
    expectSemanticFailure(loaded, "time-reversal", (bundle) => {
      const run = bundle.manifest.scenarios[0];
      const row = allRows(bundle).find((entry) => entry.runId === run.runId);
      row.atUnixMs = run.endedAt + 1;
    }, failures);
    expectSemanticFailure(loaded, "raw-content-field", (bundle) => {
      bundle.rowsByFile["browser-a.ndjson"][0].prompt =
        "prompt-private-must-fail";
    }, failures);
    expectSemanticFailure(loaded, "rescue-surface", (bundle) => {
      bundle.rowsByFile["gateway.ndjson"][0].surface = "rescue";
    }, failures);
    expectSemanticFailure(loaded, "missing-repetition", (bundle) => {
      const removed = bundle.manifest.scenarios.find(
        (entry) => entry.scenarioType === "lock-10m" && entry.repetition === 3,
      );
      bundle.manifest.scenarios = bundle.manifest.scenarios.filter(
        (entry) => entry.runId !== removed.runId,
      );
      for (const filename of TRACE_FILES) {
        bundle.rowsByFile[filename] = bundle.rowsByFile[filename].filter(
          (row) => row.runId !== removed.runId,
        );
      }
    }, failures);
    expectSemanticFailure(loaded, "clock-skew", (bundle) => {
      bundle.manifest.clock.maximumObservedSkewMs = 5_001;
    }, failures);

    fs.appendFileSync(
      path.join(temporaryRoot, "browser-a.ndjson"),
      "{\"tampered\":true}\n",
    );
    assert.throws(() => loadBundleFromDisk(temporaryRoot));
    failures.push("checksum-mismatch");

    console.log(JSON.stringify({
      ok: true,
      probe: "mobile-field-evidence-bundle",
      productionCodeExercised: false,
      externalNetworkAccessed: false,
      rescueWindowAccessed: false,
      fixture: {
        scenarios: REQUIRED_SCENARIOS.length,
        repetitionsPerScenario: 3,
        runs: positive.scenarioRuns,
        traceRows: positive.traceRows,
        bundleBytes: positive.bundleBytes,
        fieldEvidenceAccepted: false,
        reason: "synthetic fixture cannot prove a physical device",
      },
      validation: {
        structure: true,
        checksums: true,
        mode0600: true,
        directoryMode0700: true,
        scenarioTiming: true,
        layerCompleteness: true,
        distinctDeviceAndNetworkDigests: true,
        stableIdsAreDigests: true,
        rawContentAbsent: true,
      },
      injectedFailuresDetected: failures,
      physicality: {
        cryptographicallyProvenByBundle: false,
        ownerAttestationRequired: true,
        desktopSimulationCanSatisfyFieldGate: false,
      },
      formalInstallOrUpdateHook: false,
      temporaryFilesRemoved: true,
    }, null, 2));
  } finally {
    assertTemporaryRoot(temporaryRoot);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function writeSyntheticBundle(root) {
  const captureId = deterministicUuid("mobile-field", "capture");
  const deviceA = {
    role: "A",
    deviceIdDigest: digest("device-a"),
    clientInstanceIdDigest: digest("client-a"),
    osFamily: "Android",
    osMajor: 16,
    browserFamily: "Chrome",
    browserMajor: 140,
    userAgentDigest: digest("ua-a"),
    networkPathDigests: [digest("network-a-wifi"), digest("network-a-cell")],
  };
  const deviceB = {
    role: "B",
    deviceIdDigest: digest("device-b"),
    clientInstanceIdDigest: digest("client-b"),
    osFamily: "Linux",
    osMajor: 6,
    browserFamily: "Chrome",
    browserMajor: 140,
    userAgentDigest: digest("ua-b"),
    networkPathDigests: [digest("network-b-other")],
  };
  const files = Object.fromEntries(TRACE_FILES.map((name) => [name, []]));
  const fileSequences = Object.fromEntries(
    TRACE_FILES.map((name) => [name, 0]),
  );
  const scenarios = [];
  let cursor = 1_785_452_000_000;

  for (const scenarioType of REQUIRED_SCENARIOS) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const durationMs = scenarioDuration(scenarioType);
      const startedAt = cursor;
      const actionAt = startedAt + 5_000;
      const resumedAt = scenarioResumeAt(scenarioType, actionAt);
      const endedAt = Math.max(startedAt + durationMs, resumedAt + 5_000);
      const runId = `${scenarioType}-${repetition}`;
      const run = {
        runId,
        scenarioType,
        repetition,
        deviceRoles: TWO_DEVICE_SCENARIOS.has(scenarioType)
          ? ["A", "B"]
          : ["A"],
        startedAt,
        actionAt,
        resumedAt,
        endedAt,
      };
      scenarios.push(run);
      addScenarioRows({
        captureId,
        run,
        files,
        fileSequences,
        deviceA,
        deviceB,
      });
      cursor = endedAt + 10_000;
    }
  }

  const manifest = {
    schemaVersion: 1,
    fixture: true,
    captureId,
    surface: "main",
    appVersion: APP_VERSION,
    codexVersion: CODEX_VERSION,
    gatewayPolicyVersion: GATEWAY_POLICY_VERSION,
    recorderSchemaVersion: 2,
    startedAt: scenarios[0].startedAt,
    endedAt: scenarios.at(-1).endedAt,
    clock: {
      automaticTimeEnabled: true,
      maximumObservedSkewMs: 900,
    },
    ownerAttestation: {
      attestedBy: "owner",
      attestedAt: scenarios.at(-1).endedAt + 1_000,
      confirmedPhysicalDevices: true,
      confirmedDistinctDevices: true,
      confirmedDistinctNetworks: true,
      confirmedActionsFollowedProtocol: true,
      syntheticFixture: true,
    },
    devices: [deviceA, deviceB],
    scenarios,
  };

  writePrivateFile(
    path.join(root, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const filename of TRACE_FILES) {
    const content = files[filename].map((row) => JSON.stringify(row)).join("\n");
    writePrivateFile(
      path.join(root, filename),
      content ? `${content}\n` : "",
    );
  }
  const checksums = {};
  for (const filename of REQUIRED_FILES) {
    const content = fs.readFileSync(path.join(root, filename));
    checksums[filename] = {
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.length,
    };
  }
  writePrivateFile(
    path.join(root, "checksums.json"),
    `${JSON.stringify({ schemaVersion: 1, files: checksums }, null, 2)}\n`,
  );
}

function addScenarioRows({
  captureId,
  run,
  files,
  fileSequences,
  deviceA,
  deviceB,
}) {
  const runSeed = run.runId;
  const threadIdDigest = digest(`${runSeed}:thread`);
  const connectionsA = connectionSet(`${runSeed}:a`);
  const connectionsB = connectionSet(`${runSeed}:b`);
  const browserIdsA = browserIdentity(runSeed, deviceA, "a");
  const browserIdsB = browserIdentity(runSeed, deviceB, "b");
  const networkAWifi = deviceA.networkPathDigests[0];
  const networkACell = deviceA.networkPathDigests[1];
  const networkB = deviceB.networkPathDigests[0];
  const common = {
    captureId,
    runId: run.runId,
    scenarioType: run.scenarioType,
    surface: "main",
    threadIdDigest,
  };

  addRow(files, fileSequences, "observer.ndjson", {
    ...common,
    layer: "observer",
    event: "run/started",
    atUnixMs: run.startedAt,
  });
  addConnectionOpen({
    common,
    files,
    fileSequences,
    device: deviceA,
    browserIds: browserIdsA,
    connections: connectionsA,
    networkPathDigest: networkAWifi,
    atUnixMs: run.startedAt + 100,
  });

  if (run.scenarioType === "foreground-idle") {
    for (let heartbeat = 1; heartbeat <= 4; heartbeat += 1) {
      addRow(files, fileSequences, "gateway.ndjson", {
        ...common,
        ...connectionsA,
        layer: "gateway",
        event: "heartbeat/pong",
        heartbeatOrdinal: heartbeat,
        atUnixMs: run.startedAt + (heartbeat * 25_000),
      });
    }
  } else if (run.scenarioType === "background-2m") {
    addObserverAction(common, run, files, fileSequences, "action/backgrounded");
    addBrowserState(common, files, fileSequences, deviceA, browserIdsA, {
      event: "visibility/hidden",
      atUnixMs: run.actionAt,
      visibility: "hidden",
      online: true,
      networkPathDigest: networkAWifi,
    });
    addBrowserState(common, files, fileSequences, deviceA, browserIdsA, {
      event: "visibility/visible",
      atUnixMs: run.resumedAt,
      visibility: "visible",
      online: true,
      networkPathDigest: networkAWifi,
    });
    addReady(common, files, fileSequences, deviceA, browserIdsA, connectionsA, {
      atUnixMs: run.resumedAt + 1_000,
      networkPathDigest: networkAWifi,
    });
  } else if (
    run.scenarioType === "lock-2m"
    || run.scenarioType === "lock-10m"
  ) {
    addObserverAction(common, run, files, fileSequences, "action/locked");
    addRow(files, fileSequences, "observer.ndjson", {
      ...common,
      layer: "observer",
      event: "action/unlocked",
      atUnixMs: run.resumedAt,
    });
    addReady(common, files, fileSequences, deviceA, browserIdsA, connectionsA, {
      atUnixMs: run.resumedAt + 1_000,
      networkPathDigest: networkAWifi,
    });
  } else if (run.scenarioType === "wifi-cell-handoff") {
    addObserverAction(
      common,
      run,
      files,
      fileSequences,
      "action/network-switch",
    );
    addBrowserState(common, files, fileSequences, deviceA, browserIdsA, {
      event: "network/path-changed",
      atUnixMs: run.resumedAt,
      visibility: "visible",
      online: true,
      networkPathDigest: networkACell,
    });
    const nextConnections = {
      ...connectionsA,
      browserSocketId: deterministicUuid(runSeed, "a-cell-browser-socket"),
      gatewayConnectionId: deterministicUuid(runSeed, "a-cell-gateway"),
      gatewayUpstreamId: deterministicUuid(runSeed, "a-cell-upstream"),
      backendConnectionId: deterministicUuid(runSeed, "a-cell-backend"),
    };
    addReady(common, files, fileSequences, deviceA, browserIdsA, nextConnections, {
      atUnixMs: run.resumedAt + 1_000,
      networkPathDigest: networkACell,
    });
  } else if (run.scenarioType === "airplane-recover") {
    addObserverAction(common, run, files, fileSequences, "action/offline");
    addBrowserState(common, files, fileSequences, deviceA, browserIdsA, {
      event: "network/offline",
      atUnixMs: run.actionAt,
      visibility: "visible",
      online: false,
      networkPathDigest: networkAWifi,
    });
    addBrowserState(common, files, fileSequences, deviceA, browserIdsA, {
      event: "network/online",
      atUnixMs: run.resumedAt,
      visibility: "visible",
      online: true,
      networkPathDigest: networkAWifi,
    });
    addReady(common, files, fileSequences, deviceA, browserIdsA, connectionsA, {
      atUnixMs: run.resumedAt + 1_000,
      networkPathDigest: networkAWifi,
    });
  } else if (run.scenarioType === "refresh-active") {
    addObserverAction(common, run, files, fileSequences, "action/reload");
    const reloadedIds = {
      ...browserIdsA,
      windowInstanceIdDigest: digest(`${runSeed}:a-window-reload`),
    };
    const reloadedConnections = connectionSet(`${runSeed}:a-reload`);
    addConnectionOpen({
      common,
      files,
      fileSequences,
      device: deviceA,
      browserIds: reloadedIds,
      connections: reloadedConnections,
      networkPathDigest: networkAWifi,
      atUnixMs: run.resumedAt,
    });
    addTurnChain({
      common,
      files,
      fileSequences,
      device: deviceA,
      browserIds: reloadedIds,
      connections: reloadedConnections,
      networkPathDigest: networkAWifi,
      atUnixMs: run.resumedAt + 1_000,
    });
  } else if (run.scenarioType === "browser-process-reopen") {
    addObserverAction(
      common,
      run,
      files,
      fileSequences,
      "action/process-ended",
    );
    addRow(files, fileSequences, "gateway.ndjson", {
      ...common,
      ...connectionsA,
      layer: "gateway",
      event: "socket/close",
      closeCode: 1006,
      closeReasonClass: "network",
      atUnixMs: run.actionAt + 1_000,
    });
    const reopenedIds = {
      ...browserIdsA,
      windowInstanceIdDigest: digest(`${runSeed}:a-window-reopen`),
    };
    const reopenedConnections = connectionSet(`${runSeed}:a-reopen`);
    addConnectionOpen({
      common,
      files,
      fileSequences,
      device: deviceA,
      browserIds: reopenedIds,
      connections: reopenedConnections,
      networkPathDigest: networkAWifi,
      atUnixMs: run.resumedAt,
    });
  } else {
    addConnectionOpen({
      common,
      files,
      fileSequences,
      device: deviceB,
      browserIds: browserIdsB,
      connections: connectionsB,
      networkPathDigest: networkB,
      atUnixMs: run.startedAt + 200,
    });
    if (run.scenarioType === "peer-close") {
      addObserverAction(common, run, files, fileSequences, "action/peer-a-close");
      addRow(files, fileSequences, "gateway.ndjson", {
        ...common,
        ...connectionsA,
        layer: "gateway",
        event: "socket/close",
        deviceRole: "A",
        deviceIdDigest: deviceA.deviceIdDigest,
        closeCode: 1000,
        closeReasonClass: "normal",
        atUnixMs: run.actionAt,
      });
      addTurnChain({
        common,
        files,
        fileSequences,
        device: deviceB,
        browserIds: browserIdsB,
        connections: connectionsB,
        networkPathDigest: networkB,
        atUnixMs: run.actionAt + 2_000,
      });
    } else if (run.scenarioType === "peer-hidden-active") {
      addObserverAction(common, run, files, fileSequences, "action/peer-a-locked");
      addBrowserState(common, files, fileSequences, deviceA, browserIdsA, {
        event: "visibility/hidden",
        atUnixMs: run.actionAt,
        visibility: "hidden",
        online: true,
        networkPathDigest: networkAWifi,
      });
      addTurnChain({
        common,
        files,
        fileSequences,
        device: deviceB,
        browserIds: browserIdsB,
        connections: connectionsB,
        networkPathDigest: networkB,
        atUnixMs: run.actionAt + 10_000,
      });
      addBrowserState(common, files, fileSequences, deviceA, browserIdsA, {
        event: "visibility/visible",
        atUnixMs: run.resumedAt,
        visibility: "visible",
        online: true,
        networkPathDigest: networkAWifi,
      });
    }
  }

  addRow(files, fileSequences, "observer.ndjson", {
    ...common,
    layer: "observer",
    event: "run/ended",
    atUnixMs: run.endedAt,
  });
}

function addConnectionOpen({
  common,
  files,
  fileSequences,
  device,
  browserIds,
  connections,
  networkPathDigest,
  atUnixMs,
}) {
  addRow(files, fileSequences, browserFile(device.role), {
    ...common,
    ...browserIds,
    browserSocketId: connections.browserSocketId,
    layer: "browser",
    event: "socket/open",
    deviceRole: device.role,
    deviceIdDigest: device.deviceIdDigest,
    networkPathDigest,
    visibility: "visible",
    online: true,
    atUnixMs,
  });
  addRow(files, fileSequences, "gateway.ndjson", {
    ...common,
    ...connections,
    layer: "gateway",
    event: "socket/open",
    deviceRole: device.role,
    deviceIdDigest: device.deviceIdDigest,
    networkPathDigest,
    atUnixMs: atUnixMs + 10,
  });
  addRow(files, fileSequences, "backend.ndjson", {
    ...common,
    ...connections,
    layer: "backend",
    event: "socket/open",
    deviceRole: device.role,
    deviceIdDigest: device.deviceIdDigest,
    networkPathDigest,
    runtimeEpochDigest: digest(`${common.runId}:runtime`),
    atUnixMs: atUnixMs + 20,
  });
}

function addBrowserState(
  common,
  files,
  fileSequences,
  device,
  browserIds,
  state,
) {
  addRow(files, fileSequences, browserFile(device.role), {
    ...common,
    ...browserIds,
    layer: "browser",
    deviceRole: device.role,
    deviceIdDigest: device.deviceIdDigest,
    ...state,
  });
}

function addReady(
  common,
  files,
  fileSequences,
  device,
  browserIds,
  connections,
  state,
) {
  addRow(files, fileSequences, browserFile(device.role), {
    ...common,
    ...browserIds,
    browserSocketId: connections.browserSocketId,
    layer: "browser",
    event: "transport/ready",
    deviceRole: device.role,
    deviceIdDigest: device.deviceIdDigest,
    visibility: "visible",
    online: true,
    ...state,
  });
}

function addTurnChain({
  common,
  files,
  fileSequences,
  device,
  browserIds,
  connections,
  networkPathDigest,
  atUnixMs,
}) {
  const traceId = deterministicUuid(common.runId, "turn-trace");
  const ids = {
    threadIdDigest: common.threadIdDigest,
    turnIdDigest: digest(`${common.runId}:turn`),
    itemIdDigest: digest(`${common.runId}:item`),
    clientSubmissionIdDigest: digest(`${common.runId}:submission`),
  };
  const base = {
    ...common,
    ...connections,
    ...ids,
    traceId,
    method: "item/completed",
    deviceRole: device.role,
    deviceIdDigest: device.deviceIdDigest,
    networkPathDigest,
  };
  addRow(files, fileSequences, "backend.ndjson", {
    ...base,
    layer: "app-server",
    event: "event/out",
    appServerInstanceId: connections.appServerInstanceId,
    eventSequence: 41,
    atUnixMs,
  });
  addRow(files, fileSequences, "backend.ndjson", {
    ...base,
    layer: "backend",
    event: "broadcast/out",
    eventSequence: 41,
    runtimeEpochDigest: digest(`${common.runId}:runtime`),
    atUnixMs: atUnixMs + 10,
  });
  addRow(files, fileSequences, "gateway.ndjson", {
    ...base,
    layer: "gateway",
    event: "forward/out",
    atUnixMs: atUnixMs + 20,
  });
  for (const [offset, layer, event] of [
    [30, "browser", "event/in"],
    [40, "store", "canonical/apply"],
    [50, "dom", "node/apply"],
  ]) {
    addRow(files, fileSequences, browserFile(device.role), {
      ...base,
      ...browserIds,
      browserSocketId: connections.browserSocketId,
      layer,
      event,
      domNodeCount: layer === "dom" ? 1 : undefined,
      atUnixMs: atUnixMs + offset,
    });
  }
}

function addObserverAction(common, run, files, fileSequences, event) {
  addRow(files, fileSequences, "observer.ndjson", {
    ...common,
    layer: "observer",
    event,
    atUnixMs: run.actionAt,
  });
}

function addRow(files, sequences, filename, row) {
  sequences[filename] += 1;
  const cleaned = {};
  for (const [key, value] of Object.entries({
    schemaVersion: 1,
    ...row,
    sequence: sequences[filename],
    atMonoMs: sequences[filename] / 10,
  })) {
    if (value !== undefined) cleaned[key] = value;
  }
  files[filename].push(cleaned);
}

function loadBundleFromDisk(root) {
  const rootStat = fs.lstatSync(root);
  assert.equal(rootStat.isSymbolicLink(), false);
  assert.equal(rootStat.isDirectory(), true);
  assert.equal(rootStat.mode & 0o777, 0o700);
  const allowed = new Set([...REQUIRED_FILES, "checksums.json"]);
  const names = fs.readdirSync(root).sort();
  for (const name of names) assert.equal(allowed.has(name), true);
  for (const name of allowed) assert.equal(names.includes(name), true);

  const checksumPath = path.join(root, "checksums.json");
  assertPrivateFile(checksumPath, rootStat);
  const checksumDocument = JSON.parse(fs.readFileSync(checksumPath, "utf8"));
  assert.equal(checksumDocument.schemaVersion, 1);
  let totalBytes = fs.statSync(checksumPath).size;
  for (const filename of REQUIRED_FILES) {
    const target = path.join(root, filename);
    assertPrivateFile(target, rootStat);
    const content = fs.readFileSync(target);
    assert.ok(content.length <= MAX_FILE_BYTES);
    totalBytes += content.length;
    const expected = checksumDocument.files?.[filename];
    assert.ok(expected);
    assert.equal(expected.bytes, content.length);
    assert.equal(
      expected.sha256,
      createHash("sha256").update(content).digest("hex"),
    );
  }
  assert.ok(totalBytes <= MAX_BUNDLE_BYTES);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  const rowsByFile = {};
  for (const filename of TRACE_FILES) {
    const content = fs.readFileSync(path.join(root, filename), "utf8").trim();
    rowsByFile[filename] = content
      ? content.split("\n").map((line) => JSON.parse(line))
      : [];
  }
  return { root, manifest, rowsByFile, totalBytes };
}

function validateBundleOnDisk(root, options) {
  return validateLoadedBundle(loadBundleFromDisk(root), options);
}

function validateLoadedBundle(bundle, { allowFixture }) {
  const { manifest } = bundle;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.surface, "main");
  assert.equal(manifest.appVersion, APP_VERSION);
  assert.equal(manifest.codexVersion, CODEX_VERSION);
  assert.equal(manifest.gatewayPolicyVersion, GATEWAY_POLICY_VERSION);
  assert.equal(manifest.recorderSchemaVersion, 2);
  assert.match(manifest.captureId, uuidPattern());
  assert.equal(typeof manifest.fixture, "boolean");
  if (!allowFixture) assert.equal(manifest.fixture, false);
  assert.ok(manifest.startedAt < manifest.endedAt);
  assert.equal(manifest.clock?.automaticTimeEnabled, true);
  assert.ok(manifest.clock.maximumObservedSkewMs <= 5_000);
  validateOwnerAttestation(manifest.ownerAttestation, manifest.fixture);
  validateDevices(manifest.devices);
  validateScenarios(manifest.scenarios);
  validateTraceRows(bundle);
  validateScenarioEvidence(bundle);

  return {
    fixture: manifest.fixture,
    fieldEvidenceAccepted: manifest.fixture === false,
    captureId: manifest.captureId,
    scenarioRuns: manifest.scenarios.length,
    traceRows: allRows(bundle).length,
    bundleBytes: bundle.totalBytes,
    devices: manifest.devices.length,
    distinctDeviceDigests: new Set(
      manifest.devices.map((device) => device.deviceIdDigest),
    ).size,
    distinctNetworkDigests: new Set(
      manifest.devices.flatMap((device) => device.networkPathDigests),
    ).size,
    ownerAttestationPresent: true,
  };
}

function validateOwnerAttestation(attestation, fixture) {
  assert.equal(attestation?.attestedBy, "owner");
  assert.equal(Number.isSafeInteger(attestation.attestedAt), true);
  assert.equal(attestation.confirmedPhysicalDevices, true);
  assert.equal(attestation.confirmedDistinctDevices, true);
  assert.equal(attestation.confirmedDistinctNetworks, true);
  assert.equal(attestation.confirmedActionsFollowedProtocol, true);
  if (fixture) assert.equal(attestation.syntheticFixture, true);
  else assert.notEqual(attestation.syntheticFixture, true);
}

function validateDevices(devices) {
  assert.ok(Array.isArray(devices));
  assert.equal(devices.length, 2);
  assert.deepEqual(devices.map((device) => device.role).sort(), ["A", "B"]);
  assert.equal(new Set(devices.map((device) => device.deviceIdDigest)).size, 2);
  assert.equal(
    new Set(devices.map((device) => device.clientInstanceIdDigest)).size,
    2,
  );
  const networkSets = devices.map((device) => {
    assertDigest(device.deviceIdDigest);
    assertDigest(device.clientInstanceIdDigest);
    assertDigest(device.userAgentDigest);
    assert.match(device.osFamily, /^(Android|iOS|Linux|Windows|macOS)$/);
    assert.match(device.browserFamily, /^(Chrome|Safari|Firefox|Edge)$/);
    assert.ok(Number.isSafeInteger(device.osMajor) && device.osMajor > 0);
    assert.ok(
      Number.isSafeInteger(device.browserMajor) && device.browserMajor > 0,
    );
    assert.ok(Array.isArray(device.networkPathDigests));
    assert.ok(device.networkPathDigests.length > 0);
    for (const value of device.networkPathDigests) assertDigest(value);
    return new Set(device.networkPathDigests);
  });
  assert.equal(
    [...networkSets[0]].some((value) => networkSets[1].has(value)),
    false,
  );
  assert.ok(devices.find((device) => device.role === "A").networkPathDigests.length >= 2);
}

function validateScenarios(scenarios) {
  assert.ok(Array.isArray(scenarios));
  assert.equal(scenarios.length, REQUIRED_SCENARIOS.length * 3);
  assert.equal(new Set(scenarios.map((run) => run.runId)).size, scenarios.length);
  for (const scenarioType of REQUIRED_SCENARIOS) {
    const runs = scenarios.filter((run) => run.scenarioType === scenarioType);
    assert.deepEqual(
      runs.map((run) => run.repetition).sort(),
      [1, 2, 3],
    );
  }
  for (const run of scenarios) {
    assert.equal(REQUIRED_SCENARIOS.includes(run.scenarioType), true);
    assert.ok(
      run.startedAt <= run.actionAt
      && run.actionAt <= run.resumedAt
      && run.resumedAt <= run.endedAt,
    );
    const interval = run.resumedAt - run.actionAt;
    if (["background-2m", "lock-2m", "peer-hidden-active"].includes(
      run.scenarioType,
    )) {
      assert.ok(interval >= 120_000);
    }
    if (run.scenarioType === "lock-10m") assert.ok(interval >= 600_000);
    if (run.scenarioType === "airplane-recover") assert.ok(interval >= 30_000);
    const expectedRoles = TWO_DEVICE_SCENARIOS.has(run.scenarioType)
      ? ["A", "B"]
      : ["A"];
    assert.deepEqual([...run.deviceRoles].sort(), expectedRoles);
  }
}

function validateTraceRows(bundle) {
  const runById = new Map(
    bundle.manifest.scenarios.map((run) => [run.runId, run]),
  );
  const captureId = bundle.manifest.captureId;
  const devicesByRole = new Map(
    bundle.manifest.devices.map((device) => [device.role, device]),
  );
  for (const filename of TRACE_FILES) {
    let previousSequence = 0;
    let previousUnixMs = 0;
    for (const row of bundle.rowsByFile[filename]) {
      for (const key of Object.keys(row)) {
        assert.equal(FORBIDDEN_KEYS.has(key), false);
        assert.equal(ALLOWED_TRACE_KEYS.has(key), true);
      }
      assert.equal(row.schemaVersion, 1);
      assert.equal(row.captureId, captureId);
      assert.equal(row.surface, "main");
      assert.equal(ALLOWED_LAYERS.has(row.layer), true);
      assert.equal(row.sequence, previousSequence + 1);
      previousSequence = row.sequence;
      assert.ok(row.atUnixMs >= previousUnixMs);
      previousUnixMs = row.atUnixMs;
      const run = runById.get(row.runId);
      assert.ok(run);
      assert.equal(row.scenarioType, run.scenarioType);
      assert.ok(row.atUnixMs >= run.startedAt && row.atUnixMs <= run.endedAt);
      assert.ok(Number.isFinite(row.atMonoMs) && row.atMonoMs >= 0);
      if (row.deviceRole !== undefined) {
        assert.equal(["A", "B"].includes(row.deviceRole), true);
        const device = devicesByRole.get(row.deviceRole);
        assert.ok(device);
        assert.equal(row.deviceIdDigest, device.deviceIdDigest);
        if (row.networkPathDigest) {
          assert.equal(
            device.networkPathDigests.includes(row.networkPathDigest),
            true,
          );
        }
      } else {
        assert.equal(row.deviceIdDigest, undefined);
        assert.equal(row.networkPathDigest, undefined);
      }
      for (const [key, value] of Object.entries(row)) {
        if (key.endsWith("Digest")) assertDigest(value);
      }
      for (const key of [
        "traceId",
        "browserSocketId",
        "gatewayConnectionId",
        "gatewayUpstreamId",
        "backendConnectionId",
        "appServerInstanceId",
      ]) {
        if (row[key]) assert.match(row[key], uuidPattern());
      }
    }
  }
  const serialized = JSON.stringify(bundle);
  assert.equal(
    /prompt-private|reply-private|\bBearer\b|\bsk-[A-Za-z0-9]|session=|cookie|authorization|apiKey|toolOutput|"diff"/i
      .test(serialized),
    false,
  );
}

function validateScenarioEvidence(bundle) {
  const rows = allRows(bundle);
  for (const run of bundle.manifest.scenarios) {
    const runRows = rows.filter((row) => row.runId === run.runId);
    const layers = new Set(runRows.map((row) => row.layer));
    for (const layer of ["observer", "browser", "gateway", "backend"]) {
      assert.equal(layers.has(layer), true);
    }
    assert.ok(runRows.some((row) => row.event === "run/started"));
    assert.ok(runRows.some((row) => row.event === "run/ended"));

    if (TURN_SCENARIOS.has(run.scenarioType)) {
      for (const layer of [
        "app-server",
        "backend",
        "gateway",
        "browser",
        "store",
        "dom",
      ]) {
        assert.equal(layers.has(layer), true);
      }
      const chain = runRows.filter((row) => row.traceId);
      assert.equal(new Set(chain.map((row) => row.traceId)).size, 1);
      for (const field of [
        "threadIdDigest",
        "turnIdDigest",
        "itemIdDigest",
        "clientSubmissionIdDigest",
      ]) {
        assert.equal(new Set(chain.map((row) => row[field])).size, 1);
      }
      for (const field of [
        "gatewayConnectionId",
        "gatewayUpstreamId",
        "backendConnectionId",
        "appServerInstanceId",
      ]) {
        assert.equal(new Set(chain.map((row) => row[field])).size, 1);
      }
    }
    if (TWO_DEVICE_SCENARIOS.has(run.scenarioType)) {
      assert.deepEqual(
        [...new Set(runRows.map((row) => row.deviceRole).filter(Boolean))]
          .sort(),
        ["A", "B"],
      );
      assert.equal(
        new Set(runRows.map((row) => row.deviceIdDigest).filter(Boolean)).size,
        2,
      );
    }
    validateSpecificScenario(run, runRows);
  }
}

function validateSpecificScenario(run, rows) {
  const event = (name) => rows.find((row) => row.event === name);
  if (run.scenarioType === "foreground-idle") {
    assert.equal(
      rows.filter((row) => row.event === "heartbeat/pong").length,
      4,
    );
    assert.equal(
      new Set(
        rows.filter((row) => row.browserSocketId)
          .map((row) => row.browserSocketId),
      ).size,
      1,
    );
  } else if (run.scenarioType === "background-2m") {
    assert.ok(event("visibility/hidden"));
    assert.ok(event("visibility/visible"));
    assert.ok(event("transport/ready"));
  } else if (
    run.scenarioType === "lock-2m"
    || run.scenarioType === "lock-10m"
  ) {
    assert.ok(event("action/locked"));
    assert.ok(event("action/unlocked"));
    assert.ok(event("transport/ready"));
  } else if (run.scenarioType === "wifi-cell-handoff") {
    assert.ok(event("action/network-switch"));
    assert.ok(event("network/path-changed"));
    assert.ok(event("transport/ready"));
    assert.ok(
      new Set(rows.map((row) => row.networkPathDigest).filter(Boolean)).size
      >= 2,
    );
  } else if (run.scenarioType === "airplane-recover") {
    assert.equal(event("network/offline").online, false);
    assert.equal(event("network/online").online, true);
    assert.ok(event("transport/ready"));
  } else if (run.scenarioType === "refresh-active") {
    assert.ok(event("action/reload"));
    assert.ok(event("node/apply"));
  } else if (run.scenarioType === "browser-process-reopen") {
    assert.ok(event("action/process-ended"));
    assert.ok(event("socket/close"));
    assert.ok(
      new Set(rows.map((row) => row.browserSocketId).filter(Boolean)).size
      >= 2,
    );
  } else if (run.scenarioType === "peer-close") {
    const close = event("action/peer-a-close");
    const terminal = event("node/apply");
    assert.ok(close && terminal && terminal.atUnixMs > close.atUnixMs);
    assert.equal(terminal.deviceRole, "B");
  } else if (run.scenarioType === "peer-hidden-active") {
    const hidden = event("visibility/hidden");
    const terminal = event("node/apply");
    const visible = event("visibility/visible");
    assert.ok(
      hidden && terminal && visible
      && hidden.atUnixMs < terminal.atUnixMs
      && terminal.atUnixMs < visible.atUnixMs,
    );
    assert.equal(terminal.deviceRole, "B");
  }
}

function expectSemanticFailure(source, name, mutate, failures) {
  const cloned = structuredClone(source);
  mutate(cloned);
  assert.throws(() => validateLoadedBundle(cloned, { allowFixture: true }));
  failures.push(name);
}

function allRows(bundle) {
  return TRACE_FILES.flatMap((filename) => bundle.rowsByFile[filename]);
}

function scenarioDuration(type) {
  if (type === "lock-10m") return 610_000;
  if (["background-2m", "lock-2m", "peer-hidden-active"].includes(type)) {
    return 130_000;
  }
  if (type === "foreground-idle" || type === "two-device-coobserve") {
    return 130_000;
  }
  if (type === "browser-process-reopen") return 45_000;
  return 40_000;
}

function scenarioResumeAt(type, actionAt) {
  if (type === "lock-10m") return actionAt + 600_000;
  if (["background-2m", "lock-2m", "peer-hidden-active"].includes(type)) {
    return actionAt + 120_000;
  }
  if (type === "airplane-recover") return actionAt + 30_000;
  if (type === "wifi-cell-handoff") return actionAt + 15_000;
  return actionAt + 5_000;
}

function browserIdentity(runSeed, device, suffix) {
  return {
    deviceRole: device.role,
    deviceIdDigest: device.deviceIdDigest,
    clientInstanceIdDigest: device.clientInstanceIdDigest,
    windowInstanceIdDigest: digest(`${runSeed}:${suffix}:window`),
  };
}

function connectionSet(seed) {
  return {
    browserSocketId: deterministicUuid(seed, "browser-socket"),
    gatewayConnectionId: deterministicUuid(seed, "gateway-connection"),
    gatewayUpstreamId: deterministicUuid(seed, "gateway-upstream"),
    backendConnectionId: deterministicUuid(seed, "backend-connection"),
    appServerInstanceId: deterministicUuid(seed, "app-server"),
  };
}

function browserFile(role) {
  return role === "B" ? "browser-b.ndjson" : "browser-a.ndjson";
}

function assertPrivateFile(target, expectedOwner) {
  const stat = fs.lstatSync(target);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.uid, expectedOwner.uid);
  assert.equal(stat.gid, expectedOwner.gid);
}

function writePrivateFile(target, content) {
  const descriptor = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(target, 0o600);
}

function assertDigest(value) {
  assert.match(String(value), /^[0-9a-f]{64}$/);
}

function digest(value) {
  return createHash("sha256")
    .update("fixture-digest\0")
    .update(String(value))
    .digest("hex");
}

function deterministicUuid(seed, label) {
  const value = createHash("sha256")
    .update(String(seed))
    .update("\0")
    .update(label)
    .digest("hex");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    `4${value.slice(13, 16)}`,
    `8${value.slice(17, 20)}`,
    value.slice(20, 32),
  ].join("-");
}

function uuidPattern() {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  assert.ok(value && !value.startsWith("--"));
  return value;
}

function assertTemporaryRoot(root) {
  const resolved = path.resolve(root);
  const prefix = path.join(
    fs.realpathSync(os.tmpdir()),
    "wfl-mobile-field-bundle-",
  );
  assert.equal(resolved.startsWith(prefix), true);
  assert.notEqual(resolved, fs.realpathSync(os.tmpdir()));
}
