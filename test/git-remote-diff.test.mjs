import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGitNumstat,
  buildGitRemoteDiffFiles,
  gitRemoteRelation,
  nativeGitDiffIsSafe,
  parseGitNameStatus,
  parseGitRemoteRefs,
  redactGitDiffSecrets,
  REMOTE_GIT_REF_LIMIT,
  selectGitRemoteRef,
} from "../lib/git-remote-diff.mjs";

test("remote Git refs are bounded to server-discovered remotes and exact branches", () => {
  const refs = parseGitRemoteRefs([
    "refs/remotes/origin/main", "a".repeat(40), "100",
    "refs/remotes/origin/feature/mobile", "b".repeat(40), "90",
    "refs/remotes/origin/HEAD", "a".repeat(40), "100",
    "refs/remotes/unknown/private", "c".repeat(40), "80",
    "refs/heads/main", "d".repeat(40), "70",
    "",
  ].join("\0"), ["origin"]);

  assert.deepEqual(refs.map((entry) => [entry.remote, entry.branch, entry.updatedAt]), [
    ["origin", "feature/mobile", 90],
    ["origin", "main", 100],
  ]);
  assert.equal(selectGitRemoteRef(refs, { upstream: "origin/main" }).branch, "main");
  assert.equal(selectGitRemoteRef(refs, {
    remote: "origin",
    branch: "feature/mobile",
  }).ref, "origin/feature/mobile");
  assert.throws(
    () => selectGitRemoteRef(refs, { remote: "origin", branch: "../../secret" }),
    /远端分支无效/,
  );
  assert.throws(
    () => selectGitRemoteRef(refs, { remote: "origin", branch: "missing" }),
    /不存在/,
  );

  const bounded = parseGitRemoteRefs(
    Array.from({ length: REMOTE_GIT_REF_LIMIT + 20 }, (_, index) => [
      `refs/remotes/origin/branch-${String(index).padStart(4, "0")}`,
      "d".repeat(40),
      String(index),
    ]).flat().join("\0\n"),
    ["origin"],
  );
  assert.equal(bounded.length, REMOTE_GIT_REF_LIMIT);
});

test("remote Git file metadata handles rename, binary, conflict, and bounded counts", () => {
  const metadata = parseGitNameStatus([
    "M", "src/app.js",
    "R100", "old.txt", "new.txt",
    "U", "conflict.txt",
    "A", "image.png",
    "",
  ].join("\0"));
  applyGitNumstat(metadata.files, [
    "4\t2\tsrc/app.js",
    "1\t1\t", "old.txt", "new.txt",
    "3\t3\tconflict.txt",
    "-\t-\timage.png",
    "",
  ].join("\0"));

  assert.deepEqual(metadata.files.map((file) => ({
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    conflict: file.conflict,
    binary: file.binary,
    additions: file.additions,
    deletions: file.deletions,
  })), [{
    path: "src/app.js",
    oldPath: null,
    status: "M",
    conflict: false,
    binary: false,
    additions: 4,
    deletions: 2,
  }, {
    path: "new.txt",
    oldPath: "old.txt",
    status: "R",
    conflict: false,
    binary: false,
    additions: 1,
    deletions: 1,
  }, {
    path: "conflict.txt",
    oldPath: null,
    status: "U",
    conflict: true,
    binary: false,
    additions: 3,
    deletions: 3,
  }, {
    path: "image.png",
    oldPath: null,
    status: "A",
    conflict: false,
    binary: true,
    additions: null,
    deletions: null,
  }]);
  assert.equal(nativeGitDiffIsSafe(metadata.files), true);
  assert.equal(nativeGitDiffIsSafe([{ additions: 50_001, deletions: 0 }]), false);
});

test("remote Git diffs redact credentials and omit binary contents before browser delivery", () => {
  const raw = [
    "diff --git a/src/app.js b/src/app.js",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -1 +1 @@",
    "-token=ghp_abcdefghijklmnopqrstuvwxyz123456",
    "+api_key=sk-proj-abcdefghijklmnopqrstuvwxyz",
    "diff --git a/image.png b/image.png",
    "new file mode 100644",
    "Binary files /dev/null and b/image.png differ",
    "",
  ].join("\n");
  const metadata = {
    files: [{
      path: "src/app.js",
      status: "M",
      binary: false,
      additions: 1,
      deletions: 1,
    }, {
      path: "image.png",
      status: "A",
      binary: true,
      additions: null,
      deletions: null,
    }],
    truncated: false,
  };
  const result = buildGitRemoteDiffFiles(raw, metadata);

  assert.equal(result.files[0].truncated, false);
  assert.equal((result.files[0].diff.match(/\[已隐藏\]/g) || []).length, 2);
  assert.doesNotMatch(JSON.stringify(result), /ghp_|sk-proj/);
  assert.equal(result.files[1].binary, true);
  assert.equal(result.files[1].diff, "");
  assert.equal(result.redactions, 2);

  const bounded = buildGitRemoteDiffFiles(raw, metadata, { maxTotalBytes: 80, maxFileBytes: 80 });
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.files[0].diff, "utf8") <= 80);
});

test("remote Git status relations and URL-shaped credentials are sanitized", () => {
  assert.equal(gitRemoteRelation(0, 0), "synced");
  assert.equal(gitRemoteRelation(2, 0), "ahead");
  assert.equal(gitRemoteRelation(0, 3), "behind");
  assert.equal(gitRemoteRelation(2, 3), "diverged");
  const sanitized = redactGitDiffSecrets("+url=https://user:password@example.test/repo.git");
  assert.equal(sanitized.value, "+url=https://[已隐藏认证]@example.test/repo.git");
  assert.equal(sanitized.redactions, 1);

  const structured = redactGitDiffSecrets([
    '+"apiKey": "quoted secret with spaces"',
    "+aws=AKIA1234567890ABCDEF",
    "+db=postgres://user:password@example.test/db",
    "+-----BEGIN OPENSSH PRIVATE KEY-----",
    "+private-material",
    "+-----END OPENSSH PRIVATE KEY-----",
  ].join("\n"));
  assert.doesNotMatch(structured.value, /quoted secret|AKIA|password|private-material/);
  assert.match(structured.value, /已隐藏私钥/);
  assert.ok(structured.redactions >= 4);
});
