import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";

const REQUEST_LIMIT_BYTES = 512 * 1024;
const MAX_ACTIVE_CONNECTIONS = 64;
const SOCKET_NAMESPACE = "dsh-sockets";
const SOCKET_USER_HASH_LENGTH = 12;
const SOCKET_IDENTITY_LENGTH = 12;
const SOCKET_PREFIX = "dsh-";
const SOCKET_FILE_PATTERN = /^dsh-[a-f0-9]{12,16}\.sock$/u;
const SOCKET_PROBE_TIMEOUT_MS = 250;
const MAX_UNIX_SOCKET_PATH_BYTES = 107;
const RUNTIME_START_TIMEOUT_MS = 15_000;
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 5_000;
const PROVIDER_ROUTE = "wfl-third-party";
const WIRE_APIS = new Set(["openai-responses", "openai-completions"]);
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const APPROVAL_POLICIES = new Set(["ask", "never"]);

/**
 * Thin WFL host bridge for the official DeepSeek Harness runtime.
 *
 * The official runtime owns child identity, continuation, persistence, cold
 * resume, interruption, and settlement. WFL owns only the authenticated
 * Unix socket, provider lookup, and the parent execution-context handoff.
 *
 * `harnessFactory` remains a deliberately explicit compatibility seam for
 * unit tests of the old adapter boundary. Production construction does not
 * pass it and therefore always uses the persistent official runtime process.
 */
export class DeepSeekHarnessSubagentService {
  constructor({
    directory,
    userId,
    uid = null,
    gid = null,
    home = null,
    project,
    configPath,
    socketDirectory = null,
    resolveProvider,
    resolveExecutionContext,
    onSettlement = null,
    harnessFactory = null,
    runtimeScriptPath = null,
  } = {}) {
    if (typeof resolveProvider !== "function") throw new Error("Third-party subagent provider resolver is required");
    if (typeof resolveExecutionContext !== "function") throw new Error("Parent execution context resolver is required");
    this.directory = path.resolve(directory);
    this.userId = String(userId || "");
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
    this.home = path.resolve(
      typeof home === "string" && home.trim() ? home.trim() : process.env.HOME || "/tmp",
    );
    this.project = path.resolve(project || process.cwd());
    this.configPath = path.resolve(configPath);
    this.resolveProvider = resolveProvider;
    this.resolveExecutionContext = resolveExecutionContext;
    this.settlementSink = typeof onSettlement === "function" ? onSettlement : null;
    this.legacyHarnessFactory = typeof harnessFactory === "function" ? harnessFactory : null;
    this.harnessFactory = typeof harnessFactory === "function"
      ? harnessFactory
      : (options) => new DeepSeekHarness(options);
    this.runtimeScriptPath = path.resolve(
      runtimeScriptPath
      || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "deepseek-harness-runtime.mjs"),
    );
    this.server = null;
    this.socketOwned = false;
    this.sockets = new Set();
    this.harnesses = new Set();
    this.officialRuntime = null;
    this.officialRuntimeFingerprint = null;
    this.officialRuntimeProvider = null;
    this.officialRuntimeStarting = null;
    this.officialRuntimeStartController = null;
    this.knownParentThreadIds = new Set();
    this.hostBindingsPath = path.join(this.directory, "host-bindings.json");
    this.providerStatePath = path.join(this.directory, "runtime-provider.json");
    this.closing = false;
    this.authToken = crypto.randomBytes(32).toString("hex");
    const identity = crypto.createHash("sha256")
      .update(`${this.userId}\0${process.pid}\0${crypto.randomUUID()}`)
      .digest("hex")
      .slice(0, 24);
    const userHash = crypto.createHash("sha256")
      .update(this.userId)
      .digest("hex")
      .slice(0, SOCKET_USER_HASH_LENGTH);
    const runtimeDirectory = path.dirname(path.dirname(this.directory));
    this.socketDirectory = path.resolve(
      socketDirectory || path.join(runtimeDirectory, SOCKET_NAMESPACE, `u-${userHash}`),
    );
    this.socketPath = path.join(
      this.socketDirectory,
      `${SOCKET_PREFIX}${identity.slice(0, SOCKET_IDENTITY_LENGTH)}.sock`,
    );
    this.authTokenPath = path.join(
      this.directory,
      `${SOCKET_PREFIX}${identity.slice(0, SOCKET_IDENTITY_LENGTH)}.token`,
    );
    this.sessionRoot = path.join(this.directory, "sessions");
    if (process.platform === "linux" && Buffer.byteLength(this.socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
      throw serviceError(
        503,
        "SUBAGENT_SOCKET_PATH_TOO_LONG",
        "第三方子代理运行目录过深，无法创建 Unix socket",
      );
    }
  }

