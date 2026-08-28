import { findTiledFillRegion } from "./tiled-fill.js?v=0.44.63-beta";

self.addEventListener("message", (event) => {
  const request = event.data;
  if (!request || request.type !== "fill" || typeof request.id !== "string") return;
  try {
    const result = findTiledFillRegion(request.request);
    self.postMessage({ type: "result", id: request.id, result }, [result.addresses.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      id: request.id,
      error: {
        name: String(error?.name || "Error"),
        code: typeof error?.code === "string" ? error.code : null,
        message: String(error?.message || "填充 Worker 执行失败"),
      },
    });
  }
});
