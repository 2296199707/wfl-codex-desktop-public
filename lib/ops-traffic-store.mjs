import fs from "node:fs/promises";
import path from "node:path";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_RAW_RETENTION_MS = DAY_MS;
const DEFAULT_HOURLY_RETENTION_MS = 30 * DAY_MS;
const DEFAULT_DAILY_RETENTION_MS = 90 * DAY_MS;
const MAX_FILE_BYTES = 24 * 1024 * 1024;

export class OpsTrafficStore {
  constructor(directory, {
    now = () => Date.now(),
    rawRetentionMs = DEFAULT_RAW_RETENTION_MS,
    hourlyRetentionMs = DEFAULT_HOURLY_RETENTION_MS,
    dailyRetentionMs = DEFAULT_DAILY_RETENTION_MS,
    maxRawRecords = 50_000,
    writeOnInitialize = true,
  } = {}) {
    this.directory = path.resolve(directory);
    this.rawPath = path.join(this.directory, "ops-traffic.ndjson");
    this.hourlyPath = path.join(this.directory, "ops-traffic-hourly.json");
    this.dailyPath = path.join(this.directory, "ops-user-daily.json");
    this.totalsPath = path.join(this.directory, "ops-user-totals.json");
    this.now = now;
    this.rawRetentionMs = rawRetentionMs;
    this.hourlyRetentionMs = hourlyRetentionMs;
    this.dailyRetentionMs = dailyRetentionMs;
    this.maxRawRecords = maxRawRecords;
    this.writeOnInitialize = writeOnInitialize;
    this.raw = [];
    this.hourly = [];
    this.daily = [];
    this.lifetime = { throughDay: null, users: [] };
    this.writeQueue = Promise.resolve();
    this.initialized = false;
    this.pendingCompaction = 0;
    this.lastRollupHour = null;
    this.lastRollupDay = null;
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    await this.reload();
    if (this.writeOnInitialize) await this.compact();
    this.initialized = true;
    return this;
  }

  activate() {
    return this.mutate(async () => {
      this.assertInitialized();
      await this.reload();
      await this.compact();
    });
  }

  record(input) {
    const record = normalizeRecord(input, this.now());
    if (!record) return Promise.reject(new TypeError("Invalid operations traffic record"));
    return this.mutate(async () => {
      this.assertInitialized();
      this.raw.push(record);
      this.rebuildRollups(record.at);
      await fs.appendFile(this.rawPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      const rollupAdvanced = hourStart(record.at) > this.lastRollupHour || dayStart(record.at) > this.lastRollupDay;
      if (rollupAdvanced) {
        await this.writeRollups();
        this.lastRollupHour = hourStart(record.at);
        this.lastRollupDay = dayStart(record.at);
      }
      this.pendingCompaction += 1;
      if (this.pendingCompaction >= 250) await this.compact();
      return structuredClone(record);
    });
  }

  summary(range = "24h") {
    this.assertInitialized();
    const now = this.now();
    const duration = range === "1h" ? HOUR_MS : range === "7d" ? 7 * DAY_MS : DAY_MS;
    const rawWindow = this.raw.filter((record) => record.at >= now - Math.min(duration, this.rawRetentionMs));
    const records = range === "7d"
      ? rawWindow.filter((record) => record.at >= hourStart(now))
      : rawWindow;
    const completedHourly = range === "7d"
      ? this.hourly.filter((entry) => entry.at >= now - duration && entry.at < hourStart(now))
      : [];
    const live = aggregate(records);
    const combined = mergeAggregates([...completedHourly, live]);
    const tokens = tokenSummary(rawWindow, this.daily, now - duration, now, range);
    return {
      range: range === "1h" || range === "7d" ? range : "24h",
      requests: combined.requests,
      requestErrors: combined.requestErrors,
      successRate: combined.requests ? round(((combined.requests - combined.requestErrors) / combined.requests) * 100, 1) : null,
      p95LatencyMs: percentile(records.filter(isRequest).map((entry) => entry.durationMs), 0.95),
      rpcCalls: combined.rpcCalls,
      rpcErrors: combined.rpcErrors,
      turns: combined.turns,
      turnErrors: combined.turnErrors,
      socketsOpened: combined.socketsOpened,
      socketsClosed: combined.socketsClosed,
      socketErrors: combined.socketErrors,
      tokenUsage: tokens,
    };
  }

