import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SOURCE_BASELINE = Object.freeze({
  "gateway.mjs": "ea7299b0cd269ca45780ef05e55fd7354e2ee02d7e5db2cffbdcd15082d84959",
  "server.mjs": "4de3f3eb12293c61bc62f87f673f8337c5439b971ffbd645eed48a05ac47a916",
  "public/app.js": "c774d9b249608296b852fc5df3aff778e428f7a505b9309bfb036dcf26757a65",
  "public/thread-state.js": "7977762663a7ebcf5261b15816567ae01429e1bdafc3059c2f013d04cd812926",
});
const RECORDER_IDENTIFIERS = Object.freeze([
  "appServerInstanceId",
  "backendConnectionId",
  "browserSocketId",
  "conversation-shadow",
  "conversationTrace",
  "gatewayConnectionId",
  "gatewayUpstreamId",
]);

function readSource(file) {
  const text = fs.readFileSync(file, "utf8");
  const sha256 = crypto.createHash("sha256").update(text).digest("hex");
  assert.equal(
    sha256,
    SOURCE_BASELINE[file],
    `${file} changed; re-audit recorder hook placement before using this map`,
  );
  return { file, text, sha256 };
}

function lineOf(source, needle) {
  const index = source.text.indexOf(needle);
  assert.ok(index >= 0, `${source.file} missing anchor: ${needle}`);
  return source.text.slice(0, index).split("\n").length;
}

function section(source, startNeedle, endNeedle) {
  const start = source.text.indexOf(startNeedle);
  const end = source.text.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `${source.file} missing section start: ${startNeedle}`);
  assert.ok(end > start, `${source.file} missing section end: ${endNeedle}`);
  return source.text.slice(start, end);
}

function mapping(source, entries) {
  return entries.map(([name, needle, phase]) => ({
    name,
    line: lineOf(source, needle),
    phase,
  }));
}

const gateway = readSource("gateway.mjs");
const backend = readSource("server.mjs");
const browser = readSource("public/app.js");
const reducer = readSource("public/thread-state.js");

const gatewayUpgrade = section(
  gateway,
  'server.on("upgrade", (request, socket, head) => {',
  "\nserver.listen(",
);
assert.ok(gatewayUpgrade.includes('pathname !== "/ws"'));
assert.ok(gatewayUpgrade.includes('pathname === "/rescue/ws"'));
assert.ok(gatewayUpgrade.includes("OFFICIAL_BROWSER_VNC_PATHS.has(pathname)"));

const gatewayUpstream = section(
  gateway,
  "function openUpstream(requestHeaders, target = null) {",
  "\nfunction httpUpstreamTarget(",
);
for (const identifier of [
  "x-wfl-gateway-connection-id",
  "x-wfl-gateway-upstream-id",
]) {
  assert.equal(
    gatewayUpstream.includes(identifier),
    false,
    `public upstream header allowlist already contains ${identifier}`,
  );
}

const backendUpgrade = section(
  backend,
  'server.on("upgrade", (request, socket, head) => {',
  "\nfunction bridgeVncWebSocket(",
);
assert.ok(backend.text.includes(
  'const RESCUE_MODE = process.env.CODEX_DESKTOP_RESCUE_MODE === "1";',
));
assert.ok(backendUpgrade.includes('["/ws", "/rescue/ws"]'));
assert.ok(backendUpgrade.includes("if (vncSocket)"));

const backendConnection = section(
  backend,
  'wss.on("connection", (client, runtime) => {',
  "\nfunction send(client, message) {",
);
for (const anchor of [
  'message.type === "client/state"',
  'message.type === "rpc"',
  'message.type === "serverResponse"',
  'client.on("close"',
]) {
  assert.ok(backendConnection.includes(anchor), `backend missing ${anchor}`);
}

const clientState = section(
  browser,
  "function sendClientState(",
  "\nasync function releaseThreadSubscription(",
);
for (const field of [
  "threadId",
  "visible",
  "codexRuntimeEpoch",
  "codexEventSequence",
]) {
  assert.ok(clientState.includes(field), `client/state missing ${field}`);
}

const productionSources = [gateway, backend, browser, reducer];
const productionRecorderReferences = [];
for (const source of productionSources) {
  for (const identifier of RECORDER_IDENTIFIERS) {
    if (source.text.includes(identifier)) {
      productionRecorderReferences.push({
        file: source.file,
        identifier,
      });
    }
  }
}
assert.deepEqual(productionRecorderReferences, []);

