import { prepareTiledAiPatchFills } from "./tiled-ai-patch.js?v=0.44.65";

self.addEventListener("message", (event) => {
  const request = event.data;
  if (!request || request.type !== "prepare" || typeof request.id !== "string") return;
  try {
    const prepared = prepareTiledAiPatchFills(request.document, request.patch);
    const transfer = prepared.fillResults.map((entry) => entry.result.addresses.buffer);
    self.postMessage({ type: "result", id: request.id, prepared }, transfer);
  } catch (error) {
    self.postMessage({
      type: "error",
      id: request.id,
      error: {
        name: String(error?.name || "Error"),
        code: typeof error?.code === "string" ? error.code : null,
        message: String(error?.message || "AI 地图补丁预计算失败"),
      },
    });
  }
});
