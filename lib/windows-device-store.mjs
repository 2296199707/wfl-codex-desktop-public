import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEVICE_PLUGINS = new Set(["windows-codex-remote", "creator-worker"]);
const MAX_ACTIVE_DEVICES_PER_USER = 10;
const MAX_REVOKED_DEVICES_PER_USER = 20;

export class WindowsDeviceStore {
  constructor(stateDirectory, {
    now = () => Date.now(),
    randomBytes = crypto.randomBytes,
    randomUUID = crypto.randomUUID,
  } = {}) {
    this.stateDirectory = stateDirectory;
    this.storePath = path.join(stateDirectory, "windows-devices.json");
    this.pepperPath = path.join(stateDirectory, "windows-device-pepper");
    this.now = now;
    this.randomBytes = randomBytes;
    this.randomUUID = randomUUID;
    this.pepper = null;
    this.devices = [];
    this.pairings = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    this.pepper = await this.loadOrCreatePepper();
    const state = await this.readStore();
    this.devices = state.devices;
    this.pairings = state.pairings.filter((pairing) => pairing.expiresAt > this.now());
    this.pruneDevices();
    return this;
  }

  snapshot(userId) {
    const normalizedUserId = normalizeId(userId, "userId");
    return {
      protocolVersion: 1,
      devices: this.devices
        .filter((device) => device.userId === normalizedUserId)
        .map(publicDevice),
    };
  }

  get(deviceId) {
    const id = normalizeId(deviceId, "deviceId");
    const device = this.devices.find((entry) => entry.id === id);
    return device ? publicDevice(device) : null;
  }

  async createPairing({ userId, pluginIds, requestedBySessionId = null, ttlMs = PAIRING_TTL_MS }) {
    return this.mutate(async () => {
      const normalizedUserId = normalizeId(userId, "userId");
      const normalizedPlugins = normalizePluginIds(pluginIds);
      const normalizedSessionId = requestedBySessionId === null
        ? null
        : normalizeId(requestedBySessionId, "sessionId");
      const boundedTtl = Number(ttlMs);
      if (!Number.isFinite(boundedTtl) || boundedTtl < 60_000 || boundedTtl > PAIRING_TTL_MS) {
        throw deviceError(400, "配对有效期不正确");
      }
      this.prunePairings();
      // A user only needs one outstanding code. Replacing older codes keeps the
      // persisted secret set bounded and makes the most recently shown code the
      // only one that can be consumed.
      this.pairings = this.pairings.filter((pairing) => pairing.userId !== normalizedUserId);
      const code = generatePairingCode(this.randomBytes);
      const now = this.now();
      const pairing = {
        id: `pair_${this.randomUUID()}`,
        userId: normalizedUserId,
        pluginIds: normalizedPlugins,
        codeHash: this.hashPairingCode(code),
        requestedBySessionId: normalizedSessionId,
        createdAt: now,
        expiresAt: now + boundedTtl,
      };
      this.pairings.push(pairing);
      await this.writeStore();
      return {
        pairingId: pairing.id,
        code,
        pluginIds: [...pairing.pluginIds],
        expiresAt: pairing.expiresAt,
      };
    });
  }

  async consumePairing({ code, name, platform, agentVersion, protocolVersion }) {
    return this.mutate(async () => {
      const normalizedCode = normalizePairingCode(code);
      const codeHash = this.hashPairingCode(normalizedCode);
      const now = this.now();
      const pairing = this.pairings.find((entry) => (
        entry.expiresAt > now && safeHashEqual(entry.codeHash, codeHash)
      ));
      this.prunePairings();
      if (!pairing) {
        await this.writeStore();
        throw deviceError(401, "配对码无效或已过期");
      }
      if (this.devices.filter((device) => device.userId === pairing.userId && device.status === "active").length >= MAX_ACTIVE_DEVICES_PER_USER) {
        throw deviceError(409, `每个账号最多配对 ${MAX_ACTIVE_DEVICES_PER_USER} 台有效 Windows 设备`);
      }
      this.pairings = this.pairings.filter((entry) => entry.id !== pairing.id);
      const id = `device_${this.randomUUID()}`;
      const token = `wfl_device_${this.randomBytes(32).toString("base64url")}`;
      const device = {
        id,
        userId: pairing.userId,
        name: normalizeName(name),
        platform: normalizePlatform(platform),
        agentVersion: normalizeVersion(agentVersion),
        protocolVersion: normalizeProtocolVersion(protocolVersion),
        pluginIds: [...pairing.pluginIds],
        tokenHash: this.hashDeviceToken(id, token),
        epoch: 1,
        status: "active",
        pairedAt: now,
        updatedAt: now,
        lastSeenAt: null,
        revokedAt: null,
      };
      this.devices.unshift(device);
      this.pruneDevices();
      await this.writeStore();
      return { device: publicDevice(device), token };
    });
  }

