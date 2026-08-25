const VIEWPORT = Object.freeze({ width: 390, height: 844 });

export class MobilePreviewBrowserSession {
  constructor({ targetForRecord = null } = {}) {
    this.targetForRecord = targetForRecord;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.sessionId = null;
    this.target = null;
    this.buildId = null;
    this.renderErrors = [];
    this.queue = Promise.resolve();
  }

  validate(record) {
    return this.run(() => this.capture(record, { reload: true }));
  }

  screenshot(record) {
    return this.run(() => this.capture(record));
  }

  click(record, { x, y }) {
    return this.run(async () => {
      const page = await this.ensurePage(record);
      this.renderErrors.length = 0;
      await page.mouse.click(x, y);
      await page.waitForTimeout(300);
      this.assertNoRenderErrors();
      return this.screenshotResult(record, { interaction: { type: "click", x, y } });
    });
  }

  type(record, { text, clear = false }) {
    return this.run(async () => {
      const page = await this.ensurePage(record);
      this.renderErrors.length = 0;
      if (clear) {
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
      }
      await page.keyboard.insertText(text);
      await page.waitForTimeout(300);
      this.assertNoRenderErrors();
      return this.screenshotResult(record, {
        interaction: { type: "type", characters: [...text].length, clear },
      });
    });
  }

  scroll(record, { deltaX = 0, deltaY }) {
    return this.run(async () => {
      const page = await this.ensurePage(record);
      this.renderErrors.length = 0;
      await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
      await page.mouse.wheel(deltaX, deltaY);
      await page.waitForTimeout(300);
      this.assertNoRenderErrors();
      return this.screenshotResult(record, {
        interaction: { type: "scroll", deltaX, deltaY },
      });
    });
  }

  reset() {
    return this.run(() => this.closeContext());
  }

  async capture(record, { reload = false } = {}) {
    await this.ensurePage(record, { reload });
    this.assertNoRenderErrors();
    return this.screenshotResult(record);
  }

  async ensurePage(record, { reload = false } = {}) {
    if (!record?.sessionId || !record.url) throw new Error("移动 App 预览地址无效");
    const target = this.resolveTarget(record);
    const sameSession = this.page
      && !this.page.isClosed()
      && this.sessionId === record.sessionId
      && this.target === target;
    if (!sameSession) {
      await this.closeContext();
      const { chromium } = await import("playwright");
      this.browser ||= await chromium.launch({ headless: true });
      this.context = await this.browser.newContext({ viewport: VIEWPORT });
      this.page = await this.context.newPage();
      this.sessionId = record.sessionId;
      this.target = target;
      this.attachDiagnostics(this.page, target);
      await this.navigate(record, target);
    } else if (reload || this.buildId !== record.buildId) {
      await this.navigate(record, target);
    }
    return this.page;
  }

  resolveTarget(record) {
    const target = typeof this.targetForRecord === "function" ? this.targetForRecord(record) : null;
    if (!target) throw new Error("移动 App 预览网关地址无效");
    return target;
  }

  attachDiagnostics(page, target) {
    page.on("requestfailed", (request) => {
      if (request.url().startsWith(target)) this.renderErrors.push(`${request.url()}：${request.failure()?.errorText || "资源请求失败"}`);
    });
    page.on("response", (resourceResponse) => {
      if (resourceResponse.url().startsWith(target) && !resourceResponse.ok()) {
        this.renderErrors.push(`${resourceResponse.url()}：HTTP ${resourceResponse.status()}`);
      }
    });
    page.on("pageerror", (error) => this.renderErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && /content security policy|refused to|canvaskit|\.wasm|websocket/iu.test(message.text())) {
        this.renderErrors.push(message.text());
      }
    });
    page.on("websocket", (socket) => {
      if (/\b(?:127\.0\.0\.1|localhost)(?::|\/)/iu.test(socket.url())) {
        this.renderErrors.push(`预览尝试连接本机调试 WebSocket：${socket.url()}`);
      }
    });
  }

  async navigate(record, target) {
    this.renderErrors.length = 0;
    const response = await this.page.goto(target, { waitUntil: "domcontentloaded", timeout: 25_000 });
    if (!response?.ok()) throw new Error(`预览页面返回 HTTP ${response?.status() || 0}`);
    if (record.deliveryMode === "static") {
      const headers = await response.allHeaders();
      const csp = headers["content-security-policy"] || "";
      if (!csp.includes("base-uri 'self'") || !csp.includes("'wasm-unsafe-eval'") || !csp.includes("sandbox allow-scripts")) {
        throw new Error("移动 App 预览路由未启用 Flutter 隔离 CSP");
      }
      if (headers["access-control-allow-origin"] !== "*" || headers["cross-origin-resource-policy"] !== "cross-origin") {
        throw new Error("移动 App 预览路由未启用隔离静态资源响应头");
      }
    }
    await this.waitForFirstFrame();
    await this.page.waitForTimeout(250);
    this.assertNoRenderErrors();
    this.renderErrors.length = 0;
    this.buildId = record.buildId;
  }

  async waitForFirstFrame() {
    await this.page.waitForFunction(() => {
      const source = document.querySelector("flt-glass-pane")?.shadowRoot?.querySelector("canvas");
      if (!source || source.width < 2 || source.height < 2) return false;
      try {
        const sample = document.createElement("canvas");
        sample.width = 64;
        sample.height = 128;
        const context = sample.getContext("2d", { willReadFrequently: true });
        if (!context) return false;
        context.drawImage(source, 0, 0, sample.width, sample.height);
        const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
        const colorBins = new Set();
        for (let index = 0; index < pixels.length; index += 4) {
          colorBins.add(`${pixels[index] >> 4}:${pixels[index + 1] >> 4}:${pixels[index + 2] >> 4}:${pixels[index + 3] >> 4}`);
          if (colorBins.size >= 4) return true;
        }
      } catch {
        return false;
      }
      return false;
    }, undefined, { polling: 250, timeout: 25_000 }).catch(() => {
      throw new Error("移动 App 预览首帧尚未完成绘制，请稍后重试");
    });
  }

  async screenshotResult(record, extra = {}) {
    const image = await this.page.screenshot({ type: "png" });
    if (image.length > 2 * 1024 * 1024) throw new Error("预览截图过大");
    return {
      sessionId: record.sessionId,
      url: record.url,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      ...extra,
      screenshot: {
        mimeType: "image/png",
        data: image.toString("base64"),
        width: VIEWPORT.width,
        height: VIEWPORT.height,
      },
    };
  }

  assertNoRenderErrors() {
    if (this.renderErrors.length) throw new Error(`移动 App 预览资源加载失败：${this.renderErrors[0]}`);
  }

  run(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async closeContext() {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.sessionId = null;
    this.target = null;
    this.buildId = null;
    this.renderErrors.length = 0;
    await context?.close().catch(() => {});
  }

  async close() {
    await this.queue.catch(() => {});
    await this.closeContext();
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => {});
  }
}

export async function captureRenderedMobilePreview({ record, target }) {
  const session = new MobilePreviewBrowserSession({ targetForRecord: () => target });
  try {
    return await session.screenshot(record);
  } finally {
    await session.close();
  }
}
