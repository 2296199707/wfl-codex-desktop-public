import { normalizeWindowsHostCall } from "./windows-host-policy.mjs";
import { deviceWebSocketUrl } from "./config.mjs";
import { WindowsCodexHost } from "./codex-host.mjs";
import { WindowsCreatorHost } from "./creator-host.mjs";

export class WindowsHostAgent {
  constructor(config, {
    WebSocketImpl = globalThis.WebSocket,
    codexHost = null,
    creatorHost = null,
  } = {}) {
    if (typeof WebSocketImpl !== "function") throw new Error("Node.js 22 or newer with WebSocket support is required");
    this.config = config;
    this.WebSocketImpl = WebSocketImpl;
    this.codex = codexHost || new WindowsCodexHost(config);
    this.creator = creatorHost || new WindowsCreatorHost(config);
    this.socket = null;
    this.stopped = false;
    this.reconnectDelayMs = 1_000;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.device = null;
    this.authorizedPlugins = new Set();
    this.activeLease = null;
    this.highestRevokedLeaseEpoch = 0;
    this.inFlight = new Map();
  }

  async initialize() {
    await this.creator.initialize();
    return this;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.cancelCreatorCalls();
    this.socket?.close(1000, "Agent stopped");
    await this.codex.close();
  }

  connect() {
    if (this.stopped) return;
    const socket = new this.WebSocketImpl(deviceWebSocketUrl(this.config.serverUrl));
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({
        type: "authenticate",
        deviceId: this.config.deviceId,
        token: this.config.token,
        agentVersion: "0.1.0",
        protocolVersion: 1,
      }));
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      void this.handleMessage(event.data).catch(() => socket.close(1011, "Agent message failed"));
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.device = null;
      this.authorizedPlugins.clear();
      this.activeLease = null;
      this.highestRevokedLeaseEpoch = 0;
      clearInterval(this.heartbeatTimer);
      this.cancelCreatorCalls();
      if (!this.stopped) this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {});
  }

  async handleMessage(raw) {
    const message = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    if (message.type === "authenticated") {
      this.device = message.device;
      this.authorizedPlugins = new Set(message.authorizedPlugins || []);
      this.highestRevokedLeaseEpoch = 0;
      this.reconnectDelayMs = 1_000;
      clearInterval(this.heartbeatTimer);
      const interval = boundedHeartbeatInterval(message.heartbeatIntervalMs);
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), interval);
      this.heartbeatTimer.unref?.();
      const [codex, creator] = await Promise.all([
        this.codex.capabilities(),
        Promise.resolve(this.creator.capabilities()),
      ]);
      this.send({
        type: "capabilities",
        capabilities: {
          codex: { available: codex.available, appServer: codex.appServer, version: codex.version },
          creator,
        },
      });
      this.sendHeartbeat();
      return;
    }
    if (message.type === "heartbeatAck") return;
    if (message.type === "leaseRevoked") {
      const revokedContext = normalizeContext(message.context);
      if (this.activeLease && sameContext(this.activeLease, revokedContext)) {
        this.cancelCreatorCalls(revokedContext);
        this.activeLease = null;
      }
      if (
        revokedContext.userId === this.device?.userId
        && revokedContext.deviceId === this.device?.id
        && revokedContext.deviceEpoch === this.device?.epoch
      ) {
        this.highestRevokedLeaseEpoch = Math.max(this.highestRevokedLeaseEpoch, revokedContext.leaseEpoch);
      }
      return;
    }
    if (message.type !== "call" || !this.device) throw new Error("Unsupported server message");
    await this.handleCall(message);
  }

  async handleCall(message) {
    const context = normalizeContext(message.context);
    if (
      context.userId !== this.device.userId
      || context.deviceId !== this.device.id
      || context.deviceEpoch !== this.device.epoch
      || !this.authorizedPlugins.has(message.pluginId)
    ) {
      throw new Error("Call context does not match the authenticated device");
    }
    if (context.leaseEpoch <= this.highestRevokedLeaseEpoch) {
      await this.replyError(message, "Windows Host lease was already revoked", context);
      return;
    }
    if (this.activeLease && !sameContext(this.activeLease, context)) {
      await this.replyError(message, "Another Thread owns this Windows Host lease");
      return;
    }
    this.activeLease = context;
    const params = normalizeWindowsHostCall(message.pluginId, message.method, message.params || {});
    const call = {
      context,
      creatorJobId: message.pluginId === "creator-worker" && message.method === "creator.job.run"
        ? params.jobId
        : null,
    };
    this.inFlight.set(message.callId, call);
    try {
      const result = message.pluginId === "windows-codex-remote"
        ? await this.codex.call(message.method, params)
        : await this.creator.call(message.method, params);
      if (this.inFlight.get(message.callId) !== call || !sameContext(this.activeLease, context)) return;
      this.send({ type: "callResult", callId: message.callId, ok: true, result, context });
    } catch (error) {
      if (this.inFlight.get(message.callId) !== call || !sameContext(this.activeLease, context)) return;
      await this.replyError(message, safeCallError(error, this.config), context);
    } finally {
      this.inFlight.delete(message.callId);
    }
  }

  async replyError(message, errorMessage, context = normalizeContext(message.context)) {
    this.send({
      type: "callResult",
      callId: message.callId,
      ok: false,
      error: { message: String(errorMessage).slice(0, 300) },
      context,
    });
  }

  sendHeartbeat() {
    if (!this.device) return;
    this.send({ type: "heartbeat", deviceEpoch: this.device.epoch });
  }

  send(message) {
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) this.socket.send(JSON.stringify(message));
  }

  cancelCreatorCalls(context = null) {
    for (const [callId, call] of this.inFlight) {
      if (!call.creatorJobId || (context && !sameContext(call.context, context))) continue;
      this.creator.cancel(call.creatorJobId);
      this.inFlight.delete(callId);
    }
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(30_000, Math.round(this.reconnectDelayMs * 1.8));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }
}

function normalizeContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing call context");
  const deviceEpoch = Number(value.deviceEpoch);
  const leaseEpoch = Number(value.leaseEpoch);
  if (!Number.isSafeInteger(deviceEpoch) || deviceEpoch < 1 || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
    throw new Error("Invalid call epoch");
  }
  return {
    userId: opaqueId(value.userId),
    deviceId: opaqueId(value.deviceId),
    deviceEpoch,
    threadId: opaqueId(value.threadId),
    leaseEpoch,
  };
}

function sameContext(left, right) {
  return Boolean(left && right
    && left.userId === right.userId
    && left.deviceId === right.deviceId
    && left.deviceEpoch === right.deviceEpoch
    && left.threadId === right.threadId
    && left.leaseEpoch === right.leaseEpoch);
}

function opaqueId(value) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error("Invalid context identifier");
  return id;
}

function boundedHeartbeatInterval(value) {
  const interval = Number(value);
  return Number.isSafeInteger(interval) && interval >= 5_000 && interval <= 30_000 ? interval : 15_000;
}

function safeCallError(error, config) {
  let message = typeof error?.message === "string" ? error.message : "Windows Host call failed";
  for (const localPath of [config.workspaceRoot, ...config.projects.map((project) => project.path)]) {
    if (localPath) message = message.replaceAll(localPath, "[local path]");
  }
  message = message.replace(/[A-Za-z]:\\[^\r\n]*/g, "[local path]");
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300) || "Windows Host call failed";
}
