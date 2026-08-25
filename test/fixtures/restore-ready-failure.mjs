globalThis.fetch = async () => {
  throw new Error("injected restore readiness failure");
};
