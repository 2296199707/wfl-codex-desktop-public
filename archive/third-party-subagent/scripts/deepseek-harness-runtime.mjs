#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { boot, installFailLoud, loadEnv, resolveConfigPath } from "@deepseek-ai/dsh-app-boot";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  parseOfficialSettlementMessage,
  stopReasonFromOfficialSummary,
} from "../lib/deepseek-harness-settlement.mjs";

const RUNTIME_NAME = "wfl-deepseek-harness-runtime";
const PROVIDER = "wfl-third-party";
const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 512 * 1024;
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

loadEnv(RUNTIME_NAME);
installFailLoud(RUNTIME_NAME);
const MODEL = String(process.env.WFL_SUBAGENT_MODEL || "").trim();

const requestedConfig = process.env.DSH_CORDIS_CONFIG || process.argv[2];
if (!requestedConfig) {
  process.stderr.write(`${RUNTIME_NAME}: a cordis config path is required\n`);
  process.exit(1);
}

const configPath = resolveConfigPath(requestedConfig, undefined);
let context = null;
let bridge = null;
let inputBuffer = "";
let shuttingDown = null;
const inFlightRequests = new Map();

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeError(null, "INVALID_REQUEST", "runtime request is not valid JSON");
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    writeError(null, "INVALID_REQUEST", "runtime request must be an object");
    return;
  }
  if (message.method === "cancel") {
    const requestId = message.params?.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") {
      inFlightRequests.get(String(requestId))?.abort();
    }
    return;
  }
  if (!Object.hasOwn(message, "id")) return;
  const requestId = String(message.id);
  const controller = new AbortController();
  inFlightRequests.set(requestId, controller);
  try {
    const result = await bridge.dispatch(String(message.method || ""), message.params, controller.signal);
    writeResult(message.id, result);
    if (message.method === "shutdown") setImmediate(() => { void shutdown(0); });
  } catch (error) {
    writeError(message.id, errorCode(error), errorMessage(error));
  } finally {
    if (inFlightRequests.get(requestId) === controller) inFlightRequests.delete(requestId);
  }
}

class OfficialSubagentBridge {
  constructor(ctx) {
    this.ctx = ctx;
    this.hosts = new Map();
    this.hostIds = new Map();
    this.hostStarts = new Map();
    this.hostUseCounts = new Map();
    this.continuableParents = new Set();
    this.hostBindingsPath = typeof process.env.DSH_HOST_BINDINGS_PATH === "string"
      && process.env.DSH_HOST_BINDINGS_PATH.trim()
      ? path.resolve(process.env.DSH_HOST_BINDINGS_PATH.trim())
      : null;
    this.hostBindings = new Map();
    this.hostBindingsLoaded = false;
    this.hostBindingsWrite = Promise.resolve();
    this.disposers = [];

    this.disposers.push(ctx.on("agent/pre-step", ({ agent }, next) => (
      this.hostIds.has(String(agent.id)) ? { kind: "reject" } : next()
    )));
  }

  async dispatch(method, params = {}, signal = null) {
    switch (method) {
      case "ping":
        return { ready: true };
      case "subagent/start":
        return this.start(params, signal);
      case "subagent/send_message":
        return this.sendMessage(params, signal);
      case "subagent/interrupt":
        return this.interrupt(params, signal);
      case "subagent/list":
        return this.list(params, signal);
      case "shutdown":
        return {};
      default:
        throw bridgeError("METHOD_NOT_FOUND", `unknown runtime method: ${method}`);
    }
  }

