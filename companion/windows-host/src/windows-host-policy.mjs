const REMOTE_METHODS = new Set([
  "codex.projects.list",
  "codex.threads.list",
  "codex.thread.read",
  "codex.thread.resume",
  "codex.turn.start",
]);
const CREATOR_METHODS = new Set([
  "creator.workspace.list",
  "creator.workspace.readText",
  "creator.workspace.writeText",
  "creator.job.run",
  "creator.job.cancel",
]);
const JOB_KINDS = new Set([
  "presentation.generate",
  "document.generate",
  "media.transcode",
  "video.compose",
  "godot.export",
]);

export const WINDOWS_HOST_METHODS = Object.freeze({
  "windows-codex-remote": Object.freeze([...REMOTE_METHODS]),
  "creator-worker": Object.freeze([...CREATOR_METHODS]),
});

export function normalizeWindowsHostCall(pluginId, method, params) {
  const normalizedPluginId = String(pluginId || "");
  const normalizedMethod = String(method || "");
  const source = objectValue(params, "调用参数");
  if (normalizedPluginId === "windows-codex-remote" && REMOTE_METHODS.has(normalizedMethod)) {
    return normalizeCodexCall(normalizedMethod, source);
  }
  if (normalizedPluginId === "creator-worker" && CREATOR_METHODS.has(normalizedMethod)) {
    return normalizeCreatorCall(normalizedMethod, source);
  }
  throw policyError(403, "插件不允许调用此 Windows Host 方法");
}

export function normalizeWorkspaceRelativePath(value, { allowRoot = false, extensions = null } = {}) {
  const input = String(value ?? "").replaceAll("\\", "/");
  if (allowRoot && (input === "" || input === ".")) return ".";
  if (!input || input.length > 512 || input.startsWith("/") || /^[A-Za-z]:/.test(input)) {
    throw policyError(400, "工作区路径必须是相对路径");
  }
  const segments = input.split("/");
  if (segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || segment.length > 120
    || /[. ]$/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    || /[\u0000-\u001f\u007f:*?'"<>|]/.test(segment)
  ))) {
    throw policyError(400, "工作区路径包含不安全片段");
  }
  const normalized = segments.join("/");
  if (extensions) {
    const extension = normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(".")).toLowerCase() : "";
    if (!extensions.has(extension)) throw policyError(400, "输出文件类型不受支持");
  }
  return normalized;
}

function normalizeCodexCall(method, source) {
  if (method === "codex.projects.list") {
    exactKeys(source, []);
    return {};
  }
  const projectId = opaqueId(source.projectId, "工程 ID");
  if (method === "codex.threads.list") {
    exactKeys(source, ["projectId"]);
    return { projectId };
  }
  const threadId = opaqueId(source.threadId, "Thread ID");
  if (method === "codex.thread.read" || method === "codex.thread.resume") {
    exactKeys(source, ["projectId", "threadId"]);
    return { projectId, threadId };
  }
  exactKeys(source, ["projectId", "threadId", "requestId", "input"]);
  const requestId = opaqueId(source.requestId, "请求 ID");
  const input = boundedText(source.input, "消息", 1, 100_000);
  return { projectId, threadId, requestId, input };
}

function normalizeCreatorCall(method, source) {
  if (method === "creator.workspace.list") {
    exactKeys(source, ["path", "maxEntries"], ["path", "maxEntries"]);
    const maxEntries = source.maxEntries === undefined ? 200 : boundedInteger(source.maxEntries, "条目上限", 1, 500);
    return {
      path: normalizeWorkspaceRelativePath(source.path, { allowRoot: true }),
      maxEntries,
    };
  }
  if (method === "creator.workspace.readText") {
    exactKeys(source, ["path"]);
    return { path: normalizeWorkspaceRelativePath(source.path) };
  }
  if (method === "creator.workspace.writeText") {
    exactKeys(source, ["path", "content", "overwrite"], ["overwrite"]);
    return {
      path: normalizeWorkspaceRelativePath(source.path),
      content: boundedText(source.content, "文件内容", 0, 2_000_000),
      overwrite: source.overwrite === true,
    };
  }
  if (method === "creator.job.cancel") {
    exactKeys(source, ["jobId"]);
    return { jobId: opaqueId(source.jobId, "Job ID") };
  }
  exactKeys(source, ["jobId", "kind", "workspacePath", "spec"]);
  const kind = String(source.kind || "");
  if (!JOB_KINDS.has(kind)) throw policyError(400, "创作任务类型不受支持");
  return {
    jobId: opaqueId(source.jobId, "Job ID"),
    kind,
    workspacePath: normalizeWorkspaceRelativePath(source.workspacePath, { allowRoot: true }),
    spec: normalizeJobSpec(kind, objectValue(source.spec, "任务规格")),
  };
}

