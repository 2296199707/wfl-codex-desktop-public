export const CHARACTER_ANIMATION_SCHEMA = "wfl.character-animation.v1";
export const CHARACTER_ANIMATION_VERSION = 1;

const PROFILES = new Set(["topdown-rpg", "side-scroller", "first-person", "custom"]);
const CLIP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_CLIPS = 256;
const MAX_FRAMES_PER_CLIP = 4_096;
const MAX_FRAME_DURATION_MS = 3_600_000;

export const CHARACTER_PROFILES = Object.freeze([
  Object.freeze({ id: "topdown-rpg", label: "俯视角 RPG", description: "四向或八向角色，脚底锚点保持一致" }),
  Object.freeze({ id: "side-scroller", label: "横向动作", description: "左右朝向角色，基准线和动作高度保持一致" }),
  Object.freeze({ id: "first-person", label: "第一人称", description: "手臂、武器或视角动画，中心锚点保持一致" }),
  Object.freeze({ id: "custom", label: "自定义", description: "由你定义行列、锚点和动画片段" }),
]);

export function createCharacterAnimationDocument(input = {}) {
  const sourceInput = isRecord(input.source) ? clone(input.source) : {};
  const renderInput = isRecord(input.render) ? clone(input.render) : {};
  // Validate the path before falling back to numeric defaults.  An unsafe
  // path must never be hidden by an unrelated missing/invalid dimension.
  const sourcePath = normalizeProjectRelativePath(sourceInput.path || input.sourcePath || "");
  const sourceWidth = positiveInteger(input.sourceWidth ?? sourceInput.imageWidth ?? sourceInput.width, 1, 32_767, "sourceWidth", 0);
  const sourceHeight = positiveInteger(input.sourceHeight ?? sourceInput.imageHeight ?? sourceInput.height, 1, 32_767, "sourceHeight", 0);
  const frameWidth = positiveInteger(sourceInput.frameWidth ?? sourceWidth, 1, 32_767, "frameWidth", sourceWidth);
  const frameHeight = positiveInteger(sourceInput.frameHeight ?? sourceHeight, 1, 32_767, "frameHeight", sourceHeight);
  const marginX = nonNegativeInteger(sourceInput.marginX ?? sourceInput.margin ?? 0, 0, 32_767, "marginX");
  const marginY = nonNegativeInteger(sourceInput.marginY ?? sourceInput.margin ?? 0, 0, 32_767, "marginY");
  const spacingX = nonNegativeInteger(sourceInput.spacingX ?? sourceInput.spacing ?? 0, 0, 32_767, "spacingX");
  const spacingY = nonNegativeInteger(sourceInput.spacingY ?? sourceInput.spacing ?? 0, 0, 32_767, "spacingY");
  const fallbackColumns = gridCount(sourceWidth, frameWidth, marginX, spacingX);
  const fallbackRows = gridCount(sourceHeight, frameHeight, marginY, spacingY);
  const columns = positiveInteger(sourceInput.columns ?? fallbackColumns, 1, 32_767, "columns", fallbackColumns);
  const rows = positiveInteger(sourceInput.rows ?? fallbackRows, 1, 32_767, "rows", fallbackRows);
  const profile = PROFILES.has(input.profile) ? input.profile : "custom";
  const anchor = normalizeAnchor(renderInput.anchor || input.anchor, frameWidth, frameHeight);
  const referenceHeight = positiveInteger(
    renderInput.referenceHeight ?? renderInput.renderHeight ?? frameHeight,
    1,
    32_767,
    "referenceHeight",
    frameHeight,
  );
  const clips = normalizeClips(input.clips, columns * rows);
  const seed = clone(input);
  const document = {
    ...seed,
    schema: CHARACTER_ANIMATION_SCHEMA,
    version: CHARACTER_ANIMATION_VERSION,
    name: boundedText(input.name || "character", 1, 255, "name"),
    profile,
    source: {
      ...sourceInput,
      path: sourcePath,
      imageWidth: sourceWidth,
      imageHeight: sourceHeight,
      frameWidth,
      frameHeight,
      marginX,
      marginY,
      spacingX,
      spacingY,
      columns,
      rows,
    },
    render: {
      ...renderInput,
      anchor,
      referenceHeight,
      scaleMode: "reference-height",
    },
    clips,
  };
  delete document.sourceWidth;
  delete document.sourceHeight;
  delete document.sourcePath;
  delete document.anchor;
  return document;
}

