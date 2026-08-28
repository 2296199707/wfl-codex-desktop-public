import { parseTiledDocument } from "./tiled-document.js?v=0.44.64-beta";
import { TiledPixiViewer } from "./pixi-viewer.js?v=0.44.64-beta";

const config = globalThis.__WFL_RENDER_CONFIG__;
const host = document.getElementById("renderHost");
const warnings = [];

void initialize();

async function initialize() {
  try {
    if (!config?.mapPath || !host) throw new Error("地图渲染页面配置缺失");
    const source = await resourceResponse(config.mapPath).then((response) => response.text());
    const parsed = parseTiledDocument(source, {
      expectedKind: "map",
      sourcePath: config.mapPath,
    });
    warnings.push(...parsed.diagnostics.map((entry) => entry.message));
    const viewer = await new TiledPixiViewer({
      host,
      document: parsed.document,
      sourcePath: config.mapPath,
      loadResourceText: (resourcePath) => resourceResponse(resourcePath).then((response) => response.text()),
      loadResourceBlob: (resourcePath) => resourceResponse(resourcePath).then((response) => response.blob()),
      onWarning: (message) => warnings.push(String(message)),
      preference: config.preference || "webgl",
      antialias: config.antialias !== false,
      resolution: 1,
      background: config.background || "#171918",
      interactive: false,
      autoFit: false,
      animate: false,
    }).initialize();
    viewer.setGridVisible(false);
    globalThis.__WFL_MAP_RENDER__ = Object.freeze({
      snapshot: () => ({
        bounds: { ...viewer.bounds },
        warnings: [...new Set(warnings)],
        map: {
          width: parsed.document.width,
          height: parsed.document.height,
          tilewidth: parsed.document.tilewidth,
          tileheight: parsed.document.tileheight,
        },
      }),
      configure: async ({ mode = "scale", scale = 1, offsetX = 0, offsetY = 0, timeMs = 0 } = {}) => {
        if (mode === "fit") viewer.fit(0);
        else viewer.setRenderView({ scale, offsetX, offsetY });
        viewer.setAnimationTime(timeMs);
        await nextFrame();
        await nextFrame();
        return {
          canvasWidth: viewer.app.canvas.width,
          canvasHeight: viewer.app.canvas.height,
          bounds: { ...viewer.bounds },
        };
      },
    });
    document.documentElement.dataset.renderState = "ready";
  } catch (error) {
    document.documentElement.dataset.renderState = "error";
    document.documentElement.dataset.renderError = error.message || "地图渲染页面初始化失败";
  }
}

async function resourceResponse(resourcePath) {
  const url = `/${String(resourcePath).split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`无法读取地图资源 ${resourcePath} · HTTP ${response.status}`);
  return response;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
