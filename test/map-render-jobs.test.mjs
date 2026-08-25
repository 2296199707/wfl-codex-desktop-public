import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MapRenderJobStore, normalizeRenderRequest } from "../lib/map-render-jobs.mjs";
import { MapRenderSettingsStore } from "../lib/map-render-settings.mjs";

const identity = Object.freeze({
  userId: "user-1",
  browserSessionId: "browser-session-1",
  editorInstanceId: "editor-window-0001",
});

async function withQueue(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-jobs-"));
  const projectPath = path.join(root, "project");
  const targetPath = path.join(projectPath, "maps", "world.tmj");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, "{}\n");
  const settingsStore = await new MapRenderSettingsStore(path.join(root, "state")).initialize();
  try {
    await operation({ root, projectPath, targetPath, settingsStore });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function input(projectPath, targetPath, operation, kind = "map-panorama") {
  return {
    identity,
    mapContext: {
      mapSessionId: "map-session-0001",
      projectPath,
      targetPath,
      version: "a".repeat(64),
      writable: true,
    },
    request: {
      clientOperationId: operation,
      kind,
      outputRoot: "exports/maps",
      spec: { scale: 1 },
    },
  };
}

function captureInput(token = "private-preview-token") {
  return {
    identity: { ...identity, editorInstanceId: "project-preview-capture" },
    capture: {
      url: `http://127.0.0.1:3000/preview/${token}/game/index.html`,
      requestOrigin: "http://127.0.0.1:3000",
      config: { mode: "unconfigured", previewOrigins: [] },
      width: 640,
      height: 480,
      fullPage: false,
    },
  };
}

function successfulResult(job) {
  const bytes = Buffer.from(job.id);
  return {
    summary: "rendered",
    outputDirectory: `exports/maps/${job.id}`,
    files: [{
      path: "map.png",
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      mediaType: "image/png",
    }],
  };
}

async function waitFor(predicate, message = "condition") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

test("rejects render output roots inside reserved project metadata", () => {
  const request = (outputRoot) => normalizeRenderRequest({
    kind: "map-screenshot",
    clientOperationId: "render-output-root-0001",
    outputRoot,
    spec: { width: 640, height: 480 },
  });
  assert.equal(request("exports/maps").outputRoot, "exports/maps");
  for (const outputRoot of [".git/exports", ".codex-desktop/render", "assets/.codex-private/render"]) {
    assert.throws(() => request(outputRoot), (error) => error.statusCode === 400);
  }
  assert.throws(
    () => normalizeRenderRequest({
      kind: "map-screenshot",
      clientOperationId: "render-invalid-spec-0001",
      outputRoot: "exports/maps",
      spec: [640, 480],
    }),
    (error) => error.statusCode === 400 && /参数必须是对象/u.test(error.message),
  );
});

test("runs jobs in FIFO order and queues work at the fixed concurrency limit", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    const started = [];
    const releases = [];
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: (job) => new Promise((resolve) => {
        started.push(job.clientOperationId);
        releases.push(() => resolve(successfulResult(job)));
      }),
    }).initialize();
    const first = await store.begin(input(projectPath, targetPath, "render-operation-0001"));
    const second = await store.begin(input(projectPath, targetPath, "render-operation-0002"));
    const third = await store.begin(input(projectPath, targetPath, "render-operation-0003"));
    await waitFor(() => started.length === 1, "first render");
    assert.deepEqual(started, ["render-operation-0001"]);
    assert.equal(store.status().queueLength, 2);

    releases.shift()();
    await waitFor(() => started.length === 2, "second render");
    assert.deepEqual(started, ["render-operation-0001", "render-operation-0002"]);
    releases.shift()();
    await waitFor(() => started.length === 3, "third render");
    releases.shift()();
    await waitFor(() => store.status().running === 0 && store.status().queueLength === 0, "idle queue");
    assert.equal(store.snapshot({ jobId: first.job.id, identity }).status, "succeeded");
    assert.equal(store.snapshot({ jobId: second.job.id, identity }).status, "succeeded");
    assert.equal(store.snapshot({ jobId: third.job.id, identity }).status, "succeeded");
  });
});