function normalizeJobSpec(kind, source) {
  if (kind === "presentation.generate") {
    exactKeys(source, ["output", "title", "theme", "slides"], ["theme"]);
    const slides = arrayValue(source.slides, "幻灯片", 1, 80).map((slide, index) => {
      const item = objectValue(slide, `第 ${index + 1} 页`);
      exactKeys(item, ["title", "body", "bullets", "speakerNotes"], ["body", "bullets", "speakerNotes"]);
      return {
        title: boundedText(item.title, "幻灯片标题", 1, 200),
        body: optionalText(item.body, "幻灯片正文", 4_000),
        bullets: item.bullets === undefined
          ? []
          : arrayValue(item.bullets, "项目符号", 0, 30).map((entry) => boundedText(entry, "项目符号", 1, 500)),
        speakerNotes: optionalText(item.speakerNotes, "演讲备注", 4_000),
      };
    });
    const theme = source.theme === undefined ? "clean" : String(source.theme);
    if (!["clean", "dark", "business", "creative"].includes(theme)) throw policyError(400, "演示主题不受支持");
    return {
      output: normalizeWorkspaceRelativePath(source.output, { extensions: new Set([".pptx"]) }),
      title: boundedText(source.title, "演示标题", 1, 200),
      theme,
      slides,
    };
  }
  if (kind === "document.generate") {
    exactKeys(source, ["output", "title", "sections"]);
    const sections = arrayValue(source.sections, "文档章节", 1, 200).map((section, index) => {
      const item = objectValue(section, `第 ${index + 1} 节`);
      exactKeys(item, ["heading", "paragraphs"]);
      return {
        heading: boundedText(item.heading, "章节标题", 1, 300),
        paragraphs: arrayValue(item.paragraphs, "段落", 1, 100)
          .map((entry) => boundedText(entry, "段落", 1, 20_000)),
      };
    });
    return {
      output: normalizeWorkspaceRelativePath(source.output, { extensions: new Set([".docx", ".pdf"]) }),
      title: boundedText(source.title, "文档标题", 1, 300),
      sections,
    };
  }
  if (kind === "media.transcode") {
    exactKeys(source, ["input", "output", "quality"]);
    const quality = String(source.quality || "");
    if (!["small", "balanced", "high"].includes(quality)) throw policyError(400, "转码质量不受支持");
    return {
      input: normalizeWorkspaceRelativePath(source.input),
      output: normalizeWorkspaceRelativePath(source.output, {
        extensions: new Set([".mp4", ".webm", ".mp3", ".wav"]),
      }),
      quality,
    };
  }
  if (kind === "video.compose") {
    exactKeys(source, ["output", "width", "height", "fps", "clips", "titles"], ["titles"]);
    const width = boundedInteger(source.width, "视频宽度", 320, 3840);
    const height = boundedInteger(source.height, "视频高度", 240, 2160);
    const fps = boundedInteger(source.fps, "视频帧率", 12, 60);
    const clips = arrayValue(source.clips, "视频片段", 1, 100).map((clip) => {
      const item = objectValue(clip, "视频片段");
      exactKeys(item, ["path", "startMs", "durationMs"], ["startMs", "durationMs"]);
      return {
        path: normalizeWorkspaceRelativePath(item.path),
        startMs: item.startMs === undefined ? 0 : boundedInteger(item.startMs, "片段起点", 0, 86_400_000),
        durationMs: item.durationMs === undefined
          ? null
          : boundedInteger(item.durationMs, "片段时长", 100, 86_400_000),
      };
    });
    const titles = source.titles === undefined ? [] : arrayValue(source.titles, "字幕", 0, 200).map((title) => {
      const item = objectValue(title, "字幕");
      exactKeys(item, ["text", "startMs", "durationMs"]);
      return {
        text: boundedText(item.text, "字幕文本", 1, 500),
        startMs: boundedInteger(item.startMs, "字幕起点", 0, 86_400_000),
        durationMs: boundedInteger(item.durationMs, "字幕时长", 100, 86_400_000),
      };
    });
    if (titles.length) throw policyError(400, "第一版暂不支持烧录字幕");
    return {
      output: normalizeWorkspaceRelativePath(source.output, { extensions: new Set([".mp4", ".webm"]) }),
      width,
      height,
      fps,
      clips,
      titles,
    };
  }
  exactKeys(source, ["projectPath", "preset", "output"]);
  return {
    projectPath: normalizeWorkspaceRelativePath(source.projectPath, { allowRoot: true }),
    preset: boundedText(source.preset, "Godot 导出预设", 1, 100),
    output: normalizeWorkspaceRelativePath(source.output, {
      extensions: new Set([".exe", ".zip", ".pck"]),
    }),
  };
}

function exactKeys(value, allowed, optional = []) {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) throw policyError(400, "调用参数包含未允许字段");
  const required = allowed.filter((key) => !optional.includes(key));
  if (required.some((key) => !Object.hasOwn(value, key))) throw policyError(400, "调用参数缺少必填字段");
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw policyError(400, `${label}必须是对象`);
  return value;
}

function arrayValue(value, label, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw policyError(400, `${label}数量不正确`);
  }
  return value;
}

function boundedText(value, label, min, max) {
  if (typeof value !== "string" || value.length < min || value.length > max || value.includes("\u0000")) {
    throw policyError(400, `${label}不正确`);
  }
  return value;
}

function optionalText(value, label, max) {
  return value === undefined ? null : boundedText(value, label, 0, max);
}

function boundedInteger(value, label, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw policyError(400, `${label}不正确`);
  return number;
}

function opaqueId(value, label) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw policyError(400, `${label}不正确`);
  return id;
}

function policyError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
