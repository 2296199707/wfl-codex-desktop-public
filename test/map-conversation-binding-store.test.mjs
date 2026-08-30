import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MapConversationBindingStore } from "../lib/map-conversation-binding-store.mjs";

async function withStore(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-binding-"));
  let clock = 1_700_000_000_000;
  try {
    const store = await new MapConversationBindingStore(directory, {
      now: () => ++clock,
    }).initialize({ writeOnInitialize: true });
    return await callback(store, directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const userId = "user-owner";
const projectA = "/srv/games/forest";
const projectB = "/srv/games/desert";
const threadA = "thread-forest-01";
const threadB = "thread-forest-02";

test("persists a project binding and restores it after restart", async () => {
  await withStore(async (store, directory) => {
    const first = await store.set({
      userId,
      projectPath: projectA,
      threadId: threadA,
      expectedRevision: 0,
    });
    assert.deepEqual(first, {
      projectPath: projectA,
      threadId: threadA,
      revision: 1,
      updatedAt: first.updatedAt,
    });
    assert.deepEqual(store.get({ userId, projectPath: projectA }), first);

    const switched = await store.set({
      userId,
      projectPath: projectA,
      threadId: threadB,
      expectedRevision: first.revision,
    });
    assert.equal(switched.threadId, threadB);
    assert.equal(switched.revision, 2);

    const reopened = await new MapConversationBindingStore(directory).initialize();
    assert.deepEqual(reopened.get({ userId, projectPath: projectA }), switched);
  });
});

test("rejects stale revisions and prevents one thread from binding to two projects", async () => {
  await withStore(async (store) => {
    const binding = await store.set({
      userId,
      projectPath: projectA,
      threadId: threadA,
      expectedRevision: 0,
    });
    await assert.rejects(
      store.set({
        userId,
        projectPath: projectA,
        threadId: threadB,
        expectedRevision: 0,
      }),
      (error) => error.statusCode === 409 && error.code === "MAP_CONVERSATION_BINDING_CONFLICT",
    );
    await assert.rejects(
      store.set({
        userId,
        projectPath: projectB,
        threadId: threadA,
        expectedRevision: 0,
      }),
      (error) => error.statusCode === 409 && error.code === "MAP_CONVERSATION_THREAD_ALREADY_BOUND",
    );
    assert.deepEqual(store.get({ userId, projectPath: projectA }).threadId, binding.threadId);
  });
});

test("keeps an unbound tombstone so an old revision cannot reclaim the project", async () => {
  await withStore(async (store) => {
    const bound = await store.set({
      userId,
      projectPath: projectA,
      threadId: threadA,
      expectedRevision: 0,
    });
    const unbound = await store.set({
      userId,
      projectPath: projectA,
      threadId: null,
      expectedRevision: bound.revision,
    });
    assert.equal(unbound.threadId, null);
    assert.equal(unbound.revision, bound.revision + 1);
    await assert.rejects(
      store.set({
        userId,
        projectPath: projectA,
        threadId: threadB,
        expectedRevision: bound.revision,
      }),
      (error) => error.statusCode === 409 && error.code === "MAP_CONVERSATION_BINDING_CONFLICT",
    );

    const rebound = await store.set({
      userId,
      projectPath: projectA,
      threadId: threadB,
      expectedRevision: unbound.revision,
    });
    assert.equal(rebound.threadId, threadB);
  });
});

test("migrates and clears bindings when a Thread is materialized or deleted", async () => {
  await withStore(async (store) => {
    await store.set({ userId, projectPath: projectA, threadId: threadA, expectedRevision: 0 });
    const migrated = await store.replaceThread({
      userId,
      previousThreadId: threadA,
      nextThreadId: threadB,
      projectPath: projectA,
    });
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].threadId, threadB);

    const removed = await store.removeForThread({ userId, threadId: threadB });
    assert.equal(removed.length, 1);
    assert.equal(removed[0].threadId, null);
    assert.equal(store.get({ userId, projectPath: projectA }).threadId, null);
  });
});

test("does not migrate a Thread onto a project that already owns the target Thread", async () => {
  await withStore(async (store) => {
    await store.set({ userId, projectPath: projectA, threadId: threadA, expectedRevision: 0 });
    await store.set({ userId, projectPath: projectB, threadId: threadB, expectedRevision: 0 });
    await assert.rejects(
      store.replaceThread({
        userId,
        previousThreadId: threadA,
        nextThreadId: threadB,
        projectPath: projectA,
      }),
      (error) => error.statusCode === 409 && error.code === "MAP_CONVERSATION_THREAD_ALREADY_BOUND",
    );
    assert.equal(store.get({ userId, projectPath: projectA }).threadId, threadA);
  });
});

test("rejects malformed users, projects, Threads, and revisions", async () => {
  await withStore(async (store) => {
    assert.throws(
      () => store.get({ userId, projectPath: "relative/project" }),
      (error) => error.statusCode === 400,
    );
    await assert.rejects(store.set({ userId: "", projectPath: projectA, threadId: threadA }));
    await assert.rejects(store.set({ userId, projectPath: "relative/project", threadId: threadA }));
    await assert.rejects(store.set({ userId, projectPath: projectA, threadId: "bad\nthread" }));
    await assert.rejects(store.set({ userId, projectPath: projectA, threadId: threadA, expectedRevision: -1 }));
  });
});