test("applies the current manual queue limit only to new tasks", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    await settingsStore.updateCustom({ worker: { queueLimit: 1 } });
    const releases = [];
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: (job) => new Promise((resolve) => releases.push(() => resolve(successfulResult(job)))),
    }).initialize();
    const running = await store.begin(input(projectPath, targetPath, "render-queue-limit-0001"));
    await waitFor(() => releases.length === 1, "running task runner");
    const queued = await store.begin(input(projectPath, targetPath, "render-queue-limit-0002"));
    assert.equal(store.snapshot({ jobId: queued.job.id, identity }).status, "queued");
    await assert.rejects(
      store.begin(input(projectPath, targetPath, "render-queue-limit-0003")),
      (error) => error.statusCode === 429,
    );
    assert.throws(() => store.capturePreview(captureInput()), (error) => error.statusCode === 429);

    const retry = await store.begin(input(projectPath, targetPath, "render-queue-limit-0002"));
    assert.equal(retry.created, false);
    assert.equal(retry.job.id, queued.job.id);
    releases.shift()();
    await waitFor(() => releases.length === 1, "queued task runner");
    releases.shift()();
    await waitFor(() => store.status().running === 0, "queue drain");
  });
});

test("canceling a queued persistent task immediately releases queue capacity", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    await settingsStore.updateCustom({ worker: { queueLimit: 1 } });
    const started = [];
    const releases = [];
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: (job) => new Promise((resolve) => {
        started.push(job.clientOperationId);
        releases.push(() => resolve(successfulResult(job)));
      }),
    }).initialize();
    const running = await store.begin(input(projectPath, targetPath, "render-cancel-queued-0001"));
    await waitFor(() => started.length === 1, "running task");
    const queued = await store.begin(input(projectPath, targetPath, "render-cancel-queued-0002"));
    assert.equal(store.status().queueLength, 1);

    const canceled = await store.cancel({ jobId: queued.job.id, identity });
    assert.equal(canceled.accepted, true);
    assert.equal(canceled.job.status, "canceled");
    assert.equal(store.status().queueLength, 0);

    const replacement = await store.begin(input(projectPath, targetPath, "render-cancel-queued-0003"));
    assert.equal(replacement.job.status, "queued");
    releases.shift()();
    await waitFor(() => started.length === 2, "replacement task");
    assert.deepEqual(started, ["render-cancel-queued-0001", "render-cancel-queued-0003"]);
    releases.shift()();
    await waitFor(
      () => store.snapshot({ jobId: replacement.job.id, identity }).status === "succeeded",
      "replacement completion",
    );
    assert.equal(store.snapshot({ jobId: running.job.id, identity }).status, "succeeded");
  });
});

test("returns an existing idempotent job after admission or the worker is manually disabled", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    let release;
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: (job) => new Promise((resolve) => {
        release = () => resolve(successfulResult(job));
      }),
    }).initialize();
    const request = input(projectPath, targetPath, "render-idempotent-settings-0001");
    const created = await store.begin(request);
    await waitFor(() => store.snapshot({ jobId: created.job.id, identity }).status === "running", "running task");

    await settingsStore.setAcceptNewTasks(false);
    const pausedRetry = await store.begin(request);
    assert.equal(pausedRetry.created, false);
    assert.equal(pausedRetry.job.id, created.job.id);
    await assert.rejects(
      store.begin(input(projectPath, targetPath, "render-idempotent-settings-0002")),
      (error) => error.statusCode === 503,
    );
    await assert.rejects(
      store.begin({
        ...request,
        request: { ...request.request, spec: { scale: 2 } },
      }),
      (error) => error.statusCode === 409,
    );

    await settingsStore.setAcceptNewTasks(true);
    await settingsStore.updateCustom({ worker: { enabled: false } });
    const disabledRetry = await store.begin(request);
    assert.equal(disabledRetry.created, false);
    assert.equal(disabledRetry.job.id, created.job.id);
    await assert.rejects(
      store.begin(input(projectPath, targetPath, "render-idempotent-settings-0003")),
      (error) => error.statusCode === 503,
    );

    release();
    await waitFor(() => store.snapshot({ jobId: created.job.id, identity }).status === "succeeded", "task completion");
  });
});

