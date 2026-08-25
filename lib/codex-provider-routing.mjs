import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_PRIORITY_TARGETS = 40;
const MAX_BINDINGS = 1_000;
const MAX_AUDIT_EVENTS = 200;
const MAX_HEALTH_RECORDS = 40;
const TARGET_KEY_PATTERN = /^(?:managed:p-[a-f0-9]{12}|official:oa-[a-f0-9]{16}|default:[A-Za-z0-9._-]{1,64})$/;
const PROVIDER_KINDS = new Set(["managed", "official", "default"]);
const CREDENTIAL_STATUSES = new Set(["configured", "valid", "unknown", "missing", "invalid"]);
const AUDIT_REASONS = new Set([
  "manual",
  "connectivity",
  "credentials",
  "quota",
  "provider-repaired",
  "official-login",
]);
const AUDIT_RESULTS = new Set(["queued", "skipped", "switched", "restored", "failed", "exhausted"]);
const HEALTH_STATUSES = new Set(["unknown", "valid", "invalid", "limited", "missing"]);

export class CodexProviderRoutingStore {
  constructor(stateDirectory, {
    now = () => Date.now(),
    uid = null,
    gid = null,
  } = {}) {
    this.filePath = path.join(stateDirectory, "codex-provider-routing.json");
    this.now = now;
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
    this.settings = defaultSettings();
    this.bindings = new Map();
    this.audit = [];
    this.health = new Map();
    this.pending = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (stored?.version !== STORE_VERSION) throw new SyntaxError("Unsupported provider routing store");
      this.settings = normalizeSettings(stored.settings);
      this.bindings.clear();
      for (const value of Array.isArray(stored.bindings) ? stored.bindings : []) {
        const binding = normalizeBinding(value);
        if (!binding || this.bindings.has(binding.threadId)) continue;
        this.bindings.set(binding.threadId, binding);
        if (this.bindings.size >= MAX_BINDINGS) break;
      }
      this.audit = (Array.isArray(stored.audit) ? stored.audit : [])
        .map(normalizeAuditEvent)
        .filter(Boolean)
        .slice(0, MAX_AUDIT_EVENTS);
      this.health.clear();
      for (const value of Array.isArray(stored.health) ? stored.health : []) {
        const health = normalizeHealth(value);
        if (!health || this.health.has(health.key)) continue;
        this.health.set(health.key, health);
        if (this.health.size >= MAX_HEALTH_RECORDS) break;
      }
      this.pending = normalizePendingFailover(stored.pending);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.settings = defaultSettings();
      this.bindings.clear();
      this.audit = [];
      this.health.clear();
      this.pending = null;
      await this.persist();
    }
    await fs.chmod(this.filePath, 0o600);
    return this;
  }

  settingsSnapshot() {
    return structuredClone(this.settings);
  }

  snapshot({ eligibleKeys = null } = {}) {
    const keys = eligibleKeys == null ? null : new Set(normalizeEligibleKeys(eligibleKeys));
    return {
      settings: {
        automaticFailover: this.settings.automaticFailover,
        priority: keys
          ? this.settings.priority.filter((key) => keys.has(key))
          : [...this.settings.priority],
      },
      bindings: [...this.bindings.values()]
        .sort((left, right) => right.boundAt - left.boundAt)
        .map((binding) => structuredClone(binding)),
      audit: this.audit.map((event) => structuredClone(event)),
      health: [...this.health.values()]
        .sort((left, right) => right.checkedAt - left.checkedAt)
        .map((entry) => structuredClone(entry)),
      pending: this.pending ? structuredClone(this.pending) : null,
    };
  }

  getBinding(threadId) {
    const normalized = normalizeThreadId(threadId);
    const binding = this.bindings.get(normalized);
    return binding ? structuredClone(binding) : null;
  }

  getHealth(key) {
    const normalized = String(key || "");
    if (!TARGET_KEY_PATTERN.test(normalized)) throw routingError(400, "供应商路由目标无效");
    const health = this.health.get(normalized);
    return health ? structuredClone(health) : null;
  }

  orderedKeys(eligibleKeys) {
    const eligible = normalizeEligibleKeys(eligibleKeys);
    const allowed = new Set(eligible);
    return [
      ...this.settings.priority.filter((key) => allowed.delete(key)),
      ...eligible.filter((key) => allowed.has(key)),
    ];
  }

  async updateSettings(input, { eligibleKeys } = {}) {
    const eligible = normalizeEligibleKeys(eligibleKeys);
    const allowed = new Set(eligible);
    const automaticFailover = input?.automaticFailover === true;
    const priority = normalizePriority(input?.priority);
    if (priority.some((key) => !allowed.has(key))) {
      throw routingError(400, "供应商优先级包含未授权或已经失效的目标");
    }
    if (automaticFailover && eligible.length < 2) {
      throw routingError(409, "至少需要两个可用账号或供应商才能开启自动故障切换");
    }
    this.settings = {
      automaticFailover,
      priority: [
        ...priority,
        ...eligible.filter((key) => !priority.includes(key)),
      ].slice(0, MAX_PRIORITY_TARGETS),
      updatedAt: this.now(),
    };
    await this.persist();
    return this.settingsSnapshot();
  }

  async bindThread(threadId, provider) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const descriptor = normalizeProviderDescriptor(provider);
    if (!descriptor) throw routingError(400, "无法记录无效的对话供应商");
    const current = this.bindings.get(normalizedThreadId);
    const binding = {
      threadId: normalizedThreadId,
      ...descriptor,
      boundAt: this.now(),
      firstBoundAt: current?.firstBoundAt || this.now(),
    };
    this.bindings.delete(normalizedThreadId);
    this.bindings.set(normalizedThreadId, binding);
    while (this.bindings.size > MAX_BINDINGS) {
      this.bindings.delete(this.bindings.keys().next().value);
    }
    await this.persist();
    return structuredClone(binding);
  }

  async setPendingFailover(value) {
    this.pending = value == null ? null : normalizePendingFailover({
      ...value,
      queuedAt: value.queuedAt || this.now(),
      updatedAt: this.now(),
    });
    if (value != null && !this.pending) throw routingError(400, "自动故障切换请求无效");
    await this.persist();
    return this.pending ? structuredClone(this.pending) : null;
  }

  async recordAudit(value) {
    const event = normalizeAuditEvent({
      ...value,
      id: value?.id || `pa-${this.now()}-${Math.random().toString(16).slice(2, 10)}`,
      at: value?.at || this.now(),
    });
    if (!event) throw routingError(400, "供应商切换审计记录无效");
    this.audit = [event, ...this.audit.filter((entry) => entry.id !== event.id)]
      .slice(0, MAX_AUDIT_EVENTS);
    await this.persist();
    return structuredClone(event);
  }

  async recordHealth(key, value = {}) {
    const normalizedKey = String(key || "");
    if (!TARGET_KEY_PATTERN.test(normalizedKey)) {
      throw routingError(400, "供应商路由目标无效");
    }
    const health = normalizeHealth({
      key: normalizedKey,
      status: value.status,
      checkedAt: value.checkedAt || this.now(),
      code: value.code,
    });
    if (!health) throw routingError(400, "供应商健康状态无效");
    this.health.delete(normalizedKey);
    this.health.set(normalizedKey, health);
    while (this.health.size > MAX_HEALTH_RECORDS) {
      this.health.delete(this.health.keys().next().value);
    }
    await this.persist();
    return structuredClone(health);
  }

  flush() {
    return this.writeQueue;
  }

  async persist() {
    const content = `${JSON.stringify({
      version: STORE_VERSION,
      settings: this.settings,
      bindings: [...this.bindings.values()]
        .sort((left, right) => right.boundAt - left.boundAt)
        .slice(0, MAX_BINDINGS),
      audit: this.audit.slice(0, MAX_AUDIT_EVENTS),
      health: [...this.health.values()]
        .sort((left, right) => right.checkedAt - left.checkedAt)
        .slice(0, MAX_HEALTH_RECORDS),
      pending: this.pending,
    }, null, 2)}\n`;
    const queued = this.writeQueue.then(async () => {
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, content, { mode: 0o600 });
      if (this.uid !== null && this.gid !== null) {
        await fs.chown(temporaryPath, this.uid, this.gid);
      }
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    });
    this.writeQueue = queued.catch(() => {});
    await queued;
  }
}

