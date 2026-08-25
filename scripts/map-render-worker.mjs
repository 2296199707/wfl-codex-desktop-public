#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { startMapRenderPreviewServer } from "../lib/map-render-preview.mjs";
import { assertCaptureAddresses, normalizeCaptureUrl } from "../lib/preview-capture-policy.mjs";
import { isConfiguredPreviewOrigin, normalizePublicOrigin } from "../lib/public-origin-config.mjs";

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_BROWSER_DIMENSION = 32_767;
const MAX_OUTPUT_FILES = 100_000;
const IMAGE_FORMATS = new Set(["png", "webp"]);
const VIDEO_CODECS = new Set(["libvpx-vp9", "libx264"]);
const appDirectory = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const workerArgument = process.argv[2];

if (workerArgument === "--daemon") await runDaemon();
else await runStandalone(workerArgument);

async function runStandalone(inputPath) {
  try {
    const result = await executeTask(inputPath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(workerFailure(error))}\n`);
    process.exitCode = 1;
  }
}

async function runDaemon() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    let requestId = null;
    try {
      if (Buffer.byteLength(line) > 16 * 1024) throw workerError("invalid-worker-input", "Render Worker 指令过大");
      const request = JSON.parse(line);
      requestId = workerRequestId(request?.id);
      const result = await executeTask(request?.inputPath);
      process.stdout.write(`${JSON.stringify({ id: requestId, ok: true, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ id: requestId, ok: false, error: workerFailure(error) })}\n`);
    }
  }
}

async function executeTask(inputPath) {
  if (!inputPath) throw workerError("invalid-worker-input", "Render Worker 输入文件缺失");
  const inputStat = await fs.stat(inputPath);
  if (!inputStat.isFile() || inputStat.size > MAX_INPUT_BYTES) {
    throw workerError("invalid-worker-input", "Render Worker 输入文件无效或过大");
  }
  const input = normalizeInput(JSON.parse(await fs.readFile(inputPath, "utf8")));
  if (input.kind === "preview-capture") {
    await ensureEmptyOutputDirectory(input.taskDirectory, input.outputDirectory);
    return renderPreviewCapture(input);
  }
  const version = await hashFile(input.targetPath);
  if (version !== input.expectedVersion) {
    throw workerError("map-version-conflict", "地图在渲染任务开始前已经变化");
  }
  await ensureEmptyOutputDirectory(input.taskDirectory, input.outputDirectory);
  return render(input);
}

async function renderPreviewCapture(input) {
  const { capture } = input;
  const allowedOrigins = capture.config.mode === "confirmed"
    ? capture.config.previewOrigins
    : [capture.requestOrigin];
  const allowLoopback = capture.config.mode !== "confirmed";
  const allowedOriginPredicate = (origin) => isConfiguredPreviewOrigin(capture.config, origin);
  const target = normalizeCaptureUrl(capture.url, {
    baseOrigin: capture.requestOrigin,
    allowedOrigins,
    allowedOriginPredicate,
    allowLoopback,
    requirePreviewPath: true,
  });
  assertCaptureAddresses(
    await dns.lookup(target.hostname, { all: true, verbatim: true }),
    { allowLoopback },
  );
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw workerError("preview-capture-unavailable", "截图组件尚未安装，请先运行安装向导");
  }
  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: capture.width, height: capture.height },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (/^(?:data|blob):/iu.test(requestUrl)) {
        await route.continue();
        return;
      }
      try {
        const parsed = normalizeCaptureUrl(requestUrl, {
          allowedOrigins,
          allowedOriginPredicate,
          allowLoopback,
          requirePreviewPath: false,
        });
        assertCaptureAddresses(
          await dns.lookup(parsed.hostname, { all: true, verbatim: true }),
          { allowLoopback },
        );
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    await page.goto(target.href, { waitUntil: "networkidle", timeout: 45_000 });
    const outputPath = path.join(input.outputDirectory, "screenshot.png");
    await page.screenshot({ path: outputPath, type: "png", fullPage: capture.fullPage });
    await fs.chmod(outputPath, 0o600);
    const files = await outputManifest(input.outputDirectory);
    return {
      summary: "项目预览截图完成",
      outputDirectory: "temporary",
      files,
    };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function workerFailure(error) {
  return {
    code: error?.code || "render-worker-failed",
    message: error?.message || "Render Worker 执行失败",
  };
}

async function render(input) {
  const preview = await startMapRenderPreviewServer({
    projectPath: input.projectPath,
    mapPath: input.mapPath,
    appDirectory,
    renderConfig: {
      antialias: input.settings.config.preview.antialias,
      background: input.spec.background || "#171918",
    },
    cacheDirectory: input.cacheDirectory,
    cacheConfig: {
      tileBytes: input.settings.config.cache.tileMb * 1024 * 1024,
      imageBytes: input.settings.config.cache.imageMb * 1024 * 1024,
      idleMs: input.settings.config.worker.idleRecycleMs,
    },
  });
  let browser;
  let context;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 640, height: 480 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    await restrictPageRequests(page, preview.origin);
    await page.goto(preview.url, { waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForFunction(() => ["ready", "error"].includes(document.documentElement.dataset.renderState), null, {
      timeout: 45_000,
    });
    const pageState = await page.evaluate(() => ({
      state: document.documentElement.dataset.renderState,
      error: document.documentElement.dataset.renderError || null,
    }));
    if (pageState.state !== "ready") throw workerError("map-render-page", pageState.error || "地图渲染页面初始化失败");
    const snapshot = await page.evaluate(() => globalThis.__WFL_MAP_RENDER__.snapshot());
    await renderTask({ input, page, preview, snapshot, kind: input.kind, spec: input.spec, outputDirectory: input.outputDirectory });
    const files = await outputManifest(input.outputDirectory);
    return {
      summary: `${input.kind} 完成 · ${files.length} 个文件`,
      outputDirectory: "pending",
      files,
      warnings: snapshot.warnings,
      map: snapshot.map,
      bounds: snapshot.bounds,
    };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await preview.close().catch(() => {});
  }
}

async function renderTask({ input, page, preview, snapshot, kind, spec, outputDirectory }) {
  if (kind === "map-screenshot") {
    await renderScreenshot(page, outputDirectory, spec, input.settings);
    return;
  }
  if (kind === "game-screenshot") {
    await renderGameScreenshot(page.context(), preview, outputDirectory, spec, input.settings);
    return;
  }
  if (kind === "map-panorama") {
    await renderPanorama(page, outputDirectory, spec, input.settings, snapshot.bounds);
    return;
  }
  if (kind === "map-tiles") {
    await renderTiles(page, outputDirectory, spec, input.settings, snapshot.bounds);
    return;
  }
  if (kind === "map-animation") {
    await renderAnimation(page, outputDirectory, spec, input.settings);
    return;
  }
  if (kind === "map-video") {
    await renderVideo(page, outputDirectory, spec, input.settings);
    return;
  }
  if (kind === "map-batch") {
    const tasks = Array.isArray(spec.tasks) ? spec.tasks : [];
    if (!tasks.length || tasks.length > 100) throw workerError("invalid-render-spec", "批量渲染任务数量不正确");
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      if (!isRecord(task)) throw workerError("invalid-render-spec", `批量渲染第 ${index + 1} 项必须是对象`);
      const taskKind = String(task?.kind || "");
      if (taskKind === "map-batch") throw workerError("invalid-render-spec", "批量渲染不能递归嵌套");
      const name = safeName(task?.name || `${String(index + 1).padStart(3, "0")}-${taskKind}`);
      const taskOutput = path.join(outputDirectory, name);
      await fs.mkdir(taskOutput, { recursive: false, mode: 0o700 });
      await renderTask({
        input,
        page,
        preview,
        snapshot,
        kind: taskKind,
        spec: optionalSpec(task.spec, `批量渲染第 ${index + 1} 项参数`),
        outputDirectory: taskOutput,
      });
    }
    return;
  }
  throw workerError("invalid-render-kind", "Render Worker 不支持这个任务类型");
}

async function renderScreenshot(page, outputDirectory, spec, settings) {
  const width = exactInteger(spec.width, settings.config.preview.width, 1, MAX_BROWSER_DIMENSION, "截图宽度");
  const height = exactInteger(spec.height, settings.config.preview.height, 1, MAX_BROWSER_DIMENSION, "截图高度");
  const format = imageFormat(spec.format, "png");
  const mode = spec.mode === undefined ? "fit" : String(spec.mode);
  if (!new Set(["fit", "scale"]).has(mode)) throw workerError("invalid-render-spec", "截图视图模式不正确");
  await captureMapFrame(page, path.join(outputDirectory, `screenshot.${format}`), {
    width,
    height,
    format,
    mode,
    scale: exactNumber(spec.scale, 1, 0.01, 16, "截图比例"),
    offsetX: exactNumber(spec.offsetX, 0, -1e9, 1e9, "截图 X 偏移"),
    offsetY: exactNumber(spec.offsetY, 0, -1e9, 1e9, "截图 Y 偏移"),
    timeMs: exactNumber(spec.timeMs, 0, 0, 3_600_000, "截图动画时间"),
  });
}

async function renderGameScreenshot(context, preview, outputDirectory, spec, settings) {
  const entry = projectPath(spec.entry);
  const width = exactInteger(spec.width, settings.config.preview.width, 1, MAX_BROWSER_DIMENSION, "游戏截图宽度");
  const height = exactInteger(spec.height, settings.config.preview.height, 1, MAX_BROWSER_DIMENSION, "游戏截图高度");
  const page = await context.newPage();
  try {
    await restrictPageRequests(page, preview.origin);
    await page.setViewportSize({ width, height });
    const url = `${preview.origin}/${entry.split("/").map(encodeURIComponent).join("/")}`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    await page.screenshot({
      path: path.join(outputDirectory, "game-screenshot.png"),
      type: "png",
      fullPage: spec.fullPage === true,
      animations: "disabled",
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function renderPanorama(page, outputDirectory, spec, settings, bounds) {
  const scale = exactNumber(spec.scale, settings.config.panorama.scale, 0.01, 16, "全景比例");
  const format = imageFormat(spec.format, settings.config.panorama.format);
  const width = Math.ceil(bounds.width * scale);
  const height = Math.ceil(bounds.height * scale);
  assertBrowserDimensions(width, height, "完整全景");
  await captureMapFrame(page, path.join(outputDirectory, `panorama.${format}`), {
    width,
    height,
    format,
    mode: "scale",
    scale,
    offsetX: 0,
    offsetY: 0,
    timeMs: exactNumber(spec.timeMs, 0, 0, 3_600_000, "全景动画时间"),
  });
}

async function renderTiles(page, outputDirectory, spec, settings, bounds) {
  const scale = exactNumber(spec.scale, settings.config.tiles.scale, 0.01, 16, "切片比例");
  const tileWidth = exactInteger(spec.width, settings.config.tiles.width, 1, MAX_BROWSER_DIMENSION, "切片宽度");
  const tileHeight = exactInteger(spec.height, settings.config.tiles.height, 1, MAX_BROWSER_DIMENSION, "切片高度");
  const format = imageFormat(spec.format, settings.config.tiles.format);
  const totalWidth = Math.ceil(bounds.width * scale);
  const totalHeight = Math.ceil(bounds.height * scale);
  const columns = Math.ceil(totalWidth / tileWidth);
  const rows = Math.ceil(totalHeight / tileHeight);
  if (columns * rows > MAX_OUTPUT_FILES - 1) throw workerError("render-output-limit", "地图切片数量超过任务清单上限");
  const tilesDirectory = path.join(outputDirectory, "tiles");
  await fs.mkdir(tilesDirectory, { recursive: false, mode: 0o700 });
  const timeMs = exactNumber(spec.timeMs, 0, 0, 3_600_000, "切片动画时间");
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const width = Math.min(tileWidth, totalWidth - column * tileWidth);
      const height = Math.min(tileHeight, totalHeight - row * tileHeight);
      await captureMapFrame(
        page,
        path.join(tilesDirectory, `tile-${String(row).padStart(5, "0")}-${String(column).padStart(5, "0")}.${format}`),
        {
          width,
          height,
          format,
          mode: "scale",
          scale,
          offsetX: column * tileWidth,
          offsetY: row * tileHeight,
          timeMs,
        },
      );
    }
  }
  await fs.writeFile(path.join(tilesDirectory, "manifest.json"), `${JSON.stringify({
    version: 1,
    format,
    scale,
    tileWidth,
    tileHeight,
    totalWidth,
    totalHeight,
    columns,
    rows,
    bounds,
  }, null, 2)}\n`, { mode: 0o600 });
}

async function renderAnimation(page, outputDirectory, spec, settings) {
  const animation = animationSpec(spec, settings.config.animation);
  const framesDirectory = path.join(outputDirectory, "frames");
  await fs.mkdir(framesDirectory, { recursive: false, mode: 0o700 });
  const frameCount = Math.ceil(animation.durationMs * animation.fps / 1_000);
  if (frameCount > MAX_OUTPUT_FILES - 1) throw workerError("render-output-limit", "动画帧数量超过任务清单上限");
  for (let index = 0; index < frameCount; index += 1) {
    await captureMapFrame(
      page,
      path.join(framesDirectory, `frame-${String(index).padStart(6, "0")}.${animation.format}`),
      {
        ...animation,
        mode: "fit",
        timeMs: index * 1_000 / animation.fps,
      },
    );
  }
  await fs.writeFile(path.join(outputDirectory, "animation.json"), `${JSON.stringify({
    version: 1,
    frameCount,
    width: animation.width,
    height: animation.height,
    fps: animation.fps,
    durationMs: animation.durationMs,
    format: animation.format,
  }, null, 2)}\n`, { mode: 0o600 });
}

async function renderVideo(page, outputDirectory, spec, settings) {
  const fallback = settings.config.video;
  const width = exactInteger(spec.width, fallback.width, 1, MAX_BROWSER_DIMENSION, "视频宽度");
  const height = exactInteger(spec.height, fallback.height, 1, MAX_BROWSER_DIMENSION, "视频高度");
  const fps = exactInteger(spec.fps, fallback.fps, 1, 240, "视频帧率");
  const durationMs = exactInteger(spec.durationMs, fallback.durationMs, 100, 3_600_000, "视频时长");
  const codec = spec.codec === undefined ? fallback.codec : String(spec.codec);
  if (!VIDEO_CODECS.has(codec)) throw workerError("invalid-render-spec", "视频编码器不正确");
  const crf = exactInteger(spec.crf, fallback.crf, 0, 63, "视频 CRF");
  const frameCount = Math.ceil(durationMs * fps / 1_000);
  const workDirectory = path.join(outputDirectory, ".video-frames");
  await fs.mkdir(workDirectory, { recursive: false, mode: 0o700 });
  try {
    for (let index = 0; index < frameCount; index += 1) {
      await captureMapFrame(page, path.join(workDirectory, `frame-${String(index).padStart(6, "0")}.png`), {
        width,
        height,
        format: "png",
        mode: "fit",
        timeMs: index * 1_000 / fps,
      });
    }
    const extension = codec === "libx264" ? "mp4" : "webm";
    const outputPath = path.join(outputDirectory, `animation.${extension}`);
    const codecArgs = codec === "libx264"
      ? ["-c:v", codec, "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
      : ["-c:v", codec, "-crf", String(crf), "-b:v", "0", "-pix_fmt", "yuv420p"];
    await runChild("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-framerate", String(fps),
      "-i", path.join(workDirectory, "frame-%06d.png"),
      ...codecArgs,
      outputPath,
    ]);
  } finally {
    await fs.rm(workDirectory, { recursive: true, force: true });
  }
}

function animationSpec(spec, fallback) {
  return {
    width: exactInteger(spec.width, fallback.width, 1, MAX_BROWSER_DIMENSION, "动画宽度"),
    height: exactInteger(spec.height, fallback.height, 1, MAX_BROWSER_DIMENSION, "动画高度"),
    fps: exactInteger(spec.fps, fallback.fps, 1, 240, "动画帧率"),
    durationMs: exactInteger(spec.durationMs, fallback.durationMs, 100, 3_600_000, "动画时长"),
    format: imageFormat(spec.format, fallback.format),
  };
}

async function captureMapFrame(page, outputPath, options) {
  assertBrowserDimensions(options.width, options.height, "地图输出");
  await page.setViewportSize({ width: options.width, height: options.height });
  const configured = await page.evaluate(async (renderOptions) => (
    globalThis.__WFL_MAP_RENDER__.configure(renderOptions)
  ), {
    mode: options.mode,
    scale: options.scale,
    offsetX: options.offsetX,
    offsetY: options.offsetY,
    timeMs: options.timeMs,
  });
  if (configured.canvasWidth !== options.width || configured.canvasHeight !== options.height) {
    throw workerError(
      "render-size-mismatch",
      `渲染画布尺寸 ${configured.canvasWidth}x${configured.canvasHeight} 与请求 ${options.width}x${options.height} 不一致`,
    );
  }
  const pngPath = options.format === "png" ? outputPath : `${outputPath}.source.png`;
  await page.locator("canvas.map-canvas").screenshot({
    path: pngPath,
    type: "png",
    animations: "disabled",
  });
  if (options.format === "webp") {
    await runChild("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", pngPath,
      "-c:v", "libwebp", "-lossless", "1", outputPath,
    ]);
    await fs.rm(pngPath, { force: true });
  }
}

async function restrictPageRequests(page, allowedOrigin) {
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (/^(?:data|blob):/iu.test(url)) {
      await route.continue();
      return;
    }
    try {
      if (new URL(url).origin !== allowedOrigin) throw new Error("cross origin");
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });
}

async function outputManifest(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.shift();
    for (const dirent of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, dirent.name);
      if (dirent.isSymbolicLink()) throw workerError("render-output-symlink", "Render Worker 输出不能包含符号链接");
      if (dirent.isDirectory()) pending.push(filename);
      else if (dirent.isFile()) {
        const relative = path.relative(root, filename).split(path.sep).join("/");
        const stat = await fs.stat(filename);
        files.push({
          path: relative,
          size: stat.size,
          sha256: await hashFile(filename),
          mediaType: mediaType(filename),
        });
        if (files.length > MAX_OUTPUT_FILES) throw workerError("render-output-limit", "Render Worker 输出文件数量超过上限");
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function ensureEmptyOutputDirectory(taskDirectory, outputDirectory) {
  const taskRoot = await fs.realpath(taskDirectory);
  const output = path.resolve(outputDirectory);
  const relative = path.relative(taskRoot, output);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw workerError("invalid-worker-output", "Render Worker 输出目录不属于当前任务");
  }
  await fs.mkdir(output, { recursive: false, mode: 0o700 });
  if ((await fs.readdir(output)).length) throw workerError("invalid-worker-output", "Render Worker 输出目录必须为空");
}

function normalizeInput(value) {
  if (!isRecord(value)) throw workerError("invalid-worker-input", "Render Worker 输入不正确");
  if (!isRecord(value.settings?.config)) throw workerError("invalid-worker-input", "渲染设置快照缺失");
  const taskDirectory = absolutePath(value.taskDirectory, "任务路径");
  const common = {
    // Correlation IDs are base64url values and may begin with '-' or '_'.
    // They are not output path components, so use the wider ID validator.
    jobId: workerRequestId(value.jobId),
    kind: String(value.kind || ""),
    taskDirectory,
    outputDirectory: absolutePath(value.outputDirectory, "输出路径"),
    settings: value.settings,
  };
  if (common.kind === "preview-capture") {
    return {
      ...common,
      capture: normalizePreviewCapture(value.capture, value.settings),
    };
  }
  const projectPathValue = absolutePath(value.projectPath, "工程路径");
  const targetPath = absolutePath(value.targetPath, "地图路径");
  const relative = path.relative(projectPathValue, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw workerError("invalid-worker-input", "地图路径不属于当前工程");
  }
  const expectedVersion = String(value.expectedVersion || "");
  if (!/^[a-f0-9]{64}$/u.test(expectedVersion)) throw workerError("invalid-worker-input", "地图版本不正确");
  return {
    ...common,
    projectPath: projectPathValue,
    targetPath,
    mapPath: projectPath(value.mapPath || relative.split(path.sep).join("/")),
    expectedVersion,
    cacheDirectory: value.cacheDirectory
      ? absolutePath(value.cacheDirectory, "缓存路径")
      : path.join(taskDirectory, "cache"),
    spec: optionalSpec(value.spec, "渲染参数"),
  };
}

function normalizePreviewCapture(value, settings) {
  if (!isRecord(value) || !isRecord(value.config)) {
    throw workerError("invalid-worker-input", "项目截图输入不正确");
  }
  const requestOrigin = normalizePublicOrigin(value.requestOrigin, { allowLoopback: true });
  const config = value.config;
  if (config.mode === "confirmed" && !Array.isArray(config.previewOrigins)) {
    throw workerError("invalid-worker-input", "项目截图 Origin 配置不正确");
  }
  const preview = settings.config.preview;
  if (!isRecord(preview)) throw workerError("invalid-worker-input", "项目截图预览设置缺失");
  return {
    url: String(value.url || ""),
    requestOrigin,
    config,
    width: exactCaptureDimension(value.width, preview.width, 320, MAX_BROWSER_DIMENSION, "项目截图宽度"),
    height: exactCaptureDimension(value.height, preview.height, 240, MAX_BROWSER_DIMENSION, "项目截图高度"),
    fullPage: value.fullPage === true,
  };
}

function exactCaptureDimension(value, configuredFallback, minimum, maximum, label) {
  const number = Number(value === undefined ? configuredFallback : value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw workerError("invalid-render-spec", `${label}必须是 ${minimum}-${maximum} 的整数；参数未自动调整`);
  }
  return number;
}

function projectPath(value) {
  const input = String(value || "").trim().replaceAll("\\", "/");
  const segments = input.split("/");
  if (!input || input.startsWith("/") || /^[A-Za-z]:/u.test(input)
      || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".codex-"))) {
    throw workerError("invalid-render-spec", "工程相对路径不正确");
  }
  return segments.join("/");
}

function safeName(value) {
  const name = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) throw workerError("invalid-render-spec", "渲染名称不正确");
  return name;
}

function workerRequestId(value) {
  const id = String(value || "");
  // Map render job IDs are base64url values and may legitimately begin with
  // "-" or "_". They are protocol correlation IDs, not output filenames.
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw workerError("invalid-worker-input", "Render Worker 任务编号不正确");
  }
  return id;
}

function exactInteger(value, fallback, minimum, maximum, label) {
  const number = value === undefined ? Number(fallback) : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw workerError("invalid-render-spec", `${label}不正确`);
  }
  return number;
}

function exactNumber(value, fallback, minimum, maximum, label) {
  const number = value === undefined ? Number(fallback) : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw workerError("invalid-render-spec", `${label}不正确`);
  }
  return number;
}

function imageFormat(value, fallback) {
  const format = String(value === undefined ? fallback : value);
  if (!IMAGE_FORMATS.has(format)) throw workerError("invalid-render-spec", "地图图片格式不正确");
  return format;
}

function assertBrowserDimensions(width, height, label) {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_BROWSER_DIMENSION)) {
    throw workerError(
      "render-dimension-unsupported",
      `${label}要求 ${width}x${height}，超过当前浏览器单画布能力；参数未自动降低`,
    );
  }
}

function absolutePath(value, label) {
  const input = String(value || "");
  if (!path.isAbsolute(input) || input.includes("\u0000")) throw workerError("invalid-worker-input", `${label}不正确`);
  return path.resolve(input);
}

async function hashFile(filename) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function mediaType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return new Map([
    [".json", "application/json"],
    [".mp4", "video/mp4"],
    [".png", "image/png"],
    [".webm", "video/webm"],
    [".webp", "image/webp"],
  ]).get(extension) || "application/octet-stream";
}

function runChild(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(workerError("render-encoder-failed", stderr.trim() || `${command} exited with ${code ?? signal}`));
    });
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalSpec(value, label) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw workerError("invalid-render-spec", `${label}必须是对象`);
  return value;
}

function workerError(code, message) {
  return Object.assign(new Error(message), { code });
}