  async start() {
    if (this.closing) throw serviceError(503, "SUBAGENT_SERVICE_CLOSED", "第三方子代理服务已关闭");
    if (this.server) return this.socketPath;
    await ensureDirectory(this.directory, 0o711, this.uid, this.gid);
    await ensureDirectory(this.sessionRoot, 0o700, this.uid, this.gid);
    await ensureDirectory(path.dirname(this.socketDirectory), 0o711, null, null);
    await ensureDirectory(this.socketDirectory, 0o711, this.uid, this.gid);
    await cleanupStaleSocketFiles(this.socketDirectory);
    await removeStaleSocket(this.socketPath);
    await fs.writeFile(this.authTokenPath, `${this.authToken}\n`, { mode: 0o600 });
    await fs.chmod(this.authTokenPath, 0o600);
    if (this.uid !== null && this.gid !== null) await fs.chown(this.authTokenPath, this.uid, this.gid);
    const server = net.createServer({ allowHalfOpen: true }, (socket) => this.handleSocket(socket));
    this.server = server;
    let listening = false;
    try {
      await listen(server, this.socketPath);
      listening = true;
      await assertSocketFile(this.socketPath);
      await fs.chmod(this.socketPath, 0o600);
      if (this.uid !== null && this.gid !== null) await fs.chown(this.socketPath, this.uid, this.gid);
      this.socketOwned = true;
      return this.socketPath;
    } catch (error) {
      this.server = null;
      this.socketOwned = false;
      await closeServer(server);
      if (listening) await fs.unlink(this.socketPath).catch(() => {});
      await fs.unlink(this.authTokenPath).catch(() => {});
      throw error;
    }
  }

  handleSocket(socket) {
    if (this.sockets.size >= MAX_ACTIVE_CONNECTIONS) {
      socket.end(`${JSON.stringify(errorResponse(serviceError(429, "SUBAGENT_BUSY", "子代理连接数已达上限")))}\n`);
      return;
    }
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    const controller = new AbortController();
    let buffer = "";
    let accepted = false;
    let settled = false;

    const finish = async (operation) => {
      if (settled) return;
      settled = true;
      try {
        await operation();
      } finally {
        this.sockets.delete(socket);
        if (!socket.destroyed) socket.destroy();
      }
    };
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(new Error("MCP client disconnected"));
    };

    // The MCP client keeps the readable side open while waiting for the
    // response. An EOF therefore represents a disconnected request, not a
    // normal request completion; normal clients use write() and wait for the
    // service to close the socket after responding.
    socket.on("end", abort);
    socket.on("close", abort);
    socket.on("error", abort);
    socket.on("data", (chunk) => {
      if (accepted || settled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > REQUEST_LIMIT_BYTES) {
        accepted = true;
        void finish(() => this.respond(socket, errorResponse(
          serviceError(413, "SUBAGENT_REQUEST_TOO_LARGE", "子代理请求过大"),
        )));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      accepted = true;
      const line = buffer.slice(0, newline).trim();
      void this.execute(line, controller.signal)
        .then((result) => finish(() => this.respond(socket, { version: 1, ok: true, result })))
        .catch((error) => finish(() => this.respond(socket, errorResponse(error))))
        .catch(() => {});
    });
  }

  async execute(line, signal = null) {
    const executionSignal = signal || new AbortController().signal;
    const request = parseRequest(line);
    if (!secretsEqual(request.authToken, this.authToken)) {
      throw serviceError(401, "SUBAGENT_AUTH_REQUIRED", "第三方子代理工具会话未通过授权");
    }
    if (executionSignal.aborted) throw serviceError(499, "SUBAGENT_CANCELLED", "子代理工具调用已取消");
    this.knownParentThreadIds.add(request.parentThreadId);

    if (!this.legacyHarnessFactory) return this.executeOfficialRuntime(request, executionSignal);

    const provider = await this.resolveProvider();
    if (!provider || typeof provider !== "object") {
      throw serviceError(503, "SUBAGENT_PROVIDER_UNAVAILABLE", "尚未配置可用的第三方子代理供应商");
    }
    const apiKey = String(provider.apiKey || "").trim();
    const baseUrl = String(provider.baseUrl || "").trim();
    const model = String(provider.model || "").trim();
    const wireApi = String(provider.wireApi || "").trim();
    if (!apiKey) throw serviceError(503, "SUBAGENT_CREDENTIAL_MISSING", "第三方子代理供应商缺少 API Key");
    if (!baseUrl || !model || !WIRE_APIS.has(wireApi)) {
      throw serviceError(503, "SUBAGENT_PROVIDER_INVALID", "第三方子代理供应商配置不完整");
    }
    const executionContext = normalizeExecutionContext(
      await this.resolveExecutionContext(request.parentThreadId, request.parentTurnId),
    );
    await ensureDirectory(this.userTempDirectory(), 0o700, this.uid, this.gid);

    const harness = this.harnessFactory({
      launch: this.launchSpec({
        apiKey,
        baseUrl,
        model,
        wireApi,
        ...executionContext,
      }),
      cwd: executionContext.cwd,
      provider: PROVIDER_ROUTE,
      model,
    });
    this.harnesses.add(harness);
    const sessionId = `wfl-subagent-${crypto.randomUUID().replaceAll("-", "")}`;
    const abortHarness = () => { void harness.close().catch(() => {}); };
    executionSignal.addEventListener("abort", abortHarness, { once: true });
    try {
      // The client may disconnect in the small window between constructing
      // the official Harness and installing the abort listener. Check again
      // before starting it so a disconnected MCP call cannot leave a child
      // running without an owner.
      if (executionSignal.aborted) {
        throw serviceError(499, "SUBAGENT_CANCELLED", "子代理工具调用已取消");
      }
      await harness.start();
      if (executionSignal.aborted) throw serviceError(499, "SUBAGENT_CANCELLED", "子代理工具调用已取消");
      const result = await harness.run(
        request.prompt,
        { sessionId },
      );
      if (executionSignal.aborted) throw serviceError(499, "SUBAGENT_CANCELLED", "子代理工具调用已取消");
      return normalizeHarnessResult(result);
    } finally {
      executionSignal.removeEventListener("abort", abortHarness);
      await harness.close().catch(() => {});
      // One-shot children never resume this session. Remove only this exact
      // session artifact after the official runtime has flushed and closed;
      // concurrent sibling children keep their own artifacts untouched.
      await removePersistedSession(this.sessionRoot, sessionId).catch(() => {});
      this.harnesses.delete(harness);
    }
  }

