import assert from "node:assert/strict";
import test from "node:test";
import { assertStableReleaseIdentity } from "../lib/release-source-policy.mjs";

const identity = {
  version: "0.39.1",
  head: "a".repeat(40),
  tagCommit: "a".repeat(40),
  precheckedCommit: "a".repeat(40),
  remoteStableCommit: "a".repeat(40),
};

test("a prechecked stable release is authorized by its tag and origin/stable", () => {
  assert.equal(assertStableReleaseIdentity(identity), identity.head);
});

test("a stable release rejects a changed prechecked commit", () => {
  assert.throws(
    () => assertStableReleaseIdentity({ ...identity, precheckedCommit: "b".repeat(40) }),
    /changed after remote verification/,
  );
});

test("a stable release rejects a tag mismatch", () => {
  assert.throws(
    () => assertStableReleaseIdentity({ ...identity, tagCommit: "b".repeat(40) }),
    /not tagged/,
  );
});

test("a stable release rejects a commit outside the current stable tip", () => {
  assert.throws(
    () => assertStableReleaseIdentity({ ...identity, remoteStableCommit: "b".repeat(40) }),
    /does not match origin\/stable/,
  );
});
