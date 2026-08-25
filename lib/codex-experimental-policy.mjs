const THREAD_EXPERIMENTAL_FIELDS = Object.freeze({
  "thread/start": new Map([
    ["dynamicTools", "Codex 动态工具默认关闭，当前服务器尚未配置受信任的服务端执行器"],
    ["environments", "Codex 执行环境尚未开放，必须先由管理员在服务端绑定隔离凭据"],
    ["selectedCapabilityRoots", "浏览器不能直接选择实验能力根目录"],
    ["experimentalRawEvents", "浏览器不能启用 Codex 原始实验事件"],
    ["mockExperimentalField", "浏览器不能提交 Codex 测试实验字段"],
  ]),
  "turn/start": new Map([
    ["environments", "Codex 执行环境尚未开放，必须先由管理员在服务端绑定隔离凭据"],
  ]),
});

export const CODEX_EXPERIMENTAL_CAPABILITY_POLICY = Object.freeze({
  executionEnvironments: Object.freeze({
    enabled: false,
    defaultEnabled: false,
    administratorRequired: true,
    isolation: "per-user-app-server",
    credentialSurface: "server-only",
  }),
  dynamicTools: Object.freeze({
    enabled: false,
    defaultEnabled: false,
    administratorRequired: true,
    permission: "codexDynamicTools",
    schemaLimitBytes: 128 * 1024,
    callTimeoutMs: 30_000,
    outputLimitBytes: 256 * 1024,
    maximumTools: 64,
  }),
  guardianOverride: Object.freeze({
    enabled: false,
    defaultEnabled: false,
    browserMode: "read-only",
    reason: "upstream-event-schema-unstable",
  }),
  elicitationCounter: Object.freeze({
    enabled: false,
    reason: "native-app-server-requests-are-in-band",
  }),
});

export function assertCodexExperimentalBrowserParams(method, params) {
  const fields = THREAD_EXPERIMENTAL_FIELDS[method];
  if (!fields || !params || typeof params !== "object" || Array.isArray(params)) return;
  for (const [field, message] of fields) {
    if (!Object.hasOwn(params, field)) continue;
    throw new Error(message);
  }
}

export function codexExperimentalCapabilityPolicySnapshot() {
  return structuredClone(CODEX_EXPERIMENTAL_CAPABILITY_POLICY);
}