  async start(params, signal = null) {
    const parentThreadId = cleanId(params.parentThreadId, "parentThreadId");
    const description = cleanText(params.description, "description");
    const prompt = cleanText(params.prompt, "prompt");
    const context = executionContext(params);
    signal?.throwIfAborted();
    const host = await this.ensureHost(parentThreadId, context);
    this.retainHost(parentThreadId);
    signal?.throwIfAborted();
    const operationSignal = signal || new AbortController().signal;
    try {
      // `startContinuable` deliberately accepts the request shape without
      // `signal`; the cancellation signal belongs to the outer continuation
      // spec and only owns admission until the initial inbox message is
      // accepted.  One-shot `start` has the signal on its request because its
      // whole run remains owned by the caller.
      const request = {
        prompt: [{ type: "text", text: prompt }],
        parent: host.agent,
        agentOptions: {
          provider: PROVIDER,
          model: MODEL,
        },
      };
      if (params.runInBackground === true) {
        // Background delegation is the only path that establishes a durable
        // child. The official continuation manager owns its inbox, identity,
        // later turns, interruption, and cold resume.
        const started = await this.ctx.subagents.startContinuable({
          provider: "spawn",
          label: description,
          request,
          signal: operationSignal,
        });
        const childId = String(started.childId);
        this.continuableParents.add(parentThreadId);
        return {
          mode: "continuable",
          childId,
          messageId: String(started.messageId),
        };
      }

      // Foreground delegation is an official one-shot run. It must not enter
      // startContinuable(): doing so creates a durable child even though the
      // caller asked for one result and has no continuation owner.
      const run = await this.ctx.subagents.start("spawn", {
        ...request,
        signal: operationSignal,
      });
      try {
        const result = await run.result;
        return {
          mode: "foreground",
          childId: String(run.id),
          ...normalizeSubagentResult(result),
        };
      } finally {
        await run.dispose();
        await flushAndRemovePersistedSession(this.ctx, run.id, run.localAgent?.session);
      }
    } finally {
      await this.releaseHostIfUnused(parentThreadId);
    }
  }

  async sendMessage(params, signal = null) {
    const parentThreadId = cleanId(params.parentThreadId, "parentThreadId");
    const childId = cleanId(params.childId, "childId");
    const message = cleanText(params.message, "message");
    const host = await this.ensureHostForControl(parentThreadId, childId);
    const messageId = await this.ctx.subagents.followup(
      host.agent,
      SessionId(childId),
      [{ type: "text", text: message }],
      {
        source: { kind: "coordinator", form: "relay", senderSessionId: host.agent.id },
        signal: signal || new AbortController().signal,
      },
    );
    return { messageId: String(messageId) };
  }

  async interrupt(params, signal = null) {
    if (signal?.aborted) throw bridgeError("CANCELLED", "the subagent operation was cancelled");
    const parentThreadId = cleanId(params.parentThreadId, "parentThreadId");
    const childId = cleanId(params.childId, "childId");
    // `interrupt` must use the same durable parent check as `send_message`.
    // The official runtime enforces the parentSession authority, but only
    // after the host resolves the requested parent; do not let a caller use a
    // valid user socket to target another parent thread's child.
    await this.ensureHostForControl(parentThreadId, childId);
    signal?.throwIfAborted();
    const hostId = hostIdFor(parentThreadId);
    this.ctx.subagents.interrupt(SessionId(childId), {
      kind: "user",
      parentSessionId: SessionId(hostId),
    });
    return { accepted: true };
  }

  async list(params, signal = null) {
    const parentThreadId = cleanId(params.parentThreadId, "parentThreadId");
    await this.restoreKnownHost(parentThreadId);
    const hostId = hostIdFor(parentThreadId);
    const scope = params.scope === "descendants" ? "descendants" : "children";
    const entries = scope === "descendants"
      ? await this.ctx.subagents.listDescendants(SessionId(hostId), signal)
      : await this.ctx.subagents.listChildren(SessionId(hostId), signal);
    return { scope, entries: entries.map(serializeListEntry) };
  }

