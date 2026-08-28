import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createImageWorkerRunner } from "../lib/image-worker-runner.mjs";
import { IMAGE_EXECUTION_PRESETS } from "../lib/image-execution-settings.mjs";

test("isolated image worker executes generate, streamed edit, mask validation, and outpaint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-worker-integration-"));
  const requests = [];
  let server;
  let runner;
  try {
    const generatedPng = await solidPng(8, 8, { r: 20, g: 40, b: 60, alpha: 1 });
    const editedPng = await solidPng(8, 8, { r: 30, g: 180, b: 70, alpha: 1 });
    const outpaintPng = await solidPng(12, 8, { r: 60, g: 80, b: 220, alpha: 1 });
    const outpaintJpeg = await sharp(outpaintPng).jpeg({ quality: 80 }).toBuffer();
    const wrongSizePng = await solidPng(4, 4, { r: 1, g: 2, b: 3, alpha: 1 });
    server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      requests.push({ url: request.url, contentType: request.headers["content-type"], body });
      response.setHeader("x-request-id", `image-request-${requests.length}`);
      if (requests.length === 1) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          data: [{ b64_json: generatedPng.toString("base64") }],
          usage: { total_tokens: 5 },
        }));
        return;
      }
      if (requests.length === 2) {
        response.setHeader("content-type", "text/event-stream");
        const encoded = editedPng.toString("base64");
        response.write(`event: image_edit.partial_image\ndata: ${JSON.stringify({
          type: "image_edit.partial_image", partial_image_index: 0, b64_json: encoded,
        })}\n\n`);
        response.end(`event: image_edit.completed\ndata: ${JSON.stringify({
          type: "image_edit.completed", data: [{ b64_json: encoded }], usage: { total_tokens: 7 },
        })}\n\n`);
        return;
      }
      response.setHeader("content-type", "application/json");
      if (requests.length === 3) {
        response.end(JSON.stringify({ data: [{ b64_json: wrongSizePng.toString("base64") }] }));
      } else if (requests.length === 5) {
        response.end(JSON.stringify({ data: [{ b64_json: outpaintJpeg.toString("base64") }] }));
      } else {
        response.end(JSON.stringify({
          data: [{ b64_json: wrongSizePng.toString("base64") }],
          usage: { total_tokens: 11 },
        }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    runner = createImageWorkerRunner({
      runtimeDirectory: path.join(root, "runtime"),
      useSystemd: false,
      prepareTask: stageTaskPayload,
    });

    const generateEvents = [];
    const generated = await runner(job("1", {
      imageApi: imageApi(baseUrl),
      request: imageRequest({ operation: "generate", prompt: "generate-secret-prompt" }),
      sources: [],
      mask: null,
    }), { onEvent: (event) => generateEvents.push(event) });
    assert.equal(generated.files.length, 1);
    assert.deepEqual(
      [generated.files[0].width, generated.files[0].height, generated.files[0].format],
      [8, 8, "png"],
    );
    assert.equal((await sharp(generated.files[0].absolutePath).metadata()).width, 8);
    assert.ok(generateEvents.find((event) => event.type === "usage" && event.usage.totalTokens === 5));
    assert.ok(
      generateEvents.findIndex((event) => event.type === "usage")
      < generateEvents.findIndex((event) => event.type === "phase" && event.phase === "postprocessing"),
    );
    assert.doesNotMatch(JSON.stringify({ generated, generateEvents }), /generate-secret-prompt|provider-secret|b64_json/u);

    const sourcePath = path.join(root, "source.png");
    const maskPath = path.join(root, "mask.png");
    await fs.writeFile(sourcePath, await solidPng(8, 8, { r: 200, g: 10, b: 20, alpha: 1 }));
    await fs.writeFile(maskPath, await halfMaskPng(8, 8));
    const source = await sourceRecord(sourcePath);
    const mask = await sourceRecord(maskPath);
    const editEvents = [];
    const edited = await runner(job("2", {
      imageApi: imageApi(baseUrl),
      request: imageRequest({
        operation: "edit",
        prompt: "edit-secret-prompt",
        stream: true,
        partialImages: 1,
        maskMode: "strict",
        maskFeather: 0,
      }),
      sources: [source],
      mask,
    }), { onEvent: (event) => editEvents.push(event) });
    const partial = editEvents.find((event) => event.type === "partial");
    assert.ok(partial);
    assert.equal((await fs.stat(partial.file.absolutePath)).size, partial.file.size);
    assert.equal(edited.files[0].width, 8);
    assert.equal(edited.usage.totalTokens, 7);
    const strictPixels = await sharp(edited.files[0].absolutePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...strictPixels.data.subarray(0, 3)], [200, 10, 20]);
    const editablePixel = ((0 * strictPixels.info.width) + 7) * 4;
    assert.deepEqual([...strictPixels.data.subarray(editablePixel, editablePixel + 3)], [30, 180, 70]);
    assert.ok(
      editEvents.findIndex((event) => event.type === "usage")
      < editEvents.findIndex((event) => event.type === "phase" && event.phase === "postprocessing"),
    );
    assert.doesNotMatch(JSON.stringify({ edited, editEvents }), /edit-secret-prompt|provider-secret|b64_json/u);

    const outpainted = await runner(job("3", {
      imageApi: imageApi(baseUrl),
      request: imageRequest({
        operation: "outpaint",
        prompt: "outpaint-secret-prompt",
        size: null,
        outpaint: { top: 0, right: 2, bottom: 0, left: 2 },
        preserveSource: "seamless",
        blendMargin: 2,
      }),
      sources: [source],
      mask: null,
    }));
    assert.deepEqual([outpainted.files[0].width, outpainted.files[0].height], [12, 8]);
    const decoded = await sharp(outpainted.files[0].absolutePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const sourceCenter = ((4 * decoded.info.width) + 6) * 4;
    assert.deepEqual([...decoded.data.subarray(sourceCenter, sourceCenter + 3)], [200, 10, 20]);
    const outerPixel = ((4 * decoded.info.width) + 0) * 4;
    assert.deepEqual([...decoded.data.subarray(outerPixel, outerPixel + 3)], [1, 2, 3]);
    const seamPixel = ((4 * decoded.info.width) + 2) * 4;
    assert.deepEqual([...decoded.data.subarray(seamPixel, seamPixel + 3)], [1, 2, 3]);

    const differentSizeEvents = [];
    const differentSize = await runner(job("5", {
      imageApi: imageApi(baseUrl),
      request: imageRequest({ operation: "generate", prompt: "returned-different-size" }),
      sources: [],
      mask: null,
    }), { onEvent: (event) => differentSizeEvents.push(event) });
    assert.deepEqual(
      [differentSize.files[0].width, differentSize.files[0].height],
      [4, 4],
    );
    assert.ok(differentSizeEvents.find((event) => event.type === "usage" && event.usage.totalTokens === 11));

    const zeroCompressionJpeg = await runner(job("6", {
      imageApi: imageApi(baseUrl),
      request: imageRequest({
        operation: "outpaint",
        prompt: "zero-quality-outpaint",
        size: null,
        outputFormat: "jpeg",
        outputCompression: 0,
        outpaint: { top: 0, right: 2, bottom: 0, left: 2 },
      }),
      sources: [source],
      mask: null,
    }));
    assert.deepEqual(
      [zeroCompressionJpeg.files[0].format, zeroCompressionJpeg.files[0].width, zeroCompressionJpeg.files[0].height],
      ["jpeg", 12, 8],
    );
    assert.equal(zeroCompressionJpeg.requested.outputCompression, 0);

    assert.deepEqual(requests.map((entry) => entry.url), [
      "/v1/images/generations", "/v1/images/edits", "/v1/images/edits", "/v1/images/generations",
      "/v1/images/edits",
    ]);
    assert.equal(JSON.parse(requests[0].body.toString("utf8")).user, "wfl-user-a");
    assert.match(requests[1].contentType, /^multipart\/form-data;/u);
    assert.match(requests[1].body.toString("latin1"), /name="mask"/u);
    assert.match(requests[1].body.toString("latin1"), /name="user"\r\n\r\nwfl-user-a/u);
    assert.match(requests[2].body.toString("latin1"), /outpaint-canvas\.png/u);
    assert.match(requests[2].body.toString("latin1"), /outpaint-mask\.png/u);
    assert.match(requests[4].body.toString("latin1"), /name="output_compression"\r\n\r\n0\r\n/u);

    await Promise.all([generated.dispose(), edited.dispose(), outpainted.dispose(), zeroCompressionJpeg.dispose()]);
  } finally {
    await runner?.close();
    await new Promise((resolve) => server?.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isolated image worker rejects a source changed after admission", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-worker-source-race-"));
  let runner;
  try {
    const sourcePath = path.join(root, "source.png");
    await fs.writeFile(sourcePath, await solidPng(8, 8, { r: 1, g: 2, b: 3, alpha: 1 }));
    const source = await sourceRecord(sourcePath);
    source.ino = String(Number(source.ino) + 1);
    runner = createImageWorkerRunner({
      runtimeDirectory: path.join(root, "runtime"),
      useSystemd: false,
      prepareTask: async (job, context) => {
        const staged = await stageTaskPayload(job, context);
        staged.sources[0].ino = String(Number(staged.sources[0].ino) + 1);
        return staged;
      },
    });
    await assert.rejects(
      runner(job("4", {
        imageApi: imageApi("http://127.0.0.1:1/v1"),
        request: imageRequest({ operation: "edit", prompt: "changed source" }),
        sources: [source],
        mask: null,
      })),
      (error) => error.code === "IMAGE_SOURCE_CHANGED" && error.statusCode === 409,
    );
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isolated image worker rejects unstaged sources outside its fixed input directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-worker-source-boundary-"));
  let runner;
  try {
    const sourcePath = path.join(root, "outside.png");
    await fs.writeFile(sourcePath, await solidPng(8, 8, { r: 1, g: 2, b: 3, alpha: 1 }));
    runner = createImageWorkerRunner({
      runtimeDirectory: path.join(root, "runtime"),
      useSystemd: false,
      prepareTask: async (task) => structuredClone(task.payload),
    });
    await assert.rejects(
      runner(job("7", {
        imageApi: imageApi("http://127.0.0.1:1/v1"),
        request: imageRequest({ operation: "edit", prompt: "outside source" }),
        sources: [await sourceRecord(sourcePath)],
        mask: null,
      })),
      (error) => error.code === "IMAGE_SOURCE_OUTSIDE_TASK" && error.statusCode === 403,
    );
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isolated image worker never retries a possibly billed provider request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-worker-no-retry-"));
  let server;
  let runner;
  let requestCount = 0;
  try {
    server = http.createServer(async (request, response) => {
      requestCount += 1;
      for await (const _chunk of request) { /* drain the request */ }
      response.writeHead(500, { "content-type": "application/json", "x-request-id": "no-retry-request" });
      response.end(JSON.stringify({ error: { type: "server_error", message: "provider failed" } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    runner = createImageWorkerRunner({
      runtimeDirectory: path.join(root, "runtime"),
      useSystemd: false,
      prepareTask: stageTaskPayload,
    });
    await assert.rejects(
      runner(job("a", {
        imageApi: imageApi(`http://127.0.0.1:${address.port}/v1`),
        request: imageRequest({ operation: "generate", prompt: "single billed attempt" }),
        sources: [],
        mask: null,
      })),
      (error) => error.providerStatusCode === 500 && error.providerRequestId === "no-retry-request",
    );
    assert.equal(requestCount, 1);
  } finally {
    await runner?.close();
    await new Promise((resolve) => server?.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isolated compatibility probe reports each real operation without changing capabilities", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-worker-probe-"));
  const requests = [];
  const images = new Map();
  let server;
  let runner;
  try {
    for (const [size, width, height] of [
      ["1024x1024", 1_024, 1_024],
      ["1536x1024", 1_536, 1_024],
      ["1040x1024", 1_040, 1_024],
    ]) images.set(size, await solidPng(width, height, { r: 18, g: 36, b: 54, alpha: 1 }));
    server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const text = body.toString(request.url.endsWith("generations") ? "utf8" : "latin1");
      const size = request.url.endsWith("generations")
        ? JSON.parse(text).size
        : /name="size"\r\n\r\n([^\r]+)/u.exec(text)?.[1];
      requests.push({ url: request.url, size, body });
      response.setHeader("content-type", "application/json");
      response.setHeader("x-request-id", `probe-${requests.length}`);
      response.end(JSON.stringify({
        data: [{ b64_json: images.get(size).toString("base64") }],
        usage: {
          input_tokens: 2,
          input_tokens_details: { text_tokens: 1, image_tokens: request.url.endsWith("edits") ? 1 : 0 },
          output_tokens: 3,
          total_tokens: 5,
        },
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    runner = createImageWorkerRunner({
      runtimeDirectory: path.join(root, "runtime"),
      useSystemd: false,
      prepareTask: stageTaskPayload,
    });
    const events = [];
    const result = await runner(job("b", {
      kind: "compatibility-probe",
      imageApi: imageApi(baseUrl),
      probe: {
        tests: [
          "generate-standard", "edit-standard", "edit-mask", "outpaint-standard", "outpaint-custom",
        ],
        quality: "low",
        user: "wfl-user-a",
      },
    }), { onEvent: (event) => events.push(event) });
    assert.deepEqual(result.files, []);
    const report = result.requested.probeReport;
    assert.equal(report.kind, "wfl-image-compatibility-probe");
    assert.equal(report.tests.length, 5);
    assert.equal(report.tests.every((entry) => entry.ok), true);
    assert.equal(report.recommendations.outpaintCustomSize, true);
    assert.equal(report.usage.totalTokens, 25);
    assert.deepEqual(requests.map(({ url }) => url), [
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/images/edits",
      "/v1/images/edits",
      "/v1/images/edits",
    ]);
    assert.deepEqual(requests.map(({ size }) => size), [
      "1024x1024", "1024x1024", "1024x1024", "1536x1024", "1040x1024",
    ]);
    assert.equal(events.filter((event) => event.type === "usage").length, 5);
    assert.equal(events.find((event) => event.probeId === "edit-mask")?.operation, "edit");
    assert.equal(Object.hasOwn(report.recommendations, "applyAutomatically"), false);
    await result.dispose();
  } finally {
    await runner?.close();
    await new Promise((resolve) => server?.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

function job(marker, payload) {
  return {
    id: marker.repeat(36),
    identity: { userId: "user-a" },
    payload,
    settings: {
      version: 1,
      revision: 1,
      preset: "stable",
      config: structuredClone(IMAGE_EXECUTION_PRESETS.stable),
    },
  };
}

function imageApi(baseUrl) {
  return {
    baseUrl,
    apiKey: "provider-secret",
    model: "gpt-image-test",
    transport: { multipartImageField: "image[]" },
    capabilities: {
      operations: ["generate", "edit", "outpaint"],
      inputFormats: ["png", "jpeg", "webp"],
      mask: true,
    },
    limits: {
      maxInputBytesPerImage: 2 * 1024 * 1024,
      maxInputBytesTotal: 4 * 1024 * 1024,
      maxOutputBytesPerImage: 2 * 1024 * 1024,
      maxResponseBytes: 4 * 1024 * 1024,
      timeoutMs: 10_000,
      fixedSizes: [],
      size: {
        allowAuto: true,
        maxWidth: 3_840,
        maxHeight: 3_840,
        dimensionMultiple: 1,
        maxAspectRatio: 3,
        minPixels: 1,
        maxPixels: 8_294_400,
      },
    },
  };
}

function imageRequest(overrides) {
  return {
    operation: "generate",
    prompt: "image prompt",
    n: 1,
    size: "8x8",
    quality: "medium",
    outputFormat: "png",
    outputCompression: 100,
    background: "opaque",
    moderation: "auto",
    user: "wfl-user-a",
    stream: false,
    partialImages: 0,
    ...overrides,
  };
}

async function sourceRecord(filename) {
  const stat = await fs.stat(filename);
  return {
    path: filename,
    filename: path.basename(filename),
    mediaType: "image/png",
    size: stat.size,
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

function solidPng(width, height, background) {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

function halfMaskPng(width, height) {
  const pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = Math.floor(width / 2); x < width; x += 1) pixels[(y * width + x) * 4 + 3] = 0;
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function stageTaskPayload(job, { inputDirectory }) {
  const payload = structuredClone(job.payload);
  const stage = async (record, name) => {
    if (!record) return null;
    const destination = path.join(inputDirectory, name);
    await fs.copyFile(record.path, destination);
    await fs.chmod(destination, 0o600);
    const stat = await fs.stat(destination);
    return {
      ...record,
      path: destination,
      size: stat.size,
      dev: String(stat.dev),
      ino: String(stat.ino),
    };
  };
  payload.sources = await Promise.all((payload.sources || []).map((record, index) => (
    stage(record, `source-${index + 1}${path.extname(record.filename)}`)
  )));
  payload.mask = await stage(payload.mask, `mask${path.extname(payload.mask?.filename || ".png")}`);
  return payload;
}