test("keeps each task settings snapshot when an administrator changes later tasks", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    const snapshots = [];
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: async (job) => {
        snapshots.push(job.settings);
        return successfulResult(job);
      },
    }).initialize();
    const first = await store.begin(input(projectPath, targetPath, "render-snapshot-0001"));
    await waitFor(() => store.snapshot({ jobId: first.job.id, identity }).status === "succeeded", "first snapshot");
    await settingsStore.updateCustom({ worker: { memoryMb: 2_048 } });
    const second = await store.begin(input(projectPath, targetPath, "render-snapshot-0002"));
    await waitFor(() => store.snapshot({ jobId: second.job.id, identity }).status === "succeeded", "second snapshot");
    assert.equal(snapshots[0].config.worker.memoryMb, 768);
    assert.equal(snapshots[1].config.worker.memoryMb, 2_048);
    assert.equal(snapshots[0].preset, "stable");
    assert.equal(snapshots[1].preset, "custom");
  });
});

test("queues transient preview captures behind the shared screenshot limit without persisting tokens", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    const started = [];
    const releases = [];
    const captureLease = {
      filePath: path.join(root, "temporary-screenshot.png"),
      size: 3,
      sha256: "b".repeat(64),
      mediaType: "image/png",
      dispose: async () => {},
    };
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: (job) => new Promise((resolve) => {
        started.push({ kind: job.kind, settings: job.settings });
        releases.push(() => resolve(job.kind === "preview-capture" ? captureLease : successfulResult(job)));
      }),
    }).initialize();
    const map = await store.begin(input(
      projectPath,
      targetPath,
      "render-shared-screenshot-0001",
      "map-screenshot",
    ));
    await waitFor(() => started.length === 1, "map screenshot");
    const capture = store.capturePreview(captureInput());
    await waitFor(() => store.status().queueLength === 1, "queued preview capture");
    assert.equal(store.status().screenshotRunning, 1);
    assert.equal((await fs.readFile(path.join(root, "state", "map-render-jobs.json"), "utf8"))
      .includes("private-preview-token"), false);

    await settingsStore.updateCustom({ preview: { width: 1_920 } });
    releases.shift()();
    await waitFor(() => started.length === 2, "preview capture");
    assert.equal(started[1].kind, "preview-capture");
    assert.equal(started[1].settings.config.preview.width, 1_280);
    releases.shift()();
    assert.equal(await capture, captureLease);
    await waitFor(() => store.status().running === 0, "idle capture queue");
    assert.equal(store.snapshot({ jobId: map.job.id, identity }).status, "succeeded");
  });
});

test("cancels queued and running transient preview captures without starting or resolving them", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    let releaseMap;
    let releaseRunningCapture;
    let previewStarts = 0;
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: (job) => {
        if (job.kind !== "preview-capture") {
          return new Promise((resolve) => {
            releaseMap = () => resolve(successfulResult(job));
          });
        }
        previewStarts += 1;
        return new Promise((resolve) => {
          releaseRunningCapture = () => resolve({ unexpected: "late success" });
        });
      },
    }).initialize();
    const map = await store.begin(input(
      projectPath,
      targetPath,
      "render-cancel-preview-0001",
      "map-screenshot",
    ));
    await waitFor(() => typeof releaseMap === "function", "map screenshot start");

    const queuedController = new AbortController();
    const queuedCapture = store.capturePreview(captureInput("queued-preview-token"), {
      signal: queuedController.signal,
    });
    queuedController.abort();
    await assert.rejects(queuedCapture, (error) => error.code === "ABORT_ERR" && error.statusCode === 499);
    assert.equal(previewStarts, 0);
    assert.equal(store.status().queueLength, 0);

    releaseMap();
    await waitFor(() => store.snapshot({ jobId: map.job.id, identity }).status === "succeeded", "map completion");
    const runningController = new AbortController();
    const runningCapture = store.capturePreview(captureInput("running-preview-token"), {
      signal: runningController.signal,
    });
    await waitFor(() => previewStarts === 1, "preview capture start");
    runningController.abort();
    releaseRunningCapture();
    await assert.rejects(runningCapture, (error) => error.code === "ABORT_ERR" && error.statusCode === 499);
    await waitFor(() => store.status().running === 0, "preview cancellation");
  });
});

