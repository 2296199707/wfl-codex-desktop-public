import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  buildClaudeCompatibility,
  inspectClaudeCompatibility,
  sanitizeClaudeDoctor,
} from "../lib/claude-compatibility.mjs";

const fixture = JSON.parse(await fs.readFile(
  new URL("./fixtures/claude-code-2.1.236-capabilities.json", import.meta.url),
  "utf8",
));

test("Claude compatibility snapshot accepts the reviewed 2.1.236 surface", () => {
  const snapshot = buildClaudeCompatibility({
    fixture,
    detectedCapabilities: detectedFromFixture(),
    doctorOutput: doctorFixture(),
    checkedAt: 1_785_350_000_000,
  });
  assert.equal(snapshot.state, "compatible");
  assert.equal(snapshot.compatible, true);
  assert.equal(snapshot.versionReviewed, true);
  assert.equal(snapshot.commitReviewed, true);
  assert.equal(snapshot.capabilitiesReviewed, true);
  assert.equal(snapshot.semanticReviewed, true);
  assert.equal(snapshot.runtimeAutoUpdateBlocked, true);
  assert.equal(snapshot.doctor.commit, "82959839e940");
  assert.equal(snapshot.doctor.autoUpdates, "enabled");
  assert.equal(snapshot.doctor.autoUpdateChannel, "latest");
  assert.equal(Object.hasOwn(snapshot.doctor, "path"), false);
  assert.equal(snapshot.coverage.options.counts.planned, 0);
  assert.equal(snapshot.coverage.options.counts.partial, 0);
  assert.equal(snapshot.coverage.commands.counts.planned, 0);
  assert.equal(snapshot.coverage.commands.counts.partial, 0);
  assert.ok(snapshot.capabilityGroups.some((group) => (
    group.category === "implemented"
    && group.surface === "Native background agents"
    && group.methods.includes("agents")
    && group.evidence.server.length > 0
  )));
  assert.equal(snapshot.deferredGroups.some((group) => group.state === "partial"), false);
  assert.ok(snapshot.deferredGroups.length > 0);
});

test("Claude compatibility snapshot rejects version, option, semantic, and protocol drift", () => {
  const detected = detectedFromFixture();
  detected.version = "2.1.221";
  detected.helpOptions = detected.helpOptions
    .filter((option) => option !== "--resume")
    .concat("--new-capability");
  detected.helpSemanticSha256 = "f".repeat(64);
  detected.controlRequestSubtypes = detected.controlRequestSubtypes.concat("unreviewed_control");
  const snapshot = buildClaudeCompatibility({
    fixture,
    detectedCapabilities: detected,
    doctorOutput: doctorFixture(),
  });
  assert.equal(snapshot.state, "version-drift");
  assert.equal(snapshot.compatible, false);
  assert.equal(snapshot.activationAllowed, false);
  assert.equal(snapshot.risk, "blocked");
  assert.ok(snapshot.criticalIssues.some((item) => item.method === "--resume"));
  assert.equal(snapshot.semanticReviewed, false);
  assert.deepEqual(snapshot.surfaces.helpOptions.added, ["--new-capability"]);
  assert.deepEqual(snapshot.surfaces.helpOptions.removed, ["--resume"]);
  assert.deepEqual(snapshot.surfaces.controlRequests.added, ["unreviewed_control"]);
});

test("Claude compatibility rejects a changed CLI build even when version and help stay the same", () => {
  const snapshot = buildClaudeCompatibility({
    fixture,
    detectedCapabilities: detectedFromFixture(),
    doctorOutput: doctorFixture().replace("82959839e940", "aaaaaaaaaaaa"),
  });
  assert.equal(snapshot.state, "capability-drift");
  assert.equal(snapshot.compatible, false);
  assert.equal(snapshot.versionReviewed, true);
  assert.equal(snapshot.semanticReviewed, true);
  assert.equal(snapshot.commitReviewed, false);
  assert.equal(snapshot.capabilitiesReviewed, false);
  assert.equal(snapshot.activationAllowed, true);
  assert.equal(snapshot.decisionRequired, true);
  assert.equal(snapshot.risk, "unreviewed");
});

