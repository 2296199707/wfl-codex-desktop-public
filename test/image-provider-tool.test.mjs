import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ImageProviderToolService } from "../lib/image-provider-tool-service.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL_IMAGE_CAPABILITIES = {
  enabled: true,
  operations: ["generate", "edit", "outpaint"],
  features: { mask: true, multiInput: true, multiOutput: true, streaming: true, inputFidelity: false },
  operationCapabilities: {
    generate: { customSize: true, sizes: ["1024x1024", "1536x1024", "1024x1536"] },
    edit: { customSize: true, sizes: ["1024x1024", "1536x1024", "1024x1536"] },
    outpaint: { customSize: true, sizes: ["1024x1024", "1536x1024", "1024x1536"] },
  },
  defaults: {
    size: "1024x1024",
    quality: "auto",
    outputFormat: "png",
    outputCompression: 100,
    background: "auto",
    moderation: "auto",
    n: 1,
    partialImages: 0,
  },
  limits: {
    maxPromptCharacters: 32_000,
    maxInputImages: 16,
    maxOutputs: 10,
    maxPartialImages: 3,
    fixedSizes: [],
    size: {
      allowAuto: true,
      maxWidth: 3840,
      maxHeight: 3840,
      dimensionMultiple: 16,
      maxAspectRatio: 3,
      minPixels: 655_360,
      maxPixels: 8_294_400,
    },
  },
  options: {
    sizes: [],
    inputFormats: ["png", "jpeg", "webp"],
    outputFormats: ["png", "jpeg", "webp"],
    qualities: ["auto", "low", "medium", "high"],
    backgrounds: ["auto", "opaque", "transparent"],
    moderations: ["auto", "low"],
    inputFidelities: [],
  },
};

