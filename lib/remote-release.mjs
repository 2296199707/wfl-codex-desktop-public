const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export function parseStableVersion(value) {
  const match = String(value || "").match(STABLE_VERSION);
  if (!match) return null;
  return match.slice(1, 4).map(Number);
}

export function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  if (!leftParts || !rightParts) throw new Error("Stable semantic versions are required");
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function compareReleaseVersions(left, right) {
  const leftParts = parseReleaseVersion(left);
  const rightParts = parseReleaseVersion(right);
  if (!leftParts || !rightParts) throw new Error("Semantic release versions are required");
  for (let index = 0; index < leftParts.core.length; index += 1) {
    if (leftParts.core[index] !== rightParts.core[index]) {
      return leftParts.core[index] - rightParts.core[index];
    }
  }
  if (!leftParts.prerelease.length && !rightParts.prerelease.length) return 0;
  if (!leftParts.prerelease.length) return 1;
  if (!rightParts.prerelease.length) return -1;
  const length = Math.max(leftParts.prerelease.length, rightParts.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts.prerelease[index];
    const rightValue = rightParts.prerelease[index];
    if (leftValue === undefined) return -1;
    if (rightValue === undefined) return 1;
    if (leftValue === rightValue) continue;
    const leftNumeric = /^\d+$/.test(leftValue);
    const rightNumeric = /^\d+$/.test(rightValue);
    if (leftNumeric && rightNumeric) return Number(leftValue) - Number(rightValue);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftValue.localeCompare(rightValue);
  }
  return 0;
}

export function releaseVersionRelation(remote, local) {
  if (!parseStableVersion(remote) || !parseReleaseVersion(local)) return "unknown";
  const comparison = compareReleaseVersions(remote, local);
  return comparison > 0 ? "ahead" : comparison < 0 ? "behind" : "equal";
}

export function selectLatestStableTag(values) {
  let selected = null;
  for (const value of values) {
    const tag = String(value || "").trim().replace(/^refs\/tags\//, "");
    const version = tag.startsWith("v") ? tag.slice(1) : null;
    if (!parseStableVersion(version)) continue;
    if (!selected || compareStableVersions(version, selected.version) > 0) {
      selected = { tag: `v${version}`, version };
    }
  }
  return selected;
}

export function parseRemoteTagRefs(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/, 2)[1])
    .filter((ref) => ref?.startsWith("refs/tags/") && !ref.endsWith("^{}"));
}

export function parseRemoteStableChannel(output) {
  let stableCommit = null;
  const tags = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const [hash, ref] = line.trim().split(/\s+/, 2);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(hash || "") || !ref) continue;
    if (ref === "refs/heads/stable") {
      stableCommit = hash.toLowerCase();
      continue;
    }
    const match = ref.match(/^refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/);
    if (!match) continue;
    const current = tags.get(match[1]) || {};
    if (match[2]) current.commitSha = hash.toLowerCase();
    else current.refHash = hash.toLowerCase();
    tags.set(match[1], current);
  }
  const latest = selectLatestStableTag(tags.keys());
  if (!stableCommit || !latest) return null;
  const tag = tags.get(latest.tag);
  const commitSha = tag?.commitSha || tag?.refHash || null;
  if (commitSha !== stableCommit) return null;
  return { ...latest, commitSha, stableCommit };
}

export function isNewerStableVersion(candidate, current) {
  return releaseVersionRelation(candidate, current) === "ahead";
}

function parseReleaseVersion(value) {
  const match = String(value || "").match(RELEASE_VERSION);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}
