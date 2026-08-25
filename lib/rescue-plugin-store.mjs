// The independently frozen rescue runtime must never parse or mutate the main
// site's evolving plugin state. Rescue exposes an intentionally empty catalog
// and rejects every plugin mutation while preserving the small interface used
// by the shared server implementation.
export function createRescuePluginStore() {
  const unavailable = () => {
    const error = new Error("备用窗口不提供插件管理");
    error.statusCode = 404;
    throw error;
  };
  return Object.freeze({
    snapshot() {
      return {
        platformVersion: 2,
        source: { id: "rescue-isolated", name: "独立救援组件", trust: "bundled" },
        plugins: [],
        rescueIsolated: true,
      };
    },
    isEnabled() { return false; },
    isAuthorized() { return false; },
    publicPlugin: unavailable,
    install: unavailable,
    setEnabled: unavailable,
    uninstall: unavailable,
    grant: unavailable,
    revokeGrant: unavailable,
  });
}
