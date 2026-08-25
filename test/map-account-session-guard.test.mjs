import assert from "node:assert/strict";
import test from "node:test";

import {
  MAP_ACCOUNT_SESSION_CHECK_MS,
  MapAccountSessionGuard,
} from "../public/map-editor/map-account-session-guard.js";

function jsonResponse(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

test("keeps the editor only while the opening account remains current", async () => {
  const invalidations = [];
  const responses = [
    jsonResponse(200, { user: { id: "user-a" } }),
    jsonResponse(200, { user: { id: "user-b" } }),
  ];
  const guard = new MapAccountSessionGuard({
    accountId: "user-a",
    fetchImpl: async () => responses.shift(),
    onInvalidated: (value) => invalidations.push(value),
  });
  assert.equal(MAP_ACCOUNT_SESSION_CHECK_MS, 15_000);
  assert.equal(await guard.check(), "current");
  assert.equal(await guard.check(), "invalidated");
  assert.deepEqual(invalidations, [{ reason: "account-changed", accountId: "user-a" }]);
  assert.equal(await guard.check(), "disabled");
});

test("authenticated logout invalidates but network and 5xx failures preserve unsaved work", async () => {
  for (const response of [
    () => { throw new Error("offline"); },
    () => jsonResponse(503, { error: "recovering" }),
  ]) {
    let invalidated = false;
    const guard = new MapAccountSessionGuard({
      accountId: "user-a",
      fetchImpl: response,
      onInvalidated: () => { invalidated = true; },
    });
    assert.equal(await guard.check(), "unavailable");
    assert.equal(invalidated, false);
    guard.stop();
  }

  let reason = null;
  const signedOut = new MapAccountSessionGuard({
    accountId: "user-a",
    fetchImpl: async () => jsonResponse(401, { error: "请先登录" }),
    onInvalidated: (value) => { reason = value.reason; },
  });
  assert.equal(await signedOut.check(), "invalidated");
  assert.equal(reason, "signed-out");
});

test("focus and visibility checks are fixed, stoppable, and never concurrent", async () => {
  const windowRef = new EventTarget();
  const documentRef = new EventTarget();
  documentRef.visibilityState = "visible";
  let calls = 0;
  let release;
  const guard = new MapAccountSessionGuard({
    accountId: "user-a",
    windowRef,
    documentRef,
    intervalMs: 60_000,
    fetchImpl: () => {
      calls += 1;
      return new Promise((resolve) => { release = () => resolve(jsonResponse(200, { user: { id: "user-a" } })); });
    },
  });
  assert.equal(guard.start(), true);
  windowRef.dispatchEvent(new Event("focus"));
  documentRef.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 1);
  release();
  await guard.check();
  assert.equal(guard.stop(), true);
  windowRef.dispatchEvent(new Event("focus"));
  assert.equal(calls, 1);
});

test("account binding is mandatory for protected editor windows", () => {
  const guard = new MapAccountSessionGuard({ accountId: null, fetchImpl: async () => jsonResponse(200, {}) });
  assert.equal(guard.enabled, false);
  assert.equal(guard.start(), false);
  assert.throws(
    () => new MapAccountSessionGuard({ accountId: "user-a", intervalMs: 4_999, fetchImpl: async () => jsonResponse(200, {}) }),
    /intervalMs/u,
  );
});
