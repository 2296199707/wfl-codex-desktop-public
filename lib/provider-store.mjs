import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_PROFILES = 20;
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const IMAGE_API_SCHEMA_VERSION = 2;
const LEGACY_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"];
const IMAGE_PRESETS = new Set(["generation-only", "openai-gpt-image-2"]);
const IMAGE_OPERATIONS = new Set(["generate", "edit", "outpaint"]);
const IMAGE_FORMATS = new Set(["png", "jpeg", "webp"]);
const IMAGE_QUALITIES = new Set(["auto", "low", "medium", "high"]);
// OpenAI image models support transparent PNG/WebP output. Keep opaque/auto
// as explicit choices, but do not hide transparency from map/sprite workflows.
const IMAGE_BACKGROUNDS = new Set(["auto", "opaque", "transparent"]);
const IMAGE_MODERATIONS = new Set(["auto", "low"]);
const GPT_IMAGE_2_POPULAR_SIZES = [
  "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152",
  "3840x2160", "2160x3840",
];
const MIB = 1024 * 1024;
export const PROVIDER_KEY_ENV = "CODEX_DESKTOP_PROVIDER_KEY";

export const IMAGE_API_PRESETS = Object.freeze(["generation-only", "openai-gpt-image-2"]);

export class ProviderStore {
  constructor(directory) {
    this.directory = directory;
    this.keyPath = path.join(directory, "provider-store.key");
    this.storePath = path.join(directory, "providers.enc.json");
    this.key = null;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    this.key = await loadOrCreateKey(this.keyPath);
    this.data = await this.readStore();
    return this;
  }

  async reload() {
    this.assertInitialized();
    await this.writeQueue;
    this.data = await this.readStore();
    return this;
  }

  snapshot() {
    this.assertInitialized();
    return {
      activeId: this.data.activeId,
      fallback: this.data.fallback ? { ...this.data.fallback } : null,
      profiles: this.data.profiles.map(publicProfile),
      imageApi: publicImageApi(this.data.imageApi, this.data.profiles),
    };
  }

  getProfile(id) {
    this.assertInitialized();
    const profile = this.data.profiles.find((entry) => entry.id === id);
    return profile ? { ...profile } : null;
  }

  getActiveProfile() {
    return this.data?.activeId ? this.getProfile(this.data.activeId) : null;
  }

  getImageApi() {
    this.assertInitialized();
    if (!this.data.imageApi) return null;
    if (this.data.imageApi.providerId) {
      const provider = this.data.profiles.find((entry) => entry.id === this.data.imageApi.providerId);
      return provider ? {
        ...this.data.imageApi,
        providerName: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        providerProfileRevision: providerProfileRevision(provider),
        configurationRevision: imageApiConfigurationRevision(this.data.imageApi, provider),
      } : null;
    }
    return this.data.imageApi.apiKey ? {
      ...this.data.imageApi,
      providerName: "旧独立 OpenAI 配置",
      baseUrl: "https://api.openai.com/v1",
      providerProfileRevision: null,
      configurationRevision: imageApiConfigurationRevision(this.data.imageApi, null),
    } : null;
  }

  async create(input) {
    return this.mutate(async () => {
      if (this.data.profiles.length >= MAX_PROFILES) throw storeError(400, "最多保存 20 个 API 供应商");
      const profile = normalizeProfile(input);
      profile.id = `p-${crypto.randomBytes(6).toString("hex")}`;
      this.data.profiles.push(profile);
      await this.writeStore();
      return publicProfile(profile);
    });
  }

  async update(id, input) {
    return this.mutate(async () => {
      const index = this.data.profiles.findIndex((entry) => entry.id === id);
      if (index === -1) throw storeError(404, "API 供应商不存在");
      const profile = normalizeProfile(input, this.data.profiles[index]);
      profile.id = id;
      this.data.profiles[index] = profile;
      await this.writeStore();
      return publicProfile(profile);
    });
  }