test("rejects unsupported preview capture dimensions instead of clamping them", async () => {
  await withQueue(async ({ root, settingsStore }) => {
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: async () => assert.fail("invalid preview capture must not reach the runner"),
    }).initialize();
    assert.throws(
      () => store.capturePreview({ ...captureInput(), capture: { ...captureInput().capture, width: 319 } }),
      (error) => error.statusCode === 400 && /320-32767/u.test(error.message),
    );
    assert.throws(
      () => store.capturePreview({ ...captureInput(), capture: { ...captureInput().capture, height: 32_768 } }),
      (error) => error.statusCode === 400 && /240-32767/u.test(error.message),
    );
    assert.equal(store.status().queueLength, 0);
  });
});

test("does not dispatch queued work while the worker is manually disabled", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    let release;
    let started = 0;
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: (job) => new Promise((resolve) => {
        started += 1;
        release = () => resolve(successfulResult(job));
      }),
    }).initialize();
    const first = await store.begin(input(projectPath, targetPath, "render-disable-0001"));
    await waitFor(() => started === 1, "running render");
    await settingsStore.updateCustom({ worker: { enabled: false } });
    release();
    await waitFor(() => store.snapshot({ jobId: first.job.id, identity }).status === "succeeded", "first completion");
    await assert.rejects(
      store.begin(input(projectPath, targetPath, "render-disable-0002")),
      (error) => error.statusCode === 503,
    );
    assert.equal(store.status().enabled, false);
  });
});

test("fails only the over-budget task and continues the FIFO queue", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    const started = [];
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: async (job) => {
        started.push(job.clientOperationId);
        if (job.clientOperationId === "render-memory-0001") {
          throw Object.assign(new Error("Worker exceeded its memory budget"), {
            code: "memory-budget-exceeded",
          });
        }
        return successfulResult(job);
      },
    }).initialize();
    const failed = await store.begin(input(projectPath, targetPath, "render-memory-0001"));
    const succeeded = await store.begin(input(projectPath, targetPath, "render-memory-0002"));
    await waitFor(() => store.snapshot({ jobId: succeeded.job.id, identity }).status === "succeeded", "second completion");
    assert.equal(store.snapshot({ jobId: failed.job.id, identity }).status, "failed");
    assert.equal(store.snapshot({ jobId: failed.job.id, identity }).error.code, "memory-budget-exceeded");
    assert.deepEqual(started, ["render-memory-0001", "render-memory-0002"]);
  });
});

test("binds status and cancellation to the owning user, browser, and editor window", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: (job, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })));
      }),
    }).initialize();
    const created = await store.begin(input(projectPath, targetPath, "render-cancel-0001"));
    await waitFor(() => store.snapshot({ jobId: created.job.id, identity }).status === "running", "running render");
    assert.throws(
      () => store.snapshot({
        jobId: created.job.id,
        identity: { ...identity, editorInstanceId: "editor-window-0002" },
      }),
      (error) => error.statusCode === 404,
    );
    const canceled = await store.cancel({ jobId: created.job.id, identity });
    assert.equal(canceled.accepted, true);
    await waitFor(() => store.snapshot({ jobId: created.job.id, identity }).status === "canceled", "canceled render");
  });
});