  trend(range = "24h") {
    this.assertInitialized();
    const now = this.now();
    const duration = range === "1h" ? HOUR_MS : range === "7d" ? 7 * DAY_MS : DAY_MS;
    const bucketMs = range === "1h" ? 5 * 60 * 1000 : HOUR_MS;
    const rawStart = Math.max(now - duration, now - this.rawRetentionMs);
    const buckets = new Map();
    if (range === "7d") {
      for (const entry of this.hourly.filter((item) => item.at >= now - duration && item.at < hourStart(now))) {
        buckets.set(entry.at, { ...entry });
      }
    }
    for (const record of this.raw.filter((entry) => entry.at >= rawStart)) {
      const at = Math.floor(record.at / bucketMs) * bucketMs;
      if (!buckets.has(at)) buckets.set(at, emptyAggregate(at));
      addRecord(buckets.get(at), record);
    }
    return {
      range: range === "1h" || range === "7d" ? range : "24h",
      granularitySeconds: bucketMs / 1000,
      samples: [...buckets.values()].sort((left, right) => left.at - right.at).map(publicAggregate),
    };
  }

  logs({ category = "api", limit = 100, before = null } = {}) {
    this.assertInitialized();
    const kinds = category === "errors" ? null : category === "rpc" ? new Set(["rpc", "turn"]) : new Set(["http"]);
    const beforeAt = before !== null && before !== undefined && Number.isFinite(Number(before))
      ? Number(before)
      : Number.POSITIVE_INFINITY;
    return this.raw
      .filter((record) => record.at < beforeAt)
      .filter((record) => kinds ? kinds.has(record.kind) : record.success === false)
      .slice(-Math.max(1, Math.min(200, Number(limit) || 100)))
      .reverse()
      .map((record) => structuredClone(record));
  }

  rankings({ range = "7d", limit = 20 } = {}) {
    this.assertInitialized();
    const now = this.now();
    const duration = range === "24h" ? DAY_MS : range === "30d" ? 30 * DAY_MS : 7 * DAY_MS;
    const rows = new Map();
    const add = (entry) => {
      if (!entry.userId) return;
      const current = rows.get(entry.userId) || {
        userId: entry.userId,
        username: entry.username || entry.userId,
        requests: 0,
        turns: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        tokenAvailable: false,
        lastActiveAt: null,
      };
      current.username = entry.username || current.username;
      current.requests += Number(entry.requests) || 0;
      current.turns += Number(entry.turns) || 0;
      current.inputTokens += Number(entry.inputTokens) || 0;
      current.cachedInputTokens += Number(entry.cachedInputTokens) || 0;
      current.outputTokens += Number(entry.outputTokens) || 0;
      current.reasoningOutputTokens += Number(entry.reasoningOutputTokens) || 0;
      current.totalTokens += Number(entry.totalTokens) || 0;
      current.tokenAvailable ||= entry.tokenAvailable === true;
      current.lastActiveAt = Math.max(current.lastActiveAt || 0, entry.lastActiveAt || entry.at || 0) || null;
      rows.set(entry.userId, current);
    };
    for (const entry of this.daily.filter((item) => item.at >= dayStart(now - duration) && item.at < dayStart(now))) add(entry);
    for (const record of this.raw.filter((item) => item.at >= Math.max(now - duration, dayStart(now)))) {
      add(userContribution(record));
    }
    return [...rows.values()]
      .sort((left, right) => (right.totalTokens - left.totalTokens) || (right.turns - left.turns) || (right.requests - left.requests))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((entry) => structuredClone(entry));
  }

