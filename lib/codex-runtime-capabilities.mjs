const REVIEWED_CODEX_FEATURE_METHODS = Object.freeze({
  conversationSections: Object.freeze([
    "thread/section/move",
    "threadSection/create",
    "threadSection/delete",
    "threadSection/list",
    "threadSection/update",
  ]),
  pluginSearch: Object.freeze(["plugin/search"]),
  cursorMigration: Object.freeze([
    "externalAgentConfig/detect",
    "externalAgentConfig/import",
    "externalAgentConfig/import/readHistories",
  ]),
});

export function codexRuntimeCapabilities({ version = null, clientRequests = null } = {}) {
  const methods = normalizeMethodSet(clientRequests);
  const known = methods.size > 0;
  const conversationSections = supportsAll(methods, REVIEWED_CODEX_FEATURE_METHODS.conversationSections);
  return Object.freeze({
    version: normalizeCodexRuntimeVersion(version),
    detected: known,
    conversationSections,
    sectionPositionSort: conversationSections,
    pluginSearch: supportsAll(methods, REVIEWED_CODEX_FEATURE_METHODS.pluginSearch),
    cursorMigration: supportsAll(methods, REVIEWED_CODEX_FEATURE_METHODS.cursorMigration),
  });
}

export function codexRuntimeSupports(capabilities, feature) {
  return capabilities?.detected === true && capabilities?.[feature] === true;
}

export function codexRuntimeFeatureMethods() {
  return Object.fromEntries(
    Object.entries(REVIEWED_CODEX_FEATURE_METHODS).map(([feature, methods]) => [feature, [...methods]]),
  );
}

/**
 * Compare official Codex semantic versions without making a release-specific
 * version an installation requirement. The protocol probe remains the source
 * of truth for optional features; this range check only rejects versions older
 * than the first supported app-server baseline.
 */
export function codexVersionAtLeast(value, minimum) {
  const candidate = parseCodexVersion(value);
  const floor = parseCodexVersion(minimum);
  if (!candidate || !floor) return false;
  return compareCodexVersions(candidate, floor) >= 0;
}

function normalizeMethodSet(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((method) => typeof method === "string" && method.length > 0));
}

function supportsAll(methods, required) {
  return methods.size > 0 && required.every((method) => methods.has(method));
}

function normalizeCodexRuntimeVersion(value) {
  const text = String(value || "").trim();
  const match = /(?:^|\/)codex-cli\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/i.exec(text)
    || /(?:^|\/)\d+\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text)
    || /^([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(text);
  return match?.[1] || null;
}

function parseCodexVersion(value) {
  const normalized = normalizeCodexRuntimeVersion(value);
  if (!normalized) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(normalized);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareCodexVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.prerelease.length) return -1;
    if (index >= right.prerelease.length) return 1;
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) - Number(b);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}