  async remove(id) {
    return this.mutate(async () => {
      if (this.data.activeId === id) throw storeError(409, "当前使用的供应商不能删除");
      if (this.data.imageApi?.providerId === id) throw storeError(409, "图片生成正在使用这个供应商，不能删除");
      const index = this.data.profiles.findIndex((entry) => entry.id === id);
      if (index === -1) throw storeError(404, "API 供应商不存在");
      this.data.profiles.splice(index, 1);
      await this.writeStore();
    });
  }

  async setActive(id) {
    return this.mutate(async () => {
      if (id !== null && !this.data.profiles.some((entry) => entry.id === id)) {
        throw storeError(404, "API 供应商不存在");
      }
      this.data.activeId = id;
      await this.writeStore();
    });
  }

  async setFallback(fallback, { replace = false } = {}) {
    return this.mutate(async () => {
      if (!this.data.fallback || replace) {
        this.data.fallback = normalizeFallback(fallback);
        await this.writeStore();
      }
      return { ...this.data.fallback };
    });
  }

  async setImageApi(input) {
    return this.mutate(async () => {
      const imageApi = normalizeImageApi(input, this.data.imageApi);
      if (imageApi.providerId && !this.data.profiles.some((profile) => profile.id === imageApi.providerId)) {
        throw storeError(404, "图片供应商不存在");
      }
      this.data.imageApi = imageApi;
      await this.writeStore();
      return publicImageApi(this.data.imageApi, this.data.profiles);
    });
  }

  async seed({ profiles = [], activeId = null, fallback = null } = {}) {
    return this.mutate(async () => {
      this.assertInitialized();
      if (
        this.data.profiles.length
        || this.data.activeId
        || this.data.fallback
        || this.data.imageApi
      ) return false;
      const normalizedProfiles = profiles.map((profile) => normalizeStoredProfile(profile));
      const normalizedActiveId = typeof activeId === "string"
        && normalizedProfiles.some((profile) => profile.id === activeId)
        ? activeId
        : null;
      this.data = {
        version: STORE_VERSION,
        activeId: normalizedActiveId,
        fallback: fallback ? normalizeFallback(fallback) : null,
        profiles: normalizedProfiles,
        imageApi: null,
      };
      await this.writeStore();
      return true;
    });
  }

  async removeImageApi() {
    return this.mutate(async () => {
      this.data.imageApi = null;
      await this.writeStore();
    });
  }

  async readStore() {
    try {
      const envelope = JSON.parse(await fs.readFile(this.storePath, "utf8"));
      if (envelope.version !== STORE_VERSION) throw new Error("Unsupported provider store version");
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      const data = JSON.parse(plaintext.toString("utf8"));
      if (!Array.isArray(data.profiles)) throw new Error("Invalid provider store");
      const profiles = data.profiles.map((profile) => normalizeStoredProfile(profile));
      const activeId = typeof data.activeId === "string" && profiles.some((profile) => profile.id === data.activeId)
        ? data.activeId
        : null;
      return {
        version: STORE_VERSION,
        activeId,
        fallback: data.fallback ? normalizeFallback(data.fallback) : null,
        profiles,
        imageApi: data.imageApi ? normalizeImageApi(data.imageApi, null, { stored: true }) : null,
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`无法读取 API 供应商密钥存储: ${error.message}`);
      const data = {
        version: STORE_VERSION,
        activeId: null,
        fallback: null,
        profiles: [],
        imageApi: null,
      };
      this.data = data;
      await this.writeStore();
      return data;
    }
  }