  async executeOfficialRuntime(request, signal) {
    let executionContext = null;
    if (request.operation === "start") {
      // A new child must use the currently selected provider. Existing
      // control operations deliberately do not resolve the current setting:
      // the live official runtime remains the owner of its children even if
      // the UI has since selected another provider or disabled the setting.
      // This prevents a provider edit from killing an in-flight child.
      const provider = await this.resolveOfficialProvider();
      executionContext = normalizeExecutionContext(
        await this.resolveExecutionContext(request.parentThreadId, request.parentTurnId),
      );
      const runtime = await this.ensureOfficialRuntime(provider, executionContext, { operation: request.operation });
      return this.dispatchOfficialRuntimeRequest(runtime, request, signal, executionContext);
    }
    const provider = this.officialRuntime?.alive ? null : await this.resolveOfficialProvider();
    const runtime = await this.ensureOfficialRuntime(provider, executionContext, { operation: request.operation });
    return this.dispatchOfficialRuntimeRequest(runtime, request, signal, executionContext);
  }

  async dispatchOfficialRuntimeRequest(runtime, request, signal, executionContext = null) {
    try {
      switch (request.operation) {
        case "start": {
          const result = await runtime.request("subagent/start", {
            parentThreadId: request.parentThreadId,
            description: request.description,
            prompt: request.prompt,
            cwd: executionContext.cwd,
            sandboxMode: executionContext.sandboxMode,
            runInBackground: request.runInBackground,
          }, signal);
          if (request.runInBackground) {
            return {
              mode: "continuable",
              childId: result.childId,
              ...(result.messageId ? { messageId: result.messageId } : {}),
            };
          }
          return normalizeOfficialRuntimeResult(result);
        }
        case "send_message":
          return runtime.request("subagent/send_message", {
            parentThreadId: request.parentThreadId,
            childId: request.childId,
            message: request.message,
          }, signal);
        case "interrupt_agent":
          return runtime.request("subagent/interrupt", {
            parentThreadId: request.parentThreadId,
            childId: request.childId,
          }, signal);
        case "list_agents":
          return runtime.request("subagent/list", {
            parentThreadId: request.parentThreadId,
            scope: request.scope,
          }, signal);
        default:
          throw serviceError(400, "SUBAGENT_INVALID_ARGUMENTS", "不支持的第三方子代理操作");
      }
    } catch (error) {
      if (signal?.aborted) throw serviceError(499, "SUBAGENT_CANCELLED", "子代理工具调用已取消");
      throw error;
    }
  }

  async resolveOfficialProvider(providerId = null) {
    const provider = await this.resolveProvider(providerId);
    if (!provider || typeof provider !== "object") {
      throw serviceError(503, "SUBAGENT_PROVIDER_UNAVAILABLE", "尚未配置可用的第三方子代理供应商");
    }
    const apiKey = String(provider.apiKey || "").trim();
    const baseUrl = String(provider.baseUrl || "").trim();
    const model = String(provider.model || "").trim();
    const wireApi = String(provider.wireApi || "").trim();
    if (!apiKey) throw serviceError(503, "SUBAGENT_CREDENTIAL_MISSING", "第三方子代理供应商缺少 API Key");
    if (!baseUrl || !model || !WIRE_APIS.has(wireApi)) {
      throw serviceError(503, "SUBAGENT_PROVIDER_INVALID", "第三方子代理供应商配置不完整");
    }
    const resolvedProviderId = typeof provider.providerId === "string" && provider.providerId.trim()
      ? provider.providerId.trim()
      : null;
    return { providerId: resolvedProviderId, apiKey, baseUrl, model, wireApi };
  }

