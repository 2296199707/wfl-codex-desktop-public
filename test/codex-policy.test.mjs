import assert from "node:assert/strict";
import test from "node:test";
import {
  assertManagedPolicyValue,
  collaborationModeFromPreset,
  normalizePermissionProfileListParams,
  sanitizeCollaborationModeListResult,
  sanitizeConfigRequirementsResult,
  sanitizePermissionProfileListResult,
  stripCollaborationStrategyUserPrefix,
} from "../lib/codex-policy.mjs";

test("legacy collaboration prefixes are stripped only for historical transcripts", () => {
  const legacy = [
    '<wfl_collaboration_preference strategy="adaptive">',
    "legacy server-owned preference",
    "</wfl_collaboration_preference>",
    "",
    "Do not use subagents for this task.",
  ].join("\n");
  assert.deepEqual(stripCollaborationStrategyUserPrefix(legacy), {
    text: "Do not use subagents for this task.",
    strategy: "legacy",
  });
  assert.deepEqual(stripCollaborationStrategyUserPrefix("ordinary task"), {
    text: "ordinary task",
    strategy: "off",
  });
});

test("normalizes permission profile pagination and rejects hidden parameters", () => {
  assert.deepEqual(
    normalizePermissionProfileListParams({ cursor: "next", limit: 25, cwd: "/srv/project" }),
    { cursor: "next", limit: 25, cwd: "/srv/project" },
  );
  assert.throws(
    () => normalizePermissionProfileListParams({ filePath: "/tmp/requirements.toml" }),
    /未知字段/,
  );
  assert.throws(
    () => normalizePermissionProfileListParams({ limit: 101 }),
    /1 到 100/,
  );
});

test("exposes only bounded policy fields needed by the browser", () => {
  const result = sanitizeConfigRequirementsResult({
    requirements: {
      allowedApprovalPolicies: ["on-request", { granular: { request_permissions: true } }],
      allowedApprovalsReviewers: ["user", "auto_review"],
      allowedSandboxModes: ["read-only", "workspace-write"],
      allowedPermissionProfiles: { ":read-only": true, ":workspace": false },
      defaultPermissions: ":read-only",
      allowedWebSearchModes: ["disabled", "cached"],
      allowManagedHooksOnly: true,
      allowAppshots: false,
      allowRemoteControl: false,
      featureRequirements: { apps: true },
      hooks: { secretCommand: "must-not-reach-browser" },
    },
  });
  assert.deepEqual(result.requirements.allowedApprovalPolicies, ["on-request"]);
  assert.equal(result.requirements.granularApprovalPolicyAllowed, true);
  assert.deepEqual(result.requirements.allowedApprovalsReviewers, ["user", "auto_review"]);
  assert.deepEqual(result.requirements.allowedPermissionProfiles, {
    ":read-only": true,
    ":workspace": false,
  });
  assert.equal(JSON.stringify(result).includes("secretCommand"), false);
});

test("sanitizes official permission and collaboration lists", () => {
  assert.deepEqual(sanitizePermissionProfileListResult({
    data: [{ id: ":workspace", description: "Workspace access", allowed: true }],
    nextCursor: null,
  }), {
    data: [{ id: ":workspace", description: "Workspace access", allowed: true }],
    nextCursor: null,
  });
  const modes = sanitizeCollaborationModeListResult({
    data: [{
      name: "default-collab",
      mode: "default",
      model: "gpt-test",
      reasoning_effort: "ultra",
    }],
  });
  assert.deepEqual(collaborationModeFromPreset(modes.data[0], {
    model: "gpt-current",
    reasoningEffort: "high",
  }), {
    mode: "default",
    settings: {
      model: "gpt-test",
      reasoning_effort: "ultra",
      developer_instructions: null,
    },
  });
  const inherited = sanitizeCollaborationModeListResult({
    data: [{ name: "plan", mode: "plan", model: null, reasoning_effort: null }],
  });
  assert.deepEqual(collaborationModeFromPreset(inherited.data[0], {
    model: "gpt-current",
    reasoningEffort: "high",
  }), {
    mode: "plan",
    settings: {
      model: "gpt-current",
      reasoning_effort: "high",
      developer_instructions: null,
    },
  });
  assert.throws(
    () => collaborationModeFromPreset(inherited.data[0]),
    /模型不能为空/,
  );
  assert.throws(
    () => sanitizeCollaborationModeListResult({
      data: [{ name: "unsafe", mode: "root", model: null, reasoning_effort: null }],
    }),
    /协作模式无效/,
  );
});

test("managed policy enforcement rejects disabled browser selections", () => {
  const requirements = {
    allowedApprovalPolicies: ["on-request"],
    allowedApprovalsReviewers: ["user"],
    allowedSandboxModes: ["read-only"],
    allowedPermissionProfiles: { ":read-only": true, ":workspace": false },
    allowedWebSearchModes: ["disabled"],
  };
  const profiles = [
    { id: ":read-only", allowed: true },
    { id: ":workspace", allowed: false },
  ];
  assert.doesNotThrow(() =>
    assertManagedPolicyValue("default_permissions", ":read-only", requirements, profiles));
  assert.throws(
    () => assertManagedPolicyValue("sandbox_mode", "danger-full-access", requirements),
    /管理员策略禁用/,
  );
  assert.throws(
    () => assertManagedPolicyValue("approvals_reviewer", "auto_review", requirements),
    /管理员策略禁用/,
  );
  assert.throws(
    () => assertManagedPolicyValue("default_permissions", ":workspace", requirements, profiles),
    /不可用|禁用/,
  );
});