const integrationCandidates = [
  "package.json",
  "package-lock.json",
  "install.sh",
  ...fs.readdirSync("scripts")
    .filter((name) => /(deploy|install|quick|release|update)/i.test(name))
    .map((name) => path.join("scripts", name))
    .filter((file) => fs.statSync(file).isFile()),
];
const integrationReferences = integrationCandidates
  .filter((file) => fs.readFileSync(file, "utf8").includes(
    "probe-shadow-recorder-hook-map.mjs",
  ));
assert.deepEqual(integrationReferences, []);

const gatewayHooks = mapping(gateway, [
  ["upgrade-main-gate", 'server.on("upgrade", (request, socket, head) => {', "admission"],
  ["bridge-lifecycle", "function bridgeWebSocket(", "transport"],
  ["upstream-message", "const forwardUpstreamMessage =", "transport"],
  ["upstream-generation", "const attachUpstream =", "transport"],
  ["browser-message", 'client.on("message", (data, isBinary) => {', "transport"],
  ["browser-close", 'client.once("close", () => {', "lifecycle"],
  ["internal-header-construction", "function openUpstream(", "admission"],
]);
const backendHooks = mapping(backend, [
  ["bridge-process-start", "  async start() {", "app-server"],
  ["bridge-stdout-framing", "  consume(chunk) {", "app-server"],
  ["bridge-message-classification", "  handleMessage(line) {", "app-server"],
  ["bridge-stdin-write", "  write(message) {", "app-server"],
  ["raw-to-public-notification", '    this.bridge.on("notification", (rawPayload) => {', "projection"],
  ["account-broadcast", "  broadcast(message) {", "backend"],
  ["client-state-ownership", "  updateClientState(client,", "backend"],
  ["client-release", "  releaseClient(client) {", "lifecycle"],
  ["backend-connection", 'wss.on("connection", (client, runtime) => {', "admission"],
  ["backend-send", "function send(client, message) {", "transport"],
]);
const browserHooks = mapping(browser, [
  ["socket-generation", "function connectSocket() {", "transport"],
  ["outer-envelope-ingress", "function handleSocketMessage(message) {", "transport"],
  ["client-state-handshake", "function sendClientState(", "admission"],
  ["codex-reducer-entry", "function handleCodexNotification(notification) {", "store"],
  ["turn-store-apply", "function upsertTurn(turn) {", "store"],
  ["item-store-apply", "function upsertItem(turn, item,", "store"],
  ["snapshot-calibration", "async function refreshRecentTurns(threadId) {", "store"],
  ["dom-reconciliation", "function reconcileTranscriptNodes(descriptors) {", "dom"],
  ["transcript-render", "function renderMessages(", "dom"],
  ["stream-patch", "function flushStreamItemRender() {", "dom"],
]);
const pureReducerAnchors = mapping(reducer, [
  ["pending-match", "export function matchesPendingUserMessage(", "pure"],
  ["item-merge", "export function mergeThreadItem(", "pure"],
  ["item-upsert", "export function upsertThreadItem(", "pure"],
  ["turn-merge", "export function mergeTurn(", "pure"],
]);

console.log(JSON.stringify({
  ok: true,
  baseline: Object.fromEntries(productionSources.map((source) => [
    source.file,
    { sha256: source.sha256, lines: source.text.split("\n").length },
  ])),
  gates: {
    gatewaySeparatesMainRescueAndVncBeforeBridge: true,
    gatewayReservedTraceHeadersNotAcceptedFromPublicAllowlist: true,
    backendHasExplicitRescueMode: true,
    backendUpgradeSeparatesVncBeforeMainRuntime: true,
    browserUsesMainWsPath: browser.text.includes(
      "new WebSocket(`${protocol}//${location.host}/ws`)",
    ),
    recorderAlreadyInProduction: false,
  },
  hooks: {
    gateway: gatewayHooks,
    backend: backendHooks,
    browser: browserHooks,
    pureReducerNoDirectRecorderHook: pureReducerAnchors,
  },
  integration: {
    packageInstallUpdateReleaseReferences: integrationReferences,
    productionRecorderReferences,
  },
  limits: {
    installsRecorder: false,
    editsProductionSource: false,
    startsServerOrBrowser: false,
    readsConversationState: false,
    validatesFutureHookBehavior: false,
    ownerAuthorizedCaptureStillRequired: true,
    physicalMobileEvidenceStillRequired: true,
    touchesRescueWindow: false,
  },
}, null, 2));