  async ensureOfficialRuntime(provider, executionContext = null, { operation = "start" } = {}) {
    if (this.closing) throw serviceError(503, "SUBAGENT_SERVICE_CLOSED", "第三方子代理服务已关闭");
    let requestedProvider = provider;
    while (true) {
      if (this.officialRuntimeStarting) {
        await this.officialRuntimeStarting;
        continue;
      }

      const current = this.officialRuntime;
      if (current?.alive && (!requestedProvider || operation !== "start")) return current;
      if (!requestedProvider) requestedProvider = await this.resolveOfficialProvider();

      // Provider resolution and cold-start inspection are asynchronous. A
      // second caller can therefore arrive after the first caller passed the
      // lock check but before it assigned `officialRuntimeStarting`. Recheck
      // immediately after resolving the provider; the transition itself does
      // all remaining asynchronous work so no two callers can spawn runtimes.
      if (this.officialRuntimeStarting) {
        await this.officialRuntimeStarting;
        continue;
      }

      const latest = this.officialRuntime;
      if (latest?.alive && (!requestedProvider || operation !== "start")) return latest;
      const requestedFingerprint = providerFingerprint(requestedProvider);
      if (latest?.alive && this.officialRuntimeFingerprint === requestedFingerprint) return latest;

      // After a service restart, a changed selected provider must not be
      // silently applied to an existing persisted child. If the old provider
      // profile is still available, boot that owner runtime first; the loop
      // below then performs the same official activity check used by a live
      // provider switch before starting the requested provider.
      const transition = (async () => {
        const active = this.officialRuntime;
        const launchProvider = active?.alive
          ? requestedProvider
          : await this.providerForColdStart(requestedProvider);
        const launchFingerprint = providerFingerprint(launchProvider);
        if (active?.alive && this.officialRuntimeFingerprint !== launchFingerprint) {
          // Never replace a runtime while an official child or foreground
          // request is still live. The listing is the official runtime's
          // activity projection; diagnostics or a failed listing are treated
          // as uncertainty and fail closed.
          await this.assertOfficialRuntimeCanSwitch(active);
          await this.stopOfficialRuntime();
        } else if (active && !active.alive) {
          await this.stopOfficialRuntime();
        }

      const context = executionContext || {
        cwd: this.project,
        sandboxMode: "read-only",
        approvalPolicy: "never",
      };
      await ensureDirectory(this.userTempDirectory(), 0o700, this.uid, this.gid);
        const spec = this.launchSpec({
          apiKey: launchProvider.apiKey,
          baseUrl: launchProvider.baseUrl,
          model: launchProvider.model,
          wireApi: launchProvider.wireApi,
          ...context,
        });
      const startController = new AbortController();
      this.officialRuntimeStartController = startController;
      let child = null;
      let runtime = null;
      try {
        child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        runtime = new OfficialRuntimeClient(child, {
          onEvent: (event, params) => this.handleOfficialRuntimeEvent(event, params),
        });
        await runtime.request("ping", {}, startController.signal, {
          timeoutMs: RUNTIME_START_TIMEOUT_MS,
        });
        if (startController.signal.aborted || this.closing) {
          throw serviceError(503, "SUBAGENT_SERVICE_CLOSED", "第三方子代理服务正在关闭");
        }
        await this.persistOfficialRuntimeProvider(launchProvider, launchFingerprint);
        this.officialRuntime = runtime;
        this.officialRuntimeFingerprint = launchFingerprint;
        this.officialRuntimeProvider = { ...launchProvider };
        return runtime;
      } catch (error) {
        await runtime?.close().catch(() => {});
        if (!runtime && child && child.exitCode === null) {
          child.kill("SIGTERM");
          await waitForChildExit(child, RUNTIME_SHUTDOWN_TIMEOUT_MS);
          if (child.exitCode === null) child.kill("SIGKILL");
        }
        throw error;
      } finally {
        if (this.officialRuntimeStartController === startController) {
          this.officialRuntimeStartController = null;
        }
      }
      })();
      this.officialRuntimeStarting = transition;
      try {
        const runtime = await transition;
        // A cold control operation stays on the persisted provider owner. A
        // new task, however, must still honor the currently selected provider;
        // loop once more to perform the safe owner-to-requested transition.
        if (operation === "start" && this.officialRuntimeFingerprint !== requestedFingerprint) continue;
        return runtime;
      } finally {
        if (this.officialRuntimeStarting === transition) this.officialRuntimeStarting = null;
      }
    }
  }

  async assertOfficialRuntimeCanSwitch(runtime) {
    if (runtime.pending.size > 0) {
      throw serviceError(
        409,
        "SUBAGENT_PROVIDER_SWITCH_BUSY",
        "第三方子代理仍有未完成请求，暂不能切换供应商",
      );
    }
    const parentThreadIds = await this.persistedParentThreadIds();
    for (const parentThreadId of parentThreadIds) {
      let listed;
      try {
        listed = await runtime.request(
          "subagent/list",
          { parentThreadId, scope: "descendants" },
          null,
          { timeoutMs: RUNTIME_START_TIMEOUT_MS },
        );
      } catch (error) {
        throw serviceError(
          409,
          "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN",
          `无法确认已有子代理状态，暂不切换供应商：${error.message}`,
        );
      }
      const entries = Array.isArray(listed?.entries) ? listed.entries : [];
      for (const entry of entries) {
        if (entry?.kind !== "child") {
          throw serviceError(
            409,
            "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN",
            "已有子代理状态无法确认，暂不切换供应商",
          );
        }
        if (entry.activity === "running") {
          throw serviceError(
            409,
            "SUBAGENT_PROVIDER_SWITCH_BUSY",
            "已有子代理仍在运行，完成后才能切换供应商",
          );
        }
        if (entry.activity !== "inactive") {
          throw serviceError(
            409,
            "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN",
            "已有子代理状态无法确认，暂不切换供应商",
          );
        }
      }
    }
  }

  async providerForColdStart(requestedProvider) {
    const persisted = await this.readPersistedProviderState();
    if (!persisted) {
      if (await this.hasPersistedHostBindings()) {
        throw serviceError(
          409,
          "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN",
          "已有子代理没有可验证的 provider 所有权，暂不恢复",
        );
      }
      return requestedProvider;
    }
    if (persisted.fingerprint === providerIdentityFingerprint(requestedProvider)) return requestedProvider;
    if (!persisted.providerId) {
      throw serviceError(
        409,
        "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN",
        "运行时重启后无法确认旧子代理的 provider 所有权，暂不恢复",
      );
    }
    let owner;
    try {
      owner = await this.resolveOfficialProvider(persisted.providerId);
    } catch {
      owner = null;
    }
    if (!owner || providerIdentityFingerprint(owner) !== persisted.fingerprint) {
      throw serviceError(
        409,
        "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN",
        "旧子代理 provider 已不可验证，暂不恢复",
      );
    }
    return owner;
  }

