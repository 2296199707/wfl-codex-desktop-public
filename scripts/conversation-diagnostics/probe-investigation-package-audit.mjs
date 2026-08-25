import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const diagnosticsDir = path.join(projectDir, "scripts", "conversation-diagnostics");
const traceabilityPath = path.join(
  projectDir,
  "docs",
  "conversation-investigation-traceability-0.39.48.zh-CN.md",
);
const matrixPath = path.join(
  projectDir,
  "docs",
  "conversation-failure-matrix-0.39.48.zh-CN.md",
);
const requiredMarkdown = [
  "docs/conversation-architecture-investigation-0.39.48.zh-CN.md",
  "docs/conversation-failure-matrix-0.39.48.zh-CN.md",
  "docs/conversation-investigation-traceability-0.39.48.zh-CN.md",
  "docs/conversation-decision-scorecard-0.39.48.zh-CN.md",
  "docs/adr/0001-reliable-conversation-state.zh-CN.md",
  "docs/conversation-mobile-field-protocol.zh-CN.md",
  "docs/conversation-shadow-recorder-stage0.zh-CN.md",
  "scripts/conversation-diagnostics/README.md",
];
const expectedStatusCounts = {
  V: 24,
  P: 1,
  "V/D": 23,
  "D/V": 3,
  "P/X": 3,
  "N/A": 1,
  R: 1,
};
const expectedMatrixSizes = {
  M: 25,
  C: 18,
  S: 14,
  R: 9,
  G: 8,
};

