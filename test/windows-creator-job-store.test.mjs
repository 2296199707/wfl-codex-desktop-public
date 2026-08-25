import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsCreatorJobStore } from "../lib/windows-creator-job-store.mjs";

test("Creator Job IDs are idempotent per user and device", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-creator-jobs-"));
  let now = 1_000;
  try {
    const store = await new WindowsCreatorJobStore(directory, { now: () => now }).initialize();
    const request = {
      jobId: "job-1",
      kind: "presentation.generate",
      workspacePath: ".",
      spec: { output: "deck.pptx", slides: [{ title: "A" }] },
    };
    const first = await store.begin(context(), request);
    assert.equal(first.created, true);
    const replay = await store.begin(context(), {
      ...request,
      spec: { slides: [{ title: "A" }], output: "deck.pptx" },
    });
    assert.equal(replay.created, false);
    await assert.rejects(store.begin(context(), { ...request, kind: "video.compose" }), /不同任务/);
    assert.equal((await fs.stat(path.join(directory, "windows-creator-jobs.json"))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("stale device and Thread epochs cannot finish Creator Jobs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-creator-jobs-"));
  let now = 2_000;
  try {
    const store = await new WindowsCreatorJobStore(directory, { now: () => now }).initialize();
    await store.begin(context(), {
      jobId: "job-2",
      kind: "document.generate",
      workspacePath: "docs",
      spec: { output: "report.docx" },
    });
    now += 1;
    assert.equal((await store.markRunning(context(), "job-2")).accepted, true);
    assert.equal((await store.finish({ ...context(), leaseEpoch: 2 }, "job-2", {
      status: "succeeded",
      summary: "stale",
      outputPath: "docs/report.docx",
    })).accepted, false);
    assert.equal(store.snapshot("user-a").jobs[0].status, "running");
    now += 1;
    assert.equal((await store.finish(context(), "job-2", {
      status: "succeeded",
      summary: "done",
      outputPath: "docs/report.docx",
    })).accepted, true);
    assert.equal(store.snapshot("user-a").jobs[0].status, "succeeded");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("active Creator Jobs become interrupted after restart and are not replayed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-creator-jobs-"));
  let now = 3_000;
  try {
    const first = await new WindowsCreatorJobStore(directory, { now: () => now }).initialize();
    await first.begin(context(), {
      jobId: "job-3",
      kind: "video.compose",
      workspacePath: ".",
      spec: { output: "video.mp4" },
    });
    now += 100;
    const second = await new WindowsCreatorJobStore(directory, { now: () => now }).initialize();
    const job = second.snapshot("user-a").jobs[0];
    assert.equal(job.status, "interrupted");
    assert.match(job.result.summary, /未自动重放/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a non-writer candidate reads Creator Jobs without changing primary state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-creator-jobs-"));
  let now = 4_000;
  try {
    const primary = await new WindowsCreatorJobStore(directory, { now: () => now }).initialize();
    await primary.begin(context(), {
      jobId: "job-candidate",
      kind: "presentation.generate",
      workspacePath: ".",
      spec: { output: "candidate.pptx" },
    });
    const statePath = path.join(directory, "windows-creator-jobs.json");
    const before = await fs.readFile(statePath, "utf8");

    now += 100;
    const candidate = await new WindowsCreatorJobStore(directory, { now: () => now })
      .initialize({ writeOnInitialize: false });
    assert.equal(candidate.snapshot("user-a").jobs[0].status, "queued");
    assert.equal(await fs.readFile(statePath, "utf8"), before);

    const promoted = await candidate.interruptActive("候选切换后确认旧任务未自动重放");
    assert.equal(promoted, 1);
    assert.equal(candidate.snapshot("user-a").jobs[0].status, "interrupted");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function context() {
  return {
    userId: "user-a",
    deviceId: "device-a",
    deviceEpoch: 1,
    threadId: "thread-a",
    leaseEpoch: 1,
  };
}