export function normalizeCharacterAnimationDocument(value) {
  if (!isRecord(value)) throw new TypeError("角色动画文档必须是对象");
  if (value.schema !== undefined && value.schema !== CHARACTER_ANIMATION_SCHEMA) {
    throw new TypeError(`不支持的角色动画格式：${String(value.schema)}`);
  }
  return createCharacterAnimationDocument(value);
}

export function serializeCharacterAnimationDocument(value, space = 2) {
  return `${JSON.stringify(normalizeCharacterAnimationDocument(value), null, space)}\n`;
}

export function normalizeProjectRelativePath(value) {
  const path = String(value || "").trim().replaceAll("\\", "/");
  if (!path) return "";
  if (
    path.startsWith("/")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
    || path.includes("\0")
    || path.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
  ) throw new TypeError("资源路径必须是工程相对路径");
  return path;
}

export function frameRect(source, frameIndex) {
  const normalized = normalizeFrameIndex(frameIndex, source?.columns, source?.rows);
  const column = normalized % source.columns;
  const row = Math.floor(normalized / source.columns);
  return {
    x: source.marginX + column * (source.frameWidth + source.spacingX),
    y: source.marginY + row * (source.frameHeight + source.spacingY),
    width: source.frameWidth,
    height: source.frameHeight,
    column,
    row,
    index: normalized,
  };
}

export function frameCount(source) {
  return positiveInteger(source?.columns, 1, 32_767, "columns", 1)
    * positiveInteger(source?.rows, 1, 32_767, "rows", 1);
}

export function clipDurationMs(clip) {
  return playbackFrames(clip).reduce(
    (total, frame) => total + boundedDuration(frame?.durationMs),
    0,
  );
}

export function clipFrameAt(clip, elapsedMs = 0) {
  const frames = playbackFrames(clip);
  if (!frames.length) return null;
  const duration = clipDurationMs(clip);
  if (duration <= 0) return frames[0];
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const target = clip.loop === false ? Math.min(elapsed, Math.max(0, duration - 1)) : elapsed % duration;
  let cursor = 0;
  for (const frame of frames) {
    cursor += boundedDuration(frame.durationMs);
    if (target < cursor) return frame;
  }
  return frames.at(-1);
}

function playbackFrames(clip) {
  const frames = Array.isArray(clip?.frames) ? clip.frames : [];
  if (clip?.direction === "reverse") return [...frames].reverse();
  if (clip?.direction !== "pingpong" || frames.length < 2) return frames;
  return [...frames, ...frames.slice(1, -1).reverse()];
}

export function anchorOffset(document, displayScale = 1) {
  const source = document?.source;
  const anchor = document?.render?.anchor;
  if (!source || !anchor) return { x: 0, y: 0 };
  return {
    x: (Number(anchor.x) || 0) * Number(displayScale || 1),
    y: (Number(anchor.y) || 0) * Number(displayScale || 1),
  };
}