  monthlyUserUsage(userId) {
    const now = this.now();
    const date = new Date(now);
    return this.userTokenUsage(userId, {
      period: "monthly",
      periodStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      resetsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
    });
  }

  lifetimeUserUsage(userId) {
    this.assertInitialized();
    const normalizedUserId = cleanUserId(userId);
    if (!normalizedUserId) throw new TypeError("Invalid user ID for total Token usage");
    const now = this.now();
    const throughDay = Number.isFinite(this.lifetime.throughDay)
      ? this.lifetime.throughDay
      : dayStart(now);
    const archived = this.lifetime.users.find((entry) => entry.userId === normalizedUserId);
    const entries = [
      ...(archived ? [archived] : []),
      ...this.raw
        .filter((entry) => entry.userId === normalizedUserId && entry.at >= throughDay && entry.at <= now)
        .map(userContribution),
    ];
    return tokenUsageSnapshot(entries, {
      period: "total",
      periodStart: null,
      resetsAt: null,
      rolling: false,
    });
  }

  sevenDayUserUsage(userId) {
    const now = this.now();
    const periodStart = dayStart(now) - 6 * DAY_MS;
    return this.userTokenUsage(userId, {
      period: "sevenDay",
      periodStart,
      resetsAt: dayStart(now) + DAY_MS,
    });
  }

  todayUserUsage(userId) {
    const now = this.now();
    const periodStart = dayStart(now);
    return this.userTokenUsage(userId, {
      period: "today",
      periodStart,
      resetsAt: periodStart + DAY_MS,
    });
  }

  weeklyUserUsage(userId) {
    const now = this.now();
    const date = new Date(now);
    const day = date.getUTCDay() || 7;
    const periodStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 1);
    return this.userTokenUsage(userId, {
      period: "weekly",
      periodStart,
      resetsAt: periodStart + 7 * DAY_MS,
    });
  }

  fiveHourUserUsage(userId) {
    this.assertInitialized();
    const now = this.now();
    const periodStart = now - 5 * HOUR_MS;
    const normalizedUserId = cleanUserId(userId);
    if (!normalizedUserId) throw new TypeError("Invalid user ID for 5-hour usage");
    const entries = this.raw
      .filter((entry) => entry.userId === normalizedUserId && entry.at >= periodStart && entry.at <= now)
      .map(userContribution);
    const firstReportedAt = entries.find((entry) => entry.tokenAvailable)?.at || null;
    return tokenUsageSnapshot(entries, {
      period: "fiveHour",
      periodStart,
      resetsAt: firstReportedAt ? firstReportedAt + 5 * HOUR_MS : now + 5 * HOUR_MS,
      rolling: true,
    });
  }

  userTokenUsage(userId, { period, periodStart, resetsAt }) {
    this.assertInitialized();
    const normalizedUserId = cleanUserId(userId);
    if (!normalizedUserId) throw new TypeError("Invalid user ID for Token usage");
    const now = this.now();
    const entries = [
      ...this.daily.filter((entry) => (
        entry.userId === normalizedUserId
        && entry.at >= periodStart
        && entry.at < dayStart(now)
      )),
      ...this.raw
        .filter((entry) => (
          entry.userId === normalizedUserId
          && entry.at >= Math.max(periodStart, dayStart(now))
          && entry.at <= now
        ))
        .map(userContribution),
    ];
    return tokenUsageSnapshot(entries, {
      period,
      periodStart,
      resetsAt,
      rolling: false,
    });
  }

  async flush() {
    await this.writeQueue;
  }