  async ensureHost(parentThreadId, context) {
    const current = this.hosts.get(parentThreadId);
    if (current && this.ctx.agents.get(current.agent.id) === current.agent) {
      if (path.resolve(current.agent.session.header.cwd || "") !== context.cwd) {
        throw bridgeError("PARENT_CONTEXT_CHANGED", "the parent workspace changed after the host was created");
      }
      this.pinSandbox(current.agent, context.sandboxMode);
      return current;
    }
    const pending = this.hostStarts.get(parentThreadId);
    if (pending) {
      const host = await pending;
      if (path.resolve(host.agent.session.header.cwd || "") !== context.cwd) {
        throw bridgeError("PARENT_CONTEXT_CHANGED", "the parent workspace changed after the host was created");
      }
      this.pinSandbox(host.agent, context.sandboxMode);
      return host;
    }
    const hostId = hostIdFor(parentThreadId);
    const creation = (async () => {
      const setup = (agentCtx) => this.setupHost(agentCtx, parentThreadId);
      const stored = typeof this.ctx.sessionPersistence?.list === "function"
        ? await this.ctx.sessionPersistence.list()
        : [];
      const persisted = stored.some((header) => String(header.id) === hostId);
      const handle = persisted
        ? await this.ctx.agents.resume({
          resumeSessionId: SessionId(hostId),
          agentOptions: { provider: PROVIDER, model: MODEL },
          setup,
        })
        : await this.ctx.agents.create({
          sessionId: SessionId(hostId),
          meta: { cwd: context.cwd },
          agentOptions: { provider: PROVIDER, model: MODEL },
          setup,
        });
      const host = { id: hostId, agent: handle.agent, handle, cwd: context.cwd };
      this.hosts.set(parentThreadId, host);
      this.hostIds.set(hostId, parentThreadId);
      this.pinSandbox(host.agent, context.sandboxMode);
      await this.rememberHostBinding(parentThreadId, hostId, context);
      return host;
    })();
    this.hostStarts.set(parentThreadId, creation);
    try {
      return await creation;
    } finally {
      if (this.hostStarts.get(parentThreadId) === creation) this.hostStarts.delete(parentThreadId);
    }
  }

  retainHost(parentThreadId) {
    this.hostUseCounts.set(parentThreadId, (this.hostUseCounts.get(parentThreadId) || 0) + 1);
  }

  async releaseHostIfUnused(parentThreadId) {
    const currentCount = this.hostUseCounts.get(parentThreadId) || 0;
    if (currentCount > 1) {
      this.hostUseCounts.set(parentThreadId, currentCount - 1);
      return;
    }
    this.hostUseCounts.delete(parentThreadId);
    if (currentCount === 0 || this.continuableParents.has(parentThreadId)) return;
    const host = this.hosts.get(parentThreadId);
    if (!host) return;
    this.hosts.delete(parentThreadId);
    this.hostIds.delete(host.id);
    await (async () => {
      await host.handle.dispose().catch(() => {});
      await flushAndRemovePersistedSession(this.ctx, host.id, host.agent.session);
    })();
  }

  async ensureHostForControl(parentThreadId, childId) {
    const hostId = hostIdFor(parentThreadId);
    const child = await this.ctx.sessionPersistence.load(SessionId(childId));
    const childMeta = child?.meta;
    if (!childMeta || String(childMeta.parentSession || "") !== hostId) {
      throw bridgeError("SUBAGENT_UNAUTHORIZED", "the subagent does not belong to this parent");
    }
    const cwd = typeof childMeta.cwd === "string" && path.isAbsolute(childMeta.cwd)
      ? path.resolve(childMeta.cwd)
      : null;
    if (!cwd) throw bridgeError("SUBAGENT_NOT_RESUMABLE", "the subagent has no resumable workspace");
    const sandboxMode = this.ctx.sandboxPolicy.overrideOf(child) || "read-only";
    const current = this.hosts.get(parentThreadId);
    if (current && this.ctx.agents.get(current.agent.id) === current.agent) {
      if (path.resolve(current.agent.session.header.cwd || "") !== cwd) {
        throw bridgeError("PARENT_CONTEXT_CHANGED", "the parent workspace changed after the host was created");
      }
      return current;
    }
    return this.ensureHost(parentThreadId, { cwd, sandboxMode });
  }

