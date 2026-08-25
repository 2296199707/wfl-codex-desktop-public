const REMOTE_NAME_PATTERN = /^(?![./])(?!.*(?:\.\.|\/\/|@\{|[~^:?*\[\]\\\s]))(?!.*[/.]$)[A-Za-z0-9._/-]{1,128}$/;
const REMOTE_BRANCH_PATTERN = /^(?![./])(?!.*(?:\.\.|\/\/|@\{|[~^:?*\[\]\\\s]))(?!.*[/.]$)[A-Za-z0-9._/-]{1,256}$/;
const SECRET_PATTERNS = Object.freeze([
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, "[已隐藏私钥]"],
  [/((?:api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|authorization|password|passwd|secret|token)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "$1[已隐藏]"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[已隐藏 OpenAI 密钥]"],
  [/\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[已隐藏凭据]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, "[已隐藏 GitHub 令牌]"],
  [/\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gi, "[已隐藏令牌]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [已隐藏]"],
  [/((?:https?|ssh|git|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[已隐藏认证]@"],
]);

export const REMOTE_GIT_FILE_LIMIT = 200;
export const REMOTE_GIT_REF_LIMIT = 512;
export const REMOTE_GIT_TOTAL_DIFF_BYTES = 2 * 1024 * 1024;
export const REMOTE_GIT_FILE_DIFF_BYTES = 256 * 1024;
export const REMOTE_GIT_NATIVE_LINE_LIMIT = 50_000;

export function parseGitRemoteRefs(value, remoteNames) {
  const remotes = new Set(
    Array.isArray(remoteNames)
      ? remoteNames.filter((name) => validRemoteName(name))
      : [],
  );
  const refs = [];
  const seen = new Set();
  const records = String(value || "").split("\0").map((record) => record.replace(/^\n+/, ""));
  for (let index = 0; index + 2 < records.length; index += 3) {
    const refname = records[index];
    const sha = records[index + 1];
    const timestamp = Number(records[index + 2]);
    if (!refname.startsWith("refs/remotes/") || !/^[a-f0-9]{40,64}$/i.test(sha)) continue;
    const short = refname.slice("refs/remotes/".length);
    const remote = [...remotes]
      .filter((name) => short.startsWith(`${name}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (!remote) continue;
    const branch = short.slice(remote.length + 1);
    if (branch === "HEAD" || !validRemoteBranch(branch)) continue;
    const key = `${remote}\0${branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      remote,
      branch,
      ref: `${remote}/${branch}`,
      fullRef: refname,
      sha: sha.toLowerCase(),
      updatedAt: Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null,
    });
    if (refs.length >= REMOTE_GIT_REF_LIMIT) break;
  }
  return refs.sort((left, right) =>
    left.remote.localeCompare(right.remote) || left.branch.localeCompare(right.branch));
}

export function selectGitRemoteRef(refs, {
  remote = null,
  branch = null,
  upstream = null,
  currentBranch = null,
} = {}) {
  const values = Array.isArray(refs) ? refs : [];
  if (remote != null && !validRemoteName(remote)) throw inputError("Git 远端名称无效");
  if (branch != null && !validRemoteBranch(branch)) throw inputError("Git 远端分支无效");
  if ((remote == null) !== (branch == null)) throw inputError("必须同时选择 Git 远端和分支");
  if (remote != null) {
    const selected = values.find((entry) => entry.remote === remote && entry.branch === branch);
    if (!selected) throw inputError("所选远端分支不存在于本地跟踪引用");
    return selected;
  }
  const upstreamMatch = typeof upstream === "string"
    ? values.find((entry) => entry.ref === upstream)
    : null;
  if (upstreamMatch) return upstreamMatch;
  const branchMatch = typeof currentBranch === "string"
    ? values.find((entry) => entry.branch === currentBranch)
    : null;
  return branchMatch || values[0] || null;
}

export function parseGitNameStatus(value, { maxFiles = REMOTE_GIT_FILE_LIMIT } = {}) {
  const records = String(value || "").split("\0");
  const files = [];
  for (let index = 0; index < records.length && files.length < maxFiles; index += 1) {
    const rawStatus = records[index];
    if (!rawStatus) continue;
    const status = rawStatus[0]?.toUpperCase();
    if (!status || !/^[ACDMRTUXB]$/.test(status)) continue;
    const firstPath = sanitizeGitPath(records[index + 1]);
    if (!firstPath) break;
    index += 1;
    let oldPath = null;
    let filePath = firstPath;
    if (status === "R" || status === "C") {
      const nextPath = sanitizeGitPath(records[index + 1]);
      if (!nextPath) break;
      index += 1;
      oldPath = firstPath;
      filePath = nextPath;
    }
    files.push({
      path: filePath,
      oldPath,
      status,
      statusDetail: rawStatus.slice(0, 16),
      conflict: status === "U",
      binary: false,
      additions: 0,
      deletions: 0,
      diff: "",
      truncated: false,
    });
  }
  return {
    files,
    truncated: records.some(Boolean) && files.length >= maxFiles,
  };
}

export function applyGitNumstat(files, value) {
  const byPath = new Map((Array.isArray(files) ? files : []).map((file) => [file.path, file]));
  const records = String(value || "").split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const match = record.match(/^([0-9-]+)\t([0-9-]+)\t(.*)$/s);
    if (!match) continue;
    let filePath = match[3];
    if (!filePath) {
      const oldPath = records[index + 1];
      const newPath = records[index + 2];
      if (!oldPath || !newPath) continue;
      filePath = newPath;
      index += 2;
    }
    const sanitized = sanitizeGitPath(filePath);
    const file = sanitized ? byPath.get(sanitized) : null;
    if (!file) continue;
    file.binary = match[1] === "-" || match[2] === "-";
    file.additions = file.binary ? null : boundedCount(match[1]);
    file.deletions = file.binary ? null : boundedCount(match[2]);
  }
  return files;
}

export function buildGitRemoteDiffFiles(rawDiff, metadata, {
  maxTotalBytes = REMOTE_GIT_TOTAL_DIFF_BYTES,
  maxFileBytes = REMOTE_GIT_FILE_DIFF_BYTES,
} = {}) {
  const files = Array.isArray(metadata?.files) ? metadata.files.map((file) => ({ ...file })) : [];
  const chunks = splitUnifiedDiff(rawDiff);
  let remaining = Math.max(0, Number(maxTotalBytes) || 0);
  let redactions = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const chunk = chunks[index] || "";
    const binary = file.binary || /\bBinary files .+ differ\b|^GIT binary patch$/m.test(chunk);
    file.binary = binary;
    if (binary || !chunk || remaining < 1) {
      file.diff = "";
      file.truncated = Boolean(chunk && !binary);
      continue;
    }
    const sanitized = redactGitDiffSecrets(chunk);
    redactions += sanitized.redactions;
    const fileLimit = Math.min(remaining, Math.max(0, Number(maxFileBytes) || 0));
    const bounded = truncateUtf8(sanitized.value, fileLimit);
    file.diff = bounded.value;
    file.truncated = bounded.truncated;
    remaining -= Buffer.byteLength(file.diff, "utf8");
  }
  return {
    files,
    redactions,
    truncated: metadata?.truncated === true
      || chunks.length > files.length
      || files.some((file) => file.truncated),
    omittedFileCount: Math.max(0, chunks.length - files.length),
  };
}

export function redactGitDiffSecrets(value) {
  let output = String(value || "");
  let redactions = 0;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, (...args) => {
      redactions += 1;
      if (typeof replacement === "string" && replacement.includes("$")) {
        return replacement.replace(/\$(\d+)/g, (_, index) => args[Number(index)] || "");
      }
      return replacement;
    });
  }
  return { value: output, redactions };
}

export function gitRemoteRelation(ahead, behind) {
  const safeAhead = boundedCount(ahead);
  const safeBehind = boundedCount(behind);
  if (safeAhead > 0 && safeBehind > 0) return "diverged";
  if (safeAhead > 0) return "ahead";
  if (safeBehind > 0) return "behind";
  return "synced";
}

export function nativeGitDiffIsSafe(files) {
  const values = Array.isArray(files) ? files : [];
  if (values.length > REMOTE_GIT_FILE_LIMIT) return false;
  const changedLines = values.reduce((total, file) =>
    total + (Number(file.additions) || 0) + (Number(file.deletions) || 0), 0);
  return changedLines <= REMOTE_GIT_NATIVE_LINE_LIMIT;
}

function splitUnifiedDiff(value) {
  const normalized = String(value || "").replace(/\r\n?/g, "\n");
  if (!normalized) return [];
  const starts = [...normalized.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (!starts.length) return normalized.trim() ? [normalized] : [];
  return starts.map((start, index) => normalized.slice(start, starts[index + 1] ?? normalized.length));
}

function sanitizeGitPath(value) {
  const path = typeof value === "string" && value && !value.includes("\0")
    ? value.slice(0, 4_096)
    : null;
  return path ? redactGitDiffSecrets(path).value : null;
}

function validRemoteName(value) {
  return typeof value === "string" && REMOTE_NAME_PATTERN.test(value) && !value.endsWith(".lock");
}

function validRemoteBranch(value) {
  return typeof value === "string" && REMOTE_BRANCH_PATTERN.test(value) && !value.endsWith(".lock");
}

function boundedCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, 1_000_000_000) : 0;
}

function truncateUtf8(value, maxBytes) {
  const input = Buffer.from(String(value || ""), "utf8");
  if (input.length <= maxBytes) return { value: input.toString("utf8"), truncated: false };
  if (maxBytes < 1) return { value: "", truncated: input.length > 0 };
  let end = maxBytes;
  while (end > 0 && (input[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { value: input.subarray(0, end).toString("utf8"), truncated: true };
}

function inputError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
