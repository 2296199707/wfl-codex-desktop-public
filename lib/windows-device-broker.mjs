import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { normalizeWindowsHostCall } from "./windows-host-policy.mjs";

const DEFAULT_LEASE_TTL_MS = 60_000;
const MAX_LEASE_TTL_MS = 15 * 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_CALL_TIMEOUT_MS = 15 * 60_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const MAX_PENDING_CALLS_PER_DEVICE = 4;

export class WindowsDeviceBroker extends EventEmitter {
  constructor(deviceStore, {
    isPluginAuthorized,
    now = () => Date.now(),
    randomUUID = crypto.randomUUID,
  } = {}) {
    super();
    if (typeof isPluginAuthorized !== "function") throw new TypeError("isPluginAuthorized is required");
    this.deviceStore = deviceStore;
    this.isPluginAuthorized = isPluginAuthorized;
    this.now = now;
    this.randomUUID = randomUUID;
    this.connections = new Map();
    this.connectionsById = new Map();
    this.leases = new Map();
    this.leaseEpochs = new Map();
    this.pendingCalls = new Map();
  }

  async authenticateConnection({ deviceId, token, transport, agentVersion = null, protocolVersion = null }) {
    if (!transport || typeof transport.send !== "function" || typeof transport.close !== "function") {
      throw brokerError(500, "设备传输不可用");
    }
    const device = this.deviceStore.authenticate(deviceId, token);
    const authorizedPlugins = device.pluginIds.filter((pluginId) => (
      this.isPluginAuthorized({ userId: device.userId, pluginId }) === true
    ));
    if (!authorizedPlugins.length) throw brokerError(403, "设备插件未授权或未启用");
    const current = this.connections.get(device.id);
    if (current) this.disconnectConnection(current.id, "Device reconnected", 4002);
    const touched = await this.deviceStore.touch(device.id, { agentVersion, protocolVersion });
    const connection = {
      id: `connection_${this.randomUUID()}`,
      deviceId: touched.id,
      userId: touched.userId,
      deviceEpoch: touched.epoch,
      pluginIds: authorizedPlugins,
      transport,
      connectedAt: this.now(),
      lastHeartbeatAt: this.now(),
      capabilities: null,
    };
    this.connections.set(touched.id, connection);
    this.connectionsById.set(connection.id, connection);
    this.emit("deviceConnected", this.publicConnection(connection));
    return {
      connectionId: connection.id,
      device: touched,
      authorizedPlugins,
      heartbeatIntervalMs: 15_000,
    };
  }

  snapshot(userId) {
    const base = this.deviceStore.snapshot(userId);
    return {
      ...base,
      devices: base.devices.map((device) => {
        const connection = this.connections.get(device.id);
        const lease = this.leases.get(device.id);
        return {
          ...device,
          online: Boolean(connection && connection.deviceEpoch === device.epoch),
          connectedAt: connection?.connectedAt || null,
          lastHeartbeatAt: connection?.lastHeartbeatAt || null,
          capabilities: connection?.capabilities ? structuredClone(connection.capabilities) : null,
          lease: lease ? publicLease(lease) : null,
        };
      }),
    };
  }

  acquireLease({
    userId,
    deviceId,
    pluginId,
    threadId,
    browserSessionId,
    windowId,
    ttlMs = DEFAULT_LEASE_TTL_MS,
  }) {
    this.sweepExpired();
    const connection = this.requireConnection(userId, deviceId, pluginId);
    const context = normalizeLeaseContext({ userId, deviceId, pluginId, threadId, browserSessionId, windowId });
    const boundedTtl = normalizeDuration(ttlMs, DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS, "租约有效期");
    const existing = this.leases.get(context.deviceId);
    if (existing) {
      if (!sameLeaseOwner(existing, context)) throw brokerError(409, "设备正由另一个 Thread 使用");
      existing.expiresAt = this.now() + boundedTtl;
      return publicLease(existing);
    }
    const leaseEpoch = (this.leaseEpochs.get(context.deviceId) || 0) + 1;
    this.leaseEpochs.set(context.deviceId, leaseEpoch);
    const lease = {
      ...context,
      deviceEpoch: connection.deviceEpoch,
      leaseEpoch,
      acquiredAt: this.now(),
      expiresAt: this.now() + boundedTtl,
    };
    this.leases.set(context.deviceId, lease);
    this.emit("leaseAcquired", publicLease(lease));
    return publicLease(lease);
  }

  renewLease(context, ttlMs = DEFAULT_LEASE_TTL_MS) {
    const lease = this.requireLease(context);
    lease.expiresAt = this.now() + normalizeDuration(ttlMs, DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS, "租约有效期");
    return publicLease(lease);
  }