  setupHost(agentCtx, parentThreadId) {
    // A Host exists only to give the official continuation manager a durable
    // direct parent. Its settlement notice is observed from the official inbox;
    // rejecting pre-step prevents the Host from making an extra provider call.
    const hostAgent = agentCtx.agent;
    let requeuePending = null;
    const requeuePendingSettlements = () => {
      if (requeuePending) return;
      requeuePending = (async () => {
        // A settlement that arrives while the no-op Host turn is being
        // rejected lands in `next-step`. The official Agent loop intentionally
        // does not latch a normal `steer()` during a blocked pre-step, so that
        // message would otherwise remain stranded. Move one pending notice at
        // a time back to the official `next-turn` FIFO after the Host becomes
        // idle. This is transport recovery only; the official inbox remains
        // the source of truth and no WFL task state is introduced.
        while (this.ctx.agents.get(hostAgent.id) === hostAgent) {
          await hostAgent.whenIdle();
          if (this.ctx.agents.get(hostAgent.id) !== hostAgent) return;
          const pending = hostAgent.inbox.nextStep.find(
            (message) => message?.source?.kind === "subagent-settled",
          );
          if (!pending) return;
          if (!hostAgent.inbox.remove(pending.id)) continue;
          hostAgent.followup(pending);
        }
      })()
        .catch((error) => {
          process.stderr.write(`${RUNTIME_NAME}: Host settlement wake recovery failed: ${errorMessage(error)}\n`);
        })
        .finally(() => {
          requeuePending = null;
        });
    };
    agentCtx.on("agent/pre-step", () => ({ kind: "reject" }));
    agentCtx.on("agent/inbox/inserted", ({ message }) => {
      if (message?.source?.kind === "subagent-settled" && hostAgent.status === "running") {
        requeuePendingSettlements();
      }
    });
    agentCtx.on("agent/inbox/claimed", ({ message }) => {
      if (message?.source?.kind !== "subagent-settled") return;
      void this.handleHostSettlement(parentThreadId, message).catch((error) => {
        process.stderr.write(`${RUNTIME_NAME}: settlement observation failed: ${errorMessage(error)}\n`);
      });
    });
  }

  async handleHostSettlement(parentThreadId, message) {
    const source = message?.source;
    const childId = cleanId(source?.senderSessionId, "childId");
    const hostId = hostIdFor(parentThreadId);
    const persisted = await this.ctx.sessionPersistence?.load(SessionId(childId));
    if (!persisted?.meta || String(persisted.meta.parentSession || "") !== hostId) {
      throw bridgeError("SUBAGENT_UNAUTHORIZED", "the settlement child does not belong to this parent");
    }
    const { summary, finalResponse } = parseOfficialSettlementMessage(message);
    writeEvent("subagent/settled", {
      childId,
      // The official settlement source intentionally exposes no run id. The
      // durable Host inbox message id is the unique settlement identity and
      // survives a runtime restart, so it is the correct bridge fallback.
      runId: cleanId(message.id, "settlementMessageId"),
      parentThreadId,
      stopReason: stopReasonFromOfficialSummary(summary),
      finalResponse,
    });
  }

  async restoreKnownHost(parentThreadId) {
    await this.loadHostBindings();
    const binding = this.hostBindings.get(hostIdFor(parentThreadId));
    if (!binding) return;
    await this.ensureHost(parentThreadId, {
      cwd: binding.cwd,
      sandboxMode: binding.sandboxMode,
    });
  }

  async restorePersistedHosts() {
    await this.loadHostBindings();
    for (const binding of this.hostBindings.values()) {
      try {
        await this.ensureHost(binding.parentThreadId, {
          cwd: binding.cwd,
          sandboxMode: binding.sandboxMode,
        });
      } catch (error) {
        process.stderr.write(`${RUNTIME_NAME}: persisted Host restore skipped: ${errorMessage(error)}\n`);
      }
    }
  }

