import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsCodexHost } from "../companion/windows-host/src/codex-host.mjs";

test("Windows Codex Host exposes only project-owned Threads and refuses active work", async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-windows-codex-"));
  const requests = [];
  let thread = ownedThread(projectPath);
  const client = {
    async start() {},
    async close() {},
    async request(method, params, options) {
      requests.push({ method, params, options });
      if (method === "thread/list") {
        return {
          data: [ownedThread(projectPath), ownedThread(path.join(projectPath, "other"), "outside")],
          nextCursor: null,
        };
      }
      if (method === "thread/read") return { thread };
      if (method === "thread/resume") return { thread };
      if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress" } };
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const host = new WindowsCodexHost({
    projects: [{ id: "default", name: "Local", path: projectPath }],
  }, {
    command: "missing-codex",
    clientFactory: () => client,
  });
  try {
    const listed = await host.call("codex.threads.list", { projectId: "default" });
    assert.deepEqual(listed.data.map((entry) => entry.id), ["thread-1"]);
    assert.equal(listed.data[0].status, "idle");

    thread = ownedThread(projectPath, "thread-1", {
      turns: [{
        id: "turn-detail",
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "hello" }] },
          { type: "commandExecution", command: "secret command", aggregatedOutput: "secret output" },
          { type: "agentMessage", text: "answer" },
        ],
      }],
    });
    const detail = await host.call("codex.thread.read", { projectId: "default", threadId: "thread-1" });
    assert.deepEqual(detail.thread.turns[0].items, [
      { type: "userMessage", text: "hello" },
      { type: "agentMessage", text: "answer" },
    ]);
    assert.doesNotMatch(JSON.stringify(detail), /secret command|secret output/);

    thread = ownedThread(projectPath, "thread-1", { status: { type: "active", activeFlags: [] } });
    await assert.rejects(host.call("codex.thread.resume", {
      projectId: "default",
      threadId: "thread-1",
    }), /active in another Codex client/);
    assert.equal(requests.filter((entry) => entry.method === "thread/resume").length, 0);

    thread = ownedThread(projectPath, "thread-1", {
      turns: [{ id: "turn-active", status: { type: "in_progress" }, items: [] }],
    });
    await assert.rejects(host.call("codex.turn.start", {
      projectId: "default",
      threadId: "thread-1",
      requestId: "request-active",
      input: "should not run",
    }), /active Turn/);

    thread = ownedThread(projectPath, "thread-1", { status: { type: "unknown" } });
    await assert.rejects(host.call("codex.thread.resume", {
      projectId: "default",
      threadId: "thread-1",
    }), /not confirmed idle/);

    thread = ownedThread(projectPath);
    const resumed = await host.call("codex.thread.resume", {
      projectId: "default",
      threadId: "thread-1",
    });
    assert.equal(resumed.thread.id, "thread-1");
    const first = await host.call("codex.turn.start", {
      projectId: "default",
      threadId: "thread-1",
      requestId: "request-1",
      input: "make a document",
    });
    const duplicate = await host.call("codex.turn.start", {
      projectId: "default",
      threadId: "thread-1",
      requestId: "request-1",
      input: "make a document",
    });
    assert.deepEqual(duplicate, first);
    await assert.rejects(host.call("codex.turn.start", {
      projectId: "default",
      threadId: "thread-1",
      requestId: "request-1",
      input: "different input",
    }), /already used with different input/);
    const starts = requests.filter((entry) => entry.method === "turn/start");
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].params, {
      threadId: "thread-1",
      input: [{ type: "text", text: "make a document" }],
      cwd: projectPath,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
  } finally {
    await host.close();
    await fs.rm(projectPath, { recursive: true, force: true });
  }
});

test("Windows Codex Host rejects a Thread whose cwd is outside the exposed project", async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-windows-codex-"));
  const client = {
    async start() {},
    async close() {},
    async request(method) {
      if (method === "thread/read") return { thread: ownedThread(path.join(projectPath, "outside")) };
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const host = new WindowsCodexHost({
    projects: [{ id: "default", name: "Local", path: projectPath }],
  }, { clientFactory: () => client });
  try {
    await assert.rejects(host.call("codex.thread.read", {
      projectId: "default",
      threadId: "thread-1",
    }), /does not belong/);
  } finally {
    await host.close();
    await fs.rm(projectPath, { recursive: true, force: true });
  }
});

function ownedThread(cwd, id = "thread-1", overrides = {}) {
  return {
    id,
    cwd,
    name: "Local Thread",
    status: { type: "idle" },
    turns: [{ id: "turn-complete", status: "completed", items: [] }],
    ...overrides,
  };
}
