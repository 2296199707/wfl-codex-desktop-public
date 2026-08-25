import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppUpdateStatusStore } from "../lib/app-update-status.mjs";
import {
  compareReleaseVersions,
  compareStableVersions,
  isNewerStableVersion,
  parseRemoteStableChannel,
  parseRemoteTagRefs,
  releaseVersionRelation,
  selectLatestStableTag,
} from "../lib/remote-release.mjs";
import { ReleaseDrainStore } from "../lib/release-drain.mjs";
import { repairUpdateSource } from "../lib/update-source-repair.mjs";
import { execFileSync } from "node:child_process";

test("remote release selection accepts only the newest stable semantic tag", () => {
  const refs = parseRemoteTagRefs([
    "aaa refs/tags/v0.11.3",
    "bbb refs/tags/v0.12.0-rc.1",
    "ccc refs/tags/not-a-version",
    "ddd refs/tags/v0.12.0",
  ].join("\n"));
  assert.deepEqual(selectLatestStableTag(refs), { tag: "v0.12.0", version: "0.12.0" });
  assert.ok(compareStableVersions("1.0.0", "0.99.99") > 0);
  assert.equal(isNewerStableVersion("0.12.0", "0.11.3"), true);
  assert.equal(isNewerStableVersion("0.11.2", "0.11.3"), false);
  assert.equal(isNewerStableVersion("0.44.0", "0.43.29-beta"), true);
  assert.equal(isNewerStableVersion("0.43.0", "0.43.29-beta"), false);
  assert.equal(compareReleaseVersions("0.43.29", "0.43.29-beta"), 1);
  assert.equal(releaseVersionRelation("0.43.0", "0.43.29-beta"), "behind");
});

test("stable channel requires the branch and newest formal tag to identify the same commit", () => {
  const stableCommit = "a".repeat(40);
  const tagObject = "b".repeat(40);
  const channel = parseRemoteStableChannel([
    `${stableCommit}\trefs/heads/stable`,
    `${"c".repeat(40)}\trefs/tags/v0.37.6`,
    `${tagObject}\trefs/tags/v0.37.7`,
    `${stableCommit}\trefs/tags/v0.37.7^{}`,
    `${"d".repeat(40)}\trefs/tags/v0.37.8-rc.1`,
  ].join("\n"));
  assert.deepEqual(channel, {
    tag: "v0.37.7",
    version: "0.37.7",
    commitSha: stableCommit,
    stableCommit,
  });
  assert.equal(parseRemoteStableChannel([
    `${"e".repeat(40)}\trefs/heads/stable`,
    `${stableCommit}\trefs/tags/v0.37.7`,
  ].join("\n")), null);
});

test("app update status stores bounded public progress without command output", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "app-update-status-"));
  const store = new AppUpdateStatusStore(directory, { now: () => 1_700_000_000_000 });
  try {
    const written = await store.write({
      status: "running",
      phase: "preparing",
      currentVersion: "0.11.3",
      runningVersion: "0.11.2",
      sourceVersion: "0.11.3",
      targetVersion: "0.12.0",
      detail: `Installing\n${"x".repeat(300)}`,
      error: "private\noutput",
    });
    assert.equal(written.detail.includes("\n"), false);
    assert.equal(written.detail.length, 240);
    assert.equal(written.error, "private output");
    assert.equal(written.runningVersion, "0.11.2");
    assert.equal(written.sourceVersion, "0.11.3");
    assert.equal((await fs.stat(path.join(directory, "app-update-status.json"))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("source repair quarantines only known Flutter generated files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "app-source-repair-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "test"], { cwd: directory });
    await fs.mkdir(path.join(directory, "apps", "mobile"), { recursive: true });
    await fs.writeFile(path.join(directory, ".gitignore"), ".runtime/\n");
    await fs.writeFile(path.join(directory, "apps", "mobile", "pubspec.yaml"), "name: test\n");
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: directory });
    await fs.mkdir(path.join(directory, "apps", "mobile", "android", "app"), { recursive: true });
    await fs.writeFile(path.join(directory, "apps", "mobile", "android", "app", "generated.txt"), "generated");
    await fs.writeFile(path.join(directory, "apps", "mobile", ".gitignore"), "generated\n");
    await fs.writeFile(path.join(directory, "apps", "mobile", "pubspec.lock"), "generated");
    const result = await repairUpdateSource({
      sourceDirectory: directory,
      runtimeDirectory: path.join(directory, ".runtime"),
      apply: true,
    });
    assert.equal(result.status, "repaired");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: directory, encoding: "utf8" }).trim(), "");
    await fs.access(path.join(result.quarantinePath, "manifest.json"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("release drain locks expire and can only be cleared by their owner", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "release-drain-"));
  let now = 1_700_000_000_000;
  const store = new ReleaseDrainStore(directory, { now: () => now });
  try {
    const lock = await store.begin("0.12.0", { ttlMs: 1_000 });
    assert.equal((await store.read()).active, true);
    assert.equal(await store.clear("not-the-owner"), false);
    now += 1_001;
    assert.equal((await store.read()).active, false);
    assert.equal(await store.clear(lock.token), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
