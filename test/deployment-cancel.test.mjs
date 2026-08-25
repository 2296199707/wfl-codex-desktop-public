import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeploymentCancelStore } from "../lib/deployment-cancel.mjs";

const releaseScript = await fs.readFile(new URL("../scripts/release.mjs", import.meta.url), "utf8");
const appUpdateScript = await fs.readFile(new URL("../scripts/update-app.mjs", import.meta.url), "utf8");

async function temporaryStore(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-deployment-cancel-"));
  return { directory, store: new DeploymentCancelStore(directory, options) };
}

test("atomically records a private cancellation marker", async (t) => {
  const { directory, store } = await temporaryStore({ now: () => 1_234_567 });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.equal(await store.getDecision("release-123"), null);
  assert.equal(await store.isCancellationRequested("release-123"), false);
  assert.deepEqual(await store.requestCancel("release-123"), {
    operationId: "release-123",
    decision: "cancel",
    decidedAt: 1_234_567,
    accepted: true,
    created: true,
  });
  assert.equal(await store.getDecision("release-123"), "cancel");
  assert.equal(await store.isCancellationRequested("release-123"), true);

  const marker = path.join(directory, "deployment-cancel", "release-123.json");
  assert.equal((await fs.stat(marker)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(marker))).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await fs.readFile(marker, "utf8")), {
    operationId: "release-123",
    decision: "cancel",
    decidedAt: 1_234_567,
  });
  assert.doesNotMatch(await fs.readFile(marker, "utf8"), /password|secret/i);
});

test("concurrent cancellation requests are idempotent", async (t) => {
  const { directory, store } = await temporaryStore();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const results = await Promise.all(
    Array.from({ length: 24 }, () => store.requestCancel("codex-update-987")),
  );
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results.every((result) => result.operationId === "codex-update-987"), true);
  assert.equal(results.every((result) => result.accepted && result.decision === "cancel"), true);
  assert.equal(await store.isCancellationRequested("codex-update-987"), true);
});

test("cancel and commit atomically resolve to one decision", async (t) => {
  const { directory, store } = await temporaryStore();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const attempts = Array.from({ length: 24 }, (_, index) => (
    index % 2 === 0 ? store.requestCancel("release-race") : store.commit("release-race")
  ));
  const results = await Promise.all(attempts);
  const decision = await store.getDecision("release-race");

  assert.ok(decision === "cancel" || decision === "commit");
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results.every((result) => result.decision === decision), true);
  assert.equal(results.every((result, index) => result.accepted === (
    index % 2 === 0 ? decision === "cancel" : decision === "commit"
  )), true);
  assert.equal(await store.isCancellationRequested("release-race"), decision === "cancel");
});

test("an existing commit rejects cancellation and remains committed", async (t) => {
  const { directory, store } = await temporaryStore({ now: () => 9_876 });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.deepEqual(await store.commit("release-committed"), {
    operationId: "release-committed",
    decision: "commit",
    decidedAt: 9_876,
    accepted: true,
    created: true,
  });
  const cancelled = await store.requestCancel("release-committed");
  assert.equal(cancelled.accepted, false);
  assert.equal(cancelled.decision, "commit");
  assert.equal(await store.getDecision("release-committed"), "commit");
  assert.equal(await store.isCancellationRequested("release-committed"), false);
});

test("an existing cancellation rejects commit and remains cancelled", async (t) => {
  const { directory, store } = await temporaryStore();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await store.requestCancel("release-cancelled");
  const committed = await store.commit("release-cancelled");
  assert.equal(committed.accepted, false);
  assert.equal(committed.decision, "cancel");
  assert.equal(await store.getDecision("release-cancelled"), "cancel");
});

test("clear cannot remove another operation cancellation", async (t) => {
  const { directory, store } = await temporaryStore();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await store.requestCancel("release-one");
  await store.requestCancel("release-two");
  assert.equal(await store.clear("release-three"), false);
  assert.equal(await store.clear("release-one"), true);
  assert.equal(await store.isCancellationRequested("release-one"), false);
  assert.equal(await store.isCancellationRequested("release-two"), true);
  assert.equal(await store.clear("release-one"), false);
});

test("a corrupt or incomplete marker fails closed", async (t) => {
  const { directory, store } = await temporaryStore();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const markerDirectory = path.join(directory, "deployment-cancel");
  await fs.mkdir(markerDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(markerDirectory, "rollback-corrupt.json"), "{", { mode: 0o600 });

  assert.equal(await store.getDecision("rollback-corrupt"), "cancel");
  assert.equal(await store.isCancellationRequested("rollback-corrupt"), true);
  const result = await store.requestCancel("rollback-corrupt");
  assert.equal(result.created, false);
  assert.equal(result.accepted, true);
  assert.equal(result.decision, "cancel");
  assert.equal(result.operationId, "rollback-corrupt");
  const committed = await store.commit("rollback-corrupt");
  assert.equal(committed.accepted, false);
  assert.equal(committed.decision, "cancel");
  assert.equal(await store.clear("rollback-corrupt"), true);
  assert.equal(await store.getDecision("rollback-corrupt"), null);
  assert.equal(await store.isCancellationRequested("rollback-corrupt"), false);
});

test("a marker with mismatched identity fails closed", async (t) => {
  const { directory, store } = await temporaryStore();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const markerDirectory = path.join(directory, "deployment-cancel");
  await fs.mkdir(markerDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(markerDirectory, "release-expected.json"),
    `${JSON.stringify({ operationId: "release-other", decision: "commit", decidedAt: Date.now() })}\n`,
    { mode: 0o600 },
  );

  assert.equal(await store.getDecision("release-expected"), "cancel");
  assert.equal(await store.isCancellationRequested("release-expected"), true);
});

test("rejects operation IDs that could escape or alias the marker directory", async (t) => {
  const { directory, store } = await temporaryStore();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  for (const value of ["", ".", "..", "../release", "release/one", "release one", "-release", "release-", "a".repeat(161), null]) {
    await assert.rejects(() => store.requestCancel(value), /Invalid deployment operation ID/);
    await assert.rejects(() => store.commit(value), /Invalid deployment operation ID/);
    await assert.rejects(() => store.getDecision(value), /Invalid deployment operation ID/);
    await assert.rejects(() => store.isCancellationRequested(value), /Invalid deployment operation ID/);
    await assert.rejects(() => store.clear(value), /Invalid deployment operation ID/);
  }
});

test("nested releases leave the shared commit decision owned by the application updater", () => {
  assert.match(appUpdateScript, /CODEX_DESKTOP_CANCEL_DECISION_MANAGED: "1"/);
  assert.match(releaseScript, /CODEX_DESKTOP_CANCEL_DECISION_MANAGED === "1"/);
  assert.match(releaseScript, /if \(!cancelDecisionManagedByCaller\) await cancelStore\.clear\(operationId\)/);
  const nestedRelease = appUpdateScript.slice(
    appUpdateScript.indexOf('path.join(worktreeDir, "scripts", "release.mjs")'),
    appUpdateScript.indexOf("const release = await releaseStatusStore.read()"),
  );
  assert.ok(nestedRelease.indexOf("CODEX_DESKTOP_CANCEL_DECISION_MANAGED") > nestedRelease.indexOf('"--worker"'));
});