  async reload() {
    const [raw, hourly, daily, lifetime] = await Promise.all([
      readNdjsonTail(this.rawPath, MAX_FILE_BYTES),
      readJson(this.hourlyPath, []),
      readJson(this.dailyPath, []),
      readJson(this.totalsPath, null),
    ]);
    this.raw = raw.map((entry) => normalizeRecord(entry, entry?.at)).filter(Boolean);
    this.hourly = Array.isArray(hourly) ? hourly.map(normalizeAggregate).filter(Boolean) : [];
    this.daily = Array.isArray(daily) ? daily.map(normalizeDaily).filter(Boolean) : [];
    this.lifetime = normalizeLifetimeState(lifetime);
    this.rebuildRollups(this.now());
    this.lastRollupHour = hourStart(this.now());
    this.lastRollupDay = dayStart(this.now());
  }

  prune(now) {
    this.raw = this.raw
      .filter((entry) => entry.at >= now - this.rawRetentionMs && entry.at <= now + 60_000)
      .sort((left, right) => left.at - right.at)
      .slice(-this.maxRawRecords);
    this.hourly = this.hourly
      .filter((entry) => entry.at >= now - this.hourlyRetentionMs && entry.at <= now + HOUR_MS)
      .sort((left, right) => left.at - right.at)
      .slice(-Math.ceil(this.hourlyRetentionMs / HOUR_MS));
    this.daily = this.daily
      .filter((entry) => entry.at >= dayStart(now - this.dailyRetentionMs) && entry.at <= dayStart(now))
      .sort((left, right) => left.at - right.at);
  }

  rebuildRollups(now) {
    const currentHour = hourStart(now);
    const hourly = new Map(this.hourly.map((entry) => [entry.at, entry]));
    const rebuiltHours = new Set();
    for (const record of this.raw) {
      const at = hourStart(record.at);
      if (at >= currentHour) continue;
      if (!rebuiltHours.has(at)) {
        hourly.set(at, emptyAggregate(at));
        rebuiltHours.add(at);
      }
      addRecord(hourly.get(at), record);
    }
    this.hourly = [...hourly.values()].map(publicAggregate);

    const currentDay = dayStart(now);
    const daily = new Map(this.daily.map((entry) => [`${entry.at}:${entry.userId}`, entry]));
    const rebuiltDays = new Set();
    for (const record of this.raw) {
      const at = dayStart(record.at);
      if (at >= currentDay || !record.userId) continue;
      const key = `${at}:${record.userId}`;
      if (!rebuiltDays.has(key)) {
        daily.set(key, emptyDaily(at, record.userId, record.username));
        rebuiltDays.add(key);
      }
      addUserContribution(daily.get(key), record);
    }
    this.daily = [...daily.values()];
    this.rollLifetimeForward(now);
    this.prune(now);
  }

  rollLifetimeForward(now) {
    const currentDay = dayStart(now);
    const firstUnarchivedDay = Number.isFinite(this.lifetime.throughDay)
      ? this.lifetime.throughDay
      : Math.min(currentDay, ...this.daily.map((entry) => entry.at));
    if (firstUnarchivedDay >= currentDay) {
      if (!Number.isFinite(this.lifetime.throughDay)) this.lifetime.throughDay = currentDay;
      return;
    }

    const users = new Map(this.lifetime.users.map((entry) => [entry.userId, entry]));
    for (const entry of this.daily.filter((item) => item.at >= firstUnarchivedDay && item.at < currentDay)) {
      const total = users.get(entry.userId) || emptyDaily(0, entry.userId, entry.username);
      addUserAggregate(total, entry);
      users.set(entry.userId, total);
    }
    this.lifetime = { throughDay: currentDay, users: [...users.values()] };
  }

  async compact() {
    await Promise.all([
      writeAtomic(this.rawPath, this.raw.map((entry) => JSON.stringify(entry)).join("\n") + (this.raw.length ? "\n" : "")),
      this.writeRollups(),
    ]);
    this.pendingCompaction = 0;
  }

