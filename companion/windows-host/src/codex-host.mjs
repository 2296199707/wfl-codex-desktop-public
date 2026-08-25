import fs from "node:fs/promises";
import path from "node:path";
import { CodexRpcClient } from "./codex-rpc-client.mjs";

const ACTIVE_THREAD_STATUSES = new Set(["active", "running", "inprogress", "waiting", "stopping"]);
const ACTIVE_TURN_STATUSES = new Set(["active", "running", "inprogress", "waiting", "stopping"]);
const IDLE_THREAD_STATUSES = new Set(["idle", "notloaded", "unsubscribed"]);
const FINAL_TURN_STATUSES = new Set(["completed", "interrupted", "failed", "canceled", "cancelled"]);

export class WindowsCodexHost {
  constructor(config, {
    command = process.env.WFL_CODEX_BIN || "codex",
    clientFactory = (options) => new CodexRpcClient(options),
  } = {}) {
    this.config = config;
    this.command = command;
    this.clientFactory = clientFactory;
    this.projects = new Map(config.projects.map((project) => [project.id, project]));
    this.clients = new Map();
    this.clientPromises = new Map();
    this.turnRequests = new Map();
  }

  async capabilities() {
    try {
      const project = this.config.projects[0];
      await fs.access(project.path);
      const client = await this.clientFor(project);
      const result = await client.request("account/read", {}, { timeoutMs: 8_000 }).catch(() => null);
      return {
        available: true,
        appServer: true,
        version: await codexVersion(this.command),
        loggedIn: Boolean(result),
      };
    } catch {
      return { available: false, appServer: false, version: await codexVersion(this.command), loggedIn: false };
    }
  }

  async call(method, params) {
    if (method === "codex.projects.list") {
      return {
        projects: this.config.projects.map(({ id, name }) => ({ id, name })),
      };
    }
    const project = this.requireProject(params.projectId);
    const client = await this.clientFor(project);
    if (method === "codex.threads.list") {
      const result = await client.request("thread/list", {
        cwd: project.path,
        limit: 100,
        sortKey: "updated_at",
      });
      return {
        data: Array.isArray(result?.data)
          ? result.data.filter((thread) => threadBelongsToProject(thread, project.path)).map(publicThreadSummary)
          : [],
        nextCursor: result?.nextCursor || null,
      };
    }
    if (method === "codex.thread.read" || method === "codex.thread.resume") {
      const thread = await this.readOwnedThread(client, project, params.threadId);
      if (method === "codex.thread.read") return { thread: publicThreadDetail(thread) };
      assertThreadIdle(thread);
      const result = await client.request("thread/resume", {
        threadId: params.threadId,
        persistExtendedHistory: true,
      });
      if (!threadBelongsToProject(result?.thread, project.path)) throw new Error("Codex returned a Thread outside the selected project");
      return { resumed: true, thread: publicThreadSummary(result.thread) };
    }
    const requestKey = `${project.id}:${params.threadId}:${params.requestId}`;
    const fingerprint = JSON.stringify({ input: params.input });
    const existing = this.turnRequests.get(requestKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("Request ID was already used with different input");
      return existing.submission;
    }
    const submission = (async () => {
      const thread = await this.readOwnedThread(client, project, params.threadId);
      assertThreadIdle(thread);
      const result = await client.request("turn/start", {
        threadId: params.threadId,
        input: [{ type: "text", text: params.input }],
        cwd: project.path,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      }, { timeoutMs: 120_000 });
      return { turn: publicTurnSummary(result?.turn) };
    })();
    this.turnRequests.set(requestKey, { fingerprint, submission });
    try {
      return await submission;
    } finally {
      setTimeout(() => this.turnRequests.delete(requestKey), 10 * 60_000).unref?.();
    }
  }

  async close() {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.clientPromises.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
  }

  requireProject(projectId) {
    const project = this.projects.get(String(projectId || ""));
    if (!project) throw new Error("Local project is not exposed by this Windows Host");
    return project;
  }

