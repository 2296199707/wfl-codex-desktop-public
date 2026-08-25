import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  generateProviderImage,
  requestProviderImages,
  requestProviderImagesStream,
} from "../lib/openai-image.mjs";

test("generation sends non-null parameters and returns inspected multiple images", async () => {
  const png = pngFixture(2, 2);
  const jpeg = jpegFixture(2, 2);
  let observedUrl = null;
  let observedOptions = null;
  const result = await requestProviderImages({
    baseUrl: "https://images.example.test/openai/v1",
    apiKey: "image-secret-value",
    operation: "generate",
    prompt: "a yellow banana on white",
    user: "account_01-test@example",
    model: "gpt-image-2",
    n: 2,
    size: "2x2",
    quality: "medium",
    outputFormat: null,
    outputCompression: 90,
    background: "opaque",
    moderation: "low",
    inputFidelity: undefined,
    fetchImpl: async (url, options) => {
      observedUrl = url;
      observedOptions = options;
      return jsonResponse({
        data: [
          { b64_json: png.toString("base64"), revised_prompt: "A yellow banana." },
          { b64_json: jpeg.toString("base64") },
        ],
        usage: {
          input_tokens: 12,
          input_tokens_details: { text_tokens: 7, image_tokens: 5 },
          output_tokens: 34,
          total_tokens: 46,
        },
      }, 200, { "x-request-id": "req_image-123" });
    },
  });

  assert.equal(observedUrl, "https://images.example.test/openai/v1/images/generations");
  assert.equal(observedOptions.headers.Authorization, "Bearer image-secret-value");
  assert.deepEqual(JSON.parse(observedOptions.body), {
    model: "gpt-image-2",
    prompt: "a yellow banana on white",
    user: "account_01-test@example",
    n: 2,
    size: "2x2",
    quality: "medium",
    output_compression: 90,
    background: "opaque",
    moderation: "low",
  });
  assert.equal(result.outputs.length, 2);
  assert.deepEqual(
    result.outputs.map(({ image, ...metadata }) => ({ bytes: image.length, ...metadata })),
    [
      {
        bytes: png.length,
        revisedPrompt: "A yellow banana.",
        width: 2,
        height: 2,
        format: "png",
        mediaType: "image/png",
        size: png.length,
      },
      {
        bytes: jpeg.length,
        revisedPrompt: null,
        width: 2,
        height: 2,
        format: "jpeg",
        mediaType: "image/jpeg",
        size: jpeg.length,
      },
    ],
  );
  assert.equal(result.providerRequestId, "req_image-123");
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    inputTextTokens: 7,
    inputImageTokens: 5,
    cachedInputTokens: 0,
    outputTokens: 34,
    reasoningOutputTokens: 0,
    totalTokens: 46,
  });
});

test("legacy generation export retains the single PNG result contract", async () => {
  const png = pngFixture(4, 3);
  const result = await generateProviderImage({
    baseUrl: "https://images.example.test/v1",
    apiKey: "image-secret-value",
    prompt: "banana",
    model: "gpt-image-2",
    size: "4x3",
    quality: "medium",
    fetchImpl: async (_url, options) => {
      assert.equal(Object.hasOwn(JSON.parse(options.body), "user"), false);
      return jsonResponse({
        data: [{ b64_json: png.toString("base64"), revised_prompt: "A banana." }],
      });
    },
  });
  assert.deepEqual(result.image, png);
  assert.equal(result.revisedPrompt, "A banana.");
  assert.equal(result.usage, null);
});