export function providerRoutingTargetKey(kind, id) {
  const key = `${kind}:${id}`;
  if (!TARGET_KEY_PATTERN.test(key)) throw routingError(400, "供应商路由目标无效");
  return key;
}

export function normalizeProviderRoutingTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptor = normalizeProviderDescriptor(value);
  if (!descriptor) return null;
  const disabledReason = boundedText(value.disabledReason, 160);
  return {
    ...descriptor,
    eligible: value.eligible === true && !disabledReason,
    active: value.active === true,
    disabledReason,
  };
}

function defaultSettings() {
  return { automaticFailover: false, priority: [], updatedAt: null };
}

function normalizeSettings(value) {
  return {
    automaticFailover: value?.automaticFailover === true,
    priority: normalizePriority(value?.priority),
    updatedAt: timestamp(value?.updatedAt),
  };
}

function normalizePriority(value) {
  const output = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const key = String(raw || "");
    if (!TARGET_KEY_PATTERN.test(key) || seen.has(key)) continue;
    seen.add(key);
    output.push(key);
    if (output.length >= MAX_PRIORITY_TARGETS) break;
  }
  return output;
}

function normalizeEligibleKeys(value) {
  const keys = normalizePriority(value);
  if (!Array.isArray(value) || keys.length !== new Set(value).size) {
    if (!Array.isArray(value)) throw routingError(400, "可用供应商目录无效");
    for (const raw of value) {
      if (!TARGET_KEY_PATTERN.test(String(raw || ""))) {
        throw routingError(400, "可用供应商目录包含无效目标");
      }
    }
  }
  return keys;
}

