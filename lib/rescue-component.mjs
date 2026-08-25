// The rescue window is shipped with the primary release, but it has its own
// operator-facing component identity so it can be updated independently.
export const RESCUE_COMPONENT_VERSION = "1.1.16";
export const RESCUE_COMPONENT_LABEL = "1.1.16备用窗口";

export function rescueVersionFromManifest(manifest, packageVersion = null) {
  const value = typeof manifest?.rescueVersion === "string"
    ? manifest.rescueVersion.trim()
    : "";
  return value || packageVersion || RESCUE_COMPONENT_VERSION;
}

export function compareRescueVersions(left, right) {
  const leftParts = parseRescueVersion(left);
  const rightParts = parseRescueVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts.core[index] !== rightParts.core[index]) {
      return leftParts.core[index] > rightParts.core[index] ? 1 : -1;
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
    if (leftNumeric && rightNumeric) return Number(leftValue) > Number(rightValue) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftValue > rightValue ? 1 : -1;
  }
  return 0;
}

export function rescueVersionIsNewer(candidate, current) {
  return compareRescueVersions(candidate, current) > 0;
}

function parseRescueVersion(value) {
  const match = String(value || "").trim().match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/,
  );
  if (!match) throw new Error("Rescue component version must use semantic versioning");
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}