  async loadHostBindings() {
    if (this.hostBindingsLoaded) return;
    this.hostBindingsLoaded = true;
    if (!this.hostBindingsPath) return;
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.hostBindingsPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw bridgeError("SUBAGENT_HOST_BINDINGS_INVALID", "persisted subagent Host bindings could not be read");
    }
    if (!Array.isArray(parsed)) {
      throw bridgeError("SUBAGENT_HOST_BINDINGS_INVALID", "persisted subagent Host bindings are invalid");
    }
    for (const entry of parsed) {
      const parentThreadId = cleanId(entry?.parentThreadId, "parentThreadId");
      const hostId = cleanId(entry?.hostId, "hostId");
      const cwd = typeof entry?.cwd === "string" && path.isAbsolute(entry.cwd)
        ? path.resolve(entry.cwd)
        : null;
      const sandboxMode = String(entry?.sandboxMode || "");
      if (hostId !== hostIdFor(parentThreadId) || !cwd || !SANDBOX_MODES.has(sandboxMode)) continue;
      this.hostBindings.set(hostId, { parentThreadId, hostId, cwd, sandboxMode });
    }
  }

  rememberHostBinding(parentThreadId, hostId, context) {
    if (!this.hostBindingsPath) return Promise.resolve();
    this.hostBindings.set(hostId, {
      parentThreadId,
      hostId,
      cwd: context.cwd,
      sandboxMode: context.sandboxMode,
    });
    const snapshot = [...this.hostBindings.values()];
    this.hostBindingsWrite = this.hostBindingsWrite
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.hostBindingsPath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${this.hostBindingsPath}.${process.pid}.tmp`;
        await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
        await fs.chmod(temporaryPath, 0o600);
        await fs.rename(temporaryPath, this.hostBindingsPath);
      });
    return this.hostBindingsWrite;
  }

  pinSandbox(agent, mode) {
    if (!SANDBOX_MODES.has(mode)) throw bridgeError("PARENT_CONTEXT_INVALID", "invalid sandbox mode");
    const current = this.ctx.sandboxPolicy.overrideOf(agent.session);
    if (current !== mode) {
      agent.session.append("sandbox/mode", { mode, source: "delegation" });
    }
  }

}

function executionContext(params) {
  const cwd = typeof params.cwd === "string" && path.isAbsolute(params.cwd)
    ? path.resolve(params.cwd)
    : null;
  const sandboxMode = String(params.sandboxMode || "");
  if (!cwd || !SANDBOX_MODES.has(sandboxMode)) {
    throw bridgeError("PARENT_CONTEXT_INVALID", "parent cwd or sandbox mode is invalid");
  }
  return { cwd, sandboxMode };
}

function hostIdFor(parentThreadId) {
  return `wfl-codex-host-${crypto.createHash("sha256").update(parentThreadId).digest("hex").slice(0, 40)}`;
}

function serializeListEntry(entry) {
  return {
    kind: entry.kind,
    id: String(entry.id),
    ...(entry.label !== undefined ? { label: String(entry.label) } : {}),
    ...(entry.mode !== undefined ? { mode: String(entry.mode) } : {}),
    ...(entry.activity !== undefined ? { activity: String(entry.activity) } : {}),
    ...(entry.hasChildren !== undefined ? { hasChildren: Boolean(entry.hasChildren) } : {}),
    ...(entry.parentId !== undefined ? { parentId: String(entry.parentId) } : {}),
    ...(entry.depth !== undefined ? { depth: Number(entry.depth) } : {}),
    ...(entry.reason !== undefined ? { reason: String(entry.reason) } : {}),
  };
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function normalizeSubagentResult(result) {
  const stopReason = typeof result?.stopReason === "string" ? result.stopReason : "error";
  const finalResponse = textFromBlocks(result?.output);
  if (stopReason !== "completed") {
    const kind = stopReason.replace(/[^a-z0-9_-]/giu, "_").toUpperCase() || "UNKNOWN";
    const error = bridgeError(`SUBAGENT_${kind}`, `DeepSeek 子代理未完成任务（${kind}）`);
    error.stopReason = stopReason;
    if (finalResponse.trim()) error.partialOutput = finalResponse;
    throw error;
  }
  if (!finalResponse.trim()) throw bridgeError("SUBAGENT_EMPTY_RESULT", "DeepSeek 子代理未返回最终结果");
  return { stopReason, finalResponse };
}

async function flushAndRemovePersistedSession(ctx, id, session = null) {
  const persistence = ctx?.sessionPersistence;
  if (!persistence || typeof persistence.locate !== "function") return;
  if (session && typeof persistence.flush === "function") {
    await persistence.flush(session).catch(() => {});
  }
  // AgentHandle.dispose() removes the Session before the persistence
  // coordinator finishes its asynchronous `session/disposed` retirement.
  // `inspect()` is the public persistence operation that waits for that
  // retirement when it is already registered. Without this barrier, removing
  // the session directory here races the coordinator's final zstd write and
  // leaves a `session.jsonl.zstd.*.tmp` artifact behind.
  if (session && typeof persistence.inspect === "function") {
    await persistence.inspect(SessionId(id)).catch(() => {});
  }
  const meta = session?.header;
  if (!meta || String(meta.id) !== String(id)) return;
  const location = persistence.locate(meta);
  if (!location?.path) return;
  const sessionDirectory = path.dirname(location.path);
  await fs.rm(sessionDirectory, { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.dirname(sessionDirectory), { recursive: false, force: true }).catch(() => {});
}

function cleanText(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 512 * 1024 || /[\u0000]/u.test(text)) {
    throw bridgeError("INVALID_ARGUMENTS", `${name} must be non-empty text`);
  }
  return text;
}

function cleanId(value, name) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 256 || /[\u0000\r\n]/u.test(id)) {
    throw bridgeError("INVALID_ARGUMENTS", `${name} is invalid`);
  }
  return id;
}

function bridgeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function errorCode(error) {
  const code = String(error?.code || "RUNTIME_ERROR");
  return /^[A-Z0-9_:-]{1,80}$/u.test(code) ? code : "RUNTIME_ERROR";
}

function errorMessage(error) {
  return String(error?.message || "DeepSeek runtime failed").slice(0, 4_000);
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ version: PROTOCOL_VERSION, id, ok: true, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ version: PROTOCOL_VERSION, id, ok: false, error: { code, message } })}\n`);
}