function normalizeProviderDescriptor(value) {
  const kind = String(value?.kind || "");
  const id = String(value?.id || "");
  if (!PROVIDER_KINDS.has(kind)) return null;
  let key;
  try {
    key = providerRoutingTargetKey(kind, id);
  } catch {
    return null;
  }
  const label = boundedText(value.label, 128);
  if (!label) return null;
  const credentialStatus = CREDENTIAL_STATUSES.has(value.credentialStatus)
    ? value.credentialStatus
    : "unknown";
  return {
    key,
    kind,
    id,
    label,
    model: boundedText(value.model, 128),
    accountId: value.accountId == null ? null : boundedText(value.accountId, 64),
    accountLabel: value.accountLabel == null ? null : boundedText(value.accountLabel, 320),
    credentialStatus,
    quotaUsedPercent: percentage(value.quotaUsedPercent),
    checkedAt: timestamp(value.checkedAt),
  };
}

function normalizeBinding(value) {
  let threadId;
  try {
    threadId = normalizeThreadId(value?.threadId);
  } catch {
    return null;
  }
  const provider = normalizeProviderDescriptor(value);
  const boundAt = timestamp(value?.boundAt);
  if (!provider || boundAt === null) return null;
  return {
    threadId,
    ...provider,
    boundAt,
    firstBoundAt: timestamp(value?.firstBoundAt) || boundAt,
  };
}

function normalizePendingFailover(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let threadId;
  try {
    threadId = normalizeThreadId(value.threadId);
  } catch {
    return null;
  }
  const currentKey = String(value.currentKey || "");
  if (!TARGET_KEY_PATTERN.test(currentKey)) return null;
  const reason = AUDIT_REASONS.has(value.reason) ? value.reason : "connectivity";
  const queuedAt = timestamp(value.queuedAt);
  const updatedAt = timestamp(value.updatedAt);
  if (queuedAt === null || updatedAt === null) return null;
  return {
    threadId,
    currentKey,
    reason,
    queuedAt,
    updatedAt,
    attempts: Math.min(40, nonnegativeInteger(value.attempts) ?? 0),
    waitingForIdle: value.waitingForIdle === true,
  };
}

function normalizeAuditEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = boundedText(value.id, 96);
  const at = timestamp(value.at);
  const reason = AUDIT_REASONS.has(value.reason) ? value.reason : null;
  const result = AUDIT_RESULTS.has(value.result) ? value.result : null;
  if (!id || at === null || !reason || !result) return null;
  let threadId = null;
  if (value.threadId != null) {
    try {
      threadId = normalizeThreadId(value.threadId);
    } catch {
      return null;
    }
  }
  const fromKey = value.fromKey == null ? null : String(value.fromKey);
  const toKey = value.toKey == null ? null : String(value.toKey);
  if (
    (fromKey !== null && !TARGET_KEY_PATTERN.test(fromKey))
    || (toKey !== null && !TARGET_KEY_PATTERN.test(toKey))
  ) {
    return null;
  }
  return {
    id,
    at,
    threadId,
    fromKey,
    toKey,
    reason,
    result,
    code: boundedText(value.code, 64),
  };
}

function normalizeHealth(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = String(value.key || "");
  const status = HEALTH_STATUSES.has(value.status) ? value.status : null;
  const checkedAt = timestamp(value.checkedAt);
  if (!TARGET_KEY_PATTERN.test(key) || !status || checkedAt === null) return null;
  return {
    key,
    status,
    checkedAt,
    code: boundedText(value.code, 64),
  };
}

function normalizeThreadId(value) {
  const threadId = String(value || "").trim();
  if (!threadId || threadId.length > 256 || /[\u0000-\u001f\u007f]/.test(threadId)) {
    throw routingError(400, "对话 ID 无效");
  }
  return threadId;
}

function boundedText(value, limit) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, limit);
}

function percentage(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.max(0, Math.min(100, Math.round(Number(value) * 10) / 10));
}

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function routingError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
