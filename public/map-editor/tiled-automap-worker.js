import { previewTiledAutomapping } from "./tiled-automap.js?v=0.44.55";
import { applyTiledFillResultToSnapshot } from "./tiled-fill.js?v=0.44.55";

self.addEventListener("message", (event) => {
  const request = event.data;
  if (!request || request.type !== "preview" || typeof request.id !== "string") return;
  try {
    const options = request.options || {};
    if (options.preFill) {
      applyTiledFillResultToSnapshot(request.document, options.preFill.layerId, options.preFill.result);
    }
    const { preFill: omitted, ...previewOptions } = options;
    const preview = previewTiledAutomapping(request.document, request.compiled, previewOptions);
    self.postMessage({ type: "result", id: request.id, preview });
  } catch (error) {
    self.postMessage({
      type: "error",
      id: request.id,
      error: {
        name: String(error?.name || "Error"),
        code: typeof error?.code === "string" ? error.code : null,
        message: String(error?.message || "Automapping Worker 执行失败"),
        details: error?.details && typeof error.details === "object" ? error.details : null,
      },
    });
  }
});
