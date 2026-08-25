const RELEASE_REFERENCE = /wfl-codex-desktop-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+?)?(?=\.tar\.gz(?:\.sha256)?(?:[\s/`]|$)|[\s/`]|$)/g;

export function versionReleaseReferences(source, version) {
  const target = String(version || "").trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(target)) {
    throw new Error("Release reference version is invalid");
  }
  return String(source).replace(RELEASE_REFERENCE, `wfl-codex-desktop-v${target}`);
}
