import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export class WindowsCreatorHost {
  constructor(config) {
    this.config = config;
    this.root = null;
    this.tools = null;
    this.jobs = new Map();
  }

  async initialize() {
    this.root = await fs.realpath(this.config.workspaceRoot);
    const stat = await fs.stat(this.root);
    if (!stat.isDirectory()) throw new Error("Creator workspace is not a directory");
    this.tools = await detectTools();
    return this;
  }

  capabilities() {
    const tools = [];
    if (this.tools.pptxgenjs) tools.push("presentation.generate");
    if (this.tools.docx) tools.push("document.generate");
    if (this.tools.ffmpeg) tools.push("media.transcode", "video.compose");
    if (this.tools.godot) tools.push("godot.export");
    return {
      available: true,
      workspaceConfigured: true,
      tools,
    };
  }

  async call(method, params) {
    if (method === "creator.workspace.list") return this.list(params);
    if (method === "creator.workspace.readText") return this.readText(params);
    if (method === "creator.workspace.writeText") return this.writeText(params);
    if (method === "creator.job.cancel") return this.cancel(params.jobId);
    if (method === "creator.job.run") return this.runJob(params);
    throw new Error("Creator method is not supported");
  }

  async list({ path: relative, maxEntries }) {
    const directory = await this.resolveExisting(relative);
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) throw new Error("Workspace entry is not a directory");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return {
      path: this.relative(directory),
      truncated: entries.length > maxEntries,
      entries: entries.slice(0, maxEntries).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      })),
    };
  }

  async readText({ path: relative }) {
    const target = await this.resolveExisting(relative);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error("Workspace text file is not readable or is too large");
    const content = await fs.readFile(target, "utf8");
    if (content.includes("\u0000")) throw new Error("Workspace file is not UTF-8 text");
    return { path: this.relative(target), content };
  }

  async writeText({ path: relative, content, overwrite }) {
    const target = await this.resolveOutput(relative, { createParents: true, allowExisting: overwrite });
    await fs.writeFile(target, content, { encoding: "utf8", mode: 0o600, flag: overwrite ? "w" : "wx" });
    return { path: this.relative(target), bytes: Buffer.byteLength(content), overwritten: overwrite };
  }

  async runJob(request) {
    if (this.jobs.has(request.jobId)) throw new Error("Creator Job is already running locally");
    const controller = new AbortController();
    const entry = { controller, child: null };
    this.jobs.set(request.jobId, entry);
    try {
      let result;
      if (request.kind === "presentation.generate") result = await this.presentation(request, entry);
      else if (request.kind === "document.generate") result = await this.document(request, entry);
      else if (request.kind === "media.transcode") result = await this.transcode(request, entry);
      else if (request.kind === "video.compose") result = await this.composeVideo(request, entry);
      else if (request.kind === "godot.export") result = await this.godotExport(request, entry);
      else throw new Error("Creator Job kind is not supported by this Agent");
      return { status: "succeeded", summary: result.summary, outputPath: result.outputPath };
    } catch (error) {
      if (controller.signal.aborted) return { status: "canceled", summary: "任务已取消", outputPath: null };
      throw error;
    } finally {
      this.jobs.delete(request.jobId);
    }
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return { canceled: false };
    job.controller.abort();
    job.child?.kill("SIGTERM");
    return { canceled: true };
  }

  async presentation(request) {
    if (!this.tools.pptxgenjs) throw new Error("PptxGenJS is not installed");
    const target = await this.jobOutput(request, request.spec.output);
    const temporary = temporaryOutputPath(target);
    const module = await import("pptxgenjs");
    const PptxGenJS = module.default || module;
    const deck = new PptxGenJS();
    deck.layout = "LAYOUT_WIDE";
    deck.author = "WFL Creator Worker";
    deck.subject = request.spec.title;
    deck.title = request.spec.title;
    deck.company = "WFL";
    const colors = presentationTheme(request.spec.theme);
    for (const [index, item] of request.spec.slides.entries()) {
      const slide = deck.addSlide();
      slide.background = { color: colors.background };
      slide.addText(item.title, {
        x: 0.7, y: 0.5, w: 11.9, h: 0.7,
        fontFace: "Microsoft YaHei", fontSize: 28, bold: true, color: colors.heading,
      });
      const lines = [item.body, ...item.bullets.map((bullet) => `• ${bullet}`)].filter(Boolean).join("\n");
      if (lines) slide.addText(lines, {
        x: 0.85, y: 1.45, w: 11.5, h: 5.2,
        fontFace: "Microsoft YaHei", fontSize: 18, color: colors.body,
        breakLine: false, valign: "top", margin: 0.06,
      });
      slide.addText(`${index + 1}`, { x: 12.1, y: 7.0, w: 0.5, h: 0.2, fontSize: 9, color: colors.muted });
      if (item.speakerNotes) slide.addNotes(item.speakerNotes.split("\n"));
    }
    try {
      await deck.writeFile({ fileName: temporary });
      await publishOutput(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    return { summary: `已生成 ${request.spec.slides.length} 页演示文稿`, outputPath: this.relative(target) };
  }

  async document(request, entry) {
    if (!this.tools.docx) throw new Error("docx package is not installed");
    const target = await this.jobOutput(request, request.spec.output);
    const docx = await import("docx");
    const children = [new docx.Paragraph({ text: request.spec.title, heading: docx.HeadingLevel.TITLE })];
    for (const section of request.spec.sections) {
      children.push(new docx.Paragraph({ text: section.heading, heading: docx.HeadingLevel.HEADING_1 }));
      for (const paragraph of section.paragraphs) children.push(new docx.Paragraph({ text: paragraph }));
    }
    const document = new docx.Document({ sections: [{ children }] });
    const buffer = await docx.Packer.toBuffer(document);
    if (path.extname(target).toLowerCase() === ".docx") {
      await fs.writeFile(target, buffer, { flag: "wx", mode: 0o600 });
    } else {
      if (!this.tools.soffice) throw new Error("LibreOffice is required for PDF document output");
      const temporary = path.join(path.dirname(target), `.wfl-document-${crypto.randomUUID()}.docx`);
      const converted = temporary.replace(/\.docx$/i, ".pdf");
      await fs.writeFile(temporary, buffer, { flag: "wx", mode: 0o600 });
      try {
        await this.runProcess(entry, this.tools.soffice, [
          "--headless", "--convert-to", "pdf", "--outdir", path.dirname(target), temporary,
        ]);
        await publishOutput(converted, target);
      } finally {
        await fs.unlink(temporary).catch(() => {});
        await fs.unlink(converted).catch(() => {});
      }
    }
    return { summary: `已生成 ${request.spec.sections.length} 节文档`, outputPath: this.relative(target) };
  }

  async transcode(request, entry) {
    if (!this.tools.ffmpeg) throw new Error("FFmpeg is not installed");
    const input = await this.jobInput(request, request.spec.input);
    const output = await this.jobOutput(request, request.spec.output);
    const temporary = temporaryOutputPath(output);
    try {
      await this.runProcess(entry, this.tools.ffmpeg, [
        "-nostdin", "-hide_banner", "-n", "-i", input,
        ...transcodeArguments(output, request.spec.quality), temporary,
      ]);
      await publishOutput(temporary, output);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    return { summary: "媒体转码已完成", outputPath: this.relative(output) };
  }

  async composeVideo(request, entry) {
    if (!this.tools.ffmpeg) throw new Error("FFmpeg is not installed");
    if (request.spec.titles.length) throw new Error("This Agent version does not yet support burned-in titles");
    const output = await this.jobOutput(request, request.spec.output);
    const temporaryOutput = temporaryOutputPath(output);
    const workspace = await this.jobDirectory(request);
    const listPath = path.join(workspace, `.wfl-concat-${crypto.randomUUID()}.txt`);
    const lines = [];
    for (const clip of request.spec.clips) {
      const input = await this.jobInput(request, clip.path);
      const relative = path.relative(workspace, input).split(path.sep).join("/");
      if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Video clip is outside the Job workspace");
      lines.push(`file '${relative.replaceAll("'", "'\\''")}'`);
      if (clip.startMs) lines.push(`inpoint ${(clip.startMs / 1000).toFixed(3)}`);
      if (clip.durationMs) lines.push(`duration ${(clip.durationMs / 1000).toFixed(3)}`);
    }
    await fs.writeFile(listPath, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
    try {
      await this.runProcess(entry, this.tools.ffmpeg, [
        "-nostdin", "-hide_banner", "-n", "-f", "concat", "-safe", "1", "-i", listPath,
        "-vf", `scale=${request.spec.width}:${request.spec.height}:force_original_aspect_ratio=decrease,pad=${request.spec.width}:${request.spec.height}:(ow-iw)/2:(oh-ih)/2,fps=${request.spec.fps}`,
        ...videoCodecArguments(output), temporaryOutput,
      ]);
      await publishOutput(temporaryOutput, output);
    } finally {
      await fs.unlink(listPath).catch(() => {});
      await fs.unlink(temporaryOutput).catch(() => {});
    }
    return { summary: `已合并 ${request.spec.clips.length} 个视频片段`, outputPath: this.relative(output) };
  }

  async godotExport(request, entry) {
    if (!this.tools.godot) throw new Error("Godot is not installed");
    const project = await this.jobInput(request, request.spec.projectPath, { directory: true });
    const projectFile = await resolveBounded(project, "project.godot", { mustExist: true });
    if (!(await fs.stat(projectFile)).isFile()) throw new Error("Godot project.godot is not a file");
    const output = await this.jobOutput(request, request.spec.output);
    const temporary = temporaryOutputPath(output);
    try {
      await this.runProcess(entry, this.tools.godot, [
        "--headless", "--path", project, "--export-release", request.spec.preset, temporary,
      ]);
      await publishOutput(temporary, output);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    return { summary: `Godot 预设“${request.spec.preset}”导出完成`, outputPath: this.relative(output) };
  }

  async jobDirectory(request) {
    return request.workspacePath === "."
      ? this.root
      : this.resolveExisting(request.workspacePath);
  }

  async jobInput(request, relative, { directory = false } = {}) {
    const base = await this.jobDirectory(request);
    const target = await resolveBounded(base, relative, { mustExist: true });
    const stat = await fs.stat(target);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error("Creator Job input type is invalid");
    return target;
  }

  async jobOutput(request, relative) {
    const base = await this.jobDirectory(request);
    return resolveBounded(base, relative, { createParents: true, allowExisting: false });
  }

  async resolveExisting(relative) {
    return resolveBounded(this.root, relative, { mustExist: true });
  }

  async resolveOutput(relative, options) {
    return resolveBounded(this.root, relative, options);
  }

  relative(target) {
    const value = path.relative(this.root, target).split(path.sep).join("/");
    return value || ".";
  }

  runProcess(entry, command, args) {
    return new Promise((resolve, reject) => {
      if (entry.controller.signal.aborted) {
        reject(new Error("Creator Job was canceled"));
        return;
      }
      const child = spawn(command, args, {
        cwd: this.root,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        shell: false,
      });
      entry.child = child;
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 8_000) stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        entry.child = null;
        if (code === 0) resolve();
        else reject(new Error(entry.controller.signal.aborted
          ? "Creator Job was canceled"
          : `Allowlisted tool failed (${code ?? signal}): ${lastLine(stderr)}`));
      });
    });
  }
}

async function resolveBounded(root, relative, {
  mustExist = false,
  createParents = false,
  allowExisting = true,
} = {}) {
  const rootReal = await fs.realpath(root);
  const segments = String(relative || "").replaceAll("\\", "/").split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length) return rootReal;
  if (segments.some((segment) => (
    segment === ".."
    || /[. ]$/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    || /[\u0000-\u001f\u007f:*?'"<>|]/.test(segment)
  ))) {
    throw new Error("Workspace path is unsafe");
  }
  let parent = rootReal;
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(parent, segment);
    try {
      const stat = await fs.lstat(next);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Workspace parent is not a real directory");
    } catch (error) {
      if (error.code !== "ENOENT" || !createParents) throw error;
      await fs.mkdir(next, { mode: 0o700 });
    }
    parent = await fs.realpath(next);
    assertWithin(rootReal, parent);
  }
  const target = path.join(parent, segments.at(-1));
  assertWithin(rootReal, target);
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error("Workspace symlinks are not allowed");
    if (!allowExisting) throw new Error("Creator output already exists");
    return await fs.realpath(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (mustExist) throw new Error("Workspace input does not exist");
    return target;
  }
}

