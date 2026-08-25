import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverCodexProvider,
  providerFallbackFromCodexConfig,
  ProviderStore,
  readExistingProviderSnapshot,
} from "../lib/provider-store.mjs";

test("provider profiles encrypt API keys and only expose key presence", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-store-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    const created = await store.create({
      name: "Example API",
      baseUrl: "https://api.example.test/v1/",
      model: "gpt-5.6-sol",
      apiKey: "secret-provider-key-value",
    });

    assert.equal(created.baseUrl, "https://api.example.test/v1");
    assert.equal(created.hasApiKey, true);
    assert.equal(Object.hasOwn(created, "apiKey"), false);
    assert.equal(store.snapshot().imageApi.model, "gpt-image-2");
    assert.equal(store.snapshot().imageApi.schemaVersion, 2);
    assert.equal(store.snapshot().imageApi.preset, "generation-only");
    const encrypted = await fs.readFile(path.join(directory, "providers.enc.json"), "utf8");
    assert.doesNotMatch(encrypted, /secret-provider-key-value/);
    assert.equal((await fs.stat(path.join(directory, "providers.enc.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(directory, "provider-store.key"))).mode & 0o777, 0o600);

    const reloaded = await new ProviderStore(directory).initialize();
    assert.equal(reloaded.getProfile(created.id).apiKey, "secret-provider-key-value");
    assert.equal(reloaded.snapshot().profiles[0].hasApiKey, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("provider and image configuration revisions are opaque and change with safe configuration", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-revision-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    const created = await store.create({
      name: "Revision API",
      baseUrl: "https://api.example.test/v1",
      model: "gpt-image-2",
      apiKey: "revision-secret",
    });
    const first = store.snapshot();
    assert.match(first.profiles[0].revision, /^[a-f0-9]{32}$/u);
    await store.setImageApi({ providerId: created.id, preset: "openai-gpt-image-2" });
    const configured = store.snapshot();
    assert.equal(configured.imageApi.providerProfileRevision, first.profiles[0].revision);
    assert.match(configured.imageApi.configurationRevision, /^[a-f0-9]{32}$/u);
    assert.doesNotMatch(JSON.stringify(configured), /revision-secret/u);
    await store.update(created.id, {
      name: "Revision API renamed",
      baseUrl: "https://api.example.test/v1",
      model: "gpt-image-2",
    });
    const changed = store.snapshot();
    assert.notEqual(changed.profiles[0].revision, first.profiles[0].revision);
    assert.notEqual(changed.imageApi.providerProfileRevision, configured.imageApi.providerProfileRevision);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("existing provider snapshots can be inspected without creating missing stores", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-inspect-"));
  const missingDirectory = path.join(directory, "missing");
  try {
    assert.equal(await readExistingProviderSnapshot(missingDirectory), null);
    await assert.rejects(fs.stat(missingDirectory), { code: "ENOENT" });

    const store = await new ProviderStore(directory).initialize();
    const created = await store.create({
      name: "Persisted API",
      baseUrl: "https://api.example.test/v1",
      model: "gpt-persisted",
      apiKey: "persisted-secret-key",
    });
    await store.setActive(created.id);

    const snapshot = await readExistingProviderSnapshot(directory);
    assert.equal(snapshot.activeId, created.id);
    assert.equal(snapshot.profiles[0].name, "Persisted API");
    assert.equal(snapshot.profiles[0].hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(snapshot), /persisted-secret-key/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a long-running provider store reloads changes written by another process", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-reload-"));
  try {
    const longRunning = await new ProviderStore(directory).initialize();
    const writer = await new ProviderStore(directory).initialize();
    const created = await writer.create({
      name: "Rescue API",
      baseUrl: "https://api.example.test/v1",
      model: "gpt-rescue",
      apiKey: "rescue-secret-key",
    });
    await writer.setActive(created.id);

    assert.equal(longRunning.snapshot().activeId, null);
    await longRunning.reload();
    assert.equal(longRunning.snapshot().activeId, created.id);
    assert.equal(longRunning.getActiveProfile().apiKey, "rescue-secret-key");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an empty provider store can be atomically seeded with isolated credentials", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-seed-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    const profile = {
      id: "p-123456789abc",
      name: "Isolated rescue API",
      baseUrl: "https://api.example.test/v1",
      model: "gpt-rescue",
      apiKey: "isolated-rescue-secret",
    };
    assert.equal(await store.seed({ profiles: [profile], activeId: profile.id }), true);
    assert.equal(store.snapshot().activeId, profile.id);
    assert.equal(store.getActiveProfile().apiKey, "isolated-rescue-secret");
    assert.equal(await store.seed({ profiles: [], activeId: null }), false);
    const encrypted = await fs.readFile(path.join(directory, "providers.enc.json"), "utf8");
    assert.doesNotMatch(encrypted, /isolated-rescue-secret/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("image settings reference an encrypted provider and retain legacy key compatibility", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-store-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    const legacy = await store.setImageApi({
      apiKey: "legacy-image-key",
      model: "gpt-image-2.0",
      size: "1024x1024",
      quality: "auto",
    });
    assert.equal(legacy.source, "legacy");
    assert.equal(store.getImageApi().baseUrl, "https://api.openai.com/v1");
    const provider = await store.create({
      name: "Image capable provider",
      baseUrl: "https://api.example.test/v1",
      model: "gpt-text",
      apiKey: "secret-provider-key",
    });
    const saved = await store.setImageApi({
      providerId: provider.id,
      model: "gpt-image-2.0",
      size: "1536x1024",
      quality: "high",
    });
    assert.deepEqual({
      configured: saved.configured,
      source: saved.source,
      providerId: saved.providerId,
      providerName: saved.providerName,
      model: saved.model,
      size: saved.size,
      quality: saved.quality,
    }, {
      configured: true,
      source: "provider",
      providerId: provider.id,
      providerName: "Image capable provider",
      model: "gpt-image-2.0",
      size: "1536x1024",
      quality: "high",
    });
    assert.equal(saved.schemaVersion, 2);
    assert.equal(saved.preset, "generation-only");
    assert.deepEqual(saved.capabilities.operations, ["generate"]);
    assert.deepEqual(saved.capabilities.outputFormats, ["png"]);
    assert.equal(saved.defaults.n, 1);
    assert.equal(saved.limits.maxPromptCharacters, 4_000);
    assert.equal(saved.limits.maxOutputs, 1);
    assert.equal(saved.transport.multipartImageField, "image");
    assert.equal(Object.hasOwn(saved, "apiKey"), false);
    assert.equal(store.getImageApi().apiKey, "secret-provider-key");
    assert.equal(store.getImageApi().baseUrl, "https://api.example.test/v1");

    await store.setImageApi({ providerId: provider.id, model: "vendor-image-2.0", size: "1024x1024", quality: "auto" });
    assert.equal(store.getImageApi().apiKey, "secret-provider-key");
    assert.equal(store.getImageApi().model, "vendor-image-2.0");
    const encrypted = await fs.readFile(path.join(directory, "providers.enc.json"), "utf8");
    assert.doesNotMatch(encrypted, /secret-provider-key/);
    assert.doesNotMatch(encrypted, /legacy-image-key/);

    const reloaded = await new ProviderStore(directory).initialize();
    assert.equal(reloaded.snapshot().imageApi.configured, true);
    assert.equal(reloaded.getImageApi().apiKey, "secret-provider-key");
    await assert.rejects(reloaded.remove(provider.id), /图片生成正在使用/);
    await reloaded.removeImageApi();
    assert.equal(reloaded.snapshot().imageApi.configured, false);
    assert.equal(reloaded.getImageApi(), null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("legacy image settings migrate deterministically to the generation-only v2 contract", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-image-migrate-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    const provider = await store.create({
      name: "Legacy image provider",
      baseUrl: "https://api.example.test/v1",
      model: "text-model",
      apiKey: "provider-secret",
    });
    store.data.imageApi = {
      providerId: provider.id,
      model: "vendor-image-model",
      size: "1536x1024",
      quality: "high",
    };
    await store.writeStore();

    const reloaded = await new ProviderStore(directory).initialize();
    const imageApi = reloaded.getImageApi();
    assert.equal(imageApi.schemaVersion, 2);
    assert.equal(imageApi.preset, "generation-only");
    assert.equal(imageApi.size, "1536x1024");
    assert.equal(imageApi.quality, "high");
    assert.deepEqual(imageApi.capabilities.operations, ["generate"]);
    assert.deepEqual(imageApi.limits.fixedSizes, ["1024x1024", "1536x1024", "1024x1536"]);
    assert.equal(imageApi.limits.maxPromptCharacters, 4_000);
    assert.equal(imageApi.limits.maxOutputs, 1);
    assert.equal(imageApi.defaults.outputFormat, "png");
    assert.equal(imageApi.defaults.n, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the OpenAI GPT Image 2 preset exposes edit, outpaint, formats, streaming, and arbitrary size limits", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-image-v2-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    const provider = await store.create({
      name: "Full image provider",
      baseUrl: "https://api.example.test/v1",
      model: "text-model",
      apiKey: "full-provider-secret",
    });
    const saved = await store.setImageApi({
      providerId: provider.id,
      preset: "openai-gpt-image-2",
      model: "gpt-image-2",
      defaults: {
        size: "2048x1024",
        quality: "high",
        outputFormat: "webp",
        outputCompression: 82,
        background: "opaque",
        moderation: "low",
        n: 4,
        partialImages: 2,
      },
      limits: {
        timeoutMs: 240_000,
        maxInputBytesPerImage: 12 * 1024 * 1024,
        maxInputBytesTotal: 48 * 1024 * 1024,
        maxOutputBytesPerImage: 16 * 1024 * 1024,
        maxResponseBytes: 128 * 1024 * 1024,
        transientRetries: 0,
      },
    });

    assert.equal(saved.schemaVersion, 2);
    assert.equal(saved.preset, "openai-gpt-image-2");
    assert.deepEqual(saved.capabilities.operations, ["generate", "edit", "outpaint"]);
    assert.equal(saved.capabilities.mask, true);
    assert.equal(saved.capabilities.multiInput, true);
    assert.deepEqual(saved.capabilities.inputFormats, ["png", "jpeg", "webp"]);
    assert.deepEqual(saved.capabilities.outputFormats, ["png", "jpeg", "webp"]);
    assert.deepEqual(saved.capabilities.backgrounds, ["auto", "opaque", "transparent"]);
    assert.deepEqual(saved.capabilities.moderations, ["auto", "low"]);
    assert.equal(saved.capabilities.streaming, true);
    assert.equal(saved.operationCapabilities.generate.customSize, true);
    assert.equal(saved.operationCapabilities.edit.customSize, true);
    assert.ok(saved.operationCapabilities.outpaint.sizes.includes("3840x2160"));
    assert.equal(saved.transport.dialect, "openai-images-v1");
    assert.equal(saved.transport.multipartImageField, "image[]");
    assert.equal(saved.defaults.size, "2048x1024");
    assert.equal(saved.size, "2048x1024");
    assert.equal(saved.defaults.outputCompression, 82);
    assert.equal(saved.defaults.n, 4);
    assert.equal(saved.defaults.partialImages, 2);
    assert.equal(saved.limits.maxPromptCharacters, 32_000);
    assert.equal(saved.limits.maxInputImages, 16);
    assert.equal(saved.limits.maxOutputs, 10);
    assert.equal(saved.limits.maxPartialImages, 3);
    assert.deepEqual(saved.limits.size, {
      allowAuto: true,
      maxWidth: 3840,
      maxHeight: 3840,
      dimensionMultiple: 16,
      maxAspectRatio: 3,
      minPixels: 655_360,
      maxPixels: 8_294_400,
    });
    assert.equal(saved.limits.timeoutMs, 240_000);
    assert.equal(saved.limits.transientRetries, 0);

    const customized = await store.setImageApi({
      providerId: provider.id,
      capabilities: { outputFormats: ["png", "webp"] },
      operationCapabilities: {
        edit: { customSize: false, sizes: ["1536x1024"] },
        outpaint: { customSize: false, sizes: ["1536x1024"] },
      },
      defaults: { outputCompression: 81 },
      limits: { timeoutMs: 260_000 },
    });
    assert.deepEqual(customized.capabilities.operations, ["generate", "edit", "outpaint"]);
    assert.deepEqual(customized.capabilities.outputFormats, ["png", "webp"]);
    assert.equal(customized.capabilities.mask, true);
    assert.deepEqual(customized.operationCapabilities.edit, {
      customSize: false,
      sizes: ["1536x1024"],
    });
    assert.deepEqual(customized.operationCapabilities.outpaint, {
      customSize: false,
      sizes: ["1536x1024"],
    });
    assert.equal(customized.defaults.outputFormat, "webp");
    assert.equal(customized.defaults.outputCompression, 81);
    assert.equal(customized.defaults.n, 4);
    assert.equal(customized.limits.timeoutMs, 260_000);
    assert.equal(customized.limits.maxInputBytesPerImage, 12 * 1024 * 1024);
    assert.equal(customized.limits.maxResponseBytes, 128 * 1024 * 1024);
    assert.equal(customized.limits.maxPromptCharacters, 32_000);

    const updated = await store.setImageApi({
      providerId: provider.id,
      preset: "openai-gpt-image-2",
      size: "auto",
    });
    assert.equal(updated.preset, "openai-gpt-image-2");
    assert.equal(updated.defaults.size, "auto");
    assert.equal(updated.size, "auto");
    assert.equal(updated.defaults.quality, "high");
    assert.equal(updated.defaults.outputFormat, "webp");
    assert.equal(updated.defaults.outputCompression, 81);
    assert.equal(updated.defaults.background, "opaque");
    assert.equal(updated.defaults.moderation, "low");
    assert.equal(updated.defaults.n, 4);
    assert.equal(updated.defaults.partialImages, 2);
    assert.deepEqual(updated.capabilities.operations, ["generate", "edit", "outpaint"]);
    assert.deepEqual(updated.capabilities.outputFormats, ["png", "webp"]);
    assert.equal(updated.limits.timeoutMs, 260_000);
    assert.equal(updated.limits.maxInputBytesPerImage, 12 * 1024 * 1024);
    assert.equal(updated.limits.maxInputBytesTotal, 48 * 1024 * 1024);
    assert.equal(updated.limits.maxOutputBytesPerImage, 16 * 1024 * 1024);
    assert.equal(updated.limits.maxResponseBytes, 128 * 1024 * 1024);
    assert.equal(updated.limits.transientRetries, 0);
    assert.equal(updated.operationCapabilities.edit.customSize, false);
    assert.deepEqual(updated.operationCapabilities.outpaint.sizes, ["1536x1024"]);

    const reloaded = await new ProviderStore(directory).initialize();
    assert.deepEqual(reloaded.snapshot().imageApi, updated);
    assert.equal(reloaded.getImageApi().apiKey, "full-provider-secret");
    assert.doesNotMatch(JSON.stringify(reloaded.snapshot()), /full-provider-secret/);

    const switched = await reloaded.setImageApi({
      providerId: provider.id,
      preset: "generation-only",
    });
    assert.equal(switched.preset, "generation-only");
    assert.deepEqual(switched.capabilities.operations, ["generate"]);
    assert.deepEqual(switched.capabilities.outputFormats, ["png"]);
    assert.equal(switched.defaults.size, "1024x1024");
    assert.equal(switched.defaults.quality, "auto");
    assert.equal(switched.defaults.outputCompression, 100);
    assert.equal(switched.defaults.n, 1);
    assert.equal(switched.limits.timeoutMs, 180_000);
    assert.equal(switched.limits.maxPromptCharacters, 4_000);
    assert.equal(switched.limits.maxOutputs, 1);
    assert.equal(switched.limits.transientRetries, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("image v2 rejects unsupported presets, invalid dimensions, and unsafe defaults or limits", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-image-invalid-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    const provider = await store.create({
      name: "Image provider",
      baseUrl: "https://api.example.test/v1",
      model: "text-model",
      apiKey: "provider-secret",
    });
    const base = { providerId: provider.id, model: "gpt-image-2" };
    await assert.rejects(store.setImageApi({ ...base, preset: "automatic" }), /预设/);
    await assert.rejects(store.setImageApi({ ...base, preset: "generation-only", size: "2048x1024" }), /尺寸/);
    await assert.rejects(store.setImageApi({ ...base, preset: "openai-gpt-image-2", size: "1025x1024" }), /尺寸/);
    await assert.rejects(store.setImageApi({ ...base, preset: "openai-gpt-image-2", size: "3840x3840" }), /尺寸/);
    await assert.rejects(store.setImageApi({
      ...base,
      preset: "openai-gpt-image-2",
      defaults: { n: 11 },
    }), /输出图片数/);
    await assert.rejects(store.setImageApi({
      ...base,
      preset: "openai-gpt-image-2",
      defaults: { outputCompression: 101 },
    }), /压缩率/);
    await assert.rejects(store.setImageApi({
      ...base,
      preset: "openai-gpt-image-2",
      defaults: { outputFormat: "jpeg", background: "transparent" },
    }), /透明背景/);
    await assert.rejects(store.setImageApi({
      ...base,
      preset: "openai-gpt-image-2",
      limits: { transientRetries: 1 },
    }), /重试次数/);
    await assert.rejects(store.setImageApi({
      ...base,
      preset: "openai-gpt-image-2",
      limits: { maxPromptCharacters: 32_001 },
    }), /描述最大字符数/);
    await assert.rejects(store.setImageApi({
      ...base,
      preset: "generation-only",
      capabilities: { operations: ["generate", "edit"] },
    }), /不支持/);
    await assert.rejects(store.setImageApi({
      ...base,
      preset: "openai-gpt-image-2",
      operationCapabilities: { edit: { customSize: false, sizes: [] } },
    }), /至少保留一个固定尺寸/);
    await assert.rejects(store.setImageApi({
      ...base,
      preset: "openai-gpt-image-2",
      operationCapabilities: { outpaint: { customSize: false, sizes: ["1025x1024"] } },
    }), /尺寸/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("public image snapshots are detached from stored capabilities and never expose credentials", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-image-public-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    await store.setImageApi({
      apiKey: "legacy-secret-that-must-not-leak",
      preset: "openai-gpt-image-2",
      model: "gpt-image-2",
    });
    const snapshot = store.snapshot();
    snapshot.imageApi.capabilities.operations.splice(0);
    snapshot.imageApi.defaults.outputFormat = "jpeg";
    snapshot.imageApi.limits.size.maxWidth = 16;
    snapshot.imageApi.operationCapabilities.edit.sizes.splice(0);

    const fresh = store.snapshot();
    assert.deepEqual(fresh.imageApi.capabilities.operations, ["generate", "edit", "outpaint"]);
    assert.equal(fresh.imageApi.defaults.outputFormat, "png");
    assert.equal(fresh.imageApi.limits.size.maxWidth, 3840);
    assert.ok(fresh.imageApi.operationCapabilities.edit.sizes.length > 0);
    assert.equal(Object.hasOwn(fresh.imageApi, "apiKey"), false);
    assert.doesNotMatch(JSON.stringify(fresh), /legacy-secret-that-must-not-leak/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("provider profiles may defer model selection to Codex and survive reload", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-store-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    const created = await store.create({
      name: "Model Later",
      baseUrl: "https://api.example.test/v1",
      model: "",
      apiKey: "secret-provider-key-value",
    });

    assert.equal(created.model, null);
    const reloaded = await new ProviderStore(directory).initialize();
    assert.equal(reloaded.snapshot().profiles[0].model, null);
    assert.equal(reloaded.getProfile(created.id).model, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("current Codex providers are discovered without exposing secrets", () => {
  const discovered = discoverCodexProvider({
    model_provider: "custom",
    model: "gpt-5.6-sol",
    model_providers: {
      custom: {
        name: "wflapi",
        base_url: "https://wflapi.cloud/v1/",
        env_key: "PRIVATE_ENV_NAME",
        api_key: "must-not-leak",
      },
    },
  }, [{
    id: "p-e0a901e31c47",
    name: "wflapi",
    baseUrl: "https://wflapi.cloud/v1",
    model: "gpt-5.6-sol",
    hasApiKey: true,
  }]);
  assert.deepEqual(discovered, {
    id: "custom",
    name: "wflapi",
    baseUrl: "https://wflapi.cloud/v1",
    model: "gpt-5.6-sol",
    editableProfileId: "p-e0a901e31c47",
  });
  assert.doesNotMatch(JSON.stringify(discovered), /PRIVATE_ENV_NAME|must-not-leak/);
  assert.equal(discoverCodexProvider({
    model_provider: "unsafe",
    model: "model-1",
    model_providers: { unsafe: { base_url: "http://remote.example.test/v1" } },
  }), null);
});

test("orphaned desktop providers fall back to a clean official configuration", () => {
  assert.deepEqual(providerFallbackFromCodexConfig({
    model_provider: "desktop-p-deadbeefcafe",
    model: "orphaned-model",
  }), { providerId: "openai", model: null });
  assert.deepEqual(providerFallbackFromCodexConfig({
    model_provider: "company-api",
    model: "company-model",
  }), { providerId: "company-api", model: "company-model" });
});

test("provider updates retain blank keys and active profiles cannot be deleted", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-store-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    const created = await store.create({
      name: "Primary",
      baseUrl: "https://api.example.test/v1",
      model: "gpt-5.6-sol",
      apiKey: "keep-this-key",
    });
    const updated = await store.update(created.id, {
      name: "Primary Updated",
      baseUrl: "https://api.example.test/v2",
      model: "gpt-5.6-sol",
      apiKey: "",
    });
    assert.equal(updated.name, "Primary Updated");
    assert.equal(store.getProfile(created.id).apiKey, "keep-this-key");

    await store.setFallback({ providerId: "custom", model: "gpt-5.6-sol" });
    await store.setFallback({ providerId: "ignored", model: "model-2" });
    assert.equal(store.snapshot().fallback.providerId, "custom");
    await store.setFallback({ providerId: "openai", model: null }, { replace: true });
    assert.equal(store.snapshot().fallback.providerId, "openai");
    await store.setActive(created.id);
    assert.equal(store.snapshot().fallback.providerId, "openai");
    await assert.rejects(store.remove(created.id), /不能删除/);
    await store.setActive(null);
    await store.remove(created.id);
    assert.equal(store.snapshot().profiles.length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("fallback configuration accepts external provider IDs with a desktop prefix", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-store-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    await store.setFallback({ providerId: "desktop-company", model: "model-1" });
    assert.equal(store.snapshot().fallback.providerId, "desktop-company");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("remote providers require HTTPS and a key while loopback providers may omit both", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-store-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    await assert.rejects(
      store.create({ name: "Unsafe", baseUrl: "http://api.example.test/v1", model: "model-1", apiKey: "key" }),
      /HTTPS/,
    );
    await assert.rejects(
      store.create({ name: "Missing Key", baseUrl: "https://api.example.test/v1", model: "model-1" }),
      /API Key/,
    );
    const local = await store.create({
      name: "Local",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local-model",
    });
    assert.equal(local.hasApiKey, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("provider stores discard an active ID that no longer has a profile", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-store-"));
  try {
    const store = await new ProviderStore(directory).initialize();
    const created = await store.create({
      name: "Temporary",
      baseUrl: "https://api.example.test/v1",
      model: "model-1",
      apiKey: "temporary-key",
    });
    await store.setActive(created.id);
    store.data.profiles = [];
    await store.writeStore();

    const reloaded = await new ProviderStore(directory).initialize();
    assert.equal(reloaded.snapshot().activeId, null);
    assert.equal(reloaded.getActiveProfile(), null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
