import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  CLAUDE_CAPABILITY_STATES,
  CLAUDE_COMMAND_COVERAGE,
  CLAUDE_CONTROL_REQUEST_COVERAGE,
  CLAUDE_DIALOG_KIND_COVERAGE,
  CLAUDE_EFFORT_LEVEL_COVERAGE,
  CLAUDE_OPTION_COVERAGE,
  CLAUDE_PERMISSION_MODE_COVERAGE,
  CLAUDE_PROTOCOL_BASELINE,
  CLAUDE_REQUIRED_INTERNAL_OPTIONS,
  CLAUDE_STREAM_EVENT_COVERAGE,
  CLAUDE_SYSTEM_EVENT_COVERAGE,
  CLAUDE_TOP_LEVEL_EVENT_COVERAGE,
  claudeProtocolCoverageSections,
  claudeProtocolCoverageSnapshot,
} from "../lib/claude-protocol-coverage.mjs";
import {
  renderClaudeCoverageDocument,
  validateClaudeCoverage,
} from "../scripts/generate-claude-coverage.mjs";

const fixture = JSON.parse(await fs.readFile(
  new URL("./fixtures/claude-code-2.1.236-capabilities.json", import.meta.url),
  "utf8",
));

test("Claude 2.1.236 capability inventory is complete, unique, and classified", () => {
  assert.equal(CLAUDE_PROTOCOL_BASELINE, "claude-code 2.1.236");
  assert.equal(fixture.baseline, CLAUDE_PROTOCOL_BASELINE);
  assert.equal(fixture.version, "2.1.236");
  assert.equal(fixture.commit, "82959839e940");
  assert.match(fixture.helpSemanticSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(methods(CLAUDE_OPTION_COVERAGE), sorted(fixture.helpOptions));
  assert.deepEqual(methods(CLAUDE_COMMAND_COVERAGE), sorted(fixture.commands));
  assert.deepEqual(sorted(CLAUDE_REQUIRED_INTERNAL_OPTIONS), sorted(fixture.requiredInternalOptions));
  assert.deepEqual(methods(CLAUDE_PERMISSION_MODE_COVERAGE), sorted(fixture.permissionModes));
  assert.deepEqual(methods(CLAUDE_EFFORT_LEVEL_COVERAGE), sorted(fixture.effortLevels));
  for (const entries of allCoverage()) {
    assert.equal(new Set(entries.map((entry) => entry.method)).size, entries.length);
    for (const entry of entries) {
      assert.ok(CLAUDE_CAPABILITY_STATES.has(entry.state), `${entry.method}: ${entry.state}`);
      assert.ok(entry.surface.length > 2);
      assert.equal(entry.origin === "wfl-compatible", entry.state === "custom-equivalent");
    }
  }
});

test("Claude stream-json and control protocol inventories stay explicitly pinned", () => {
  assert.deepEqual(methods(CLAUDE_TOP_LEVEL_EVENT_COVERAGE), sorted(fixture.topLevelEvents));
  assert.deepEqual(methods(CLAUDE_STREAM_EVENT_COVERAGE), sorted(fixture.streamEvents));
  assert.deepEqual(methods(CLAUDE_SYSTEM_EVENT_COVERAGE), sorted(fixture.systemEvents));
  assert.deepEqual(methods(CLAUDE_CONTROL_REQUEST_COVERAGE), sorted(fixture.controlRequestSubtypes));
  assert.deepEqual(methods(CLAUDE_DIALOG_KIND_COVERAGE), sorted(fixture.dialogKinds));
});

test("Claude capability snapshot distinguishes complete, partial, planned, and deferred work", () => {
  const snapshot = claudeProtocolCoverageSnapshot();
  assert.equal(snapshot.baseline, CLAUDE_PROTOCOL_BASELINE);
  assert.equal(snapshot.options.total, fixture.helpOptions.length);
  assert.ok(snapshot.options.counts.runtime > 20);
  assert.ok(snapshot.options.counts["custom-equivalent"] > 0);
  assert.equal(snapshot.commands.counts.partial, 0);
  assert.equal(snapshot.options.counts.planned, 0);
  assert.equal(snapshot.commands.counts.planned, 0);
  assert.ok(snapshot.options.counts.deferred > 0);
  assert.equal(snapshot.controlRequests.counts.runtime, 3);
  assert.equal(snapshot.dialogKinds.counts.runtime, 1);
});

test("native background coverage reflects the real --bg and complete agents lifecycle", () => {
  assert.equal(CLAUDE_OPTION_COVERAGE.find((entry) => entry.method === "--bg")?.state, "runtime");
  assert.equal(
    CLAUDE_OPTION_COVERAGE.find((entry) => entry.method === "--background")?.state,
    "custom-equivalent",
  );
  const agents = CLAUDE_COMMAND_COVERAGE.find((item) => item.method === "agents");
  assert.equal(agents?.state, "runtime");
  for (const command of ["mcp", "plugin"]) {
    const entry = CLAUDE_COMMAND_COVERAGE.find((item) => item.method === command);
    assert.equal(entry?.state, "runtime");
    assert.ok(entry.evidence.server.length > 0);
    assert.ok(entry.evidence.ui.length > 0);
    assert.ok(entry.evidence.tests.length > 0);
  }
});

test("Claude 2.1.236 additions are classified with the safe context feature implemented", () => {
  assert.equal(CLAUDE_OPTION_COVERAGE.find((entry) => entry.method === "--autocompact")?.state, "runtime");
  for (const option of ["--cloud", "--environment", "--teleport"]) {
    assert.equal(CLAUDE_OPTION_COVERAGE.find((entry) => entry.method === option)?.state, "deferred");
  }
  assert.equal(CLAUDE_COMMAND_COVERAGE.find((entry) => entry.method === "import")?.state, "deferred");
});

test("safe native launch controls are implemented through isolated new processes", () => {
  for (const option of [
    "--exclude-dynamic-system-prompt-sections",
    "--json-schema",
    "--mcp-config",
    "--no-session-persistence",
    "--safe-mode",
    "--setting-sources",
    "--strict-mcp-config",
    "--system-prompt",
  ]) {
    assert.equal(CLAUDE_OPTION_COVERAGE.find((entry) => entry.method === option)?.state, "runtime");
  }
});

test("generated Claude capability matrix is current and every implemented item has evidence", async () => {
  const sections = claudeProtocolCoverageSections();
  await validateClaudeCoverage({
    fixture,
    sections,
    projectDirectory: new URL("..", import.meta.url).pathname,
  });
  const expected = renderClaudeCoverageDocument({ fixture, sections });
  const current = await fs.readFile(
    new URL("../docs/claude-code-2.1.236-coverage.md", import.meta.url),
    "utf8",
  );
  assert.equal(current, expected);
  assert.match(current, /\| `--bg` \| Implemented \| Native background agents \|/);
  assert.match(current, /\| `agents` \| Implemented \| Native background agents \|/);
});

function allCoverage() {
  return [
    CLAUDE_OPTION_COVERAGE,
    CLAUDE_COMMAND_COVERAGE,
    CLAUDE_TOP_LEVEL_EVENT_COVERAGE,
    CLAUDE_STREAM_EVENT_COVERAGE,
    CLAUDE_SYSTEM_EVENT_COVERAGE,
    CLAUDE_CONTROL_REQUEST_COVERAGE,
    CLAUDE_DIALOG_KIND_COVERAGE,
    CLAUDE_PERMISSION_MODE_COVERAGE,
    CLAUDE_EFFORT_LEVEL_COVERAGE,
  ];
}

function methods(entries) {
  return sorted(entries.map((entry) => entry.method));
}

function sorted(entries) {
  return [...entries].sort((left, right) => left.localeCompare(right, "en"));
}
