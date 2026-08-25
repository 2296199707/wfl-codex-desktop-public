const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);
const APPROVALS_REVIEWERS = new Set(["user", "auto_review", "guardian_subagent"]);
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const WEB_SEARCH_MODES = new Set(["disabled", "cached", "indexed", "live"]);
const COLLABORATION_MODES = new Set(["plan", "default"]);
export const CODEX_REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const REASONING_EFFORTS = new Set(CODEX_REASONING_EFFORTS);
const MAX_CURSOR_LENGTH = 512;
const MAX_PROFILE_COUNT = 200;
const MAX_REQUIREMENT_ENTRIES = 200;
const MAX_COLLABORATION_MODES = 32;

export function stripCollaborationStrategyUserPrefix(value) {
  const text = String(value || "");
  const match = /^<wfl_collaboration_preference strategy="(?:adaptive|required)">[\s\S]*?<\/wfl_collaboration_preference>\n\n/u.exec(text);
  if (match) return { text: text.slice(match[0].length), strategy: "legacy" };
  return { text, strategy: "off" };
}

export function normalizePermissionProfileListParams(value = {}) {
  assertPlainObject(value, "权限配置列表参数无效");
  const allowed = new Set(["cursor", "limit", "cwd"]);
  assertKnownKeys(value, allowed, "权限配置列表参数包含未知字段");
  const result = {};
  if (value.cursor != null) {
    result.cursor = boundedProtocolString(value.cursor, MAX_CURSOR_LENGTH, "权限配置分页游标无效");
  }
  if (value.limit != null) {
    if (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100) {
      throw new Error("权限配置分页数量必须在 1 到 100 之间");
    }
    result.limit = value.limit;
  }
  if (value.cwd != null) {
    result.cwd = boundedProtocolString(value.cwd, 4_096, "权限配置工作目录无效");
  }
  return result;
}

export function sanitizePermissionProfileListResult(value) {
  assertPlainObject(value, "Codex 权限配置列表响应无效");
  const data = Array.isArray(value.data) ? value.data : [];
  if (data.length > MAX_PROFILE_COUNT) throw new Error("Codex 权限配置列表过大");
  return {
    data: data.map((entry) => sanitizePermissionProfile(entry)),
    nextCursor: value.nextCursor == null
      ? null
      : boundedProtocolString(value.nextCursor, MAX_CURSOR_LENGTH, "Codex 权限配置分页游标无效"),
  };
}

export function sanitizeConfigRequirementsResult(value) {
  assertPlainObject(value, "Codex 管理员策略响应无效");
  if (value.requirements == null) return { requirements: null };
  const requirements = value.requirements;
  assertPlainObject(requirements, "Codex 管理员策略格式无效");
  const approvals = nullableArray(requirements.allowedApprovalPolicies, MAX_REQUIREMENT_ENTRIES);
  return {
    requirements: {
      allowedApprovalPolicies: approvals === null
        ? null
        : approvals.filter((entry) => typeof entry === "string" && APPROVAL_POLICIES.has(entry)),
      granularApprovalPolicyAllowed: approvals?.some((entry) => (
        entry && typeof entry === "object" && !Array.isArray(entry) && entry.granular
      )) === true,
      allowedApprovalsReviewers: sanitizeNullableEnumArray(
        requirements.allowedApprovalsReviewers,
        APPROVALS_REVIEWERS,
        "Codex 管理员审批复核策略无效",
      ),
      allowedSandboxModes: sanitizeNullableEnumArray(
        requirements.allowedSandboxModes,
        SANDBOX_MODES,
        "Codex 管理员沙箱策略无效",
      ),
      allowedPermissionProfiles: sanitizeBooleanRecord(
        requirements.allowedPermissionProfiles,
        "Codex 管理员权限配置策略无效",
      ),
      defaultPermissions: requirements.defaultPermissions == null
        ? null
        : boundedProtocolString(
          requirements.defaultPermissions,
          256,
          "Codex 管理员默认权限配置无效",
        ),
      allowedWebSearchModes: sanitizeNullableEnumArray(
        requirements.allowedWebSearchModes,
        WEB_SEARCH_MODES,
        "Codex 管理员网页搜索策略无效",
      ),
      allowManagedHooksOnly: nullableBoolean(requirements.allowManagedHooksOnly),
      allowAppshots: nullableBoolean(requirements.allowAppshots),
      allowRemoteControl: nullableBoolean(requirements.allowRemoteControl),
      featureRequirements: sanitizeBooleanRecord(
        requirements.featureRequirements,
        "Codex 管理员功能策略无效",
      ),
    },
  };
}