  async writeRollups() {
    await Promise.all([
      writeAtomic(this.hourlyPath, `${JSON.stringify(this.hourly)}\n`),
      writeAtomic(this.dailyPath, `${JSON.stringify(this.daily)}\n`),
      writeAtomic(this.totalsPath, `${JSON.stringify(this.lifetime)}\n`),
    ]);
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Operations traffic store is not initialized");
  }
}

export class CodexTokenUsageTracker {
  constructor({ maxThreads = 1_000 } = {}) {
    if (!Number.isSafeInteger(maxThreads) || maxThreads < 1 || maxThreads > 10_000) {
      throw new TypeError("Invalid Token usage thread limit");
    }
    this.maxThreads = maxThreads;
    this.threadTotals = new Map();
  }

  consume(params) {
    const threadId = ephemeralId(params?.threadId);
    const usage = extractOfficialTokenUsage(params);
    if (!threadId || !usage) return null;

    const previous = this.threadTotals.get(threadId);
    this.remember(threadId, usage.total);
    if (!previous || usageDecreased(previous, usage.total)) return usage.last;

    const delta = subtractUsage(usage.total, previous);
    return delta.totalTokens || delta.inputTokens || delta.outputTokens
      || delta.cachedInputTokens || delta.reasoningOutputTokens
      ? delta
      : null;
  }

  remember(threadId, total) {
    this.threadTotals.delete(threadId);
    this.threadTotals.set(threadId, total);
    while (this.threadTotals.size > this.maxThreads) {
      this.threadTotals.delete(this.threadTotals.keys().next().value);
    }
  }
}

export function extractOfficialTokenUsage(params) {
  const tokenUsage = params?.tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== "object" || Array.isArray(tokenUsage)) return null;
  const last = normalizeTokenUsage(tokenUsage.last, true);
  const total = normalizeTokenUsage(tokenUsage.total, true);
  return last && total ? { last, total } : null;
}

function normalizeRecord(value, fallbackAt) {
  const kind = ["http", "rpc", "turn", "usage", "socket"].includes(value?.kind) ? value.kind : null;
  const at = Number(value?.at ?? fallbackAt);
  const operation = cleanOperation(value?.operation);
  if (!kind || !Number.isFinite(at) || at < 0 || !operation) return null;
  const status = cleanStatus(value?.status);
  const success = typeof value?.success === "boolean" ? value.success : status !== "error";
  const record = {
    at: Math.round(at),
    kind,
    operation,
    status,
    success,
    durationMs: duration(value?.durationMs),
    userId: cleanUserId(value?.userId),
    username: cleanUsername(value?.username),
  };
  if (kind === "http") {
    record.method = cleanMethod(value?.method);
    record.statusCode = statusCode(value?.statusCode);
    record.responseBytes = byteCount(value?.responseBytes);
  }
  if (kind === "turn" || kind === "usage") record.tokenUsage = normalizeTokenUsage(value?.tokenUsage);
  return record;
}

function cleanOperation(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_./:-]{1,96}$/.test(text) && !/[?&=]/.test(text) ? text : "";
}

function cleanStatus(value) {
  const text = String(value || "unknown").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(text) ? text : "unknown";
}

function cleanMethod(value) {
  const method = String(value || "GET").toUpperCase();
  return /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method) ? method : "GET";
}

function cleanUserId(value) {
  const text = String(value || "");
  return /^u-[a-f0-9]{16}$/.test(text) ? text : null;
}

function cleanUsername(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(text) ? text : null;
}

function duration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? round(Math.min(number, 24 * HOUR_MS), 1) : null;
}

function statusCode(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : null;
}

function byteCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeTokenUsage(value, requireBreakdown = false) {
  if (!value || typeof value !== "object") return null;
  const inputTokens = integer(value.inputTokens);
  const cachedInputTokens = integer(value.cachedInputTokens);
  const outputTokens = integer(value.outputTokens);
  const reasoningOutputTokens = integer(value.reasoningOutputTokens);
  const totalTokens = integer(value.totalTokens);
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null;
  if (requireBreakdown && (cachedInputTokens === null || reasoningOutputTokens === null)) return null;
  return {
    inputTokens,
    cachedInputTokens: cachedInputTokens || 0,
    outputTokens,
    reasoningOutputTokens: reasoningOutputTokens || 0,
    totalTokens,
  };
}