  authenticate(deviceId, token) {
    const id = normalizeId(deviceId, "deviceId");
    const presented = normalizeToken(token);
    const device = this.devices.find((entry) => entry.id === id);
    if (!device || device.status !== "active" || !device.tokenHash) {
      throw deviceError(401, "设备认证失败");
    }
    if (!safeHashEqual(device.tokenHash, this.hashDeviceToken(id, presented))) {
      throw deviceError(401, "设备认证失败");
    }
    return publicDevice(device);
  }

  async touch(deviceId, { agentVersion = null, protocolVersion = null } = {}) {
    return this.mutate(async () => {
      const device = this.requireActive(deviceId);
      device.lastSeenAt = this.now();
      device.updatedAt = device.lastSeenAt;
      if (agentVersion !== null) device.agentVersion = normalizeVersion(agentVersion);
      if (protocolVersion !== null) device.protocolVersion = normalizeProtocolVersion(protocolVersion);
      await this.writeStore();
      return publicDevice(device);
    });
  }

  async revoke(userId, deviceId) {
    return this.mutate(async () => {
      const device = this.requireOwned(userId, deviceId);
      if (device.status === "revoked") return publicDevice(device);
      const now = this.now();
      device.status = "revoked";
      device.epoch += 1;
      device.tokenHash = null;
      device.revokedAt = now;
      device.updatedAt = now;
      this.pruneDevices();
      await this.writeStore();
      return publicDevice(device);
    });
  }

  async revokePlugin(userId, pluginId) {
    return this.mutate(async () => {
      const normalizedUserId = normalizeId(userId, "userId");
      const normalizedPluginId = normalizePluginId(pluginId);
      const changed = [];
      const now = this.now();
      for (const device of this.devices) {
        if (device.userId !== normalizedUserId || !device.pluginIds.includes(normalizedPluginId)) continue;
        device.pluginIds = device.pluginIds.filter((entry) => entry !== normalizedPluginId);
        device.epoch += 1;
        device.updatedAt = now;
        if (!device.pluginIds.length) {
          device.status = "revoked";
          device.tokenHash = null;
          device.revokedAt = now;
        }
        changed.push(publicDevice(device));
      }
      const pairingCount = this.pairings.length;
      this.pairings = this.pairings.flatMap((pairing) => {
        if (pairing.userId !== normalizedUserId || !pairing.pluginIds.includes(normalizedPluginId)) {
          return [pairing];
        }
        const pluginIds = pairing.pluginIds.filter((entry) => entry !== normalizedPluginId);
        return pluginIds.length ? [{ ...pairing, pluginIds }] : [];
      });
      this.pruneDevices();
      if (changed.length || this.pairings.length !== pairingCount) await this.writeStore();
      return changed;
    });
  }