test("edit uses one exact configured multipart image field and includes a mask", async () => {
  const first = pngFixture(4, 3);
  const second = jpegFixture(4, 3);
  const mask = pngFixture(4, 3);
  let form = null;
  const result = await requestProviderImages({
    baseUrl: "https://images.example.test/v1",
    apiKey: "image-secret-value",
    operation: "edit",
    sources: [
      { data: first, filename: "first.png", mediaType: "image/png" },
      { data: second, filename: "second.jpg", mediaType: "image/jpeg" },
    ],
    mask: { data: mask, filename: "selection.png", mediaType: "image/png" },
    multipartImageField: "image[]",
    model: "compatible-image-edit-v1",
    prompt: "replace the sky",
    user: "anonymous-user-02",
    n: 1,
    size: "4x3",
    quality: "high",
    outputFormat: "webp",
    outputCompression: 80,
    background: "transparent",
    moderation: "auto",
    inputFidelity: "high",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://images.example.test/v1/images/edits");
      assert.deepEqual(options.headers, { Authorization: "Bearer image-secret-value" });
      form = options.body;
      return jsonResponse({ data: [{ b64_json: webpFixture(4, 3).toString("base64") }] });
    },
  });

  assert.ok(form instanceof FormData);
  assert.equal(form.get("model"), "compatible-image-edit-v1");
  assert.deepEqual([...form.keys()], [
    "model", "prompt", "user", "n", "size", "quality", "output_format", "output_compression",
    "background", "moderation", "input_fidelity", "image[]", "image[]", "mask",
  ]);
  assert.equal(form.get("user"), "anonymous-user-02");
  assert.equal(form.has("image"), false);
  assert.equal(form.getAll("image[]").length, 2);
  assert.equal(form.get("image[]").name, "first.png");
  assert.equal(form.getAll("image[]")[1].type, "image/jpeg");
  assert.equal(form.get("mask").name, "selection.png");
  assert.deepEqual(Buffer.from(await form.get("mask").arrayBuffer()), mask);
  assert.equal(result.outputs[0].format, "webp");
});

test("gpt-image-2 edits omit unsupported input fidelity and transparent background fields", async () => {
  const source = pngFixture(4, 3);
  let form = null;
  await requestProviderImages({
    baseUrl: "https://images.example.test/v1",
    apiKey: "image-secret-value",
    operation: "edit",
    sources: [{ data: source, filename: "source.png", mediaType: "image/png" }],
    multipartImageField: "image[]",
    model: "gpt-image-2",
    prompt: "replace the sky",
    background: "auto",
    inputFidelity: undefined,
    fetchImpl: async (_url, options) => {
      form = options.body;
      return jsonResponse({ data: [{ b64_json: source.toString("base64") }] });
    },
  });

  assert.ok(form instanceof FormData);
  assert.equal(form.get("model"), "gpt-image-2");
  assert.equal(form.get("background"), "auto");
  assert.equal(form.has("input_fidelity"), false);
  assert.equal([...form.values()].includes("transparent"), false);
});

test("outpaint uses the edits endpoint without changing or retrying the configured image field", async () => {
  const png = pngFixture(3, 2);
  let calls = 0;
  await requestProviderImages({
    baseUrl: "https://images.example.test/v1",
    apiKey: "image-secret-value",
    operation: "outpaint",
    sources: [{ data: png, filename: "canvas.png", mediaType: "image/png" }],
    multipartImageField: "image",
    prompt: "extend to the right",
    size: "3x2",
    outputFormat: "png",
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, "https://images.example.test/v1/images/edits");
      assert.equal(options.body.has("image"), true);
      assert.equal(options.body.has("image[]"), false);
      assert.equal(options.body.has("user"), false);
      return jsonResponse({ data: [{ b64_json: png.toString("base64") }] });
    },
  });
  assert.equal(calls, 1);
});

test("optional provider user rejects invalid identifiers before dispatch", async () => {
  const invalidUsers = [
    "",
    " leading",
    "trailing ",
    "contains\ttab",
    "contains\nnewline",
    "non-ascii-用户",
    "x".repeat(257),
    123,
  ];
  for (const user of invalidUsers) {
    let called = false;
    await assert.rejects(
      requestProviderImages({
        baseUrl: "https://images.example.test/v1",
        apiKey: "secret",
        prompt: "banana",
        user,
        fetchImpl: async () => {
          called = true;
          return jsonResponse({});
        },
      }),
      (error) => error.code === "INVALID_IMAGE_USER" && error.statusCode === 400,
    );
    assert.equal(called, false);
  }
});

test("edit honors the configured per-image input byte limit", async () => {
  const png = pngFixture(3, 2);
  const baseOptions = {
    baseUrl: "https://images.example.test/v1",
    apiKey: "image-secret-value",
    operation: "edit",
    sources: [{ data: png, filename: "source.png", mediaType: "image/png" }],
    prompt: "edit",
    size: "3x2",
    outputFormat: "png",
  };
  let calls = 0;
  await assert.rejects(
    requestProviderImages({
      ...baseOptions,
      maxInputBytesPerImage: png.length - 1,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    }),
    (error) => error.code === "INVALID_IMAGE_SOURCE" && error.statusCode === 400,
  );
  assert.equal(calls, 0);

  const result = await requestProviderImages({
    ...baseOptions,
    maxInputBytesPerImage: png.length,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ data: [{ b64_json: png.toString("base64") }] });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.outputs[0].width, 3);
});