export function sanitizeCollaborationModeListResult(value) {
  assertPlainObject(value, "Codex 协作预设响应无效");
  const data = Array.isArray(value.data) ? value.data : [];
  if (data.length > MAX_COLLABORATION_MODES) throw new Error("Codex 协作预设数量过多");
  return {
    data: data.map((entry) => {
      assertPlainObject(entry, "Codex 协作预设格式无效");
      return {
        name: boundedProtocolString(entry.name, 128, "Codex 协作预设名称无效"),
        mode: entry.mode == null ? null : enumValue(entry.mode, COLLABORATION_MODES, "Codex 协作模式无效"),
        model: entry.model == null
          ? null
          : boundedProtocolString(entry.model, 256, "Codex 协作预设模型无效"),
        reasoning_effort: entry.reasoning_effort == null
          ? null
          : enumValue(entry.reasoning_effort, REASONING_EFFORTS, "Codex 协作推理强度无效"),
      };
    }),
  };
}

export function assertManagedPolicyValue(keyPath, value, requirements, profiles = []) {
  if (keyPath === "default_permissions") {
    if (value == null) {
      if (requirements?.allowedPermissionProfiles != null) {
        throw new Error("管理员已强制权限配置模式，不能切回旧沙箱设置");
      }
      return;
    }
    if (typeof value !== "string" || !value || value.length > 256) {
      throw new Error("默认权限配置无效");
    }
    const listed = profiles.find((profile) => profile.id === value);
    if (!listed || listed.allowed !== true) throw new Error("该权限配置不可用或被管理员禁用");
    const managed = requirements?.allowedPermissionProfiles;
    if (managed != null && managed[value] !== true) {
      throw new Error("该权限配置被管理员策略禁用");
    }
    return;
  }
  if (!requirements) return;
  if (keyPath === "approval_policy" && requirements.allowedApprovalPolicies !== null) {
    if (typeof value !== "string" || !requirements.allowedApprovalPolicies.includes(value)) {
      throw new Error("该批准策略被管理员策略禁用");
    }
  }
  if (keyPath === "approvals_reviewer" && requirements.allowedApprovalsReviewers !== null) {
    if (typeof value !== "string" || !requirements.allowedApprovalsReviewers.includes(value)) {
      throw new Error("该审批复核方式被管理员策略禁用");
    }
  }
  if (keyPath === "sandbox_mode" && requirements.allowedSandboxModes !== null) {
    if (typeof value !== "string" || !requirements.allowedSandboxModes.includes(value)) {
      throw new Error("该沙箱模式被管理员策略禁用");
    }
  }
  if (keyPath === "web_search" && requirements.allowedWebSearchModes !== null) {
    if (typeof value !== "string" || !requirements.allowedWebSearchModes.includes(value)) {
      throw new Error("该网页搜索模式被管理员策略禁用");
    }
  }
}

export function collaborationModeFromPreset(preset, {
  model = null,
  reasoningEffort = null,
} = {}) {
  if (!preset || preset.mode == null) return null;
  const inheritedModel = typeof model === "string" ? model : "";
  if (!preset.model && !inheritedModel.trim()) throw new Error("Codex 协作模型不能为空");
  const effectiveModel = preset.model || boundedProtocolString(
    inheritedModel,
    256,
    "Codex 协作模型无效",
  );
  return {
    mode: preset.mode,
    settings: {
      model: effectiveModel,
      reasoning_effort: preset.reasoning_effort ?? reasoningEffort ?? null,
      developer_instructions: null,
    },
  };
}

function sanitizePermissionProfile(entry) {
  assertPlainObject(entry, "Codex 权限配置格式无效");
  return {
    id: boundedProtocolString(entry.id, 256, "Codex 权限配置标识无效"),
    description: entry.description == null
      ? null
      : boundedProtocolString(entry.description, 2_048, "Codex 权限配置说明无效"),
    allowed: entry.allowed === true,
  };
}

function sanitizeNullableEnumArray(value, allowed, message) {
  const list = nullableArray(value, MAX_REQUIREMENT_ENTRIES);
  if (list === null) return null;
  return [...new Set(list.map((entry) => enumValue(entry, allowed, message)))];
}

function sanitizeBooleanRecord(value, message) {
  if (value == null) return null;
  assertPlainObject(value, message);
  const entries = Object.entries(value);
  if (entries.length > MAX_REQUIREMENT_ENTRIES) throw new Error(message);
  return Object.fromEntries(entries.map(([key, allowed]) => [
    boundedProtocolString(key, 256, message),
    allowed === true,
  ]));
}

function nullableArray(value, limit) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > limit) throw new Error("Codex 管理员策略列表无效");
  return value;
}

function nullableBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function enumValue(value, allowed, message) {
  if (typeof value !== "string" || !allowed.has(value)) throw new Error(message);
  return value;
}

function boundedProtocolString(value, limit, message) {
  if (
    typeof value !== "string"
    || !value
    || value.length > limit
    || /[\r\n\0]/.test(value)
  ) {
    throw new Error(message);
  }
  return value;
}

function assertKnownKeys(value, allowed, message) {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(message);
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
}
