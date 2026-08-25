import { AppUpdateStatusStore } from "./app-update-status.mjs";
import { CodexUpdateStatusStore } from "./codex-update-status.mjs";
import { deploymentOperationKind } from "./deployment-operation.mjs";
import { ReleaseStatusStore } from "./release-status.mjs";
import { RollbackStatusStore } from "./rollback-status.mjs";

export function deploymentRecoveryStatusIsTerminal(status, operationId, startedAt = 0) {
  return status?.unit === operationId
    && (status.status === "completed" || status.status === "failed")
    && (status.recoveryOutcome === "old" || status.recoveryOutcome === "candidate")
    && Number.isFinite(status.recoveryReconciledAt)
    && status.recoveryReconciledAt >= startedAt;
}

export async function reconcileDeploymentRecoveryStatus({
  stateDirectory,
  operationId,
  version = null,
  outcome = "failed",
  selectedPort = null,
  error = null,
  detail = null,
} = {}) {
  const kind = deploymentOperationKind(operationId);
  if (!kind || !stateDirectory || typeof operationId !== "string") {
    return { updated: false, reason: "unsupported-operation" };
  }

  const store = statusStoreFor(kind, stateDirectory);
  const current = await store.read();
  // A recovery service can run after a new operation has already been queued.
  // The operation ID is the fencing key for the public status file; never let
  // an old recovery worker overwrite the newer operation's progress.
  if (current.unit !== operationId) {
    return { updated: false, reason: "status-owned-by-another-operation", kind };
  }
  // Candidate takeover is terminal. A slower watchdog or systemd OnFailure
  // invocation must not downgrade a completed recovery to failed. A failed
  // recovery remains retryable while its prepared manifest is present, so a
  // later successful attempt may still upgrade that state to completed.
  if (current.status === "completed" && current.recoveryOutcome === "candidate") {
    return { updated: false, reason: "recovery-already-completed", kind, status: current };
  }

  const candidateRecovered = outcome === "candidate" || outcome === "completed";
  const portText = Number.isInteger(selectedPort) ? `（后端 ${selectedPort}）` : "";
  const normalizedVersion = typeof version === "string" && version ? version : null;
  const fallbackDetail = candidateRecovered
    ? `中断恢复已接管健康候选${portText}${normalizedVersion ? `，v${normalizedVersion} 已完成切换` : "，发布已完成"}`
    : `更新未完成，已自动恢复旧后端${portText}；可以安全重试`;
  const publicError = typeof error === "string" && error.trim()
    ? error.replace(/[\r\n]+/g, " ").trim().slice(0, 500)
    : null;
  const update = candidateRecovered
    ? completedUpdate(kind, operationId, normalizedVersion, detail || fallbackDetail)
    : failedUpdate(kind, operationId, detail || fallbackDetail, publicError);
  return {
    updated: true,
    kind,
    status: await store.write(update),
  };
}

function statusStoreFor(kind, stateDirectory) {
  switch (kind) {
    case "release": return new ReleaseStatusStore(stateDirectory);
    case "app-update": return new AppUpdateStatusStore(stateDirectory);
    case "codex-update": return new CodexUpdateStatusStore(stateDirectory);
    case "rollback": return new RollbackStatusStore(stateDirectory);
    default: throw new Error(`Unsupported deployment operation kind: ${kind}`);
  }
}

function completedUpdate(kind, operationId, version, detail) {
  const common = {
    status: "completed",
    phase: "completed",
    unit: operationId,
    completedAt: Date.now(),
    detail,
    error: null,
    recoveryOutcome: "candidate",
    recoveryReconciledAt: Date.now(),
  };
  if (kind === "release") return { ...common, ...(version ? { version } : {}) };
  if (kind === "app-update") {
    return {
      ...common,
      ...(version ? { targetVersion: version, runningVersion: version, currentVersion: version } : {}),
    };
  }
  if (kind === "rollback") return { ...common, ...(version ? { targetVersion: version } : {}) };
  return common;
}

function failedUpdate(kind, operationId, detail, error) {
  const common = {
    status: "failed",
    phase: "failed",
    unit: operationId,
    completedAt: Date.now(),
    detail,
    recoveryOutcome: "old",
    recoveryReconciledAt: Date.now(),
    ...(error ? { error } : {}),
  };
  return common;
}