  async clientFor(project) {
    const existing = this.clients.get(project.id);
    if (existing) return existing;
    const pending = this.clientPromises.get(project.id);
    if (pending) return pending;
    const promise = (async () => {
      const realProject = await fs.realpath(project.path);
      const client = this.clientFactory({
        command: this.command,
        cwd: realProject,
        clientVersion: "0.1.0",
        clientName: "wfl-windows-host",
        clientTitle: "WFL Windows Host",
        requestTimeoutMs: 30_000,
      });
      try {
        await client.start();
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
      this.clients.set(project.id, client);
      return client;
    })().finally(() => this.clientPromises.delete(project.id));
    this.clientPromises.set(project.id, promise);
    return promise;
  }

  async readOwnedThread(client, project, threadId) {
    const result = await client.request("thread/read", { threadId, includeTurns: true });
    if (!threadBelongsToProject(result?.thread, project.path)) {
      throw new Error("Thread does not belong to the selected local project");
    }
    return result.thread;
  }
}

function threadBelongsToProject(thread, projectPath) {
  if (!thread || typeof thread !== "object" || typeof thread.cwd !== "string") return false;
  return samePath(thread.cwd, projectPath);
}

function samePath(left, right) {
  const a = path.resolve(left).replace(/[\\/]+$/, "").toLowerCase();
  const b = path.resolve(right).replace(/[\\/]+$/, "").toLowerCase();
  return a === b;
}

function assertThreadIdle(thread) {
  const threadStatus = statusType(thread?.status);
  if (ACTIVE_THREAD_STATUSES.has(threadStatus)) throw new Error("Thread is active in another Codex client");
  if (!IDLE_THREAD_STATUSES.has(threadStatus)) throw new Error("Thread is not confirmed idle");
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  if (turns.some((turn) => ACTIVE_TURN_STATUSES.has(statusType(turn?.status)))) {
    throw new Error("Thread has an active Turn and cannot be taken over");
  }
  if (turns.some((turn) => !FINAL_TURN_STATUSES.has(statusType(turn?.status)))) {
    throw new Error("Thread contains a Turn whose final state is unknown");
  }
}

function publicThreadSummary(thread) {
  return {
    id: thread.id,
    name: thread.name || thread.title || null,
    status: statusType(thread.status) || null,
    preview: thread.preview || null,
    createdAt: thread.createdAt || null,
    updatedAt: thread.updatedAt || null,
  };
}

function publicThreadDetail(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const selected = turns.slice(-10);
  return {
    ...publicThreadSummary(thread),
    turns: selected.map(publicTurnSummary),
    truncatedTurns: turns.length > selected.length,
  };
}

function publicTurnSummary(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return {
    id: typeof turn?.id === "string" ? turn.id : null,
    status: statusType(turn?.status) || null,
    items: items.map(publicMessageItem).filter(Boolean).slice(0, 4),
  };
}

function publicMessageItem(item) {
  if (item?.type === "agentMessage" && typeof item.text === "string") {
    return { type: "agentMessage", text: boundedPreviewText(item.text) };
  }
  if (item?.type !== "userMessage" || !Array.isArray(item.content)) return null;
  const text = item.content
    .filter((content) => content?.type === "text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("\n");
  return text ? { type: "userMessage", text: boundedPreviewText(text) } : null;
}

function boundedPreviewText(value) {
  const text = String(value).replaceAll("\u0000", "");
  return text.length > 1_000 ? `${text.slice(0, 1_000)}…` : text;
}

function statusType(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value.type : value;
  return typeof raw === "string" ? raw.replaceAll("_", "").toLowerCase() : "";
}

async function codexVersion(command) {
  try {
    const { spawn } = await import("node:child_process");
    return await new Promise((resolve) => {
      const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: false });
      let output = "";
      const timer = setTimeout(() => child.kill(), 5_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        const match = output.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
        resolve(match?.[1] || null);
      });
    });
  } catch {
    return null;
  }
}