function ephemeralId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 ? value : null;
}

function usageDecreased(previous, current) {
  return tokenKeys().some((key) => current[key] < previous[key]);
}

function subtractUsage(current, previous) {
  return Object.fromEntries(tokenKeys().map((key) => [key, current[key] - previous[key]]));
}

function tokenKeys() {
  return ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
}

function integer(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function emptyAggregate(at = null) {
  return { at, requests: 0, requestErrors: 0, rpcCalls: 0, rpcErrors: 0, turns: 0, turnErrors: 0, socketsOpened: 0, socketsClosed: 0, socketErrors: 0 };
}

function addRecord(target, record) {
  if (record.kind === "http") {
    target.requests += 1;
    if (!record.success) target.requestErrors += 1;
  } else if (record.kind === "rpc") {
    target.rpcCalls += 1;
    if (!record.success) target.rpcErrors += 1;
  } else if (record.kind === "turn") {
    target.turns += 1;
    if (!record.success) target.turnErrors += 1;
  } else if (record.kind === "socket") {
    if (record.operation === "open") target.socketsOpened += 1;
    if (record.operation === "close") {
      target.socketsClosed += 1;
      if (!record.success) target.socketErrors += 1;
    }
  }
}

function aggregate(records) {
  const result = emptyAggregate();
  for (const record of records) addRecord(result, record);
  return result;
}

function mergeAggregates(entries) {
  const result = emptyAggregate();
  for (const entry of entries) {
    for (const key of Object.keys(result)) {
      if (key !== "at") result[key] += Number(entry?.[key]) || 0;
    }
  }
  return result;
}

function publicAggregate(value) {
  return { ...emptyAggregate(value.at), ...Object.fromEntries(Object.keys(emptyAggregate()).filter((key) => key !== "at").map((key) => [key, Math.max(0, Math.round(Number(value[key]) || 0))])) };
}

function normalizeAggregate(value) {
  const at = Number(value?.at);
  return Number.isFinite(at) && at >= 0 ? publicAggregate({ ...value, at: Math.round(at) }) : null;
}

function emptyDaily(at, userId, username) {
  return {
    at,
    userId,
    username: username || userId,
    requests: 0,
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    tokenAvailable: false,
    lastActiveAt: null,
  };
}

function addUserContribution(target, record) {
  addUserAggregate(target, userContribution(record));
}

function addUserAggregate(target, contribution) {
  target.username = contribution.username || target.username;
  target.requests += contribution.requests;
  target.turns += contribution.turns;
  target.inputTokens += contribution.inputTokens;
  target.cachedInputTokens += contribution.cachedInputTokens;
  target.outputTokens += contribution.outputTokens;
  target.reasoningOutputTokens += contribution.reasoningOutputTokens;
  target.totalTokens += contribution.totalTokens;
  target.tokenAvailable ||= contribution.tokenAvailable;
  target.lastActiveAt = Math.max(target.lastActiveAt || 0, contribution.lastActiveAt || 0) || null;
}

function userContribution(record) {
  const usage = record.tokenUsage;
  return {
    at: record.at,
    userId: record.userId,
    username: record.username,
    requests: record.kind === "http" ? 1 : 0,
    turns: record.kind === "turn" ? 1 : 0,
    inputTokens: usage?.inputTokens || 0,
    cachedInputTokens: usage?.cachedInputTokens || 0,
    outputTokens: usage?.outputTokens || 0,
    reasoningOutputTokens: usage?.reasoningOutputTokens || 0,
    totalTokens: usage?.totalTokens || 0,
    tokenAvailable: Boolean(usage),
    lastActiveAt: record.at,
  };
}

function normalizeDaily(value) {
  const at = Number(value?.at);
  const userId = cleanUserId(value?.userId);
  if (!Number.isFinite(at) || !userId) return null;
  const result = emptyDaily(dayStart(at), userId, cleanUsername(value?.username));
  for (const key of [
    "requests", "turns", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens",
  ]) result[key] = integer(value?.[key]) || 0;
  result.tokenAvailable = value?.tokenAvailable === true;
  result.lastActiveAt = Number.isFinite(Number(value?.lastActiveAt)) ? Math.round(Number(value.lastActiveAt)) : null;
  return result;
}

function normalizeLifetimeState(value) {
  const throughDay = Number(value?.throughDay);
  const users = new Map();
  for (const valueUser of Array.isArray(value?.users) ? value.users : []) {
    const user = normalizeDaily({ ...valueUser, at: 0 });
    if (user) users.set(user.userId, user);
  }
  return {
    throughDay: Number.isFinite(throughDay) && throughDay >= 0 ? dayStart(throughDay) : null,
    users: [...users.values()],
  };
}

function tokenSummary(raw, daily, cutoff, now, range) {
  const entries = range === "7d"
    ? [
      ...daily.filter((entry) => entry.at >= dayStart(cutoff) && entry.at < dayStart(now)),
      ...raw.filter((entry) => entry.at >= dayStart(now) && entry.tokenUsage).map(userContribution),
    ]
    : raw.filter((entry) => entry.at >= cutoff && entry.tokenUsage).map(userContribution);
  const available = entries.some((entry) => entry.tokenAvailable);
  return {
    available,
    source: available ? "codex" : null,
    inputTokens: available ? entries.reduce((sum, entry) => sum + (entry.inputTokens || 0), 0) : null,
    cachedInputTokens: available ? entries.reduce((sum, entry) => sum + (entry.cachedInputTokens || 0), 0) : null,
    outputTokens: available ? entries.reduce((sum, entry) => sum + (entry.outputTokens || 0), 0) : null,
    reasoningOutputTokens: available ? entries.reduce((sum, entry) => sum + (entry.reasoningOutputTokens || 0), 0) : null,
    totalTokens: available ? entries.reduce((sum, entry) => sum + (entry.totalTokens || 0), 0) : null,
  };
}

function tokenUsageSnapshot(entries, { period, periodStart, resetsAt, rolling }) {
  const available = entries.some((entry) => entry.tokenAvailable);
  const turns = entries.reduce((sum, entry) => sum + (Number(entry.turns) || 0), 0);
  return {
    periodStart,
    resetsAt,
    available,
    reportingStatus: available ? "reported" : turns > 0 ? "missing" : "idle",
    source: available ? "codex" : null,
    inputTokens: available ? entries.reduce((sum, entry) => sum + (entry.inputTokens || 0), 0) : null,
    cachedInputTokens: available ? entries.reduce((sum, entry) => sum + (entry.cachedInputTokens || 0), 0) : null,
    outputTokens: available ? entries.reduce((sum, entry) => sum + (entry.outputTokens || 0), 0) : null,
    reasoningOutputTokens: available ? entries.reduce((sum, entry) => sum + (entry.reasoningOutputTokens || 0), 0) : null,
    totalTokens: available ? entries.reduce((sum, entry) => sum + (entry.totalTokens || 0), 0) : null,
  };
}

function isRequest(record) {
  return (record.kind === "http" || record.kind === "rpc") && Number.isFinite(record.durationMs);
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)], 1);
}

function hourStart(value) {
  return Math.floor(value / HOUR_MS) * HOUR_MS;
}

function dayStart(value) {
  return Math.floor(value / DAY_MS) * DAY_MS;
}

function round(value, precision) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

async function readNdjsonTail(filePath, maxBytes) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function writeAtomic(filePath, content) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}
