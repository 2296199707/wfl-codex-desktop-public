import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  RescueCredentialPublisher,
  createRescueCredentialMirror,
  loadRescueCredentialMirror,
  publishRescueCredentialMirror,
  synchronizeRescueAuth,
} from "../lib/rescue-credential-mirror.mjs";
import { createAuthRecord, loadAuth, verifyAuthCredentials } from "../lib/auth.mjs";

test("rescue credential mirror initializes once and updates with a monotonic generation", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-rescue-credential-mirror-");
  const mirrorPath = path.join(directory, "rescue-credentials", "current.json");
  const authPath = path.join(directory, "rescue-auth", "auth.json");
  const firstPassword = "owner-password-1234";
  const secondPassword = "replacement-password-1234";
  try {
    const first = createAuthRecord("owner", firstPassword);
    const firstStatus = await publishRescueCredentialMirror({
      mirrorPath,
      source: {
        userId: "u-1111111111111111",
        username: "owner",
        role: "owner",
        status: "active",
        password: first,
        sourceRevision: 1,
      },
    });
    assert.equal(firstStatus.state, "ready");
    assert.equal(firstStatus.generation, 1);
    assert.equal((await fs.stat(mirrorPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(mirrorPath))).mode & 0o777, 0o700);

    const firstMirror = await loadRescueCredentialMirror(mirrorPath);
    assert.equal(firstMirror.generation, 1);
    assert.equal(verifyAuthCredentials("owner", firstPassword, firstMirror.password), true);
    assert.doesNotMatch(await fs.readFile(mirrorPath, "utf8"), new RegExp(firstPassword));

    await synchronizeRescueAuth({ mirrorPath, authPath });
    assert.equal((await fs.stat(authPath)).mode & 0o777, 0o600);
    assert.equal(await loadAuth(authPath).then((record) => verifyAuthCredentials("owner", firstPassword, record)), true);

    const second = createAuthRecord("owner", secondPassword);
    const secondStatus = await publishRescueCredentialMirror({
      mirrorPath,
      source: {
        userId: "u-1111111111111111",
        username: "owner",
        role: "owner",
        status: "active",
        password: second,
        sourceRevision: 2,
      },
    });
    assert.equal(secondStatus.generation, 2);
    await synchronizeRescueAuth({ mirrorPath, authPath });
    const current = await loadAuth(authPath);
    assert.equal(verifyAuthCredentials("owner", firstPassword, current), false);
    assert.equal(verifyAuthCredentials("owner", secondPassword, current), true);

    const unchanged = await publishRescueCredentialMirror({
      mirrorPath,
      source: {
        userId: "u-1111111111111111",
        username: "owner",
        role: "owner",
        status: "active",
        password: second,
        sourceRevision: 2,
      },
    });
    assert.equal(unchanged.generation, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rescue credential publishing persists a pending state and retries transient failures", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-rescue-credential-retry-");
  const mirrorPath = path.join(directory, "rescue-credentials", "current.json");
  let attempts = 0;
  const publisher = new RescueCredentialPublisher({
    mirrorPath,
    retryDelayMs: 1_000,
    loadSource: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary source unavailable");
      return {
        userId: "u-3333333333333333",
        username: "owner",
        role: "owner",
        status: "active",
        password: createAuthRecord("owner", "retry-owner-password-1234"),
        sourceRevision: 1,
      };
    },
  });
  try {
    await publisher.initialize();
    assert.equal(publisher.lastStatus.state, "pending");
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    assert.equal(publisher.lastStatus.state, "ready");
    assert.equal(attempts, 2);
  } finally {
    publisher.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rescue credential publishing cannot overwrite a newer source with an older revision", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-rescue-credential-stale-");
  const mirrorPath = path.join(directory, "rescue-credentials", "current.json");
  try {
    const currentPassword = createAuthRecord("owner", "current-owner-password-1234");
    const stalePassword = createAuthRecord("owner", "stale-owner-password-1234");
    await publishRescueCredentialMirror({
      mirrorPath,
      source: {
        userId: "u-2222222222222222",
        username: "owner",
        role: "owner",
        status: "active",
        password: currentPassword,
        sourceRevision: 20,
      },
    });
    const staleStatus = await publishRescueCredentialMirror({
      mirrorPath,
      source: {
        userId: "u-2222222222222222",
        username: "owner",
        role: "owner",
        status: "active",
        password: stalePassword,
        sourceRevision: 19,
      },
    });
    assert.equal(staleStatus.state, "stale");
    assert.equal(staleStatus.generation, 1);
    assert.equal((await loadRescueCredentialMirror(mirrorPath)).sourceRevision, 20);
    assert.equal(
      verifyAuthCredentials("owner", "current-owner-password-1234", (await loadRescueCredentialMirror(mirrorPath)).password),
      true,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rescue credential mirror rejects non-owner projections", () => {
  assert.throws(
    () => createRescueCredentialMirror({
      userId: "u-1111111111111111",
      username: "member",
      role: "admin",
      status: "active",
      password: createAuthRecord("member", "member-password-1234"),
      generation: 1,
    }),
    /Only the main owner can be mirrored to rescue/,
  );
});