function writeEvent(event, params) {
  process.stdout.write(`${JSON.stringify({ version: PROTOCOL_VERSION, event, params })}\n`);
}

async function shutdown(code) {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    await context.fiber.dispose().catch((error) => {
      process.stderr.write(`${RUNTIME_NAME}: shutdown failed: ${errorMessage(error)}\n`);
    });
    process.exit(code);
  })();
  return shuttingDown;
}

async function startRuntime() {
  context = await boot(RUNTIME_NAME, configPath);
  bridge = new OfficialSubagentBridge(context);
  void bridge.restorePersistedHosts().catch((error) => {
    process.stderr.write(`${RUNTIME_NAME}: persisted Host restore failed: ${errorMessage(error)}\n`);
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    inputBuffer += chunk;
    let newline;
    while ((newline = inputBuffer.indexOf("\n")) !== -1) {
      const rawLine = inputBuffer.slice(0, newline);
      inputBuffer = inputBuffer.slice(newline + 1);
      if (Buffer.byteLength(rawLine) > MAX_LINE_BYTES) {
        writeError(null, "INVALID_REQUEST", "runtime request is too large");
        continue;
      }
      const line = rawLine.trim();
      if (line) void handleLine(line);
    }
    if (Buffer.byteLength(inputBuffer) > MAX_LINE_BYTES) {
      inputBuffer = "";
      writeError(null, "INVALID_REQUEST", "runtime request is too large");
    }
  });
  process.stdin.on("end", () => { void shutdown(0); });
  process.on("SIGTERM", () => { void shutdown(0); });
  process.on("SIGINT", () => { void shutdown(130); });
}

try {
  await startRuntime();
} catch (error) {
  process.stderr.write(`${RUNTIME_NAME}: ${errorMessage(error)}\n`);
  process.exit(1);
}