  releaseLease(context, reason = "Lease released") {
    const lease = this.requireLease(context);
    this.dropLease(lease, reason);
    return true;
  }

  call({
    userId,
    deviceId,
    pluginId,
    threadId,
    leaseEpoch,
    browserSessionId,
    windowId,
    method,
    params,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  }) {
    this.sweepExpired();
    const lease = this.requireLease({
      userId,
      deviceId,
      pluginId,
      threadId,
      leaseEpoch,
      browserSessionId,
      windowId,
    });
    const connection = this.requireConnection(userId, deviceId, pluginId);
    if (connection.deviceEpoch !== lease.deviceEpoch) throw brokerError(409, "设备上下文已变化，请重新取得租约");
    if ([...this.pendingCalls.values()].filter((pending) => pending.deviceId === deviceId).length >= MAX_PENDING_CALLS_PER_DEVICE) {
      throw brokerError(429, "Windows Host 同时调用过多");
    }
    const normalizedParams = normalizeWindowsHostCall(pluginId, method, params);
    const callId = `call_${this.randomUUID()}`;
    const boundedTimeout = normalizeDuration(timeoutMs, DEFAULT_CALL_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS, "调用超时");
    const envelope = {
      type: "call",
      callId,
      pluginId,
      method,
      params: normalizedParams,
      context: {
        userId,
        deviceId,
        deviceEpoch: lease.deviceEpoch,
        threadId,
        leaseEpoch: lease.leaseEpoch,
      },
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingCalls.get(callId);
        if (!pending) return;
        this.pendingCalls.delete(callId);
        reject(brokerError(504, "Windows Host 调用超时；未自动重试"));
      }, boundedTimeout);
      timer.unref?.();
      const pending = {
        callId,
        connectionId: connection.id,
        userId,
        deviceId,
        pluginId,
        deviceEpoch: lease.deviceEpoch,
        threadId,
        leaseEpoch: lease.leaseEpoch,
        browserSessionId,
        windowId,
        timer,
        resolve,
        reject,
      };
      this.pendingCalls.set(callId, pending);
      try {
        connection.transport.send(JSON.stringify(envelope));
      } catch {
        clearTimeout(timer);
        this.pendingCalls.delete(callId);
        reject(brokerError(503, "Windows Host 已断开；调用未排队"));
      }
    });
  }

  handleCallResult(connectionId, message) {
    const connection = this.connectionsById.get(String(connectionId));
    if (!connection) return false;
    const callId = String(message?.callId || "");
    const pending = this.pendingCalls.get(callId);
    if (!pending || pending.connectionId !== connection.id) return false;
    const context = message?.context;
    const lease = this.leases.get(pending.deviceId);
    const currentDevice = this.deviceStore.get(pending.deviceId);
    const current = Boolean(
      lease
      && currentDevice
      && currentDevice.status === "active"
      && currentDevice.epoch === pending.deviceEpoch
      && connection.deviceEpoch === pending.deviceEpoch
      && lease.deviceEpoch === pending.deviceEpoch
      && lease.leaseEpoch === pending.leaseEpoch
      && lease.threadId === pending.threadId
      && context?.userId === pending.userId
      && context?.deviceId === pending.deviceId
      && context?.deviceEpoch === pending.deviceEpoch
      && context?.threadId === pending.threadId
      && context?.leaseEpoch === pending.leaseEpoch
    );
    if (!current) return false;
    clearTimeout(pending.timer);
    this.pendingCalls.delete(callId);
    if (message.ok === true) {
      pending.resolve(message.result ?? null);
    } else {
      pending.reject(brokerError(502, safeDeviceError(message.error)));
    }
    return true;
  }

  heartbeat(connectionId, { deviceEpoch } = {}) {
    const connection = this.connectionsById.get(String(connectionId));
    if (!connection || connection.deviceEpoch !== Number(deviceEpoch)) return false;
    connection.lastHeartbeatAt = this.now();
    return true;
  }

  updateCapabilities(connectionId, value) {
    const connection = this.connectionsById.get(String(connectionId));
    if (!connection) return false;
    connection.capabilities = normalizeHostCapabilities(value);
    this.emit("capabilities", {
      ...this.publicConnection(connection),
      capabilities: structuredClone(connection.capabilities),
    });
    return true;
  }

  disconnectConnection(connectionId, reason = "Device disconnected", closeCode = 4000) {
    const connection = this.connectionsById.get(String(connectionId));
    if (!connection) return false;
    this.connectionsById.delete(connection.id);
    if (this.connections.get(connection.deviceId)?.id === connection.id) this.connections.delete(connection.deviceId);
    const lease = this.leases.get(connection.deviceId);
    if (lease) this.dropLease(lease, reason);
    for (const pending of [...this.pendingCalls.values()]) {
      if (pending.connectionId === connection.id) this.rejectPending(pending, brokerError(503, "Windows Host 已断开；调用未排队"));
    }
    try {
      connection.transport.close(closeCode, String(reason).slice(0, 120));
    } catch {
      // The transport may already be closed.
    }
    this.emit("deviceDisconnected", { ...this.publicConnection(connection), reason });
    return true;
  }

  async revokeDevice(userId, deviceId) {
    const device = await this.deviceStore.revoke(userId, deviceId);
    const connection = this.connections.get(device.id);
    if (connection) this.disconnectConnection(connection.id, "Device revoked", 4003);
    return device;
  }

  async revokePlugin(userId, pluginId) {
    const devices = await this.deviceStore.revokePlugin(userId, pluginId);
    for (const device of devices) {
      const connection = this.connections.get(device.id);
      if (connection) this.disconnectConnection(connection.id, "Plugin authorization changed", 4003);
    }
    return devices;
  }

  async revokePluginForAll(pluginId) {
    const devices = await this.deviceStore.revokePluginForAll(pluginId);
    for (const device of devices) {
      const connection = this.connections.get(device.id);
      if (connection) this.disconnectConnection(connection.id, "Plugin disabled or uninstalled", 4003);
    }
    return devices;
  }

  releaseBrowserSession(browserSessionId, reason = "Browser session ended") {
    const normalizedSessionId = String(browserSessionId || "");
    let released = 0;
    for (const lease of [...this.leases.values()]) {
      if (lease.browserSessionId !== normalizedSessionId) continue;
      this.dropLease(lease, reason);
      released += 1;
    }
    return released;
  }

  releaseBrowserWindow(browserSessionId, windowId, reason = "Browser window disconnected") {
    const normalizedSessionId = String(browserSessionId || "");
    const normalizedWindowId = String(windowId || "");
    let released = 0;
    for (const lease of [...this.leases.values()]) {
      if (lease.browserSessionId !== normalizedSessionId || lease.windowId !== normalizedWindowId) continue;
      this.dropLease(lease, reason);
      released += 1;
    }
    return released;
  }

  disconnectUser(userId, reason = "User access changed") {
    const normalizedUserId = String(userId || "");
    let disconnected = 0;
    for (const connection of [...this.connections.values()]) {
      if (connection.userId !== normalizedUserId) continue;
      this.disconnectConnection(connection.id, reason, 4003);
      disconnected += 1;
    }
    return disconnected;
  }

  sweepExpired() {
    const now = this.now();
    for (const lease of [...this.leases.values()]) {
      if (lease.expiresAt <= now) this.dropLease(lease, "Lease expired");
    }
    for (const connection of [...this.connections.values()]) {
      if (connection.lastHeartbeatAt + HEARTBEAT_TIMEOUT_MS <= now) {
        this.disconnectConnection(connection.id, "Heartbeat timeout", 4004);
      }
    }
  }

  requireConnection(userId, deviceId, pluginId) {
    const connection = this.connections.get(String(deviceId));
    if (!connection || connection.userId !== String(userId)) throw brokerError(503, "Windows Host 离线；不会排队执行");
    if (!connection.pluginIds.includes(String(pluginId))) throw brokerError(403, "设备未获得此插件能力");
    if (this.isPluginAuthorized({ userId: connection.userId, pluginId: String(pluginId) }) !== true) {
      throw brokerError(403, "设备插件未授权或未启用");
    }
    return connection;
  }

  requireLease(context) {
    this.sweepExpired();
    const lease = this.leases.get(String(context?.deviceId));
    if (!lease || !sameLeaseContext(lease, context)) throw brokerError(409, "设备 Thread 租约无效或已变化");
    return lease;
  }

  dropLease(lease, reason) {
    if (this.leases.get(lease.deviceId)?.leaseEpoch !== lease.leaseEpoch) return;
    this.leases.delete(lease.deviceId);
    this.leaseEpochs.set(lease.deviceId, Math.max(this.leaseEpochs.get(lease.deviceId) || 0, lease.leaseEpoch));
    const connection = this.connections.get(lease.deviceId);
    if (connection && connection.deviceEpoch === lease.deviceEpoch) {
      try {
        connection.transport.send(JSON.stringify({
          type: "leaseRevoked",
          context: {
            userId: lease.userId,
            deviceId: lease.deviceId,
            deviceEpoch: lease.deviceEpoch,
            threadId: lease.threadId,
            leaseEpoch: lease.leaseEpoch,
          },
          reason: String(reason).slice(0, 120),
        }));
      } catch {
        // Disconnect cleanup below remains authoritative.
      }
    }
    for (const pending of [...this.pendingCalls.values()]) {
      if (pending.deviceId === lease.deviceId && pending.leaseEpoch === lease.leaseEpoch) {
        this.rejectPending(pending, brokerError(409, `设备 Thread 租约已结束：${reason}`));
      }
    }
    this.emit("leaseReleased", { ...publicLease(lease), reason });
  }

  rejectPending(pending, error) {
    if (!this.pendingCalls.has(pending.callId)) return;
    clearTimeout(pending.timer);
    this.pendingCalls.delete(pending.callId);
    pending.reject(error);
  }

  publicConnection(connection) {
    return {
      connectionId: connection.id,
      deviceId: connection.deviceId,
      userId: connection.userId,
      deviceEpoch: connection.deviceEpoch,
      pluginIds: [...connection.pluginIds],
      connectedAt: connection.connectedAt,
      lastHeartbeatAt: connection.lastHeartbeatAt,
      capabilities: connection.capabilities ? structuredClone(connection.capabilities) : null,
    };
  }
}