  async revokePluginForAll(pluginId) {
    return this.mutate(async () => {
      const normalizedPluginId = normalizePluginId(pluginId);
      const changed = [];
      const now = this.now();
      for (const device of this.devices) {
        if (!device.pluginIds.includes(normalizedPluginId)) continue;
        device.pluginIds = device.pluginIds.filter((entry) => entry !== normalizedPluginId);
        device.epoch += 1;
        device.updatedAt = now;
        if (!device.pluginIds.length) {
          device.status = "revoked";
          device.tokenHash = null;
          device.revokedAt = now;
        }
        changed.push(publicDevice(device));
      }
      const pairingCount = this.pairings.length;
      this.pairings = this.pairings.flatMap((pairing) => {
        if (!pairing.pluginIds.includes(normalizedPluginId)) return [pairing];
        const pluginIds = pairing.pluginIds.filter((entry) => entry !== normalizedPluginId);
        return pluginIds.length ? [{ ...pairing, pluginIds }] : [];
      });
      this.pruneDevices();
      if (changed.length || this.pairings.length !== pairingCount) await this.writeStore();
      return changed;
    });
  }

  requireOwned(userId, deviceId) {
    const normalizedUserId = normalizeId(userId, "userId");
    const id = normalizeId(deviceId, "deviceId");
    const device = this.devices.find((entry) => entry.id === id && entry.userId === normalizedUserId);
    if (!device) throw deviceError(404, "设备不存在");
    return device;
  }

  requireActive(deviceId) {
    const id = normalizeId(deviceId, "deviceId");
    const device = this.devices.find((entry) => entry.id === id && entry.status === "active");
    if (!device) throw deviceError(404, "有效设备不存在");
    return device;
  }

  hashPairingCode(code) {
    return crypto.createHmac("sha256", this.pepper).update(`pair:v1:${code}`).digest("hex");
  }

  hashDeviceToken(deviceId, token) {
    return crypto.createHmac("sha256", this.pepper).update(`device:v1:${deviceId}:${token}`).digest("hex");
  }

  prunePairings() {
    const now = this.now();
    this.pairings = this.pairings.filter((pairing) => pairing.expiresAt > now);
  }

  pruneDevices() {
    const revokedByUser = new Map();
    const kept = [];
    for (const device of this.devices) {
      if (device.status !== "revoked") {
        kept.push(device);
        continue;
      }
      const count = revokedByUser.get(device.userId) || 0;
      if (count >= MAX_REVOKED_DEVICES_PER_USER) continue;
      revokedByUser.set(device.userId, count + 1);
      kept.push(device);
    }
    this.devices = kept;
  }

