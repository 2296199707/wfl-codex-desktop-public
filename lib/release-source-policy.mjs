export function assertStableReleaseIdentity({
  version,
  head,
  tagCommit,
  precheckedCommit,
  remoteStableCommit,
}) {
  if (head !== tagCommit) {
    throw new Error(`HEAD is not tagged as v${version}`);
  }
  if (!precheckedCommit || head !== precheckedCommit) {
    throw new Error("Stable release commit changed after remote verification");
  }
  if (!remoteStableCommit || head !== remoteStableCommit) {
    throw new Error("Stable release commit does not match origin/stable");
  }
  return head;
}
