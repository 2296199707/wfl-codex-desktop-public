import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGitStatusPorcelain,
  validateGitBranchName,
  validateGitCommitMessage,
  validateGitRelativePath,
  validateUnifiedPatchPaths,
} from "../lib/git-workspace.mjs";

test("parses porcelain v2 status without losing paths containing spaces", () => {
  const snapshot = parseGitStatusPorcelain([
    "# branch.oid abc123",
    "# branch.head feature/review",
    "# branch.upstream origin/feature/review",
    "# branch.ab +2 -1",
    "1 M. N... 100644 100644 100644 abc def src/staged file.js",
    "1 .M N... 100644 100644 100644 abc def src/dirty.js",
    "? notes/new file.md",
    "",
  ].join("\0"));
  assert.equal(snapshot.branch, "feature/review");
  assert.equal(snapshot.ahead, 2);
  assert.equal(snapshot.behind, 1);
  assert.deepEqual(snapshot.staged.map((file) => file.path), ["src/staged file.js"]);
  assert.deepEqual(snapshot.unstaged.map((file) => file.path), ["src/dirty.js"]);
  assert.deepEqual(snapshot.untracked.map((file) => file.path), ["notes/new file.md"]);
});

test("validates Git paths, branches, messages, and single-file patches", () => {
  assert.equal(validateGitRelativePath("src/app.js"), "src/app.js");
  assert.throws(() => validateGitRelativePath("../secret"), /无效/);
  assert.equal(validateGitBranchName("feature/review-ui"), "feature/review-ui");
  assert.throws(() => validateGitBranchName("bad branch"), /无效/);
  assert.equal(validateGitCommitMessage("feat: add review drawer"), "feat: add review drawer");
  assert.throws(() => validateGitCommitMessage(""), /无效/);
  const patch = "diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-old\n+new\n";
  assert.equal(validateUnifiedPatchPaths(patch, "src/app.js"), patch);
  assert.throws(() => validateUnifiedPatchPaths(patch, "src/other.js"), /超出/);
  const smuggled = `${patch}diff --git a/src/secret.js b/src/secret.js\n`;
  assert.throws(() => validateUnifiedPatchPaths(smuggled, "src/app.js"), /超出/);
});