  async writeStore() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(this.data), "utf8"),
      cipher.final(),
    ]);
    const envelope = {
      version: STORE_VERSION,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const temporaryPath = `${this.storePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporaryPath, this.storePath);
    await fs.chmod(this.storePath, 0o600);
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.data || !this.key) throw new Error("Provider store is not initialized");
  }
}

export async function readExistingProviderSnapshot(directory) {
  const store = new ProviderStore(directory);
  try {
    await Promise.all([
      fs.access(store.keyPath),
      fs.access(store.storePath),
    ]);
    store.key = await fs.readFile(store.keyPath);
    if (store.key.length !== 32) throw new Error("Invalid provider store key");
    store.data = await store.readStore();
    return store.snapshot();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function managedProviderId(id) {
  return `desktop-${id}`;
}

export function managedProviderConfig(profile) {
  const config = {
    name: profile.name,
    base_url: profile.baseUrl,
    wire_api: "responses",
    requires_openai_auth: false,
  };
  if (profile.apiKey) config.env_key = PROVIDER_KEY_ENV;
  return config;
}

export function providerRuntimeEnvironment(profile) {
  return profile?.apiKey ? { [PROVIDER_KEY_ENV]: profile.apiKey } : {};
}

export function providerFallbackFromCodexConfig(config) {
  const providerId = boundedIdentifier(config?.model_provider) || "openai";
  if (isManagedProviderId(providerId)) return { providerId: "openai", model: null };
  return { providerId, model: boundedIdentifier(config?.model) };
}

export function isManagedProviderId(value) {
  return /^desktop-p-[a-f0-9]{12}$/.test(String(value || "").trim());
}

export function discoverCodexProvider(config, profiles = []) {
  const providerId = boundedIdentifier(config?.model_provider);
  const model = boundedIdentifier(config?.model);
  if (!providerId) return null;
  const raw = config?.model_providers?.[providerId];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const baseUrl = publicBaseUrl(raw.base_url);
  if (!baseUrl) return null;
  const name = String(raw.name || providerId).trim();
  const safeName = name && name.length <= 64 ? name : providerId;
  const match = profiles.find((profile) =>
    profile.baseUrl === baseUrl && (!profile.model || profile.model === model),
  );
  return {
    id: providerId,
    name: safeName,
    baseUrl,
    model,
    editableProfileId: match?.id || null,
  };
}

async function loadOrCreateKey(keyPath) {
  try {
    const key = await fs.readFile(keyPath);
    if (key.length !== 32) throw new Error("Invalid provider store key");
    await fs.chmod(keyPath, 0o600);
    return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const key = crypto.randomBytes(32);
    try {
      await fs.writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
      return key;
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      return fs.readFile(keyPath);
    }
  }
}

function normalizeProfile(input, existing = null) {
  const name = String(input?.name ?? existing?.name ?? "").trim();
  if (!name || name.length > 64) throw storeError(400, "供应商名称必须为 1-64 个字符");

  const baseUrl = normalizeBaseUrl(input?.baseUrl ?? existing?.baseUrl);
  const model = String(input?.model ?? existing?.model ?? "").trim();
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) {
    throw storeError(400, "模型 ID 格式不正确");
  }

  const submittedKey = Object.hasOwn(input || {}, "apiKey") ? String(input.apiKey || "").trim() : "";
  if (submittedKey.length > 4096) throw storeError(400, "API Key 过长");
  const apiKey = submittedKey || existing?.apiKey || "";
  const hostname = new URL(baseUrl).hostname;
  if (!apiKey && !isLoopbackHostname(hostname)) throw storeError(400, "远程供应商必须配置 API Key");

  return { id: existing?.id || null, name, baseUrl, model: model || null, apiKey };
}

function normalizeStoredProfile(profile) {
  if (!profile || !/^p-[a-f0-9]{12}$/.test(profile.id)) throw new Error("Invalid provider profile");
  const normalized = normalizeProfile(profile, null);
  normalized.id = profile.id;
  return normalized;
}

function providerProfileRevision(profile) {
  if (!profile || typeof profile !== "object") return null;
  return revisionHash({
    id: profile.id || null,
    name: profile.name || null,
    baseUrl: profile.baseUrl || null,
    model: profile.model || null,
  });
}

function imageApiConfigurationRevision(imageApi, provider) {
  if (!imageApi || typeof imageApi !== "object") return null;
  return revisionHash({
    provider: provider ? {
      id: provider.id || null,
      name: provider.name || null,
      baseUrl: provider.baseUrl || null,
      model: provider.model || null,
    } : null,
    providerId: imageApi.providerId || null,
    model: imageApi.model || null,
    schemaVersion: imageApi.schemaVersion || null,
    preset: imageApi.preset || null,
    transport: imageApi.transport || null,
    capabilities: imageApi.capabilities || null,
    operationCapabilities: imageApi.operationCapabilities || null,
    defaults: imageApi.defaults || null,
    limits: imageApi.limits || null,
  });
}

function revisionHash(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 32);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeImageApi(input, existing = null, { stored = false } = {}) {
  const submittedProviderId = Object.hasOwn(input || {}, "providerId")
    ? String(input.providerId || "").trim()
    : "";
  const providerId = submittedProviderId || existing?.providerId || null;
  const submittedKey = Object.hasOwn(input || {}, "apiKey") ? String(input.apiKey || "").trim() : "";
  if (submittedKey.length > 4096) throw storeError(400, "OPENAI_API_KEY 过长");
  const apiKey = submittedKey || existing?.apiKey || "";
  if (!providerId && !apiKey) throw storeError(400, "请选择图片供应商");
  if (providerId && !/^p-[a-f0-9]{12}$/.test(providerId)) throw storeError(400, "图片供应商格式不正确");

  const model = String(input?.model ?? existing?.model ?? DEFAULT_IMAGE_MODEL).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) throw storeError(400, "图片模型 ID 格式不正确");

  // Calls and stored values from before schema v2 have no preset. Keep those
  // configurations deliberately limited instead of inferring features from a model ID.
  const preset = Object.hasOwn(input || {}, "preset")
    ? String(input.preset || "").trim()
    : existing?.schemaVersion === IMAGE_API_SCHEMA_VERSION && existing?.preset
      ? existing.preset
      : "generation-only";
  if (!IMAGE_PRESETS.has(preset)) throw storeError(400, "不支持这个图片供应商预设");

  const presetConfig = imageApiPreset(preset);
  const retainExisting = existing?.schemaVersion === IMAGE_API_SCHEMA_VERSION && existing?.preset === preset;
  const capabilitiesFallback = retainExisting && existing.capabilities
    ? existing.capabilities
    : presetConfig.capabilities;
  const limitsFallback = retainExisting && existing.limits ? existing.limits : presetConfig.limits;
  const defaultsFallback = retainExisting && existing.defaults ? existing.defaults : presetConfig.defaults;
  const capabilities = normalizeImageCapabilities(
    input?.capabilities,
    capabilitiesFallback,
    presetConfig.capabilities,
  );
  const limits = normalizeImageLimits(
    input?.limits,
    limitsFallback,
    presetConfig.limits,
    capabilities,
    preset,
    { stored },
  );
  const operationCapabilitiesFallback = retainExisting && existing.operationCapabilities
    ? existing.operationCapabilities
    : presetConfig.operationCapabilities;
  const operationCapabilities = normalizeImageOperationCapabilities(
    input?.operationCapabilities,
    operationCapabilitiesFallback,
    presetConfig.operationCapabilities,
    limits,
  );
  const defaultsInput = {
    ...(input?.defaults && typeof input.defaults === "object" && !Array.isArray(input.defaults)
      ? input.defaults
      : {}),
    ...(Object.hasOwn(input || {}, "size") ? { size: input.size } : {}),
    ...(Object.hasOwn(input || {}, "quality") ? { quality: input.quality } : {}),
  };
  const defaults = normalizeImageDefaults(
    defaultsInput,
    defaultsFallback,
    capabilities,
    limits,
    preset,
    operationCapabilities,
  );
  const common = {
    schemaVersion: IMAGE_API_SCHEMA_VERSION,
    preset,
    model,
    size: defaults.size,
    quality: defaults.quality,
    transport: cloneJson(presetConfig.transport),
    capabilities,
    operationCapabilities,
    defaults,
    limits,
  };
  return providerId ? { providerId, ...common } : { apiKey, ...common };
}

function imageApiPreset(preset) {
  const generationOnly = preset === "generation-only";
  return {
    transport: {
      dialect: "openai-images-v1",
      multipartImageField: generationOnly ? "image" : "image[]",
    },
    capabilities: {
      operations: generationOnly ? ["generate"] : ["generate", "edit", "outpaint"],
      inputFormats: generationOnly ? [] : ["png", "jpeg", "webp"],
      mask: !generationOnly,
      multiInput: !generationOnly,
      outputFormats: generationOnly ? ["png"] : ["png", "jpeg", "webp"],
      qualities: ["auto", "low", "medium", "high"],
      backgrounds: generationOnly ? ["opaque"] : ["auto", "opaque", "transparent"],
      moderations: generationOnly ? ["auto"] : ["auto", "low"],
      streaming: !generationOnly,
    },
    operationCapabilities: generationOnly
      ? {
          generate: { customSize: false, sizes: [...LEGACY_IMAGE_SIZES] },
        }
      : Object.fromEntries(["generate", "edit", "outpaint"].map((operation) => [
          operation,
          { customSize: true, sizes: [...GPT_IMAGE_2_POPULAR_SIZES] },
        ])),
    defaults: {
      size: "1024x1024",
      quality: "auto",
      outputFormat: "png",
      outputCompression: 100,
      background: generationOnly ? "opaque" : "auto",
      moderation: "auto",
      n: 1,
      partialImages: 0,
    },
    limits: {
      maxPromptCharacters: generationOnly ? 4_000 : 32_000,
      fixedSizes: generationOnly ? [...LEGACY_IMAGE_SIZES] : [],
      maxInputImages: generationOnly ? 0 : 16,
      maxOutputs: generationOnly ? 1 : 10,
      maxPartialImages: generationOnly ? 0 : 3,
      size: generationOnly ? null : {
        allowAuto: true,
        maxWidth: 3840,
        maxHeight: 3840,
        dimensionMultiple: 16,
        maxAspectRatio: 3,
        minPixels: 655_360,
        maxPixels: 8_294_400,
      },
      timeoutMs: 180_000,
      maxInputBytesPerImage: 20 * MIB,
      maxInputBytesTotal: generationOnly ? 0 : 64 * MIB,
      maxOutputBytesPerImage: 20 * MIB,
      maxResponseBytes: generationOnly ? 32 * MIB : 256 * MIB,
      transientRetries: 0,
    },
  };
}

function normalizeImageCapabilities(input, fallback, allowed) {
  if (input == null) return cloneJson(fallback);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw storeError(400, "图片能力配置格式不正确");
  }
  const operations = normalizedEnumList(input.operations, fallback.operations, allowed.operations, IMAGE_OPERATIONS, "图片操作");
  if (!operations.includes("generate")) throw storeError(400, "图片能力必须包含 generate");
  const inputFormats = normalizedEnumList(input.inputFormats, fallback.inputFormats, allowed.inputFormats, IMAGE_FORMATS, "输入图片格式");
  const outputFormats = normalizedEnumList(input.outputFormats, fallback.outputFormats, allowed.outputFormats, IMAGE_FORMATS, "输出图片格式");
  if (!outputFormats.length) throw storeError(400, "至少需要一种输出图片格式");
  const qualities = normalizedEnumList(input.qualities, fallback.qualities, allowed.qualities, IMAGE_QUALITIES, "图片质量");
  const backgrounds = normalizedEnumList(input.backgrounds, fallback.backgrounds, allowed.backgrounds, IMAGE_BACKGROUNDS, "图片背景");
  const moderations = normalizedEnumList(input.moderations, fallback.moderations, allowed.moderations, IMAGE_MODERATIONS, "图片审核档位");
  return {
    operations,
    inputFormats,
    mask: normalizedBoolean(input.mask, fallback.mask, allowed.mask, "蒙版能力"),
    multiInput: normalizedBoolean(input.multiInput, fallback.multiInput, allowed.multiInput, "多图输入能力"),
    outputFormats,
    qualities,
    backgrounds,
    moderations,
    streaming: normalizedBoolean(input.streaming, fallback.streaming, allowed.streaming, "流式预览能力"),
  };
}

function normalizeImageLimits(input, fallback, allowed, capabilities, preset, { stored = false } = {}) {
  if (input != null && (!input || typeof input !== "object" || Array.isArray(input))) {
    throw storeError(400, "图片限制配置格式不正确");
  }
  const value = input || {};
  const maxPromptCharacters = boundedImageInteger(
    value.maxPromptCharacters,
    fallback.maxPromptCharacters,
    1,
    allowed.maxPromptCharacters,
    "图片描述最大字符数",
  );
  const maxInputImages = boundedImageInteger(value.maxInputImages, fallback.maxInputImages, 0, allowed.maxInputImages, "最大输入图片数");
  const maxOutputs = boundedImageInteger(value.maxOutputs, fallback.maxOutputs, 1, allowed.maxOutputs, "最大输出图片数");
  const maxPartialImages = boundedImageInteger(value.maxPartialImages, fallback.maxPartialImages, 0, allowed.maxPartialImages, "最大流式预览数");
  if (!capabilities.multiInput && maxInputImages > 1) throw storeError(400, "未启用多图输入能力");
  if (!capabilities.streaming && maxPartialImages > 0) throw storeError(400, "未启用流式预览能力");
  if (
    !stored
    && Object.hasOwn(value, "transientRetries")
    && Number(value.transientRetries) !== 0
  ) {
    throw storeError(400, "图片请求不允许自动重试；瞬时错误重试次数必须为 0");
  }
  return {
    maxPromptCharacters,
    fixedSizes: [...allowed.fixedSizes],
    maxInputImages,
    maxOutputs,
    maxPartialImages,
    size: allowed.size ? cloneJson(allowed.size) : null,
    timeoutMs: boundedImageInteger(value.timeoutMs, fallback.timeoutMs, 1_000, 900_000, "图片请求超时"),
    maxInputBytesPerImage: boundedImageInteger(value.maxInputBytesPerImage, fallback.maxInputBytesPerImage, 1, 512 * MIB, "单张输入图片大小"),
    maxInputBytesTotal: boundedImageInteger(value.maxInputBytesTotal, fallback.maxInputBytesTotal, preset === "generation-only" ? 0 : 1, 1024 * MIB, "输入图片总大小"),
    maxOutputBytesPerImage: boundedImageInteger(value.maxOutputBytesPerImage, fallback.maxOutputBytesPerImage, 1, 512 * MIB, "单张输出图片大小"),
    maxResponseBytes: boundedImageInteger(value.maxResponseBytes, fallback.maxResponseBytes, 1, 2048 * MIB, "图片响应大小"),
    transientRetries: 0,
  };
}

function normalizeImageDefaults(input, fallback, capabilities, limits, preset, operationCapabilities) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw storeError(400, "图片默认配置格式不正确");
  }
  const size = String(input.size ?? fallback.size).trim();
  validateImageSize(size, limits, preset, operationCapabilities.generate);
  const quality = normalizedEnum(input.quality, fallback.quality, capabilities.qualities, "图片质量");
  const outputFormat = normalizedEnum(input.outputFormat, fallback.outputFormat, capabilities.outputFormats, "输出图片格式");
  const background = normalizedEnum(input.background, fallback.background, capabilities.backgrounds, "图片背景");
  if (background === "transparent" && outputFormat === "jpeg") {
    throw storeError(400, "透明背景只支持 PNG 或 WebP 输出");
  }
  const moderation = normalizedEnum(input.moderation, fallback.moderation, capabilities.moderations, "图片审核档位");
  return {
    size,
    quality,
    outputFormat,
    outputCompression: boundedImageInteger(input.outputCompression, fallback.outputCompression, 0, 100, "输出压缩率"),
    background,
    moderation,
    n: boundedImageInteger(input.n, fallback.n, 1, limits.maxOutputs, "默认输出图片数"),
    partialImages: boundedImageInteger(input.partialImages, fallback.partialImages, 0, limits.maxPartialImages, "默认流式预览数"),
  };
}

function validateImageSize(value, limits, preset, operationCapability = null) {
  if (preset === "generation-only") {
    if (!limits.fixedSizes.includes(value)) throw storeError(400, "不支持这个图片尺寸");
    return;
  }
  if (operationCapability && operationCapability.sizes.includes(value)) return;
  if (operationCapability && operationCapability.customSize !== true) {
    throw storeError(400, "当前生成操作不支持这个默认图片尺寸");
  }
  if (value === "auto" && limits.size?.allowAuto) return;
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(value);
  if (!match) throw storeError(400, "图片尺寸格式不正确");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const rule = limits.size;
  const pixels = width * height;
  if (
    width > rule.maxWidth
    || height > rule.maxHeight
    || width % rule.dimensionMultiple !== 0
    || height % rule.dimensionMultiple !== 0
    || Math.max(width / height, height / width) > rule.maxAspectRatio
    || pixels < rule.minPixels
    || pixels > rule.maxPixels
  ) throw storeError(400, "图片尺寸不符合当前预设限制");
}

function normalizeImageOperationCapabilities(input, fallback, allowed, limits) {
  if (input != null && (!input || typeof input !== "object" || Array.isArray(input))) {
    throw storeError(400, "按操作图片能力格式不正确");
  }
  const value = input || {};
  for (const operation of Object.keys(value)) {
    if (!Object.hasOwn(allowed, operation)) throw storeError(400, `不支持 ${operation} 图片操作能力`);
  }
  const result = {};
  for (const [operation, allowedEntry] of Object.entries(allowed)) {
    const fallbackEntry = fallback?.[operation] || allowedEntry;
    const supplied = Object.hasOwn(value, operation) ? value[operation] : null;
    if (supplied != null && (!supplied || typeof supplied !== "object" || Array.isArray(supplied))) {
      throw storeError(400, `${operation} 图片操作能力格式不正确`);
    }
    const entry = supplied || fallbackEntry;
    const customSize = normalizedBoolean(
      entry.customSize,
      fallbackEntry.customSize === true,
      allowedEntry.customSize === true,
      `${operation} 自定义尺寸能力`,
    );
    const sizes = entry.sizes == null
      ? [...(fallbackEntry.sizes || [])]
      : normalizeOperationSizes(entry.sizes, limits, operation);
    if (!customSize && !sizes.length) {
      throw storeError(400, `${operation} 关闭自定义尺寸后必须至少保留一个固定尺寸`);
    }
    result[operation] = { customSize, sizes };
  }
  return result;
}

function normalizeOperationSizes(value, limits, operation) {
  if (!Array.isArray(value) || value.length > 64) {
    throw storeError(400, `${operation} 固定尺寸清单格式不正确`);
  }
  const sizes = [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
  for (const size of sizes) {
    if (limits.fixedSizes?.length) {
      if (!limits.fixedSizes.includes(size)) throw storeError(400, `${operation} 固定尺寸超出预设范围`);
    } else {
      validateImageSize(size, limits, "openai-gpt-image-2", { customSize: true, sizes: [] });
    }
  }
  return sizes;
}

function normalizedEnumList(value, fallback, allowed, universe, label) {
  if (value == null) return [...fallback];
  if (!Array.isArray(value)) throw storeError(400, `${label}格式不正确`);
  const normalized = [...new Set(value.map((entry) => String(entry || "").trim()))];
  if (normalized.some((entry) => !universe.has(entry) || !allowed.includes(entry))) {
    throw storeError(400, `${label}包含不支持的值`);
  }
  return normalized;
}

function normalizedEnum(value, fallback, allowed, label) {
  const normalized = String(value ?? fallback).trim();
  if (!allowed.includes(normalized)) throw storeError(400, `不支持这个${label}`);
  return normalized;
}

function normalizedBoolean(value, fallback, allowed, label) {
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw storeError(400, `${label}格式不正确`);
  if (value && !allowed) throw storeError(400, `当前预设不支持${label}`);
  return value;
}

function boundedImageInteger(value, fallback, minimum, maximum, label) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw storeError(400, `${label}必须是 ${minimum}-${maximum} 的整数`);
  }
  return number;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw storeError(400, "Base URL 格式不正确");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw storeError(400, "Base URL 不能包含账号、查询参数或片段");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw storeError(400, "远程供应商必须使用 HTTPS");
  }
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}`;
}