test("logout cancels persistent renders and preview captures only for the exact browser login", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    const otherIdentity = { ...identity, browserSessionId: "browser-session-2" };
    const started = [];
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: (job, { signal }) => new Promise((resolve, reject) => {
        started.push(job);
        if (job.identity.browserSessionId === otherIdentity.browserSessionId) {
          resolve(successfulResult(job));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
        }, { once: true });
      }),
    }).initialize();
    const running = await store.begin(input(projectPath, targetPath, "render-logout-running-0001"));
    const queued = await store.begin(input(projectPath, targetPath, "render-logout-queued-0001"));
    const otherInput = input(projectPath, targetPath, "render-other-login-0001");
    otherInput.identity = otherIdentity;
    const survivor = await store.begin(otherInput);
    const preview = store.capturePreview(captureInput("logout-preview-token"));
    const previewRejected = assert.rejects(
      preview,
      (error) => error.code === "ABORT_ERR" && error.statusCode === 499,
    );

    await waitFor(() => store.snapshot({ jobId: running.job.id, identity }).status === "running", "running render");
    assert.deepEqual(await store.cancelForBrowserSession(identity), { canceled: 3 });
    await previewRejected;
    await waitFor(
      () => store.snapshot({ jobId: running.job.id, identity }).status === "canceled",
      "logout running cancellation",
    );
    await waitFor(
      () => store.snapshot({ jobId: survivor.job.id, identity: otherIdentity }).status === "succeeded",
      "other login render completion",
    );

    assert.equal(store.snapshot({ jobId: queued.job.id, identity }).status, "canceled");
    assert.equal(store.snapshot({ jobId: survivor.job.id, identity: otherIdentity }).status, "succeeded");
    assert.equal(started.some((job) => job.id === queued.job.id), false);
    assert.equal(started.some((job) => job.kind === "preview-capture"), false);
    await store.close();
  });
});

test("revoking an account cancels renders and previews across all browser logins", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    const secondIdentity = { ...identity, browserSessionId: "browser-session-2" };
    const survivorIdentity = { ...identity, userId: "user-2", browserSessionId: "browser-session-3" };
    const started = [];
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: (job, { signal }) => new Promise((resolve, reject) => {
        started.push(job);
        if (job.identity.userId === survivorIdentity.userId) {
          resolve(successfulResult(job));
          return;
        }
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), {
          code: "ABORT_ERR",
        })), { once: true });
      }),
    }).initialize();
    const first = await store.begin(input(projectPath, targetPath, "render-user-revoke-first-0001"));
    const secondInput = input(projectPath, targetPath, "render-user-revoke-second-0001");
    secondInput.identity = secondIdentity;
    const second = await store.begin(secondInput);
    const survivorInput = input(projectPath, targetPath, "render-user-survivor-0001");
    survivorInput.identity = survivorIdentity;
    const survivor = await store.begin(survivorInput);
    const previewInput = captureInput("user-revoke-preview-token");
    previewInput.identity = { ...secondIdentity, editorInstanceId: "project-preview-capture" };
    const preview = store.capturePreview(previewInput);
    const previewRejected = assert.rejects(preview, (error) => error.code === "ABORT_ERR");

    await waitFor(() => store.snapshot({ jobId: first.job.id, identity }).status === "running", "account render");
    assert.deepEqual(await store.cancelForUser({ userId: identity.userId }), { canceled: 3 });
    await previewRejected;
    await waitFor(() => store.snapshot({ jobId: first.job.id, identity }).status === "canceled", "account cancel");
    await waitFor(
      () => store.snapshot({ jobId: survivor.job.id, identity: survivorIdentity }).status === "succeeded",
      "other user render",
    );
    assert.equal(store.snapshot({ jobId: second.job.id, identity: secondIdentity }).status, "canceled");
    assert.equal(started.some((job) => job.id === second.job.id), false);
    await store.close();
  });
});

