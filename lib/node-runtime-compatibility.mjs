export function parseMinimumNodeEngine(required) {
  const value = String(required || "").trim();
  const match = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
  if (!match) {
    const error = new Error(`目标版本声明了无法识别的 Node.js 要求：${value || "未声明"}`);
    error.code = "ERR_NODE_ENGINE_INVALID";
    throw error;
  }
  return match.slice(1).map((part) => Number(part || 0));
}

export function parseNodeVersion(version = process.versions.node) {
  const value = String(version || "").trim().replace(/^v/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) {
    const error = new Error(`当前 Node.js 版本无法识别：${value || "未知"}`);
    error.code = "ERR_NODE_RUNTIME_INVALID";
    throw error;
  }
  return match.slice(1).map(Number);
}

export function nodeVersionSatisfiesMinimum(current, minimum) {
  for (let index = 0; index < 3; index += 1) {
    if (current[index] === minimum[index]) continue;
    return current[index] > minimum[index];
  }
  return true;
}

export function assertNodeEngineCompatible(required, {
  currentVersion = process.versions.node,
} = {}) {
  const minimum = parseMinimumNodeEngine(required);
  const current = parseNodeVersion(currentVersion);
  if (nodeVersionSatisfiesMinimum(current, minimum)) {
    return { required: String(required).trim(), minimum, current };
  }
  const error = new Error(
    `目标版本需要 Node.js ${minimum.join(".")} 或更高版本；当前为 v${current.join(".")}。旧主站保持运行，请先升级 Node.js 后重试`,
  );
  error.code = "ERR_NODE_RUNTIME_TOO_OLD";
  throw error;
}
