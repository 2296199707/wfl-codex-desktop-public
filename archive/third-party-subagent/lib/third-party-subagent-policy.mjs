import path from "node:path";

const CODEX_SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const CODEX_APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);

export function thirdPartySubagentApprovalPolicy(value) {
  if (value === "never") return "never";
  if (value === "ask") return "ask";
  if (typeof value === "string" && CODEX_APPROVAL_POLICIES.has(value)) return "ask";
  // Codex 0.147 can return granular approval policies. The Harness adapter
  // only has `ask`/`never`; mapping a valid granular policy to `ask` is the
  // safe direction and never grants an approval the parent did not grant.
  if (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.granular
    && typeof value.granular === "object"
    && !Array.isArray(value.granular)
  ) return "ask";
  return null;
}

export function codexSandboxModeForThirdPartySubagent(policy) {
  if (CODEX_SANDBOX_MODES.has(policy)) return policy;
  const type = typeof policy?.type === "string" ? policy.type : "";
  return {
    readOnly: "read-only",
    workspaceWrite: "workspace-write",
    dangerFullAccess: "danger-full-access",
  }[type] || null;
}

export function thirdPartySubagentWorkspaceRootsFit(cwd, runtimeRoots, writableRoots) {
  if (!cwd || !path.isAbsolute(cwd)) return false;
  if (runtimeRoots !== undefined && !Array.isArray(runtimeRoots)) return false;
  if (writableRoots !== undefined && !Array.isArray(writableRoots)) return false;
  const roots = [
    ...(Array.isArray(runtimeRoots) ? runtimeRoots : []),
    ...(Array.isArray(writableRoots) ? writableRoots : []),
  ];
  for (const root of roots) {
    if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== path.resolve(cwd)) {
      return false;
    }
  }
  return true;
}

export function codexThirdPartySubagentContextFromPolicy(value, fallbackCwd = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const settings = value.threadSettings && typeof value.threadSettings === "object"
    ? value.threadSettings
    : value;
  const thread = value.thread && typeof value.thread === "object" ? value.thread : null;
  const cwdValue = settings.cwd || value.cwd || thread?.cwd || fallbackCwd;
  const cwd = typeof cwdValue === "string" && path.isAbsolute(cwdValue)
    ? path.resolve(cwdValue)
    : null;
  const policy = settings.sandboxPolicy
    ?? settings.sandbox
    ?? value.sandbox
    ?? thread?.sandbox
    ?? null;
  const approvalValue = settings.approvalPolicy
    ?? value.approvalPolicy
    ?? thread?.approvalPolicy
    ?? null;
  const hasPolicy = Boolean(
    policy
    || Object.hasOwn(settings, "sandboxPolicy")
    || Object.hasOwn(settings, "sandbox")
    || Object.hasOwn(value, "sandbox")
    || Object.hasOwn(thread || {}, "sandbox")
    || Object.hasOwn(settings, "approvalPolicy")
    || Object.hasOwn(value, "approvalPolicy")
    || Object.hasOwn(thread || {}, "approvalPolicy"),
  );
  if (!hasPolicy) return null;

  const sandboxMode = codexSandboxModeForThirdPartySubagent(policy);
  const approvalPolicy = thirdPartySubagentApprovalPolicy(approvalValue);
  const runtimeRoots = settings.runtimeWorkspaceRoots ?? value.runtimeWorkspaceRoots;
  const unsupportedWorkspaceRoots = sandboxMode === "workspace-write"
    && !thirdPartySubagentWorkspaceRootsFit(cwd, runtimeRoots, policy?.writableRoots);
  if (!cwd || !sandboxMode || !approvalPolicy || unsupportedWorkspaceRoots) {
    return {
      cwd,
      sandboxMode: unsupportedWorkspaceRoots ? null : sandboxMode,
      approvalPolicy,
      unsupported: true,
    };
  }
  return { cwd, sandboxMode, approvalPolicy };
}

export function normalizeStoredThirdPartySubagentContext(value) {
  const cwd = typeof value?.cwd === "string" && path.isAbsolute(value.cwd)
    ? path.resolve(value.cwd)
    : null;
  const sandboxMode = String(value?.sandboxMode || "");
  const approvalPolicy = String(value?.approvalPolicy || "");
  if (!cwd || !CODEX_SANDBOX_MODES.has(sandboxMode) || !["ask", "never"].includes(approvalPolicy)) {
    return null;
  }
  return { cwd, sandboxMode, approvalPolicy };
}