test("explicit output format and size are checked against actual image metadata", async () => {
  const png = pngFixture(8, 6);
  const fetchImpl = async () => jsonResponse({ data: [{ b64_json: png.toString("base64") }] });
  await assert.rejects(
    requestProviderImages({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "banana",
      size: "8x6",
      outputFormat: "jpeg",
      fetchImpl,
    }),
    (error) => error.code === "IMAGE_FORMAT_MISMATCH"
      && error.requestedFormat === "jpeg"
      && error.actualFormat === "png",
  );
  await assert.rejects(
    requestProviderImages({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "banana",
      size: "10x6",
      outputFormat: "png",
      fetchImpl,
    }),
    (error) => error.code === "IMAGE_SIZE_MISMATCH"
      && error.requestedWidth === 10
      && error.actualWidth === 8,
  );
});

test("transparent backgrounds reject JPEG before provider dispatch", async () => {
  let calls = 0;
  await assert.rejects(
    requestProviderImages({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "transparent prop",
      size: "1024x1024",
      outputFormat: "jpeg",
      background: "transparent",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    }),
    (error) => error.code === "INVALID_IMAGE_BACKGROUND" && error.statusCode === 400,
  );
  assert.equal(calls, 0);
});

test("invalid image structures are rejected after base64 decoding", async () => {
  const fakePng = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64)]);
  await assert.rejects(
    requestProviderImages({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "banana",
      fetchImpl: async () => jsonResponse({ data: [{ b64_json: fakePng.toString("base64") }] }),
    }),
    (error) => error.code === "INVALID_IMAGE_OUTPUT" && error.statusCode === 502,
  );
});

test("successful provider responses retain billed usage when local output validation fails", async () => {
  const usage = {
    input_tokens_details: { text_tokens: 7, image_tokens: 11 },
    output_tokens: 23,
  };
  for (const data of [undefined, [{ b64_json: "not-base64" }]]) {
    await assert.rejects(
      requestProviderImages({
        baseUrl: "https://images.example.test/v1",
        apiKey: "secret",
        prompt: "banana",
        fetchImpl: async () => jsonResponse({ data, usage }, 200, { "x-request-id": "req_billed-123" }),
      }),
      (error) => {
        assert.ok(["IMAGE_OUTPUT_MISSING", "INVALID_IMAGE_OUTPUT"].includes(error.code));
        assert.equal(error.providerRequestId, "req_billed-123");
        assert.deepEqual(error.providerUsage, {
          inputTokens: 18,
          inputTextTokens: 7,
          inputImageTokens: 11,
          cachedInputTokens: 0,
          outputTokens: 23,
          reasoningOutputTokens: 0,
          totalTokens: 41,
        });
        assert.equal(Object.hasOwn(error, "payload"), false);
        assert.equal(Object.hasOwn(error, "data"), false);
        return true;
      },
    );
  }
});