  async readPersistedProviderState() {
    let raw;
    try {
      raw = await fs.readFile(this.providerStatePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw serviceError(409, "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN", "无法读取子代理 provider 所有权，暂不恢复");
    }
    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      throw serviceError(409, "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN", "子代理 provider 所有权记录已损坏，暂不恢复");
    }
    if (
      !state
      || typeof state !== "object"
      || state.version !== 1
      || !/^[a-f0-9]{64}$/u.test(String(state.fingerprint || ""))
      || (state.providerId !== null && typeof state.providerId !== "string")
    ) {
      throw serviceError(409, "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN", "子代理 provider 所有权记录无效，暂不恢复");
    }
    return {
      fingerprint: String(state.fingerprint),
      providerId: typeof state.providerId === "string" && state.providerId ? state.providerId : null,
    };
  }

  async hasPersistedHostBindings() {
    let raw;
    try {
      raw = await fs.readFile(this.hostBindingsPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw serviceError(409, "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN", "无法读取子代理父会话绑定，暂不恢复");
    }
    let bindings;
    try {
      bindings = JSON.parse(raw);
    } catch {
      throw serviceError(409, "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN", "子代理父会话绑定已损坏，暂不恢复");
    }
    if (!Array.isArray(bindings)) {
      throw serviceError(409, "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN", "子代理父会话绑定无效，暂不恢复");
    }
    return bindings.length > 0;
  }

  async persistOfficialRuntimeProvider(provider, fingerprint) {
    if (providerFingerprint(provider) !== fingerprint) {
      throw serviceError(409, "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN", "provider 所有权校验失败");
    }
    await ensureDirectory(this.directory, 0o700, this.uid, this.gid);
    const temporaryPath = `${this.providerStatePath}.${process.pid}.tmp`;
    const state = {
      version: 1,
      providerId: provider.providerId || null,
      fingerprint: providerIdentityFingerprint(provider),
    };
    await fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await fs.chmod(temporaryPath, 0o600);
    if (this.uid !== null && this.gid !== null) await fs.chown(temporaryPath, this.uid, this.gid);
    await fs.rename(temporaryPath, this.providerStatePath);
  }

  async persistedParentThreadIds() {
    const parentThreadIds = new Set(this.knownParentThreadIds);
    let raw;
    try {
      raw = await fs.readFile(this.hostBindingsPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [...parentThreadIds];
      throw serviceError(409, "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN", "无法读取子代理父会话绑定，暂不切换供应商");
    }
    let bindings;
    try {
      bindings = JSON.parse(raw);
    } catch {
      throw serviceError(409, "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN", "子代理父会话绑定已损坏，暂不切换供应商");
    }
    if (!Array.isArray(bindings)) {
      throw serviceError(409, "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN", "子代理父会话绑定无效，暂不切换供应商");
    }
    for (const binding of bindings) {
      const parentThreadId = binding?.parentThreadId;
      if (
        typeof parentThreadId !== "string"
        || !parentThreadId
        || parentThreadId.length > 256
        || /[\u0000\r\n]/u.test(parentThreadId)
      ) {
        throw serviceError(409, "SUBAGENT_PROVIDER_SWITCH_UNCERTAIN", "子代理父会话绑定无效，暂不切换供应商");
      }
      parentThreadIds.add(parentThreadId);
    }
    return [...parentThreadIds];
  }

  launchSpec({ apiKey, baseUrl, model, wireApi, cwd, sandboxMode, approvalPolicy }) {
    const inherited = process.env;
    const environment = {
      PATH: inherited.PATH || "/usr/local/bin:/usr/bin:/bin",
      ...(inherited.HOME ? { HOME: inherited.HOME } : {}),
      ...(inherited.LANG ? { LANG: inherited.LANG } : {}),
      ...(inherited.LC_ALL ? { LC_ALL: inherited.LC_ALL } : {}),
      ...(inherited.TZ ? { TZ: inherited.TZ } : {}),
      ...copyEnvironment(inherited, [
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "http_proxy", "https_proxy", "all_proxy", "no_proxy",
      ]),
      WFL_SUBAGENT_API_KEY: apiKey,
      WFL_SUBAGENT_BASE_URL: baseUrl,
      WFL_SUBAGENT_MODEL: model,
      WFL_SUBAGENT_API: wireApi,
      WFL_SUBAGENT_SANDBOX_MODE: sandboxMode,
      HOME: this.userHome(),
      TMPDIR: this.userTempDirectory(),
      DSH_CWD: cwd,
      DSH_SESSION_ROOT: this.sessionRoot,
      DSH_HOST_BINDINGS_PATH: path.join(this.directory, "host-bindings.json"),
    };
    const args = [this.runtimeScriptPath, this.configPath];
    if (shouldDropPrivileges(this.uid, this.gid)) {
      if (process.platform !== "linux") {
        throw serviceError(503, "SUBAGENT_ISOLATION_UNAVAILABLE", "当前平台无法按账号身份启动子代理");
      }
      return {
        command: "/usr/bin/setpriv",
        args: [
          `--reuid=${this.uid}`,
          `--regid=${this.gid}`,
          "--init-groups",
          "--",
          process.execPath,
          ...args,
        ],
        cwd,
        env: environment,
      };
    }
    return { command: process.execPath, args, cwd, env: environment };
  }

  userHome() {
    return this.home;
  }

  userTempDirectory() {
    return path.join(this.userHome(), "tmp");
  }

  handleOfficialRuntimeEvent(event, params) {
    if (event !== "subagent/settled" || !this.settlementSink) return;
    Promise.resolve(this.settlementSink(params)).catch((error) => {
      // Settlement delivery is an observation/notification path. A parent
      // transport failure must not take down the official runtime or change
      // the already-settled child result.
      console.error(`DeepSeek subagent settlement delivery failed: ${error?.message || error}`);
    });
  }

  async respond(socket, value) {
    const payload = `${JSON.stringify(value)}\n`;
    if (!socket.destroyed && socket.writable) await new Promise((resolve) => socket.end(payload, resolve));
  }

  async close() {
    this.closing = true;
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const harnesses = [...this.harnesses];
    this.harnesses.clear();
    this.officialRuntimeStartController?.abort();
    const starting = this.officialRuntimeStarting;
    if (starting) await Promise.allSettled([starting]);
    await Promise.allSettled([
      ...harnesses.map((harness) => harness.close()),
      this.stopOfficialRuntime(),
    ]);
    if (server) await closeServer(server);
    if (this.socketOwned) {
      this.socketOwned = false;
      await fs.unlink(this.socketPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await fs.unlink(this.authTokenPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async stopOfficialRuntime() {
    const runtime = this.officialRuntime;
    this.officialRuntime = null;
    this.officialRuntimeFingerprint = null;
    this.officialRuntimeProvider = null;
    if (!runtime) return;
    await runtime.close().catch(() => {});
  }
}

function normalizeExecutionContext(value) {
  const cwd = typeof value?.cwd === "string" && path.isAbsolute(value.cwd)
    ? path.resolve(value.cwd)
    : null;
  const sandboxMode = String(value?.sandboxMode || "");
  const approvalPolicy = String(value?.approvalPolicy || "");
  if (!cwd || !SANDBOX_MODES.has(sandboxMode) || !APPROVAL_POLICIES.has(approvalPolicy)) {
    throw serviceError(409, "SUBAGENT_PARENT_CONTEXT_INVALID", "无法安全继承父会话的目录或权限");
  }
  // The current cross-process bridge has no approval/request round-trip. The
  // Harness composition therefore pins child approval to `never`; accepting
  // an ask/on-request parent here would silently widen the child's authority.
  // Fail closed until an actual approval bridge exists.
  if (approvalPolicy !== "never") {
    throw serviceError(
      409,
      "SUBAGENT_APPROVAL_UNSUPPORTED",
      "第三方子代理暂不支持需要人工审批的父会话",
    );
  }
  return { cwd, sandboxMode, approvalPolicy };
}

function parseRequest(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    throw serviceError(400, "SUBAGENT_INVALID_REQUEST", "子代理请求不是有效 JSON");
  }
  if (!request || typeof request !== "object" || Array.isArray(request) || request.version !== 1) {
    throw serviceError(400, "SUBAGENT_INVALID_REQUEST", "子代理请求无效");
  }
  const allowed = new Set([
    "version",
    "authToken",
    "operation",
    "description",
    "prompt",
    "runInBackground",
    "childId",
    "message",
    "scope",
    "parentThreadId",
    "parentTurnId",
  ]);
  if (Object.keys(request).some((key) => !allowed.has(key))) {
    throw serviceError(400, "SUBAGENT_INVALID_ARGUMENTS", "子代理请求包含不支持的字段");
  }
  const operation = typeof request.operation === "string" && request.operation.trim()
    ? request.operation.trim()
    : "start";
  if (!["start", "send_message", "interrupt_agent", "list_agents"].includes(operation)) {
    throw serviceError(400, "SUBAGENT_INVALID_ARGUMENTS", "子代理操作无效");
  }
  const description = operation === "start" ? cleanPrompt(request.description, "description") : "";
  const prompt = operation === "start" ? cleanPrompt(request.prompt, "prompt") : "";
  const parentThreadId = request.parentThreadId == null
    ? null
    : cleanThreadId(request.parentThreadId);
  const parentTurnId = request.parentTurnId == null
    ? null
    : cleanThreadId(request.parentTurnId, "parentTurnId");
  if (parentTurnId && !parentThreadId) {
    throw serviceError(400, "SUBAGENT_INVALID_ARGUMENTS", "parentTurnId 不能脱离 parentThreadId 使用");
  }
  if (!parentThreadId) {
    throw serviceError(400, "SUBAGENT_PARENT_METADATA_REQUIRED", "子代理操作缺少父线程元数据");
  }
  const childId = operation === "start" || operation === "list_agents"
    ? null
    : cleanThreadId(request.childId, "childId");
  const message = operation === "send_message" ? cleanPrompt(request.message, "message") : null;
  const scope = request.scope === "descendants" ? "descendants" : "children";
  return {
    authToken: request.authToken,
    operation,
    description,
    prompt,
    runInBackground: request.runInBackground === true,
    childId,
    message,
    scope,
    parentThreadId,
    parentTurnId,
  };
}

function cleanPrompt(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /[\u0000]/u.test(text)) {
    throw serviceError(400, "SUBAGENT_INVALID_ARGUMENTS", `${name} 必须是非空文本`);
  }
  return text;
}

function cleanThreadId(value, name = "parentThreadId") {
  if (
    typeof value !== "string"
    || !value
    || value.length > 256
    || value !== value.trim()
    || /[\u0000\r\n]/u.test(value)
  ) {
    throw serviceError(400, "SUBAGENT_INVALID_ARGUMENTS", `${name} 无效`);
  }
  return value;
}

function providerFingerprint(provider) {
  return JSON.stringify([
    provider.providerId || null,
    provider.apiKey,
    provider.baseUrl,
    provider.model,
    provider.wireApi,
  ]);
}

function providerIdentityFingerprint(provider) {
  return crypto.createHash("sha256").update(providerFingerprint(provider)).digest("hex");
}

function normalizeOfficialRuntimeResult(result) {
  const stopReason = typeof result?.stopReason === "string" ? result.stopReason : "error";
  const finalResponse = typeof result?.finalResponse === "string" ? result.finalResponse : "";
  if (stopReason !== "completed") {
    const kind = stopReason.replace(/[^a-z0-9_-]/giu, "_").toUpperCase() || "UNKNOWN";
    const error = serviceError(502, `SUBAGENT_${kind}`, `DeepSeek 子代理未完成任务（${kind}）`);
    error.stopReason = stopReason;
    if (finalResponse.trim()) error.partialOutput = finalResponse;
    throw error;
  }
  if (!finalResponse.trim()) {
    throw serviceError(502, "SUBAGENT_EMPTY_RESULT", "DeepSeek 子代理未返回最终结果");
  }
  return { finalResponse };
}

class OfficialRuntimeClient {
  constructor(child, { onEvent = null } = {}) {
    this.child = child;
    this.alive = true;
    this.nextId = 1;
    this.buffer = "";
    this.pending = new Map();
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.closePromise = null;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.read(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {});
    child.once("error", (error) => {
      this.alive = false;
      this.fail(error);
      this.resolveExit();
    });
    child.once("exit", (code, signal) => {
      this.alive = false;
      const error = new Error(`DeepSeek runtime exited (${signal || code || "unknown"})`);
      error.code = "SUBAGENT_RUNTIME_EXITED";
      this.fail(error);
      this.resolveExit();
    });
  }

  request(method, params = {}, signal = null, { timeoutMs = null } = {}) {
    if (!this.alive || !this.child.stdin.writable) {
      return Promise.reject(serviceError(503, "SUBAGENT_RUNTIME_UNAVAILABLE", "DeepSeek 子代理 runtime 不可用"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let abortListener = null;
      let timeout = null;
      const finish = (operation) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (timeout) clearTimeout(timeout);
        if (abortListener) signal?.removeEventListener("abort", abortListener);
        operation();
      };
      abortListener = () => {
        this.cancelRequest(id);
        finish(() => reject(serviceError(499, "SUBAGENT_CANCELLED", "子代理工具调用已取消")));
      };
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      if (signal?.aborted) {
        abortListener();
        return;
      }
      signal?.addEventListener("abort", abortListener, { once: true });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeout = setTimeout(() => {
          this.cancelRequest(id);
          finish(() => reject(serviceError(504, "SUBAGENT_RUNTIME_TIMEOUT", "DeepSeek 子代理 runtime 响应超时")));
        }, timeoutMs);
      }
      try {
        this.child.stdin.write(`${JSON.stringify({ version: 1, id, method, params })}\n`);
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  cancelRequest(id) {
    if (!this.alive || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify({
        version: 1,
        method: "cancel",
        params: { requestId: id },
      })}\n`);
    } catch {
      // The child may have exited between the cancellation decision and the
      // write. Its exit handler rejects the remaining requests.
    }
  }

  read(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(serviceError(502, "SUBAGENT_RUNTIME_PROTOCOL", "DeepSeek 子代理 runtime 返回了无效响应"));
        continue;
      }
      if (message.event) {
        this.onEvent?.(message.event, message.params);
        continue;
      }
      if (!Object.hasOwn(message, "id")) continue;
      const pending = this.pending.get(Number(message.id));
      if (!pending) continue;
      if (message.ok === true) pending.resolve(message.result);
      else {
        const error = serviceError(
          502,
          safeErrorCode(message.error?.code || "SUBAGENT_RUNTIME_ERROR"),
          message.error?.message || "DeepSeek 子代理 runtime 执行失败",
        );
        pending.reject(error);
      }
    }
  }

  fail(error) {
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.pending.clear();
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (!this.alive) return;
      try {
        await this.request("shutdown", {}, null, { timeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS });
      } catch {
        if (this.alive) this.child.kill("SIGTERM");
      }
      await waitForChildExit(this.child, RUNTIME_SHUTDOWN_TIMEOUT_MS, this.exitPromise);
      if (this.alive) this.child.kill("SIGKILL");
      await this.exitPromise;
    })();
    return this.closePromise;
  }
}

function normalizeHarnessResult(result) {
  const finalResponse = typeof result?.finalResponse === "string" ? result.finalResponse : "";
  if (Array.isArray(result?.events)) {
    const turnEnd = lastEventOfType(result.events, "turn/end");
    const reason = turnEnd?.data?.reason;
    if (!reason || typeof reason.kind !== "string") {
      throw serviceError(502, "SUBAGENT_RESULT_INCOMPLETE", "DeepSeek Harness 未返回完整的任务结束状态");
    }
    if (reason.kind !== "completed") {
      const kind = reason.kind.replace(/[^a-z0-9_-]/giu, "_").toUpperCase() || "UNKNOWN";
      const error = serviceError(502, `SUBAGENT_${kind}`, `DeepSeek Harness 子代理未完成任务（${kind}）`);
      error.stopReason = reason.kind;
      if (finalResponse.trim()) error.partialOutput = finalResponse;
      throw error;
    }
  }
  if (!finalResponse.trim()) {
    throw serviceError(502, "SUBAGENT_EMPTY_RESULT", "DeepSeek Harness 子代理未返回最终结果");
  }
  return { finalResponse };
}

function lastEventOfType(events, type) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === type) return events[index];
  }
  return null;
}

function copyEnvironment(environment, names) {
  return Object.fromEntries(names
    .filter((name) => typeof environment[name] === "string")
    .map((name) => [name, environment[name]]));
}

function shouldDropPrivileges(uid, gid) {
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return false;
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return false;
  if (process.getuid() === uid && process.getgid() === gid) return false;
  if (process.getuid() !== 0) {
    throw serviceError(503, "SUBAGENT_ISOLATION_UNAVAILABLE", "服务进程没有按账号启动子代理的权限");
  }
  return uid !== 0 || gid !== 0;
}

async function waitForChildExit(child, timeoutMs, exitPromise = null) {
  if (!child || child.exitCode !== null) return true;
  const exited = exitPromise || new Promise((resolve) => child.once("exit", resolve));
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || 1));
  });
  const result = await Promise.race([exited.then(() => true), timeout]);
  clearTimeout(timer);
  return result;
}

async function ensureDirectory(directory, mode, uid, gid) {
  await fs.mkdir(directory, { recursive: true, mode });
  await fs.chmod(directory, mode);
  if (uid !== null && gid !== null) await fs.chown(directory, uid, gid);
}

async function cleanupStaleSocketFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isSocket() || !SOCKET_FILE_PATTERN.test(entry.name)) continue;
    const socketPath = path.join(directory, entry.name);
    const listener = await probeSocketListener(socketPath);
    if (listener !== false) continue;
    await fs.unlink(socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function removeStaleSocket(socketPath) {
  let stat;
  try {
    stat = await fs.lstat(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket()) {
    throw serviceError(409, "SUBAGENT_SOCKET_PATH_OCCUPIED", "第三方子代理 socket 路径已被其他文件占用");
  }
  const listener = await probeSocketListener(socketPath);
  if (listener === true) {
    throw serviceError(409, "SUBAGENT_SOCKET_IN_USE", "第三方子代理 socket 仍有活动实例");
  }
  if (listener === null) {
    throw serviceError(503, "SUBAGENT_SOCKET_UNCERTAIN", "无法确认旧的第三方子代理 socket 是否仍在使用");
  }
  await fs.unlink(socketPath);
}

function probeSocketListener(socketPath) {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      probe.destroy();
      resolve(value);
    };
    probe.once("connect", () => finish(true));
    probe.once("error", (error) => {
      if (["ECONNREFUSED", "ENOENT", "ENOTSOCK"].includes(error.code)) finish(false);
      else finish(null);
    });
    probe.setTimeout(SOCKET_PROBE_TIMEOUT_MS, () => finish(null));
  });
}

async function assertSocketFile(socketPath) {
  let stat;
  try {
    stat = await fs.lstat(socketPath);
  } catch (error) {
    throw serviceError(
      503,
      "SUBAGENT_SOCKET_NOT_CREATED",
      `第三方子代理 socket 创建失败（${error.code || "未知错误"}）`,
    );
  }
  if (!stat.isSocket()) {
    throw serviceError(503, "SUBAGENT_SOCKET_NOT_CREATED", "第三方子代理未创建有效 Unix socket");
  }
}

async function removePersistedSession(sessionRoot, sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return;
  const encodedSessionId = encodeSessionPathSegment(sessionId);
  let projects;
  try {
    projects = await fs.readdir(sessionRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const projectPath = path.join(sessionRoot, project.name);
    const sessionPath = path.join(projectPath, encodedSessionId);
    let sessionStat;
    try {
      sessionStat = await fs.lstat(sessionPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) continue;
    await fs.rm(sessionPath, { recursive: true, force: true });
    await fs.rm(projectPath, { force: true }).catch((error) => {
      if (!(["ENOENT", "ENOTEMPTY"].includes(error.code))) throw error;
    });
  }
}

function encodeSessionPathSegment(value) {
  if (!/^[A-Za-z0-9._-]+$/u.test(value) || value === "." || value === "..") {
    throw new Error("invalid DeepSeek Harness session id");
  }
  return value;
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve())).catch(() => {});
}

function secretsEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serviceError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function errorResponse(error) {
  return {
    version: 1,
    ok: false,
    error: {
      status: Number.isInteger(error?.status) ? error.status : 500,
      code: safeErrorCode(error?.code),
      message: sanitizeErrorMessage(error?.message || "第三方子代理执行失败"),
      ...(typeof error?.stopReason === "string" ? { stopReason: error.stopReason } : {}),
      ...(typeof error?.partialOutput === "string" && error.partialOutput.trim()
        ? { partialOutput: error.partialOutput }
        : {}),
    },
  };
}

function safeErrorCode(value) {
  const code = String(value || "SUBAGENT_ERROR");
  return /^[A-Z0-9_:-]{1,80}$/u.test(code) ? code : "SUBAGENT_ERROR";
}

function sanitizeErrorMessage(value) {
  let message = String(value || "第三方子代理执行失败");
  message = message
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[redacted-api-key]")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/giu, "$1[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
  return message.slice(0, 4_000);
}
