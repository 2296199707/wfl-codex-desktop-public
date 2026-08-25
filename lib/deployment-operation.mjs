const DEPLOYMENT_OPERATION_PATTERN = /^wfl-codex-(?:release-v[0-9A-Za-z-]+-\d+|rollback-v[0-9A-Za-z-]+-\d+|app-update-\d+|update(?:-decision)?-\d+)(?:-[0-9a-f]{8})?$/;

export function deploymentOperationUnit(operationId) {
  if (!DEPLOYMENT_OPERATION_PATTERN.test(String(operationId || ""))) return null;
  return `${operationId}.service`;
}

export function deploymentOperationKind(operationId) {
  const value = String(operationId || "");
  if (/^wfl-codex-release-/.test(value)) return "release";
  if (/^wfl-codex-rollback-/.test(value)) return "rollback";
  if (/^wfl-codex-app-update-/.test(value)) return "app-update";
  if (/^wfl-codex-update(?:-decision)?-/.test(value)) return "codex-update";
  return null;
}

export function validDeploymentOperationId(operationId) {
  return typeof operationId === "string"
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(operationId);
}