function publicLease(lease) {
  return {
    userId: lease.userId,
    deviceId: lease.deviceId,
    pluginId: lease.pluginId,
    deviceEpoch: lease.deviceEpoch,
    threadId: lease.threadId,
    leaseEpoch: lease.leaseEpoch,
    browserSessionId: lease.browserSessionId,
    windowId: lease.windowId,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
  };
}

function normalizeLeaseContext(value) {
  return {
    userId: opaqueId(value.userId, "userId"),
    deviceId: opaqueId(value.deviceId, "deviceId"),
    pluginId: pluginId(value.pluginId),
    threadId: opaqueId(value.threadId, "threadId"),
    browserSessionId: opaqueId(value.browserSessionId, "browserSessionId"),
    windowId: opaqueId(value.windowId, "windowId"),
  };
}

function sameLeaseOwner(lease, context) {
  return lease.userId === context.userId
    && lease.deviceId === context.deviceId
    && lease.pluginId === context.pluginId
    && lease.threadId === context.threadId
    && lease.browserSessionId === context.browserSessionId
    && lease.windowId === context.windowId;
}

function sameLeaseContext(lease, context) {
  return sameLeaseOwner(lease, {
    userId: String(context?.userId || ""),
    deviceId: String(context?.deviceId || ""),
    pluginId: String(context?.pluginId || ""),
    threadId: String(context?.threadId || ""),
    browserSessionId: String(context?.browserSessionId || ""),
    windowId: String(context?.windowId || ""),
  }) && lease.leaseEpoch === Number(context?.leaseEpoch);
}