test("Claude reports an optional missing capability without blocking activation", () => {
  const detected = detectedFromFixture();
  detected.version = "2.1.221";
  detected.helpOptions = detected.helpOptions.filter((option) => option !== "--prompt-suggestions");
  const snapshot = buildClaudeCompatibility({
    fixture,
    detectedCapabilities: detected,
    doctorOutput: doctorFixture().replaceAll("2.1.236", "2.1.237"),
  });
  assert.equal(snapshot.activationAllowed, true);
  assert.equal(snapshot.decisionRequired, true);
  assert.equal(snapshot.risk, "limited");
  assert.ok(snapshot.limitations.some((item) => (
    item.method === "--prompt-suggestions" && item.feature === "Prompt suggestions"
  )));
});

test("Claude Doctor output is reduced to an explicit path- and account-safe allowlist", () => {
  const doctor = sanitizeClaudeDoctor(`${doctorFixture()}
Path: /srv/private/users/alice/.claude/bin/claude
Remote Control
- Signed in as private@example.test
- Cookie: session-secret
`);
  assert.deepEqual(doctor, {
    running: "npm-global",
    version: "2.1.236",
    commit: "82959839e940",
    platform: "linux-x64",
    installMethod: "native",
    search: "OK (bundled)",
    autoUpdates: "enabled",
    autoUpdateChannel: "latest",
    lastUpdateAttempt: "none recorded",
    warnings: [],
    fatalIssues: [],
    installationHealthy: true,
  });
  assert.doesNotMatch(JSON.stringify(doctor), /alice|private@example|session-secret|\/srv\//);
});

test("Claude Doctor installation warnings remain visible without blocking activation", () => {
  const snapshot = buildClaudeCompatibility({
    fixture,
    detectedCapabilities: detectedFromFixture(),
    doctorOutput: `${doctorFixture().replace("Running: npm-global", "Running: native").replace("No installation issues found.", "2 warnings found\n- Running native installation but config install method is 'unknown'\n  Fix: Run claude install\n- claude command at /root/.local/bin/claude missing or broken\n  Fix: Run claude install")}`,
  });
  assert.equal(snapshot.compatible, true);
  assert.equal(snapshot.activationAllowed, true);
  assert.equal(snapshot.doctor.installationHealthy, true);
  assert.equal(snapshot.doctor.fatalIssues.length, 0);
  assert.deepEqual(snapshot.doctor.warnings, [
    "Running native installation but config install method is 'unknown'",
    "redacted",
  ]);
});

test("Claude Doctor installation errors still block activation", () => {
  const snapshot = buildClaudeCompatibility({
    fixture,
    detectedCapabilities: detectedFromFixture(),
    doctorOutput: doctorFixture().replace(
      "No installation issues found.",
      "1 installation issue found.\n- Claude installation is corrupt",
    ),
  });
  assert.equal(snapshot.compatible, false);
  assert.equal(snapshot.activationAllowed, false);
  assert.equal(snapshot.state, "unhealthy");
  assert.equal(snapshot.doctor.installationHealthy, false);
  assert.ok(snapshot.doctor.fatalIssues.length > 0);
});

test("installed Claude performs a real lightweight initialize probe against the reviewed baseline", { timeout: 30_000 }, async () => {
  const snapshot = await inspectClaudeCompatibility();
  assert.equal(snapshot.installedVersion, "2.1.236");
  assert.equal(snapshot.compatible, true);
  assert.equal(snapshot.doctor.installationHealthy, true);
  assert.ok(snapshot.checkedAt > 0);
});

function detectedFromFixture() {
  return {
    version: fixture.version,
    helpSemanticSha256: fixture.helpSemanticSha256,
    helpOptions: [...fixture.helpOptions],
    commands: [...fixture.commands],
    internalOptions: [...fixture.requiredInternalOptions],
    permissionModes: [...fixture.permissionModes],
    effortLevels: [...fixture.effortLevels],
    topLevelEvents: [...fixture.topLevelEvents],
    streamEvents: [...fixture.streamEvents],
    systemEvents: [...fixture.systemEvents],
    controlRequestSubtypes: [...fixture.controlRequestSubtypes],
    dialogKinds: [...fixture.dialogKinds],
  };
}

function doctorFixture() {
  return `Claude Code doctor

Running: npm-global (2.1.236)
Commit: 82959839e940
Platform: linux-x64
Config install method: native
Search: OK (bundled)
Auto-updates: enabled
Auto-update channel: latest
Last update attempt: none recorded

No installation issues found.`;
}
