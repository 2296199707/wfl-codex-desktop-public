const DEFAULT_INTERVAL_MS = 10_000;

export class OpsSupervisor {
  constructor({ snapshot, eventStore, alertManager, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    if (typeof snapshot !== "function" || !eventStore || !alertManager) throw new TypeError("snapshot, eventStore, and alertManager are required");
    this.snapshot = snapshot;
    this.eventStore = eventStore;
    this.alertManager = alertManager;
    this.intervalMs = intervalMs;
    this.previous = null;
    this.timer = null;
    this.pending = null;
  }

  start() {
    if (this.timer) return this;
    this.poll().catch(() => {});
    this.timer = setInterval(() => this.poll().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.pending) return this.pending;
    this.pending = this.capture();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  async capture() {
    const current = await this.snapshot();
    if (!current) {
      this.previous = null;
      return null;
    }
    if (this.previous) await this.recordTransitions(this.previous, current);
    await this.alertManager.evaluate(current.alertSignal);
    this.previous = structuredClone(current);
    return current;
  }

  async recordTransitions(previous, current) {
    if (previous.gatewayStatus !== current.gatewayStatus) {
      const recovered = ["healthy", "direct"].includes(current.gatewayStatus);
      await this.eventStore.record({
        type: recovered ? "service.gateway_recovered" : "service.gateway_abnormal",
        severity: recovered ? "info" : current.gatewayStatus === "offline" ? "critical" : "warning",
        source: "gateway",
        title: recovered ? "入口网关已恢复" : "入口网关状态异常",
        detail: `状态由 ${previous.gatewayStatus} 变为 ${current.gatewayStatus}`,
      });
    }
    if (previous.codexStatus !== current.codexStatus) {
      const recovered = current.codexStatus === "healthy";
      await this.eventStore.record({
        type: recovered ? "service.codex_recovered" : "service.codex_abnormal",
        severity: recovered ? "info" : current.codexStatus === "offline" ? "critical" : "warning",
        source: "codex",
        title: recovered ? "Codex Runtime 已恢复" : "Codex Runtime 状态异常",
        detail: `${current.codexReady} / ${current.codexTotal} 个运行环境就绪`,
      });
    }
    for (const key of ["release", "appUpdate", "codexUpdate"]) {
      const before = previous.deployments[key];
      const after = current.deployments[key];
      if (before === after || !["completed", "failed"].includes(after)) continue;
      const labels = { release: "网页发布", appUpdate: "远程同步", codexUpdate: "Codex 升级" };
      await this.eventStore.record({
        type: after === "completed" ? "deployment.completed" : "deployment.failed",
        severity: after === "completed" ? "info" : "critical",
        source: "deployment",
        title: `${labels[key]}${after === "completed" ? "完成" : "失败"}`,
        detail: null,
      });
    }
  }
}
