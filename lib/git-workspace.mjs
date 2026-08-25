const BRANCH_PATTERN = /^(?![./])(?!.*(?:\.\.|\/\/|@\{|[~^:?*\[\]\\\s]))(?!.*[/.]$)[A-Za-z0-9._/-]{1,200}$/;

export function parseGitStatusPorcelain(value) {
  const records = String(value || "").split("\0");
  const snapshot = {
    repository: true,
    branch: null,
    detached: false,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    files: [],
  };
  const files = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# branch.oid ")) {
      snapshot.oid = nullIfInitial(record.slice(13));
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const head = record.slice(14);
      snapshot.detached = head === "(detached)";
      snapshot.branch = snapshot.detached ? null : head;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      snapshot.upstream = record.slice(18) || null;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = record.match(/\+(\d+)\s+-(\d+)/);
      snapshot.ahead = Number(match?.[1] || 0);
      snapshot.behind = Number(match?.[2] || 0);
      continue;
    }
    if (record.startsWith("? ")) {
      rememberFile(files, record.slice(2), {
        path: record.slice(2),
        indexStatus: "?",
        worktreeStatus: "?",
        staged: false,
        unstaged: false,
        untracked: true,
      });
      continue;
    }
    if (record.startsWith("1 ")) {
      const match = record.match(/^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s);
      if (match) rememberTrackedFile(files, match[2], match[1]);
      continue;
    }
    if (record.startsWith("2 ")) {
      const match = record.match(/^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s);
      const originalPath = records[index + 1] || null;
      if (originalPath) index += 1;
      if (match) rememberTrackedFile(files, match[2], match[1], originalPath);
      continue;
    }
    if (record.startsWith("u ")) {
      const match = record.match(/^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s);
      if (match) rememberTrackedFile(files, match[2], match[1]);
    }
  }
  snapshot.files = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  snapshot.staged = snapshot.files.filter((file) => file.staged);
  snapshot.unstaged = snapshot.files.filter((file) => file.unstaged);
  snapshot.untracked = snapshot.files.filter((file) => file.untracked);
  return snapshot;
}

export function validateGitRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\0")) {
    throw new Error("Git 文件路径无效");
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Git 文件路径无效");
  }
  return normalized;
}

export function validateGitBranchName(value) {
  const branch = typeof value === "string" ? value.trim() : "";
  if (!BRANCH_PATTERN.test(branch) || branch.endsWith(".lock")) throw new Error("Git 分支名称无效");
  return branch;
}

export function validateGitCommitMessage(value) {
  const message = typeof value === "string" ? value.trim() : "";
  if (!message || message.length > 4_000 || /[\0\r]/.test(message)) throw new Error("提交说明无效");
  return message;
}

export function validateUnifiedPatchPaths(value, expectedPath = null) {
  const patch = typeof value === "string" ? value : "";
  if (!patch || Buffer.byteLength(patch, "utf8") > 1024 * 1024 || patch.includes("\0")) {
    throw new Error("Git 区块补丁无效");
  }
  const paths = [];
  const diffHeaders = [...patch.matchAll(/^diff --git (.+)$/gm)].map((match) => match[1]);
  for (const match of patch.matchAll(/^(?:---|\+\+\+) (.+)$/gm)) {
    const raw = match[1].split("\t", 1)[0];
    if (raw === "/dev/null") continue;
    const withoutPrefix = raw.replace(/^[ab]\//, "");
    paths.push(validateGitRelativePath(withoutPrefix));
  }
  if (!paths.length) throw new Error("Git 区块补丁没有文件路径");
  if (expectedPath) {
    const expected = validateGitRelativePath(expectedPath);
    if (paths.some((filePath) => filePath !== expected)) throw new Error("Git 区块补丁超出所选文件");
    const expectedHeader = `a/${expected} b/${expected}`;
    if (diffHeaders.some((header) => header !== expectedHeader)) {
      throw new Error("Git 区块补丁超出所选文件");
    }
  }
  return patch;
}

function rememberTrackedFile(files, filePath, status, originalPath = null) {
  const indexStatus = status[0];
  const worktreeStatus = status[1];
  rememberFile(files, filePath, {
    path: filePath,
    originalPath,
    indexStatus,
    worktreeStatus,
    staged: indexStatus !== ".",
    unstaged: worktreeStatus !== ".",
    untracked: false,
  });
}

function rememberFile(files, filePath, value) {
  if (!filePath) return;
  files.set(filePath, value);
}

function nullIfInitial(value) {
  return value === "(initial)" ? null : value || null;
}