function normalizeDuration(value, fallback, max, label) {
  const duration = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(duration) || duration < 1_000 || duration > max) throw brokerError(400, `${label}不正确`);
  return duration;
}

function opaqueId(value, label) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw brokerError(400, `${label} 不正确`);
  return id;
}

function pluginId(value) {
  const id = String(value || "");
  if (!["windows-codex-remote", "creator-worker"].includes(id)) throw brokerError(400, "设备插件不正确");
  return id;
}

function safeDeviceError(value) {
  const message = typeof value?.message === "string" ? value.message.trim() : "Windows Host 调用失败";
  return message && message.length <= 300 && !/[\u0000-\u001f\u007f]/.test(message)
    ? message
    : "Windows Host 调用失败";
}

function normalizeHostCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw brokerError(400, "设备能力格式不正确");
  const codex = value.codex && typeof value.codex === "object" && !Array.isArray(value.codex)
    ? value.codex
    : {};
  const creator = value.creator && typeof value.creator === "object" && !Array.isArray(value.creator)
    ? value.creator
    : {};
  const tools = Array.isArray(creator.tools)
    ? [...new Set(creator.tools.map(String))].filter((tool) => [
      "presentation.generate",
      "document.generate",
      "media.transcode",
      "video.compose",
      "godot.export",
    ].includes(tool)).slice(0, 5)
    : [];
  const codexVersion = typeof codex.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(codex.version)
    ? codex.version
    : null;
  return {
    codex: {
      available: codex.available === true,
      appServer: codex.appServer === true,
      version: codexVersion,
    },
    creator: {
      available: creator.available === true,
      workspaceConfigured: creator.workspaceConfigured === true,
      tools,
    },
  };
}

function brokerError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
