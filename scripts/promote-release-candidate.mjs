import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireOperationLock } from "../lib/operation-lock.mjs";
import { ReleaseCandidateStore } from "../lib/release-candidate-store.mjs";
import { ReleaseStatusStore } from "../lib/release-status.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.resolve(process.env.CODEX_DESKTOP_SOURCE_DIR || path.dirname(scriptDirectory));
const stateDirectory = path.resolve(
  process.env.CODEX_DESKTOP_STATE_DIR || path.join(sourceDirectory, ".codex-desktop"),
);
const runtimeDirectory = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(sourceDirectory, ".codex-runtime"),
);
const candidateId = optionValue("--candidate-id");
const promotedBy = optionValue("--promoted-by");
const candidateStore = new ReleaseCandidateStore(stateDirectory);
const releaseStatusStore = new ReleaseStatusStore(stateDirectory);
const lock = await acquireOperationLock(path.join(runtimeDirectory, "candidate-promotion.lock"), {
  operationId: candidateId,
  ownerCommand: "scripts/promote-release-candidate.mjs",
  acceptedCommands: ["scripts/promote-release-candidate.mjs"],
  conflictMessage: "Another candidate promotion is already running",
});
let localTagCreated = false;
let candidate = null;

try {
  candidate = await candidateStore.current();
  if (!candidate || candidate.id !== candidateId || candidate.phase !== "promoting") {
    throw new Error("Release candidate is no longer ready for promotion");
  }
  assertPromotableCandidate(candidate);
  await verifyCandidateDeployment(candidate);
  await verifyCandidateSource(candidate);
  const remoteRefs = await verifyRemoteRefs(candidate);

  const tag = `v${candidate.version}`;
  if (!await localTagCommit(candidate.version, candidate.commitSha)) {
    await run("git", [
      "tag",
      "--annotate",
      tag,
      "--message",
      `WFL Codex Desktop ${tag}`,
      candidate.commitSha,
    ]);
    localTagCreated = true;
  }
  if (!remoteRefs.alreadyPublished) {
    await run("git", [
      "push",
      "--atomic",
      "origin",
      `refs/tags/${tag}:refs/tags/${tag}`,
      `${candidate.commitSha}:refs/heads/stable`,
    ]);
  }
  await verifyPublishedRefs(candidate);
  const completedAt = Date.now();
  const stable = await candidateStore.update(candidate.id, {
    phase: "stable",
    detail: `${tag} 已提升为正式稳定版本`,
    promotedBy,
    completedAt,
    error: null,
  }, { expectedPhases: ["promoting"] });
  console.log(JSON.stringify({
    ok: true,
    candidateId: stable.id,
    version: stable.version,
    commitSha: stable.commitSha,
    status: stable.status,
  }));
} catch (error) {
  if (localTagCreated && candidate) {
    const remoteTag = await remoteTagCommit(candidate.version).catch(() => null);
    if (!remoteTag) await run("git", ["tag", "--delete", `v${candidate.version}`], { allowFailure: true });
  }
  if (candidate?.id) {
    await candidateStore.update(candidate.id, {
      phase: "awaiting-approval",
      detail: "正式提升未完成，稳定通道保持不变",
      completedAt: null,
      error: error.message,
    }, { expectedPhases: ["promoting"] }).catch(() => {});
  }
  throw error;
} finally {
  await lock.release();
}

function assertPromotableCandidate(value) {
  if (!value.actualValidationConfirmed || !value.actualValidationConfirmedAt || !value.actualValidationConfirmedBy) {
    throw new Error("Actual candidate validation has not been confirmed");
  }
  for (const name of ["fullSuite", "browser", "deployment"]) {
    if (value.checks?.[name]?.status !== "passed" || !value.checks[name].completedAt) {
      throw new Error(`Candidate ${name} verification has not passed`);
    }
  }
}

async function verifyCandidateDeployment(value) {
  const release = await releaseStatusStore.read();
  if (
    release.status !== "completed"
    || release.version !== value.version
    || release.candidateId !== value.id
    || release.commitSha !== value.commitSha
    || release.treeHash !== value.treeHash
  ) {
    throw new Error("Completed deployment does not match the candidate source identity");
  }
}

async function verifyCandidateSource(value) {
  const status = (await capture("git", ["status", "--porcelain", "--untracked-files=all"])).trim();
  if (status) throw new Error("Candidate source has changed since verification");
  const [head, tree, upstream] = await Promise.all([
    capture("git", ["rev-parse", "HEAD"]).then((output) => output.trim()),
    capture("git", ["rev-parse", "HEAD^{tree}"]).then((output) => output.trim()),
    capture("git", ["rev-parse", "@{upstream}"]).then((output) => output.trim()),
  ]);
  if (head !== value.commitSha || tree !== value.treeHash) {
    throw new Error("Candidate source identity changed after testing");
  }
  if (upstream !== value.commitSha) throw new Error("Candidate commit is no longer the pushed upstream commit");
}

async function verifyRemoteRefs(value) {
  const remoteTag = await remoteTagCommit(value.version);
  if (remoteTag && remoteTag !== value.commitSha) {
    throw new Error(`Remote tag v${value.version} already exists for another commit`);
  }
  const stableCommit = await remoteStableCommit();
  if (stableCommit === value.commitSha && remoteTag === value.commitSha) {
    return { alreadyPublished: true };
  }
  if (stableCommit && !await commandSucceeds("git", ["merge-base", "--is-ancestor", stableCommit, value.commitSha])) {
    throw new Error("Candidate commit cannot fast-forward the stable branch");
  }
  return { alreadyPublished: false };
}

async function localTagCommit(version, expectedCommit) {
  try {
    const output = await capture("git", ["rev-parse", `refs/tags/v${version}^{commit}`]);
    const commit = output.trim().toLowerCase();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) throw new Error("invalid local tag");
    if (commit !== expectedCommit) {
      throw new Error(`Local tag v${version} already exists for another commit`);
    }
    return commit;
  } catch (error) {
    if (/already exists for another commit/.test(error.message)) throw error;
    return null;
  }
}

async function verifyPublishedRefs(value) {
  const [stableCommit, tagCommit] = await Promise.all([
    remoteStableCommit(),
    remoteTagCommit(value.version),
  ]);
  if (stableCommit !== value.commitSha || tagCommit !== value.commitSha) {
    throw new Error("Remote stable branch or release tag does not match the promoted candidate");
  }
}

async function remoteStableCommit() {
  const output = await capture("git", ["ls-remote", "--heads", "origin", "refs/heads/stable"]);
  return remoteRefHash(output, "refs/heads/stable");
}

async function remoteTagCommit(version) {
  const ref = `refs/tags/v${version}`;
  const output = await capture("git", ["ls-remote", "origin", ref, `${ref}^{}`]);
  return remoteRefHash(output, `${ref}^{}`) || remoteRefHash(output, ref);
}

function remoteRefHash(output, expectedRef) {
  for (const line of String(output || "").split(/\r?\n/)) {
    const [hash, ref] = line.trim().split(/\s+/, 2);
    if (ref === expectedRef && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(hash)) return hash.toLowerCase();
  }
  return null;
}

function run(command, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: sourceDirectory, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output = `${output}${chunk}`.slice(-8_000)));
    child.stderr.on("data", (chunk) => (output = `${output}${chunk}`.slice(-8_000)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 || allowFailure) resolve(output);
      else reject(new Error(output.trim() || `${command} ${args.join(" ")} exited with status ${code}`));
    });
  });
}

function capture(command, args) {
  return run(command, args);
}

function commandSucceeds(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: sourceDirectory, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}