export function gridFromImageSize({ imageWidth, imageHeight, frameWidth, frameHeight, marginX = 0, marginY = 0, spacingX = 0, spacingY = 0 } = {}) {
  const width = positiveInteger(imageWidth, 1, 32_767, "imageWidth");
  const height = positiveInteger(imageHeight, 1, 32_767, "imageHeight");
  const cellWidth = positiveInteger(frameWidth, 1, 32_767, "frameWidth");
  const cellHeight = positiveInteger(frameHeight, 1, 32_767, "frameHeight");
  return {
    columns: gridCount(width, cellWidth, nonNegativeInteger(marginX, 0, 32_767, "marginX"), nonNegativeInteger(spacingX, 0, 32_767, "spacingX")),
    rows: gridCount(height, cellHeight, nonNegativeInteger(marginY, 0, 32_767, "marginY"), nonNegativeInteger(spacingY, 0, 32_767, "spacingY")),
  };
}

function normalizeClips(value, maxFrameIndex) {
  const input = Array.isArray(value) && value.length ? value : [{ id: "idle", name: "待机", frames: [{ index: 0, durationMs: 120 }] }];
  if (input.length > MAX_CLIPS) throw new RangeError("角色动画片段过多");
  const ids = new Set();
  return input.map((clip, clipIndex) => {
    if (!isRecord(clip)) throw new TypeError(`动画片段 ${clipIndex + 1} 无效`);
    const fallbackId = `clip-${clipIndex + 1}`;
    const id = boundedText(clip.id || fallbackId, 1, 64, "clip id");
    if (!CLIP_ID.test(id) || ids.has(id)) throw new TypeError(`动画片段 ID 无效或重复：${id}`);
    ids.add(id);
    const frames = Array.isArray(clip.frames) && clip.frames.length
      ? clip.frames
      : [{ index: 0, durationMs: 120 }];
    if (frames.length > MAX_FRAMES_PER_CLIP) throw new RangeError(`动画片段 ${id} 帧数过多`);
    return {
      ...clone(clip),
      id,
      name: boundedText(clip.name || id, 1, 255, "clip name"),
      loop: clip.loop !== false,
      direction: ["forward", "reverse", "pingpong"].includes(clip.direction) ? clip.direction : "forward",
      frames: frames.map((frame, frameIndex) => {
        if (!isRecord(frame)) throw new TypeError(`动画片段 ${id} 的第 ${frameIndex + 1} 帧无效`);
        return {
          ...clone(frame),
          index: normalizeFrameIndex(frame.index, maxFrameIndex, 1),
          durationMs: boundedDuration(frame.durationMs),
        };
      }),
    };
  });
}

function normalizeFrameIndex(value, columns, rows = 1) {
  const maximum = rows === undefined ? Number(columns) : Number(columns) * Number(rows);
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index >= maximum) throw new RangeError("动画帧索引超出精灵图网格");
  return index;
}

function normalizeAnchor(value, frameWidth, frameHeight) {
  const anchor = isRecord(value) ? value : {};
  const x = finiteNumber(anchor.x, frameWidth / 2);
  const y = finiteNumber(anchor.y, frameHeight);
  if (x < 0 || x > frameWidth || y < 0 || y > frameHeight) throw new RangeError("角色锚点必须位于帧内部");
  return {
    ...clone(anchor),
    x,
    y,
    unit: "pixel",
    locked: true,
  };
}

function boundedDuration(value) {
  return positiveInteger(value ?? 120, 1, MAX_FRAME_DURATION_MS, "durationMs", 120);
}

function gridCount(total, frame, margin, spacing) {
  const available = total - margin * 2;
  if (available < frame) return 1;
  return Math.max(1, Math.floor((available + spacing) / (frame + spacing)));
}

function positiveInteger(value, minimum, maximum, name, fallback = null) {
  const number = value == null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function nonNegativeInteger(value, minimum, maximum, name) {
  return positiveInteger(value, minimum, maximum, name, 0);
}

function finiteNumber(value, fallback) {
  const number = value == null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(number)) throw new RangeError("数值无效");
  return number;
}

function boundedText(value, minimum, maximum, name) {
  const text = String(value ?? "").trim();
  if (text.length < minimum || text.length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new RangeError(`${name} 长度或字符无效`);
  }
  return text;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value == null ? {} : structuredClone(value);
}
