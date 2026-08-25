#!/usr/bin/env node
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import process from "node:process";
import { assertCaptureAddresses, normalizeCaptureUrl } from "../lib/preview-capture-policy.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.url || !args.output) usage("用法：preview-capture URL --output screenshot.png [--width 1280 --height 720]");
const allowedOrigins = [new URL(args.url).origin, ...(args.allowOrigin || [])];
const target = normalizeCaptureUrl(args.url, {
  allowedOrigins,
  allowLoopback: true,
  requirePreviewPath: false,
});
const addresses = await dns.lookup(target.hostname, { all: true, verbatim: true });
assertCaptureAddresses(addresses, { allowLoopback: true });
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("截图组件尚未安装，请先运行 npm install");
  process.exit(1);
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  serviceWorkers: "block",
  viewport: {
    width: bounded(args.width, 1_280, 320, 2_560),
    height: bounded(args.height, 720, 240, 2_048),
  },
});
try {
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (/^(?:data|blob):/i.test(requestUrl)) return route.continue();
    try {
      const parsed = normalizeCaptureUrl(requestUrl, {
        allowedOrigins,
        allowLoopback: true,
        requirePreviewPath: false,
      });
      // Resolve every request so a DNS rebinding cannot turn a safe target
      // into a private address during the capture.
      assertCaptureAddresses(await dns.lookup(parsed.hostname, { all: true, verbatim: true }), { allowLoopback: true });
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });
  await page.goto(target.href, { waitUntil: "networkidle", timeout: 45_000 });
  await page.screenshot({ path: args.output, type: "png", fullPage: args.fullPage === true });
  await fs.chmod(args.output, 0o600).catch(() => {});
  console.log(JSON.stringify({ output: args.output, url: target.href }, null, 2));
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(Math.max(number, minimum), maximum) : fallback;
}

function parseArgs(values) {
  const result = { url: values[0], allowOrigin: [] };
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--output") result.output = values[++index];
    else if (value === "--width") result.width = values[++index];
    else if (value === "--height") result.height = values[++index];
    else if (value === "--full-page") result.fullPage = true;
    else if (value === "--allow-origin") result.allowOrigin.push(new URL(values[++index]).origin);
    else usage(`未知参数：${value}`);
  }
  return result;
}

function usage(message) {
  console.error(message);
  process.exit(2);
}