test("keeps running-task cancellation final when a runner returns late success", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    let release;
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: (job) => new Promise((resolve) => {
        release = () => resolve(successfulResult(job));
      }),
    }).initialize();
    const created = await store.begin(input(projectPath, targetPath, "render-cancel-late-success-0001"));
    await waitFor(() => typeof release === "function", "render start");
    const canceled = await store.cancel({ jobId: created.job.id, identity });
    assert.equal(canceled.job.status, "canceling");
    release();
    await waitFor(() => store.snapshot({ jobId: created.job.id, identity }).status === "canceled", "final cancellation");
    assert.deepEqual(store.snapshot({ jobId: created.job.id, identity }).error, {
      code: "user-canceled",
      message: "用户取消了地图渲染任务",
    });
  });
});

test("closing the store interrupts persistent work and rejects every preview capture", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    await settingsStore.updateCustom({ worker: { renderConcurrency: 2 } });
    const releases = [];
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: (job) => new Promise((resolve) => {
        releases.push(() => resolve(job.kind === "preview-capture"
          ? { unexpected: "late success" }
          : successfulResult(job)));
      }),
    }).initialize();
    const running = await store.begin(input(projectPath, targetPath, "render-close-0001"));
    const preview = store.capturePreview(captureInput("closing-preview-token"));
    await waitFor(() => store.status().running === 2, "running render and preview");
    const queued = await store.begin(input(projectPath, targetPath, "render-close-0002"));
    assert.equal(queued.job.status, "queued");

    const previewRejected = assert.rejects(
      preview,
      (error) => error.code === "service-stopped" && error.statusCode === 503,
    );
    await store.close("测试关闭地图渲染队列");
    await previewRejected;
    for (const created of [running, queued]) {
      assert.deepEqual(store.snapshot({ jobId: created.job.id, identity }).error, {
        code: "service-stopped",
        message: "测试关闭地图渲染队列",
      });
      assert.equal(store.snapshot({ jobId: created.job.id, identity }).status, "interrupted");
    }
    assert.throws(() => store.capturePreview(captureInput()), (error) => error.statusCode === 503);
    await assert.rejects(
      store.begin(input(projectPath, targetPath, "render-close-0003")),
      (error) => error.statusCode === 503,
    );

    for (const release of releases) release();
    await waitFor(() => store.status().running === 0, "closed running tasks");
    assert.equal(store.snapshot({ jobId: running.job.id, identity }).status, "interrupted");
  });
});

test("rejects new jobs while admission is paused without mutating the selected preset", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: async (job) => successfulResult(job),
    }).initialize();
    await settingsStore.setAcceptNewTasks(false);
    await assert.rejects(
      store.begin(input(projectPath, targetPath, "render-paused-0001")),
      (error) => error.statusCode === 503,
    );
    assert.equal(settingsStore.snapshot().preset, "stable");
  });
});

test("resolves successful output files only for the owning identity", async () => {
  await withQueue(async ({ root, projectPath, targetPath, settingsStore }) => {
    const store = await new MapRenderJobStore(path.join(root, "state"), {
      settingsStore,
      runner: async (job) => successfulResult(job),
    }).initialize();
    const created = await store.begin(input(projectPath, targetPath, "render-output-file-0001"));
    await waitFor(
      () => store.snapshot({ jobId: created.job.id, identity }).status === "succeeded",
      "render output",
    );
    const output = store.outputFile({
      jobId: created.job.id,
      identity,
      filePath: "map.png",
    });
    assert.equal(output.projectPath, projectPath);
    assert.equal(output.file.path, "map.png");
    assert.deepEqual(store.outputDirectory({ jobId: created.job.id, identity }), {
      projectPath,
      outputDirectory: `exports/maps/${created.job.id}`,
    });
    assert.throws(
      () => store.outputFile({
        jobId: created.job.id,
        identity: { ...identity, browserSessionId: "browser-session-2" },
        filePath: "map.png",
      }),
      (error) => error.statusCode === 404,
    );
    assert.throws(
      () => store.outputFile({ jobId: created.job.id, identity, filePath: "private.png" }),
      (error) => error.statusCode === 404,
    );
  });
});