function publicBaseUrl(value) {
  try {
    return normalizeBaseUrl(value);
  } catch {
    return null;
  }
}

function boundedIdentifier(value) {
  const identifier = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(identifier) ? identifier : null;
}

function normalizeFallback(value) {
  const providerId = String(value?.providerId || "").trim();
  const model = String(value?.model || "").trim();
  if (!providerId || isManagedProviderId(providerId)) {
    throw new Error("Invalid fallback provider");
  }
  return { providerId, model: model || null };
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    hasApiKey: Boolean(profile.apiKey),
    revision: providerProfileRevision(profile),
  };
}

function publicImageApi(imageApi, profiles = []) {
  if (imageApi?.providerId) {
    const provider = profiles.find((entry) => entry.id === imageApi.providerId);
    return {
      configured: Boolean(provider),
      source: "provider",
      providerId: imageApi.providerId,
      providerName: provider?.name || null,
      providerProfileRevision: provider ? providerProfileRevision(provider) : null,
      configurationRevision: imageApiConfigurationRevision(imageApi, provider),
      model: imageApi.model,
      size: imageApi.size,
      quality: imageApi.quality,
      schemaVersion: imageApi.schemaVersion,
      preset: imageApi.preset,
      transport: cloneJson(imageApi.transport),
      capabilities: cloneJson(imageApi.capabilities),
      operationCapabilities: cloneJson(imageApi.operationCapabilities),
      defaults: cloneJson(imageApi.defaults),
      limits: cloneJson(imageApi.limits),
    };
  }
  if (imageApi?.apiKey) return {
    configured: true,
    source: "legacy",
    providerId: null,
    providerName: "旧独立 OpenAI 配置",
    providerProfileRevision: null,
    configurationRevision: imageApiConfigurationRevision(imageApi, null),
    model: imageApi.model,
    size: imageApi.size,
    quality: imageApi.quality,
    schemaVersion: imageApi.schemaVersion,
    preset: imageApi.preset,
    transport: cloneJson(imageApi.transport),
    capabilities: cloneJson(imageApi.capabilities),
    operationCapabilities: cloneJson(imageApi.operationCapabilities),
    defaults: cloneJson(imageApi.defaults),
    limits: cloneJson(imageApi.limits),
  };
  const preset = imageApiPreset("generation-only");
  return {
    configured: false,
    source: null,
    providerId: null,
    providerName: null,
    providerProfileRevision: null,
    configurationRevision: imageApiConfigurationRevision(preset, null),
    model: DEFAULT_IMAGE_MODEL,
    size: "1024x1024",
    quality: "auto",
    schemaVersion: IMAGE_API_SCHEMA_VERSION,
    preset: "generation-only",
    transport: cloneJson(preset.transport),
    capabilities: cloneJson(preset.capabilities),
    operationCapabilities: cloneJson(preset.operationCapabilities),
    defaults: cloneJson(preset.defaults),
    limits: cloneJson(preset.limits),
  };
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function storeError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