test("provider errors retain only safe structured details and request ids", async () => {
  const secret = "image-secret-value";
  await assert.rejects(
    requestProviderImages({
      baseUrl: "https://images.example.test/v1",
      apiKey: secret,
      prompt: "banana",
      fetchImpl: async () => jsonResponse({
        error: {
          message: `bad ${secret}`,
          code: "content_policy_violation",
          type: "image_safety_error",
          moderation_details: {
            categories: ["harassment", "must-not-copy", { nested: true }, ["violence"]],
            sexual: { filtered: true, severity: "high" },
            unsafe_text: `do-not-copy-${secret}`,
          },
        },
      }, 400, { "x-request-id": "req_safe-456" }),
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.providerStatusCode, 400);
      assert.equal(error.code, "content_policy_violation");
      assert.equal(error.type, "image_safety_error");
      assert.equal(error.retryable, false);
      assert.equal(error.providerRequestId, "req_safe-456");
      assert.deepEqual(error.moderationDetails, {
        categories: ["harassment"],
        sexual: { filtered: true, severity: "high" },
      });
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
});

test("provider exceptions and secret-shaped structured fields are fully redacted", async () => {
  const secret = "image-secret-value";
  await assert.rejects(
    requestProviderImages({
      baseUrl: "https://images.example.test/v1",
      apiKey: secret,
      prompt: "banana",
      fetchImpl: async () => jsonResponse({
        error: {
          message: secret,
          code: `failure-${secret}`,
          type: `type-${secret}`,
        },
      }, 500, { "x-request-id": `req-${secret}` }),
    }),
    (error) => error.code === "IMAGE_PROVIDER_ERROR"
      && error.type === null
      && error.providerRequestId === null
      && error.retryable === true
      && !JSON.stringify(error).includes(secret),
  );
  await assert.rejects(
    requestProviderImages({
      baseUrl: "https://images.example.test/v1",
      apiKey: secret,
      prompt: "banana",
      fetchImpl: async () => {
        throw new Error(`socket failed with ${secret}`);
      },
    }),
    (error) => error.code === "IMAGE_PROVIDER_UNREACHABLE"
      && error.statusCode === 502
      && error.retryable === true
      && !error.message.includes(secret),
  );
});

test("generation streaming sends explicit SSE parameters and validates partial and completed images", async () => {
  const partial = pngFixture(6, 4);
  const completed = webpFixture(6, 4);
  let observedBody = null;
  const events = await collectEvents(requestProviderImagesStream({
    baseUrl: "https://images.example.test/v1",
    apiKey: "image-secret-value",
    operation: "generate",
    model: "gpt-image-2",
    prompt: "banana",
    n: 1,
    size: "6x4",
    partialImages: 2,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://images.example.test/v1/images/generations");
      observedBody = JSON.parse(options.body);
      return sseResponse([
        {
          event: "image_generation.partial_image",
          payload: {
            type: "image_generation.partial_image",
            partial_image_index: 0,
            b64_json: partial.toString("base64"),
          },
        },
        {
          payload: {
            type: "image_generation.completed",
            b64_json: completed.toString("base64"),
            usage: {
              input_tokens_details: { text_tokens: 9, image_tokens: 0 },
              output_tokens: 20,
            },
          },
        },
        { done: true },
      ], { "x-request-id": "req_stream-123" }, 7);
    },
  }));

  assert.deepEqual(observedBody, {
    model: "gpt-image-2",
    prompt: "banana",
    n: 1,
    size: "6x4",
    stream: true,
    partial_images: 2,
  });
  assert.equal(events.length, 2);
  assert.deepEqual(
    { ...events[0], output: withoutImageBytes(events[0].output) },
    {
      type: "image_generation.partial_image",
      operation: "generate",
      partialImageIndex: 0,
      output: {
        revisedPrompt: null,
        width: 6,
        height: 4,
        format: "png",
        mediaType: "image/png",
        size: partial.length,
      },
      requested: {
        operation: "generate",
        model: "gpt-image-2",
        prompt: "banana",
        n: 1,
        size: "6x4",
        stream: true,
        partialImages: 2,
      },
      usage: null,
      providerRequestId: "req_stream-123",
    },
  );
  assert.equal(events[1].outputs[0].format, "webp");
  assert.equal(events[1].providerRequestId, "req_stream-123");
  assert.deepEqual(events[1].usage, {
    inputTokens: 9,
    inputTextTokens: 9,
    inputImageTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 0,
    totalTokens: 29,
  });
});

test("edit and outpaint streaming use the edits endpoint and exact configured multipart fields", async () => {
  const png = pngFixture(5, 3);
  for (const operation of ["edit", "outpaint"]) {
    let calls = 0;
    const events = await collectEvents(requestProviderImagesStream({
      baseUrl: "https://images.example.test/v1",
      apiKey: "image-secret-value",
      operation,
      sources: [{ data: png, filename: "source.png", mediaType: "image/png" }],
      mask: { data: png, filename: "mask.png", mediaType: "image/png" },
      multipartImageField: operation === "edit" ? "image[]" : "image",
      model: "compatible-image-edit-stream-v1",
      prompt: "extend",
      size: "5x3",
      outputFormat: "png",
      inputFidelity: "high",
      partialImages: 0,
      fetchImpl: async (url, options) => {
        calls += 1;
        assert.equal(url, "https://images.example.test/v1/images/edits");
        const expectedField = operation === "edit" ? "image[]" : "image";
        const otherField = operation === "edit" ? "image" : "image[]";
        assert.equal(options.body.getAll(expectedField).length, 1);
        assert.equal(options.body.has(otherField), false);
        assert.equal(options.body.get("stream"), "true");
        assert.equal(options.body.get("partial_images"), "0");
        assert.equal(options.body.get("input_fidelity"), "high");
        assert.equal(options.body.get("model"), "compatible-image-edit-stream-v1");
        return sseResponse([{
          payload: {
            type: "image_edit.completed",
            b64_json: png.toString("base64"),
          },
        }]);
      },
    }));
    assert.equal(calls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, operation);
    assert.equal(events[0].outputs[0].width, 5);
  }
});

test("streaming and non-streaming honor caller-provided response and output byte limits", async () => {
  const png = pngFixture(8, 6);
  await assert.rejects(
    requestProviderImages({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "banana",
      maxOutputBytesPerImage: png.length - 1,
      fetchImpl: async () => jsonResponse({ data: [{ b64_json: png.toString("base64") }] }),
    }),
    (error) => error.code === "INVALID_IMAGE_OUTPUT",
  );
  await assert.rejects(
    requestProviderImages({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "banana",
      maxResponseBytes: 16,
      fetchImpl: async () => jsonResponse({ data: [{ b64_json: png.toString("base64") }] }),
    }),
    (error) => error.code === "IMAGE_PROVIDER_RESPONSE_TOO_LARGE",
  );
  await assert.rejects(
    collectEvents(requestProviderImagesStream({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "banana",
      maxResponseBytes: 32,
      fetchImpl: async () => sseResponse([{
        payload: { type: "image_generation.completed", b64_json: png.toString("base64") },
      }]),
    })),
    (error) => error.code === "IMAGE_PROVIDER_RESPONSE_TOO_LARGE",
  );
  await assert.rejects(
    collectEvents(requestProviderImagesStream({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "banana",
      maxOutputBytesPerImage: png.length - 1,
      fetchImpl: async () => sseResponse([{
        payload: { type: "image_generation.completed", b64_json: png.toString("base64") },
      }]),
    })),
    (error) => error.code === "INVALID_IMAGE_OUTPUT",
  );
});

test("streaming rejects malformed or incomplete SSE instead of treating it as success", async () => {
  const png = pngFixture(2, 2);
  await assert.rejects(
    collectEvents(requestProviderImagesStream({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "banana",
      fetchImpl: async () => sseResponse([{
        event: "image_generation.completed",
        payload: { type: 123, b64_json: png.toString("base64") },
      }]),
    })),
    (error) => error.code === "INVALID_IMAGE_PROVIDER_STREAM",
  );
  await assert.rejects(
    collectEvents(requestProviderImagesStream({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "banana",
      fetchImpl: async () => sseResponse([{ done: true }]),
    })),
    (error) => error.code === "INCOMPLETE_IMAGE_PROVIDER_STREAM",
  );
});

test("streaming completed events retain billed usage when local output validation fails", async () => {
  await assert.rejects(
    collectEvents(requestProviderImagesStream({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "banana",
      fetchImpl: async () => sseResponse([{
        payload: {
          type: "image_generation.completed",
          b64_json: "not-base64",
          usage: { input_tokens: 13, output_tokens: 17, total_tokens: 30 },
        },
      }], { "x-request-id": "req_stream-billed" }),
    })),
    (error) => {
      assert.equal(error.code, "INVALID_IMAGE_OUTPUT");
      assert.equal(error.providerRequestId, "req_stream-billed");
      assert.deepEqual(error.providerUsage, {
        inputTokens: 13,
        inputTextTokens: 0,
        inputImageTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 17,
        reasoningOutputTokens: 0,
        totalTokens: 30,
      });
      assert.equal(Object.hasOwn(error, "payload"), false);
      assert.equal(Object.hasOwn(error, "data"), false);
      return true;
    },
  );
});

test("streaming surfaces structured SSE and HTTP errors without retries or secret leakage", async () => {
  const secret = "image-secret-value";
  let calls = 0;
  await assert.rejects(
    collectEvents(requestProviderImagesStream({
      baseUrl: "https://images.example.test/v1",
      apiKey: secret,
      prompt: "banana",
      fetchImpl: async () => {
        calls += 1;
        return sseResponse([{
          event: "error",
          payload: {
            type: "error",
            error: {
              message: `rate limited ${secret}`,
              code: "rate_limit_exceeded",
              type: "provider_rate_limit",
              status_code: 429,
              retryable: true,
            },
          },
        }], { "x-request-id": "req_error-123" });
      },
    })),
    (error) => error.statusCode === 429
      && error.code === "rate_limit_exceeded"
      && error.type === "provider_rate_limit"
      && error.retryable === true
      && error.providerRequestId === "req_error-123"
      && !JSON.stringify(error).includes(secret),
  );
  assert.equal(calls, 1);

  await assert.rejects(
    collectEvents(requestProviderImagesStream({
      baseUrl: "https://images.example.test/v1",
      apiKey: secret,
      prompt: "banana",
      fetchImpl: async () => jsonResponse({ error: { message: secret, code: "invalid_api_key" } }, 401, {
        "x-request-id": "req_http-401",
      }),
    })),
    (error) => error.statusCode === 502
      && error.providerStatusCode === 401
      && error.code === "invalid_api_key"
      && error.providerRequestId === "req_http-401"
      && !error.message.includes(secret),
  );
});

test("external cancellation and internal timeout abort upstream with distinct errors", async () => {
  const external = new AbortController();
  let externalSignal = null;
  const cancelled = collectEvents(requestProviderImagesStream({
    baseUrl: "https://images.example.test/v1",
    apiKey: "secret",
    prompt: "banana",
    signal: external.signal,
    fetchImpl: async (_url, options) => {
      externalSignal = options.signal;
      return await rejectWhenAborted(options.signal);
    },
  }));
  external.abort(new Error("private cancellation reason"));
  await assert.rejects(
    cancelled,
    (error) => error.statusCode === 499
      && error.code === "IMAGE_PROVIDER_CANCELLED"
      && error.retryable === false
      && !error.message.includes("private"),
  );
  assert.equal(externalSignal.aborted, true);

  await assert.rejects(
    requestProviderImages({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "banana",
      timeoutMs: 5,
      fetchImpl: async (_url, options) => await rejectWhenAborted(options.signal),
    }),
    (error) => error.statusCode === 504
      && error.code === "IMAGE_PROVIDER_TIMEOUT"
      && error.retryable === true,
  );

  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  let called = false;
  await assert.rejects(
    requestProviderImages({
      baseUrl: "https://images.example.test/v1",
      apiKey: "secret",
      prompt: "banana",
      signal: alreadyCancelled.signal,
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
    }),
    (error) => error.code === "IMAGE_PROVIDER_CANCELLED",
  );
  assert.equal(called, false);
});

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function sseResponse(events, headers = {}, chunkSize = 0) {
  const text = events.map((entry) => {
    if (entry.done) return "data: [DONE]\n\n";
    const eventLine = entry.event ? `event: ${entry.event}\n` : "";
    return `${eventLine}data: ${JSON.stringify(entry.payload)}\n\n`;
  }).join("");
  const encoded = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(controller) {
      if (!chunkSize) controller.enqueue(encoded);
      else {
        for (let offset = 0; offset < encoded.length; offset += chunkSize) {
          controller.enqueue(encoded.subarray(offset, offset + chunkSize));
        }
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", ...headers },
  });
}

async function collectEvents(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function withoutImageBytes(output) {
  const { image, ...metadata } = output;
  assert.ok(image instanceof Buffer);
  return metadata;
}

function rejectWhenAborted(signal) {
  return new Promise((resolve, reject) => {
    void resolve;
    const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function pngFixture(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((1 + (width * 4)) * height);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const checksumInput = Buffer.concat([name, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(checksumInput), 8 + data.length);
  return chunk;
}

function jpegFixture(width, height) {
  const frame = Buffer.alloc(17);
  frame.writeUInt16BE(17, 0);
  frame[2] = 8;
  frame.writeUInt16BE(height, 3);
  frame.writeUInt16BE(width, 5);
  frame[7] = 3;
  for (let component = 0; component < 3; component += 1) {
    frame[8 + (component * 3)] = component + 1;
    frame[9 + (component * 3)] = 0x11;
  }
  const scan = Buffer.from([0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0]),
    frame,
    Buffer.from([0xff, 0xda]),
    scan,
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]),
  ]);
}

function webpFixture(width, height) {
  const payload = Buffer.alloc(11);
  payload[0] = 0x30;
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  const chunk = Buffer.concat([Buffer.from("VP8 "), uint32le(payload.length), payload, Buffer.alloc(1)]);
  return Buffer.concat([Buffer.from("RIFF"), uint32le(4 + chunk.length), Buffer.from("WEBP"), chunk]);
}

function uint32le(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
