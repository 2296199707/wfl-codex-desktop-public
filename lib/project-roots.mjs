import crypto from "node:crypto";
import path from "node:path";

export const MAX_PROJECT_ROOTS = 8;

export function normalizeProjectRoots(value, fallback = "/srv") {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim()
      ? value.split(path.delimiter)
      : [fallback];
  const roots = [];
  for (const raw of values) {
    const input = String(raw || "").trim();
    if (input.includes("..")) throw new Error("项目存储根目录必须是有效的绝对路径");
    const candidate = path.resolve(input);
    if (!isSafeProjectRoot(candidate)) throw new Error("项目存储根目录必须是有效的绝对路径");
    if (!roots.includes(candidate)) roots.push(candidate);
  }
  if (!roots.length) throw new Error("至少需要一个项目存储根目录");
  if (roots.length > MAX_PROJECT_ROOTS) throw new Error(`项目存储根目录最多支持 ${MAX_PROJECT_ROOTS} 个`);
  return roots;
}

export function isSafeProjectRoot(candidate) {
  const value = String(candidate || "");
  return path.isAbsolute(value)
    && value !== path.parse(value).root
    && !value.includes("..")
    && !/[\u0000-\u001f\u007f\s]/u.test(value);
}

export function projectRootContains(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function projectRootForPath(roots, candidate) {
  const normalized = normalizeProjectRoots(roots);
  return normalized
    .filter((root) => projectRootContains(root, candidate))
    .sort((left, right) => right.length - left.length)[0] || null;
}

export function projectRootId(root) {
  return `root-${crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16)}`;
}

export function publicProjectRoots(roots, defaultProject = null) {
  return normalizeProjectRoots(roots).map((root, index) => ({
    id: projectRootId(root),
    path: root,
    label: index === 0 ? "主存储" : `存储位置 ${index + 1}`,
    isDefault: Boolean(defaultProject && projectRootContains(root, defaultProject)),
  }));
}
