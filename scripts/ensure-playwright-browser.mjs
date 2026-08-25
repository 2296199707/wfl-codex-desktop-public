import process from "node:process";
import { ensurePlaywrightBrowser } from "../lib/playwright-browser.mjs";

const install = process.argv.includes("--install");

try {
  const timeoutSeconds = readTimeoutSeconds();
  const result = await ensurePlaywrightBrowser({
    runtimeDirectory: process.env.CODEX_DESKTOP_RUNTIME_DIR,
    install,
    timeoutMs: timeoutSeconds * 1_000,
  });
  console.log(JSON.stringify({
    ok: true,
    installed: result.installed,
    browsersPath: result.path,
    executable: result.executable,
    source: result.source,
  }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function readTimeoutSeconds() {
  const value = Number(process.env.CODEX_DESKTOP_PLAYWRIGHT_TIMEOUT_SECONDS || 1_200);
  if (!Number.isInteger(value) || value < 60 || value > 3_600) {
    throw new Error("CODEX_DESKTOP_PLAYWRIGHT_TIMEOUT_SECONDS must be between 60 and 3600");
  }
  return value;
}