function assertWithin(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error("Workspace path escaped its configured root");
}

async function detectTools() {
  const [pptxgenjs, docx, ffmpeg, soffice, godot] = await Promise.all([
    importAvailable("pptxgenjs"),
    importAvailable("docx"),
    executableAvailable("ffmpeg", ["-version"]),
    executableAvailable("soffice", ["--version"]),
    detectGodot(),
  ]);
  return { pptxgenjs, docx, ffmpeg: ffmpeg ? "ffmpeg" : null, soffice: soffice ? "soffice" : null, godot };
}

async function importAvailable(name) {
  try {
    await import(name);
    return true;
  } catch {
    return false;
  }
}

async function detectGodot() {
  if (await executableAvailable("godot", ["--version"])) return "godot";
  if (await executableAvailable("godot4", ["--version"])) return "godot4";
  return null;
}

function executableAvailable(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true, shell: false });
    const timer = setTimeout(() => child.kill(), 5_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function presentationTheme(theme) {
  return ({
    clean: { background: "FFFFFF", heading: "162033", body: "334155", muted: "94A3B8" },
    dark: { background: "111827", heading: "F8FAFC", body: "E2E8F0", muted: "94A3B8" },
    business: { background: "F8FAFC", heading: "0F3D64", body: "243B53", muted: "829AB1" },
    creative: { background: "FFF7ED", heading: "9A3412", body: "431407", muted: "C2410C" },
  })[theme];
}

function temporaryOutputPath(target) {
  const parsed = path.parse(target);
  return path.join(parsed.dir, `.${parsed.name}.wfl-${crypto.randomUUID()}${parsed.ext}`);
}

async function publishOutput(source, destination) {
  try {
    await fs.link(source, destination);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Creator output already exists");
    if (!["EPERM", "ENOTSUP", "EXDEV"].includes(error.code)) throw error;
    try {
      await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    } catch (copyError) {
      if (copyError.code === "EEXIST") throw new Error("Creator output already exists");
      throw copyError;
    }
  }
  await fs.unlink(source);
}

function transcodeArguments(output, quality) {
  const extension = path.extname(output).toLowerCase();
  if (extension === ".mp3") {
    return ["-vn", "-c:a", "libmp3lame", "-b:a", { small: "128k", balanced: "192k", high: "256k" }[quality]];
  }
  if (extension === ".wav") return ["-vn", "-c:a", "pcm_s16le"];
  const crf = { small: "31", balanced: "25", high: "19" }[quality];
  if (extension === ".webm") return ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", crf, "-c:a", "libopus"];
  return ["-c:v", "libx264", "-preset", { small: "fast", balanced: "medium", high: "slow" }[quality], "-crf", crf, "-c:a", "aac"];
}

function videoCodecArguments(output) {
  return path.extname(output).toLowerCase() === ".webm"
    ? ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "25", "-c:a", "libopus"]
    : ["-c:v", "libx264", "-crf", "23", "-c:a", "aac"];
}

function lastLine(value) {
  const line = String(value || "").trim().split(/\r?\n/).at(-1) || "tool error";
  return line.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}
