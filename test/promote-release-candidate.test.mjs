import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ReleaseCandidateStore } from "../lib/release-candidate-store.mjs";
import { ReleaseStatusStore } from "../lib/release-status.mjs";

const execFileAsync = promisify(execFile);
const promotionScript = path.resolve("scripts/promote-release-candidate.mjs");

test("candidate promotion atomically publishes the tag and stable branch", { timeout: 20_000 }, async () => {
  const fixture = await candidateFixture();
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      promotionScript,
      "--candidate-id",
      fixture.candidate.id,
      "--promoted-by",
      "owner",
    ], {
      cwd: fixture.sourceDirectory,
      env: fixture.environment,
    });

    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.commitSha, fixture.commitSha);
    assert.equal(await git(fixture.remoteDirectory, ["rev-parse", "refs/heads/stable"]), fixture.commitSha);
    assert.equal(await git(fixture.remoteDirectory, ["rev-parse", "refs/tags/v0.37.7^{}"]), fixture.commitSha);

    const stored = await fixture.candidateStore.current();
    assert.equal(stored.phase, "stable");
    assert.equal(stored.promotedBy, "owner");
    assert.ok(stored.completedAt);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("candidate promotion refuses a non-fast-forward stable update", { timeout: 20_000 }, async () => {
  const fixture = await candidateFixture({ divergentStable: true });
  try {
    await assert.rejects(execFileAsync(process.execPath, [
      promotionScript,
      "--candidate-id",
      fixture.candidate.id,
      "--promoted-by",
      "owner",
    ], {
      cwd: fixture.sourceDirectory,
      env: fixture.environment,
    }), /cannot fast-forward the stable branch/);

    assert.equal(await git(fixture.remoteDirectory, ["rev-parse", "refs/heads/stable"]), fixture.stableCommit);
    await assert.rejects(git(fixture.remoteDirectory, ["rev-parse", "refs/tags/v0.37.7"]));
    await assert.rejects(git(fixture.sourceDirectory, ["rev-parse", "refs/tags/v0.37.7"]));

    const stored = await fixture.candidateStore.current();
    assert.equal(stored.phase, "awaiting-approval");
    assert.match(stored.error, /cannot fast-forward the stable branch/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

async function candidateFixture({ divergentStable = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-candidate-promotion-"));
  const sourceDirectory = path.join(root, "source");
  const remoteDirectory = path.join(root, "origin.git");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  await fs.mkdir(sourceDirectory);
  await git(root, ["init", "--bare", remoteDirectory]);
  await git(sourceDirectory, ["init", "--initial-branch=main"]);
  await git(sourceDirectory, ["config", "user.name", "Candidate Test"]);
  await git(sourceDirectory, ["config", "user.email", "candidate@example.invalid"]);
  await fs.writeFile(path.join(sourceDirectory, "release.txt"), "candidate\n");
  await git(sourceDirectory, ["add", "release.txt"]);
  await git(sourceDirectory, ["commit", "--message", "candidate"]);
  await git(sourceDirectory, ["remote", "add", "origin", remoteDirectory]);
  await git(sourceDirectory, ["push", "--set-upstream", "origin", "main"]);

  const commitSha = await git(sourceDirectory, ["rev-parse", "HEAD"]);
  const treeHash = await git(sourceDirectory, ["rev-parse", "HEAD^{tree}"]);
  let stableCommit = null;
  if (divergentStable) {
    await git(sourceDirectory, ["switch", "--orphan", "divergent-stable"]);
    await fs.rm(path.join(sourceDirectory, "release.txt"), { force: true });
    await fs.writeFile(path.join(sourceDirectory, "stable.txt"), "existing stable\n");
    await git(sourceDirectory, ["add", "--all"]);
    await git(sourceDirectory, ["commit", "--message", "divergent stable"]);
    stableCommit = await git(sourceDirectory, ["rev-parse", "HEAD"]);
    await git(sourceDirectory, ["push", "origin", "HEAD:refs/heads/stable"]);
    await git(sourceDirectory, ["switch", "main"]);
  }
  assert.equal(await git(sourceDirectory, ["rev-parse", "@{upstream}"]), commitSha);

  const now = Date.now();
  const candidateStore = new ReleaseCandidateStore(stateDirectory);
  const candidate = await candidateStore.create({
    id: `candidate-v0.37.7-${commitSha.slice(0, 12)}-${now}`,
    version: "0.37.7",
    commitSha,
    treeHash,
    detail: "ready",
  });
  await candidateStore.update(candidate.id, {
    phase: "promoting",
    actualValidationConfirmed: true,
    actualValidationConfirmedAt: now,
    actualValidationConfirmedBy: "owner",
    checks: {
      fullSuite: { status: "passed", completedAt: now },
      browser: { status: "passed", completedAt: now },
      deployment: { status: "passed", completedAt: now },
    },
  }, { expectedPhases: ["preparing"] });
  await new ReleaseStatusStore(stateDirectory).write({
    status: "completed",
    phase: "completed",
    version: "0.37.7",
    candidateId: candidate.id,
    commitSha,
    treeHash,
    completedAt: now,
  });

  return {
    root,
    sourceDirectory,
    remoteDirectory,
    candidateStore,
    candidate,
    commitSha,
    stableCommit,
    environment: {
      ...process.env,
      CODEX_DESKTOP_SOURCE_DIR: sourceDirectory,
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
    },
  };
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