test("managed image provider MCP exposes autonomous project image generation over a private socket", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-provider-tool-"));
  const calls = [];
  const service = new ImageProviderToolService({
    directory: temporary,
    userId: "u-test-image",
    generate: async () => {
      throw new Error("v2 MCP calls must not downgrade to the v1 handler");
    },
    execute: async (input) => {
      calls.push(input);
      return {
        attachment: {
          name: "hero.png",
          path: "/srv/project/assets/images/hero.png",
          relativePath: "assets/images/hero.png",
          mediaType: "image/png",
          size: 123,
        },
        revisedPrompt: null,
        model: "gpt-image-2",
        size: "1024x1024",
        quality: "auto",
      };
    },
    capabilities: () => structuredClone(FULL_IMAGE_CAPABILITIES),
  });
  let child;
  try {
    await service.start();
    const stat = await fs.lstat(service.socketPath);
    assert.equal(stat.isSocket(), true);
    assert.equal(stat.mode & 0o777, 0o600);

    child = spawn(process.execPath, [
      path.join(root, "scripts", "image-provider-mcp.mjs"),
      "--socket",
      service.socketPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const rpc = mcpClient(child);
    const initialized = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(initialized.serverInfo.name, "wfl-image-provider");
    assert.equal(initialized.capabilities.tools.listChanged, true);
    assert.match(initialized.instructions, /生成、参考图编辑、扩图/);

    const listed = await rpc.request("tools/list", {});
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      "generate_image",
      "edit_image",
      "outpaint_image",
    ]);
    assert.match(listed.tools[0].description, /不会自动重试/);
    assert.equal(listed.tools.every((tool) => tool.inputSchema.additionalProperties === false), true);
    assert.equal(listed.tools[0].inputSchema.properties.prompt.maxLength, 32_000);
    assert.equal(Object.hasOwn(listed.tools[0].inputSchema.properties, "partialImages"), false);
    assert.equal(Object.hasOwn(listed.tools[1].inputSchema.properties, "inputFidelity"), false);
    assert.deepEqual(listed.tools[0].inputSchema.properties.background.enum, ["auto", "opaque", "transparent"]);
    assert.deepEqual(listed.tools[1].inputSchema.required, ["prompt", "project", "sourcePaths"]);
    assert.deepEqual(listed.tools[2].inputSchema.required, ["prompt", "project", "sourcePath", "expand"]);
    assert.deepEqual(listed.tools[1].inputSchema.properties.maskMode.enum, ["strict", "soft"]);
    assert.deepEqual(listed.tools[2].inputSchema.properties.preserveSource.enum, ["exact", "seamless"]);
    assert.deepEqual(listed.tools[2].inputSchema.properties.alignmentPolicy.enum, [
      "reject", "pad-and-crop", "rescale-and-crop",
    ]);

    const invalidTransparentJpeg = await rpc.request("tools/call", {
      name: "generate_image",
      arguments: {
        prompt: "transparent prop",
        project: "/srv/project",
        outputFormat: "jpeg",
        background: "transparent",
      },
    });
    assert.equal(invalidTransparentJpeg.isError, true);
    assert.equal(invalidTransparentJpeg.structuredContent.error.code, "INVALID_IMAGE_BACKGROUND");

    const generated = await rpc.request("tools/call", {
      name: "generate_image",
      arguments: {
        prompt: "painted airship hero",
        project: "/srv/project",
        outputPath: "assets/images/hero.png",
      },
    });
    assert.equal(generated.isError, false);
    assert.match(generated.content[0].text, /assets\/images\/hero\.png/);
    assert.deepEqual(calls, [{
      operation: "generate",
      prompt: "painted airship hero",
      project: "/srv/project",
      outputPath: "assets/images/hero.png",
    }]);

    const maximumPrompt = "图".repeat(32_000);
    const maximumGenerated = await rpc.request("tools/call", {
      name: "generate_image",
      arguments: { prompt: maximumPrompt, project: "/srv/project" },
    });
    assert.equal(maximumGenerated.isError, false);
    assert.equal(calls.at(-1).prompt.length, 32_000);

    const oversizedGenerated = await rpc.request("tools/call", {
      name: "generate_image",
      arguments: { prompt: `${maximumPrompt}图`, project: "/srv/project" },
    });
    assert.equal(oversizedGenerated.isError, true);
    assert.equal(oversizedGenerated.structuredContent.error.code, "INVALID_IMAGE_TOOL_ARGUMENTS");

    const fakeOutpaint = await rpc.request("tools/call", {
      name: "generate_image",
      arguments: {
        prompt: "请根据 assets/images/hero.png 向左扩图",
        project: "/srv/project",
      },
    });
    assert.equal(fakeOutpaint.isError, true);
    assert.equal(fakeOutpaint.structuredContent.error.code, "IMAGE_SOURCE_REQUIRED");
    rpc.close();
  } finally {
    child?.kill("SIGTERM");
    await service.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("image provider MCP v2 forwards explicit edit and outpaint path requests and returns every output", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-provider-v2-"));
  const calls = [];
  const service = new ImageProviderToolService({
    directory: temporary,
    userId: "u-test-image-v2",
    execute: async (input) => {
      calls.push(input);
      if (input.prompt === "rollback metadata failure") {
        const error = new Error("图片输出发布失败，回滚状态未完全确认");
        error.code = "IMAGE_OUTPUT_ROLLBACK_INCOMPLETE";
        error.statusCode = 500;
        error.partialOutputs = [
          { index: 0, filename: "result-1.png", path: "/srv/private/internal-secret" },
          { index: "1", filename: "result-2.webp", internal: "internal-secret" },
          { index: 2, filename: "/srv/private/result-3.png" },
          { index: 3, filename: "control\nsecret.png" },
          { index: 10, filename: "out-of-range.png" },
          ...Array.from({ length: 7 }, (_, index) => ({
            index: 5 + index,
            filename: index < 5 ? `valid-${index + 5}.png` : `tail-ignored-${index}.png`,
          })),
        ];
        error.rollbackFailures = [
          {
            index: 0,
            filename: "result-1.png",
            operation: "remove-output",
            code: "EACCES",
            path: "/srv/private/internal-secret",
            message: "internal-secret",
          },
          { operation: "sync-directory", code: "eio", directory: "/srv/private" },
          { index: "1", filename: "result-2.webp", operation: "verify-output-removal", code: "EIO" },
          { index: 2, filename: "unknown.png", operation: "unknown-operation", code: "EIO" },
          { index: 3, filename: "/srv/private/result-3.png", operation: "remove-temporary", code: "EPERM" },
          { index: 11, filename: "control\nsecret.png", operation: "close-temporary", code: "BAD-CODE" },
          ...Array.from({ length: 30 }, (_, index) => ({
            index: index % 10,
            filename: `bounded-${index}.png`,
            operation: "remove-output",
            code: "EIO",
            internal: index === 29 ? "tail-ignored-internal-secret" : undefined,
          })),
        ];
        throw error;
      }
      if (input.prompt === "provider failure") {
        const error = new Error("供应商拒绝了图片请求");
        error.code = "IMAGE_PROVIDER_REJECTED";
        error.type = "image_generation_user_error";
        error.status = 422;
        error.providerStatusCode = 429;
        error.providerRequestId = "req-image-v2";
        error.stage = "provider";
        error.operation = "generate";
        error.model = "gpt-image-2";
        error.requestedSize = "2512x944";
        error.providerSize = "2512x944";
        error.reason = "provider_size_unsupported";
        error.supportedSizes = ["1536x1024"];
        error.customSize = false;
        error.moderationDetails = {
          moderation_stage: "input",
          categories: ["harassment", "must-not-pass", { internal_reason: "high" }, ["violence"]],
          severity: "high",
        };
        error.retryable = false;
        throw error;
      }
      return {
        operation: input.operation,
        requested: {
          size: input.size,
          outputFormat: input.outputFormat,
          n: input.n,
        },
        outputs: [
          {
            path: "/srv/project/assets/images/result-1.webp",
            relativePath: "assets/images/result-1.webp",
            actual: { width: 1536, height: 1024, format: "webp", size: 456 },
          },
          {
            path: "/srv/project/assets/images/result-2.webp",
            relativePath: "assets/images/result-2.webp",
            actual: { width: 1536, height: 1024, format: "webp", size: 478 },
          },
        ],
        usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
        providerRequestId: "req-success-v2",
      };
    },
    capabilities: async () => structuredClone(FULL_IMAGE_CAPABILITIES),
  });
  let child;
  try {
    await service.start();
    const socketRollbackFailure = await socketRequest(service.socketPath, {
      version: 2,
      action: "execute",
      operation: "generate",
      prompt: "rollback metadata failure",
      project: "/srv/project",
    });
    assert.deepEqual(socketRollbackFailure.error.partialOutputs, [
      { index: 0, filename: "result-1.png" },
      { index: 1, filename: "result-2.webp" },
      { index: 5, filename: "valid-5.png" },
      { index: 6, filename: "valid-6.png" },
      { index: 7, filename: "valid-7.png" },
      { index: 8, filename: "valid-8.png" },
      { index: 9, filename: "valid-9.png" },
    ]);
    assert.equal(socketRollbackFailure.error.rollbackFailures.length, 31);
    assert.doesNotMatch(
      JSON.stringify(socketRollbackFailure),
      /\/srv\/private|internal-secret|unknown-operation|BAD-CODE|tail-ignored/,
    );
    child = spawn(process.execPath, [
      path.join(root, "scripts", "image-provider-mcp.mjs"),
      "--socket",
      service.socketPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const rpc = mcpClient(child);
    await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });

    const edited = await rpc.request("tools/call", {
      name: "edit_image",
      arguments: {
        prompt: "keep the hero and repaint the sky",
        project: "/srv/project",
        sourcePaths: ["assets/images/hero.png", "assets/images/style.webp"],
        maskPath: "assets/masks/sky.png",
        maskMode: "strict",
        maskFeather: 24,
        outputPath: "assets/images/result.webp",
        size: "1536x1024",
        quality: "high",
        outputFormat: "webp",
        outputCompression: 91,
        background: "opaque",
        moderation: "low",
        n: 2,
      },
    });
    assert.equal(edited.isError, false);
    assert.equal(edited.structuredContent.outputs.length, 2);
    assert.match(edited.content[0].text, /result-1\.webp[\s\S]*1536x1024/);
    assert.match(edited.content[0].text, /result-2\.webp[\s\S]*1536x1024/);

    const outpainted = await rpc.request("tools/call", {
      name: "outpaint_image",
      arguments: {
        prompt: "continue the landscape",
        project: "/srv/project",
        sourcePath: "assets/images/landscape.png",
        expand: { top: 0, right: 512, bottom: 128, left: 0 },
        outputPath: "assets/images/landscape-wide.png",
        preserveSource: "seamless",
        blendMargin: 96,
        alignmentPolicy: "pad-and-crop",
      },
    });
    assert.equal(outpainted.isError, false);

    const rejectedUrl = await rpc.request("tools/call", {
      name: "edit_image",
      arguments: {
        prompt: "unsafe reference",
        project: "/srv/project",
        sourcePaths: ["https://example.test/private.png"],
      },
    });
    assert.equal(rejectedUrl.isError, true);
    assert.equal(rejectedUrl.structuredContent.error.code, "INVALID_PROJECT_FILE_PATH");

    const rejectedFileId = await rpc.request("tools/call", {
      name: "edit_image",
      arguments: {
        prompt: "unsafe file id",
        project: "/srv/project",
        sourcePaths: ["assets/images/hero.png"],
        fileId: "file-secret",
      },
    });
    assert.equal(rejectedFileId.isError, true);
    assert.equal(rejectedFileId.structuredContent.error.code, "INVALID_IMAGE_TOOL_ARGUMENTS");

    const rejectedInputFidelity = await rpc.request("tools/call", {
      name: "edit_image",
      arguments: {
        prompt: "unsupported fidelity",
        project: "/srv/project",
        sourcePaths: ["assets/images/hero.png"],
        inputFidelity: "high",
      },
    });
    assert.equal(rejectedInputFidelity.isError, true);
    assert.equal(rejectedInputFidelity.structuredContent.error.code, "INVALID_IMAGE_TOOL_ARGUMENTS");

    const providerFailure = await rpc.request("tools/call", {
      name: "generate_image",
      arguments: { prompt: "provider failure", project: "/srv/project" },
    });
    assert.equal(providerFailure.isError, true);
    assert.deepEqual(providerFailure.structuredContent.error, {
      code: "IMAGE_PROVIDER_REJECTED",
      type: "image_generation_user_error",
      message: "供应商拒绝了图片请求",
      status: 422,
      requestId: "req-image-v2",
      providerStatusCode: 429,
      stage: "provider",
      operation: "generate",
      reason: "provider_size_unsupported",
      model: "gpt-image-2",
      requestedSize: "2512x944",
      providerSize: "2512x944",
      customSize: false,
      supportedSizes: ["1536x1024"],
      moderationDetails: {
        moderation_stage: "input",
        categories: ["harassment"],
        severity: "high",
      },
      retryable: false,
    });
    assert.doesNotMatch(JSON.stringify(providerFailure), /must-not-pass|internal_reason/);

    const rollbackFailure = await rpc.request("tools/call", {
      name: "generate_image",
      arguments: { prompt: "rollback metadata failure", project: "/srv/project" },
    });
    assert.equal(rollbackFailure.isError, true);
    assert.deepEqual(rollbackFailure.structuredContent.error.partialOutputs, [
      { index: 0, filename: "result-1.png" },
      { index: 1, filename: "result-2.webp" },
      { index: 5, filename: "valid-5.png" },
      { index: 6, filename: "valid-6.png" },
      { index: 7, filename: "valid-7.png" },
      { index: 8, filename: "valid-8.png" },
      { index: 9, filename: "valid-9.png" },
    ]);
    assert.deepEqual(rollbackFailure.structuredContent.error.rollbackFailures.slice(0, 5), [
      { index: 0, filename: "result-1.png", operation: "remove-output", code: "EACCES" },
      { operation: "sync-directory", code: "IMAGE_ROLLBACK_FAILED" },
      { index: 1, filename: "result-2.webp", operation: "verify-output-removal", code: "EIO" },
      { index: 3, operation: "remove-temporary", code: "EPERM" },
      { operation: "close-temporary", code: "IMAGE_ROLLBACK_FAILED" },
    ]);
    assert.equal(rollbackFailure.structuredContent.error.rollbackFailures.length, 31);
    assert.doesNotMatch(rollbackFailure.content[0].text, /result-1\.png|result-2\.webp/);
    assert.doesNotMatch(
      JSON.stringify(rollbackFailure),
      /\/srv\/private|internal-secret|unknown-operation|BAD-CODE|tail-ignored/,
    );

    assert.deepEqual(calls.map(({ operation }) => operation), [
      "generate", "edit", "outpaint", "generate", "generate",
    ]);
    assert.deepEqual(calls[1].sourcePaths, ["assets/images/hero.png", "assets/images/style.webp"]);
    assert.equal(calls[1].maskMode, "strict");
    assert.equal(calls[1].maskFeather, 24);
    assert.deepEqual(calls[2].expand, { top: 0, right: 512, bottom: 128, left: 0 });
    assert.equal(calls[2].preserveSource, "seamless");
    assert.equal(calls[2].blendMargin, 96);
    assert.equal(calls[2].alignmentPolicy, "pad-and-crop");
    assert.equal(Object.hasOwn(calls[1], "version"), false);
    assert.equal(Object.hasOwn(calls[1], "action"), false);
    rpc.close();
  } finally {
    child?.kill("SIGTERM");
    await service.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("image provider socket v2 rejects unsafe paths with a structured error before dispatch", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-provider-v2-validation-"));
  let calls = 0;
  const service = new ImageProviderToolService({
    directory: temporary,
    userId: "u-test-image-validation",
    execute: async () => {
      calls += 1;
      return {};
    },
  });
  try {
    await service.start();
    const response = await socketRequest(service.socketPath, {
      version: 2,
      action: "execute",
      operation: "edit",
      prompt: "do not dispatch",
      project: "/srv/project",
      sourcePaths: ["data:image/png;base64,AAAA"],
    });
    assert.deepEqual(response, {
      version: 2,
      ok: false,
      error: {
        code: "INVALID_PROJECT_FILE_PATH",
        message: "源图片路径必须是工程内相对路径",
        status: 400,
        retryable: false,
      },
    });
    assert.equal(calls, 0);
  } finally {
    await service.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("managed MCP lists only the operations and options assigned to the current user", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-provider-capabilities-"));
  let calls = 0;
  const service = new ImageProviderToolService({
    directory: temporary,
    userId: "u-generation-only",
    execute: async () => {
      calls += 1;
      return {};
    },
    capabilities: async () => ({
      ...structuredClone(FULL_IMAGE_CAPABILITIES),
      operations: ["generate"],
      operationCapabilities: {
        generate: { customSize: false, sizes: ["1024x1024", "1536x1024", "1024x1536"] },
      },
      features: { mask: false, multiInput: false, multiOutput: false, streaming: false, inputFidelity: false },
      limits: {
        ...structuredClone(FULL_IMAGE_CAPABILITIES.limits),
        maxPromptCharacters: 4_000,
        maxInputImages: 0,
        maxOutputs: 1,
        maxPartialImages: 0,
        fixedSizes: ["1024x1024", "1536x1024", "1024x1536"],
        size: null,
      },
      options: {
        sizes: ["1024x1024", "1536x1024", "1024x1536"],
        inputFormats: [],
        outputFormats: ["png"],
        qualities: ["auto", "low", "medium", "high"],
        backgrounds: ["opaque"],
        moderations: ["auto"],
        inputFidelities: [],
      },
    }),
  });
  let child;
  try {
    await service.start();
    child = spawn(process.execPath, [
      path.join(root, "scripts", "image-provider-mcp.mjs"),
      "--socket",
      service.socketPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const rpc = mcpClient(child);
    await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const listed = await rpc.request("tools/list", {});
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["generate_image"]);
    assert.equal(listed.tools[0].inputSchema.properties.prompt.maxLength, 4_000);
    assert.deepEqual(listed.tools[0].inputSchema.properties.size.enum, [
      "1024x1024", "1536x1024", "1024x1536",
    ]);
    assert.equal(listed.tools[0].inputSchema.properties.n.maximum, 1);
    assert.equal(Object.hasOwn(listed.tools[0].inputSchema.properties, "outputCompression"), false);

    const unavailable = await rpc.request("tools/call", {
      name: "edit_image",
      arguments: {
        prompt: "must not dispatch",
        project: "/srv/project",
        sourcePaths: ["source.png"],
      },
    });
    assert.equal(unavailable.isError, true);
    assert.equal(unavailable.structuredContent.error.code, "IMAGE_OPERATION_UNAVAILABLE");
    assert.equal(calls, 0);
    rpc.close();
  } finally {
    child?.kill("SIGTERM");
    await service.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("partial MCP exposes native parameters and keeps omitted fields optional", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-provider-partial-"));
  const calls = [];
  const service = new ImageProviderToolService({
    directory: temporary,
    userId: "u-partial-image",
    execute: async (input) => {
      calls.push(input);
      return { outputs: [] };
    },
    capabilities: async () => ({
      ...structuredClone(FULL_IMAGE_CAPABILITIES),
      requestMode: "partial",
    }),
  });
  let child;
  try {
    await service.start();
    child = spawn(process.execPath, [
      path.join(root, "scripts", "image-provider-mcp.mjs"),
      "--socket",
      service.socketPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const rpc = mcpClient(child);
    await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const listed = await rpc.request("tools/list", {});
    const properties = listed.tools.find((tool) => tool.name === "generate_image").inputSchema.properties;
    assert.equal(properties.providerParameters.type, "object");
    assert.equal(properties.providerParameters.additionalProperties, true);
    assert.equal(Object.hasOwn(properties.size, "enum"), false);
    assert.equal(Object.hasOwn(properties.quality, "enum"), false);
    assert.match(listed.tools[0].description, /部分透传模式/);

    const result = await rpc.request("tools/call", {
      name: "generate_image",
      arguments: {
        prompt: "partial native request",
        project: "/srv/project",
        providerParameters: {
          response_format: "b64_json",
          vendor_options: { trace: true },
        },
      },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(calls, [{
      operation: "generate",
      prompt: "partial native request",
      project: "/srv/project",
      providerParameters: {
        response_format: "b64_json",
        vendor_options: { trace: true },
      },
    }]);
    rpc.close();
  } finally {
    child?.kill("SIGTERM");
    await service.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("long-lived MCP sessions receive tools/list_changed when the assigned operations change", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-provider-list-changed-"));
  let current = {
    ...structuredClone(FULL_IMAGE_CAPABILITIES),
    operations: ["generate"],
    operationCapabilities: {
      generate: { customSize: false, sizes: ["1024x1024"] },
    },
  };
  const service = new ImageProviderToolService({
    directory: temporary,
    userId: "u-capability-refresh",
    execute: async () => ({ outputs: [] }),
    capabilities: async () => structuredClone(current),
  });
  let child;
  try {
    await service.start();
    child = spawn(process.execPath, [
      path.join(root, "scripts", "image-provider-mcp.mjs"),
      "--socket",
      service.socketPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const rpc = mcpClient(child);
    const initialized = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.match(initialized.instructions, /当前可用能力：生成/);
    rpc.notify("notifications/initialized", {});
    assert.deepEqual((await rpc.request("tools/list", {})).tools.map((tool) => tool.name), ["generate_image"]);

    current = structuredClone(FULL_IMAGE_CAPABILITIES);
    const changed = await rpc.waitForNotification("notifications/tools/list_changed", 5_000);
    assert.deepEqual(changed.params, {});
    assert.deepEqual((await rpc.request("tools/list", {})).tools.map((tool) => tool.name), [
      "generate_image", "edit_image", "outpaint_image",
    ]);
    rpc.close();
  } finally {
    child?.kill("SIGTERM");
    await service.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("image provider service aborts active execution when the client disconnects", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-provider-cancel-"));
  let dispatch;
  let aborted;
  const dispatched = new Promise((resolve) => { dispatch = resolve; });
  const observedAbort = new Promise((resolve) => { aborted = resolve; });
  const service = new ImageProviderToolService({
    directory: temporary,
    userId: "u-cancel-image",
    execute: async (_input, { signal }) => {
      dispatch(signal);
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted(signal);
          const error = new Error("cancelled");
          error.code = "IMAGE_PROVIDER_CANCELLED";
          reject(error);
        }, { once: true });
      });
    },
  });
  let socket;
  try {
    await service.start();
    socket = net.createConnection(service.socketPath);
    socket.on("error", () => {});
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify({
      version: 2,
      action: "execute",
      operation: "generate",
      prompt: "cancel this request",
      project: "/srv/project",
    })}\n`);
    const signal = await dispatched;
    assert.equal(signal.aborted, false);
    socket.destroy();
    assert.equal((await observedAbort).aborted, true);
  } finally {
    socket?.destroy();
    await service.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("image provider service leaves admitted execution to the frozen Worker timeout", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-provider-timeout-"));
  let dispatched;
  let release;
  let observedSignal;
  const started = new Promise((resolve) => { dispatched = resolve; });
  const execution = new Promise((resolve) => { release = resolve; });
  const service = new ImageProviderToolService({
    directory: temporary,
    userId: "u-timeout-image",
    requestTimeoutMs: 25,
    execute: async (_input, { signal }) => {
      observedSignal = signal;
      dispatched();
      return execution;
    },
  });
  try {
    await service.start();
    const responsePromise = socketRequest(service.socketPath, {
      version: 2,
      action: "execute",
      operation: "generate",
      prompt: "wait under the admitted task policy",
      project: "/srv/project",
    });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(observedSignal.aborted, false);
    release({ outputs: [{ path: "generated-images/result.png" }] });
    const response = await responsePromise;
    assert.deepEqual(response, {
      version: 2,
      ok: true,
      result: { outputs: [{ path: "generated-images/result.png" }] },
    });
  } finally {
    release?.({ outputs: [] });
    await service.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("image provider service still times out an incomplete local request frame", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-provider-frame-timeout-"));
  let dispatches = 0;
  const service = new ImageProviderToolService({
    directory: temporary,
    userId: "u-frame-timeout-image",
    requestTimeoutMs: 25,
    execute: async () => {
      dispatches += 1;
      return {};
    },
  });
  let socket;
  try {
    await service.start();
    const responsePromise = new Promise((resolve, reject) => {
      socket = net.createConnection(service.socketPath);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.once("connect", () => socket.write('{"version":2'));
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          resolve(JSON.parse(buffer.slice(0, newline)));
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
    });
    assert.deepEqual(await responsePromise, {
      version: 2,
      ok: false,
      error: {
        code: "IMAGE_TOOL_TIMEOUT",
        message: "图片供应商工具调用超时",
        status: 504,
        retryable: false,
      },
    });
    assert.equal(dispatches, 0);
  } finally {
    socket?.destroy();
    await service.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("image provider sockets keep concurrent users on their own server-side generator", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-provider-isolation-"));
  const observed = [];
  const services = ["user-a", "user-b"].map((userId) => new ImageProviderToolService({
    directory: temporary,
    userId,
    generate: async ({ prompt }) => {
      observed.push(`${userId}:${prompt}`);
      return { userId, prompt };
    },
  }));
  try {
    await Promise.all(services.map((service) => service.start()));
    assert.notEqual(services[0].socketPath, services[1].socketPath);
    const [left, right] = await Promise.all([
      socketRequest(services[0].socketPath, { version: 1, action: "generate", prompt: "left" }),
      socketRequest(services[1].socketPath, { version: 1, action: "generate", prompt: "right" }),
    ]);
    assert.deepEqual(left.result, { userId: "user-a", prompt: "left" });
    assert.deepEqual(right.result, { userId: "user-b", prompt: "right" });
    assert.deepEqual(observed.sort(), ["user-a:left", "user-b:right"]);
  } finally {
    await Promise.all(services.map((service) => service.close()));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("main runtime injects the managed image tool without putting provider secrets in MCP arguments", async () => {
  const source = await fs.readFile(path.join(root, "server.mjs"), "utf8");
  const override = source.slice(
    source.indexOf("function codexImageProviderMcpOverride"),
    source.indexOf("class CodexBridge"),
  );
  assert.match(override, /wfl_image_provider/);
  assert.match(override, /image-provider-mcp\.mjs|scriptPath/);
  assert.match(override, /socketPath/);
  assert.doesNotMatch(override, /apiKey|PROVIDER_KEY_ENV|Authorization|Bearer/);

  const initialization = source.slice(
    source.indexOf("this\.refreshImportedThreadMappings\(\)".replaceAll("\\", "")),
    source.indexOf("this.turnStartDeduplicator", source.indexOf("this.refreshImportedThreadMappings()")),
  );
  assert.match(initialization, /if \(!RESCUE_MODE && CODEX_ENABLED\)/);
  assert.match(initialization, /new ImageProviderToolService/);
  assert.match(initialization, /withPersistentStateOperation/);
  assert.match(initialization, /generateImageForRuntime\(this, input, \{ signal \}\)/);
  assert.match(initialization, /publicImageCapabilities\(this\.providerStore\.snapshot\(\)\.imageApi\)/);
});

function mcpClient(child) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  const notifications = new Map();
  const notificationWaiters = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        const request = pending.get(String(message.id));
        if (request) {
          pending.delete(String(message.id));
          if (message.error) request.reject(new Error(message.error.message));
          else request.resolve(message.result);
        } else if (!Object.hasOwn(message, "id") && typeof message.method === "string") {
          const waiters = notificationWaiters.get(message.method);
          const waiter = waiters?.shift();
          if (waiter) {
            waiter.resolve(message);
            if (!waiters.length) notificationWaiters.delete(message.method);
          } else {
            const queued = notifications.get(message.method) || [];
            queued.push(message);
            notifications.set(message.method, queued);
          }
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(String(id));
          reject(new Error(`${method} timed out`));
        }, 5_000);
        pending.set(String(id), {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    waitForNotification(method, timeoutMs = 5_000) {
      const queued = notifications.get(method);
      if (queued?.length) {
        const message = queued.shift();
        if (!queued.length) notifications.delete(method);
        return Promise.resolve(message);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const waiters = notificationWaiters.get(method) || [];
          const index = waiters.findIndex((entry) => entry.resolve === finish);
          if (index >= 0) waiters.splice(index, 1);
          if (!waiters.length) notificationWaiters.delete(method);
          reject(new Error(`${method} notification timed out`));
        }, timeoutMs);
        const finish = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        const waiters = notificationWaiters.get(method) || [];
        waiters.push({ resolve: finish });
        notificationWaiters.set(method, waiters);
      });
    },
    close() {
      child.stdin.end();
    },
  };
}

function socketRequest(socketPath, value) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
    socket.on("error", reject);
  });
}