  async loadOrCreatePepper() {
    try {
      const pepper = await fs.readFile(this.pepperPath);
      if (pepper.length !== 32) throw new Error("invalid pepper length");
      return pepper;
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`无法读取 Windows 设备密钥: ${error.message}`);
      const pepper = this.randomBytes(32);
      try {
        await fs.writeFile(this.pepperPath, pepper, { mode: 0o600, flag: "wx" });
        await fs.chmod(this.pepperPath, 0o600);
        return pepper;
      } catch (writeError) {
        if (writeError.code !== "EEXIST") throw writeError;
        const existing = await fs.readFile(this.pepperPath);
        if (existing.length !== 32) throw new Error("invalid pepper length");
        return existing;
      }
    }
  }

  async readStore() {
    try {
      const value = JSON.parse(await fs.readFile(this.storePath, "utf8"));
      if (value?.version !== STORE_VERSION || !Array.isArray(value.devices) || !Array.isArray(value.pairings)) {
        throw new Error("unsupported state format");
      }
      return {
        devices: value.devices.map(normalizeStoredDevice),
        pairings: value.pairings.map(normalizeStoredPairing),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`无法读取 Windows 设备状态: ${error.message}`);
      return { devices: [], pairings: [] };
    }
  }

  async writeStore() {
    const content = `${JSON.stringify({
      version: STORE_VERSION,
      devices: this.devices,
      pairings: this.pairings,
    }, null, 2)}\n`;
    const temporary = `${this.storePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, this.storePath);
    await fs.chmod(this.storePath, 0o600);
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }
}

function publicDevice(device) {
  return {
    id: device.id,
    userId: device.userId,
    name: device.name,
    platform: device.platform,
    agentVersion: device.agentVersion,
    protocolVersion: device.protocolVersion,
    pluginIds: [...device.pluginIds],
    epoch: device.epoch,
    status: device.status,
    pairedAt: device.pairedAt,
    updatedAt: device.updatedAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
  };
}

function normalizeStoredDevice(value) {
  const status = String(value?.status || "");
  const epoch = Number(value?.epoch);
  const pairedAt = normalizeTimestamp(value?.pairedAt, "pairedAt");
  const updatedAt = normalizeTimestamp(value?.updatedAt, "updatedAt");
  const lastSeenAt = value?.lastSeenAt === null ? null : normalizeTimestamp(value?.lastSeenAt, "lastSeenAt");
  const revokedAt = value?.revokedAt === null ? null : normalizeTimestamp(value?.revokedAt, "revokedAt");
  const tokenHash = value?.tokenHash === null ? null : normalizeHash(value?.tokenHash);
  if (!["active", "revoked"].includes(status) || !Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error("invalid stored device");
  }
  if (status === "active" && !tokenHash) throw new Error("active device has no token");
  const pluginIds = normalizePluginIds(value?.pluginIds, { allowEmpty: status === "revoked" });
  if (status === "active" && !pluginIds.length) throw new Error("active device has no plugins");
  return {
    id: normalizeId(value?.id, "deviceId"),
    userId: normalizeId(value?.userId, "userId"),
    name: normalizeName(value?.name),
    platform: normalizePlatform(value?.platform),
    agentVersion: normalizeVersion(value?.agentVersion),
    protocolVersion: normalizeProtocolVersion(value?.protocolVersion),
    pluginIds,
    tokenHash,
    epoch,
    status,
    pairedAt,
    updatedAt,
    lastSeenAt,
    revokedAt,
  };
}

function normalizeStoredPairing(value) {
  return {
    id: normalizeId(value?.id, "pairingId"),
    userId: normalizeId(value?.userId, "userId"),
    pluginIds: normalizePluginIds(value?.pluginIds),
    codeHash: normalizeHash(value?.codeHash),
    requestedBySessionId: value?.requestedBySessionId === null
      ? null
      : normalizeId(value?.requestedBySessionId, "sessionId"),
    createdAt: normalizeTimestamp(value?.createdAt, "createdAt"),
    expiresAt: normalizeTimestamp(value?.expiresAt, "expiresAt"),
  };
}

function generatePairingCode(randomBytes) {
  const bytes = randomBytes(12);
  let code = "";
  for (const byte of bytes) code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function normalizePairingCode(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code)) {
    throw deviceError(401, "配对码无效或已过期");
  }
  return code;
}

function normalizeToken(value) {
  const token = String(value || "");
  if (!/^wfl_device_[A-Za-z0-9_-]{43}$/.test(token)) throw deviceError(401, "设备认证失败");
  return token;
}

function normalizePluginIds(values, { allowEmpty = false } = {}) {
  const plugins = Array.isArray(values) ? [...new Set(values.map(normalizePluginId))] : [];
  if ((!allowEmpty && !plugins.length) || plugins.length > DEVICE_PLUGINS.size) {
    throw deviceError(400, "必须选择设备插件");
  }
  return plugins.sort();
}

function normalizePluginId(value) {
  const pluginId = String(value || "");
  if (!DEVICE_PLUGINS.has(pluginId)) throw deviceError(400, "设备插件不受支持");
  return pluginId;
}

function normalizeId(value, label) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw deviceError(400, `${label} 不正确`);
  return id;
}

function normalizeName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw deviceError(400, "设备名称不正确");
  return name;
}

function normalizePlatform(value) {
  const platform = String(value || "").toLowerCase();
  if (platform !== "windows") throw deviceError(400, "第一版只支持 Windows 设备");
  return platform;
}

function normalizeVersion(value) {
  const version = String(value || "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw deviceError(400, "Agent 版本不正确");
  return version;
}

function normalizeProtocolVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version !== 1) throw deviceError(409, "Windows Host 协议版本不兼容");
  return version;
}

function normalizeTimestamp(value, label) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error(`invalid ${label}`);
  return timestamp;
}

function normalizeHash(value) {
  const hash = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid secret hash");
  return hash;
}

function safeHashEqual(left, right) {
  const a = Buffer.from(String(left), "hex");
  const b = Buffer.from(String(right), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function deviceError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
