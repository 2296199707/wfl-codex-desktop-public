export function calculateOpsHealth({ services = {}, traffic = {}, resources = {}, network = {} } = {}) {
  const components = [
    component("gateway", "入口网关", 20, serviceScore(services.gateway?.status)),
    component("codex", "Codex Runtime", 20, serviceScore(services.codex?.status)),
    component("api", "网页请求", 15, successScore(traffic.successRate)),
    component("turns", "对话任务", 10, errorRatioScore(traffic.turns, traffic.turnErrors)),
    component("latency", "响应延迟", 10, latencyScore(traffic.p95LatencyMs)),
    component("memory", "内存", 10, usageScore(resources.memory?.percent, 75, 92)),
    component("disk", "磁盘", 10, usageScore(resources.disk?.percent, 75, 92)),
    component("network", "网络稳定性", 5, networkScore(network)),
  ];
  let score = Math.round(components.reduce((sum, entry) => sum + entry.score, 0));
  const caps = [];
  if (services.gateway?.status === "offline") caps.push({ value: 35, reason: "入口网关离线" });
  if (services.codex?.status === "offline") caps.push({ value: 45, reason: "Codex Runtime 离线" });
  if (Number(resources.disk?.percent) >= 97) caps.push({ value: 40, reason: "磁盘空间严重不足" });
  for (const cap of caps) score = Math.min(score, cap.value);
  const deductions = components
    .filter((entry) => entry.score < entry.weight)
    .map((entry) => ({ id: entry.id, label: entry.label, points: entry.weight - entry.score }));
  return {
    score,
    status: score >= 90 ? "healthy" : score >= 70 ? "degraded" : "critical",
    components,
    deductions,
    caps,
  };
}

function component(id, label, weight, ratio) {
  return { id, label, weight, score: Math.round(weight * Math.max(0, Math.min(1, ratio))) };
}

function serviceScore(status) {
  return status === "healthy" || status === "direct" ? 1 : status === "degraded" ? 0.5 : 0;
}

function successScore(value) {
  if (value === null || value === undefined) return 1;
  if (value >= 99) return 1;
  if (value <= 80) return 0;
  return (value - 80) / 19;
}

function errorRatioScore(total, errors) {
  if (!Number(total)) return 1;
  const rate = Math.max(0, Number(errors) || 0) / Number(total);
  if (rate <= 0.01) return 1;
  if (rate >= 0.25) return 0;
  return 1 - ((rate - 0.01) / 0.24);
}

function latencyScore(value) {
  if (value === null || value === undefined) return 1;
  if (value <= 500) return 1;
  if (value >= 5_000) return 0;
  return 1 - ((value - 500) / 4_500);
}

function usageScore(value, warning, critical) {
  if (!Number.isFinite(Number(value))) return 1;
  if (value <= warning) return 1;
  if (value >= critical) return 0;
  return 1 - ((value - warning) / (critical - warning));
}

function networkScore(value) {
  if (value.status === "offline") return 0;
  const churn = Number(value.socketErrors) || 0;
  const opens = Number(value.socketOpens) || 0;
  if (churn <= Math.max(3, opens * 0.25)) return 1;
  if (churn >= Math.max(20, opens * 2)) return 0;
  return 0.5;
}