const read = (relativePath) => fs.readFileSync(path.join(projectDir, relativePath), "utf8");
const run = (command, args) => execFileSync(command, args, {
  cwd: projectDir,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const auditProgress = process.env.CODEX_DESKTOP_INVESTIGATION_AUDIT_PROGRESS === "1";
const mark = (stage) => {
  if (auditProgress) process.stderr.write(`[audit] ${stage}\n`);
};

function splitMarkdownRow(line) {
  const cells = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && line[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
}

function assertCleanMarkdown(relativePath) {
  const absolutePath = path.join(projectDir, relativePath);
  const bytes = fs.readFileSync(absolutePath);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.split("\n");
  let fence = null;
  let tableColumns = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    assert.doesNotMatch(line, /[ \t]+$/, `${relativePath}:${lineNumber} has trailing whitespace`);
    assert.doesNotMatch(
      line,
      /^(?:<{7}|={7}|>{7})(?: |$)/,
      `${relativePath}:${lineNumber} has a conflict marker`,
    );
    for (const character of line) {
      const code = character.charCodeAt(0);
      assert.ok(
        code >= 32 || code === 9,
        `${relativePath}:${lineNumber} has control character ${code}`,
      );
      assert.notEqual(code, 127, `${relativePath}:${lineNumber} has DEL`);
    }

    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const length = fenceMatch[1].length;
      if (!fence) fence = { marker, length, lineNumber };
      else if (fence.marker === marker && length >= fence.length) fence = null;
    }

    if (line.trim().startsWith("|")) {
      const columns = splitMarkdownRow(line).length;
      if (tableColumns === null) tableColumns = columns;
      assert.equal(
        columns,
        tableColumns,
        `${relativePath}:${lineNumber} has ${columns} table columns; expected ${tableColumns}`,
      );
    } else {
      tableColumns = null;
    }
  }
  assert.equal(fence, null, `${relativePath} has an unclosed fence from line ${fence?.lineNumber}`);

  for (const match of text.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    target = target.split("#", 1)[0];
    if (!target) continue;
    const resolved = path.resolve(path.dirname(absolutePath), decodeURIComponent(target));
    assert.ok(fs.existsSync(resolved), `${relativePath} has missing local link ${match[1]}`);
  }
}

function parseTraceability() {
  const rows = fs.readFileSync(traceabilityPath, "utf8")
    .split("\n")
    .filter((line) => /^\| \d{2} \|/.test(line))
    .map((line) => splitMarkdownRow(line));
  assert.equal(rows.length, 56, "traceability table must contain 56 Goal rows");

  const statuses = {};
  rows.forEach((cells, index) => {
    assert.equal(cells.length, 5, `Goal ${index + 1} must have five table columns`);
    const [number, requirement, status, evidence, remaining] = cells;
    assert.equal(number, String(index + 1).padStart(2, "0"), "Goal numbering must be contiguous");
    assert.ok(requirement, `Goal ${number} must name its requirement`);
    assert.ok(evidence, `Goal ${number} must cite evidence`);
    assert.ok(remaining, `Goal ${number} must state its remaining gate`);
    assert.ok(status in expectedStatusCounts, `Goal ${number} has unsupported status ${status}`);
    statuses[status] = (statuses[status] || 0) + 1;
  });
  assert.deepEqual(statuses, expectedStatusCounts);

  const byNumber = Object.fromEntries(rows.map((cells) => [cells[0], {
    requirement: cells[1],
    status: cells[2],
    evidence: cells[3],
    remaining: cells[4],
  }]));
  assert.equal(byNumber["02"].status, "V");
  assert.equal(byNumber["06"].status, "P");
  assert.equal(byNumber["07"].status, "V");
  assert.equal(byNumber["15"].status, "N/A");
  assert.equal(byNumber["16"].status, "P/X");
  assert.equal(byNumber["27"].status, "P/X");
  assert.equal(byNumber["45"].status, "P/X");
  assert.equal(byNumber["56"].status, "R");
  return { rows, byNumber, statuses };
}

function assertMatrixCoverage() {
  const text = fs.readFileSync(matrixPath, "utf8");
  const result = {};
  for (const [prefix, size] of Object.entries(expectedMatrixSizes)) {
    const actual = [...text.matchAll(new RegExp(String.raw`^\| (${prefix}\d{2}) \|`, "gm"))]
      .map((match) => match[1]);
    const expected = Array.from(
      { length: size },
      (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`,
    );
    assert.deepEqual(actual, expected, `${prefix} matrix IDs must be unique and contiguous`);
    result[prefix] = actual.length;
  }
  return result;
}

function assertSemanticCoverage() {
  const report = read("docs/conversation-architecture-investigation-0.39.48.zh-CN.md");
  const scorecard = read("docs/conversation-decision-scorecard-0.39.48.zh-CN.md");
  const adr = read("docs/adr/0001-reliable-conversation-state.zh-CN.md");
  const fieldProtocol = read("docs/conversation-mobile-field-protocol.zh-CN.md");
  const recorder = read("docs/conversation-shadow-recorder-stage0.zh-CN.md");
  const diagnosticReadme = read("scripts/conversation-diagnostics/README.md");
  const normalizedReadme = diagnosticReadme.replace(/\s+/g, " ");

  assert.match(report, /### P0/);
  assert.match(report, /### P1/);
  assert.match(scorecard, /选择方案 B：保留当前受支持 transport 边界/);
  assert.match(adr, /experimental and unsupported/);
  assert.match(adr, /等待所有者接受/);

  const fieldIds = [...fieldProtocol.matchAll(/^\| (F\d{2}) \|/gm)]
    .map((match) => match[1]);
  assert.deepEqual(
    fieldIds,
    Array.from({ length: 11 }, (_, index) => `F${String(index + 1).padStart(2, "0")}`),
  );
  assert.match(fieldProtocol, /每个场景独立新建 run ID，至少重复 3 次/);
  assert.match(fieldProtocol, /owner attestation/);
  assert.match(fieldProtocol, /尚无真实设备结果/);

  assert.match(recorder, /状态：调查设计；尚未接入生产代码/);
  assert.match(recorder, /默认关闭/);
  assert.match(recorder, /所有者明确授权/);
  assert.match(recorder, /备用窗口 `1\.0 \/ 4321`/);

  const probes = fs.readdirSync(diagnosticsDir)
    .filter((name) => /^probe-.*\.mjs$/.test(name))
    .sort();
  for (const probe of probes) {
    assert.ok(diagnosticReadme.includes(probe), `${probe} is missing from diagnostics README`);
  }
  for (const phrase of [
    "not part of the production request path",
    "must not be added to formal installation or update checks",
    "never connect to the frozen rescue window on port `4321`",
  ]) {
    assert.ok(normalizedReadme.includes(phrase), `diagnostic boundary missing: ${phrase}`);
  }
  return {
    recommendation: "B",
    p0AndP1Classified: true,
    fieldScenarios: fieldIds.length,
    fieldRunsRequired: 33,
    recorderActivated: false,
    ownerAcceptanceRequired: true,
    documentedProbes: probes.length,
  };
}

function inspectWorkspaceBaseline(goal01) {
  mark("baseline:versions");
  assert.equal(read("VERSION").trim(), "0.39.48");
  assert.equal(JSON.parse(read("package.json")).version, "0.39.48");
  assert.equal(run("git", ["rev-parse", "HEAD"]).trim(), "accb59f1d2a53c9a437dd41a9955f3ab78d5b3bf");
  assert.match(run("codex", ["--version"]).trim(), /^codex-cli 0\.146\.0(?:\s|$)/);
  assert.equal(fs.existsSync(path.join(projectDir, "backups", "README.md")), false);
  assert.equal(run("git", ["ls-files", "--", "backups/README.md"]).trim(), "");

  mark("baseline:git-status");
  const porcelainRows = run("git", ["status", "--porcelain=v1"]).trimEnd().split("\n")
    .filter(Boolean);
  const untracked = porcelainRows.filter((line) => line.startsWith("??")).length;
  const tracked = porcelainRows.length - untracked;
  mark("baseline:git-numstat");
  const numstatRows = run("git", ["diff", "--numstat"]).trimEnd().split("\n").filter(Boolean);
  let additions = 0;
  let deletions = 0;
  for (const row of numstatRows) {
    const [added, deleted] = row.split("\t", 2);
    assert.match(added, /^\d+$/, `binary tracked diff is outside the frozen text baseline: ${row}`);
    assert.match(deleted, /^\d+$/, `binary tracked diff is outside the frozen text baseline: ${row}`);
    additions += Number(added);
    deletions += Number(deleted);
  }
  assert.equal(numstatRows.length, tracked, "tracked porcelain and numstat file counts differ");

  const expectedPhrase = `当前 ${porcelainRows.length} 项 porcelain（${tracked} tracked 修改、`
    + `${untracked} untracked 路径）和 tracked diff ${additions.toLocaleString("en-US")}+/`
    + `${deletions.toLocaleString("en-US")}- 已记录`;
  assert.ok(goal01.evidence.includes(expectedPhrase), "Goal 01 frozen worktree counts are stale");
  return {
    head: "accb59f1d2a53c9a437dd41a9955f3ab78d5b3bf",
    version: "0.39.48-beta",
    codex: "0.146.0",
    porcelain: porcelainRows.length,
    tracked,
    untracked,
    trackedDiff: { files: numstatRows.length, additions, deletions },
    backupsReadme: "absent-and-untracked",
  };
}

function assertExecutionBoundaries() {
  mark("boundaries:sources");
  const quickCheck = read("scripts/quick-update-check.mjs");
  const appUpdate = read("scripts/update-app.mjs");
  const release = read("scripts/release.mjs");
  const installer = read("scripts/install-server.sh");
  assert.doesNotMatch(
    quickCheck,
    /rescue/i,
    "main-site quick update check must not inspect or request the frozen rescue window",
  );
  assert.match(
    appUpdate,
    /CODEX_DESKTOP_QUICK_CHECK_OFFLINE:\s*"1"/,
    "ordinary app update precheck must be offline",
  );
  assert.match(
    release,
    /CODEX_DESKTOP_QUICK_CHECK_OFFLINE:\s*"1"/,
    "ordinary release precheck must be offline",
  );
  assert.match(
    installer,
    /CODEX_DESKTOP_QUICK_CHECK_OFFLINE=1 npm run update:quick-check/,
    "ordinary installation precheck must be offline",
  );
  assert.match(
    release,
    /install-service-units\.mjs"\), "--main-only"/,
    "main-site release must install main units only",
  );
  assert.match(
    release,
    /const fullReleaseCheck = candidateMode\s*\|\|\s*process\.env\.CODEX_DESKTOP_FULL_RELEASE_CHECK === "1"/,
    "full suites must require candidate mode or an explicit primary-server override",
  );

  const executableIntegrationFiles = [
    "package.json",
    "install.sh",
    ...fs.readdirSync(path.join(projectDir, "scripts"))
      .filter((name) => /\.(?:mjs|sh)$/.test(name))
      .map((name) => path.join("scripts", name)),
  ];
  mark("boundaries:integration");
  const integrationReferences = executableIntegrationFiles.filter((relativePath) => {
    const text = read(relativePath);
    return text.includes("scripts/conversation-diagnostics/")
      || text.includes("probe-investigation-package-audit.mjs");
  });
  assert.deepEqual(
    integrationReferences,
    [],
    "investigation probes must not enter install/update/deploy/release execution paths",
  );

  const diagnosticScripts = fs.readdirSync(diagnosticsDir)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  mark("boundaries:diagnostics");
  for (const name of diagnosticScripts) {
    const text = fs.readFileSync(path.join(diagnosticsDir, name), "utf8");
    assert.doesNotMatch(
      text,
      /(?:https?|wss?):\/\/[^"'`\s]*(?:4321|\/rescue\/)/i,
      `${name} contains a frozen rescue runtime URL`,
    );
  }
  return {
    quickCheckRescueReferences: 0,
    ordinaryUpdateOffline: true,
    ordinaryReleaseOffline: true,
    installerPrecheckOffline: true,
    releaseInstallsMainUnitsOnly: true,
    formalExecutionReferences: 0,
    diagnosticScripts: diagnosticScripts.length,
    syntaxChecksDelegated: true,
  };
}

mark("markdown:start");
for (const relativePath of requiredMarkdown) {
  assert.ok(fs.statSync(path.join(projectDir, relativePath)).isFile());
  assertCleanMarkdown(relativePath);
}
mark("markdown:done");
mark("traceability:start");
const traceability = parseTraceability();
mark("traceability:done");
mark("matrix:start");
const matrix = assertMatrixCoverage();
mark("matrix:done");
mark("semantics:start");
const semantics = assertSemanticCoverage();
mark("semantics:done");
mark("baseline:start");
const baseline = inspectWorkspaceBaseline(traceability.byNumber["01"]);
mark("baseline:done");
mark("boundaries:start");
const boundaries = assertExecutionBoundaries();
mark("boundaries:done");

console.log(JSON.stringify({
  ok: true,
  packageAuditPassed: true,
  goalCompletionEligible: false,
  environment: {
    productionRequests: 0,
    frozenRescuePortTouched: false,
    productionRecorderActivated: false,
  },
  baseline,
  traceability: {
    goals: traceability.rows.length,
    statuses: traceability.statuses,
  },
  matrix,
  semantics,
  markdownArtifacts: requiredMarkdown.length,
  boundaries,
  remaining: {
    goal06: traceability.byNumber["06"].remaining,
    physicalEnvironment: [
      traceability.byNumber["16"].remaining,
      traceability.byNumber["27"].remaining,
      traceability.byNumber["45"].remaining,
    ],
    ownerDecision: traceability.byNumber["56"].remaining,
  },
}, null, 2));
