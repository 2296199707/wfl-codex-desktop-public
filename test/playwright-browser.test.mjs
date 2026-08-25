import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeBrowsersPath,
  persistPlaywrightBrowsersPath,
  readPlaywrightBrowsersPath,
  resolvePlaywrightBrowsersPath,
} from "../lib/playwright-browser.mjs";

test("Playwright browser paths prefer an explicit safe path and persist it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "playwright-browser-path-"));
  const runtimeDirectory = path.join(directory, "runtime");
  const browsersPath = path.join(directory, "data", "playwright-browsers");
  try {
    assert.equal(normalizeBrowsersPath("0"), null);
    assert.equal(normalizeBrowsersPath("relative/cache"), null);
    assert.equal(normalizeBrowsersPath("/data/cache with spaces"), null);
    assert.equal(normalizeBrowsersPath(browsersPath), browsersPath);

    await fs.mkdir(path.dirname(browsersPath), { recursive: true });
    const resolved = await resolvePlaywrightBrowsersPath({
      runtimeDirectory,
      env: { CODEX_DESKTOP_PLAYWRIGHT_BROWSERS_PATH: browsersPath },
      homeDirectory: path.join(directory, "home"),
    });
    assert.equal(resolved.path, browsersPath);
    assert.equal(resolved.source, "environment");

    await persistPlaywrightBrowsersPath(runtimeDirectory, browsersPath);
    assert.equal(await readPlaywrightBrowsersPath(runtimeDirectory), browsersPath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an existing default cache symlink resolves to its mounted target", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "playwright-browser-link-"));
  const homeDirectory = path.join(directory, "home");
  const target = path.join(directory, "mounted", "ms-playwright");
  try {
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(path.join(homeDirectory, ".cache"), { recursive: true });
    await fs.symlink(target, path.join(homeDirectory, ".cache", "ms-playwright"), "dir");
    const resolved = await resolvePlaywrightBrowsersPath({
      runtimeDirectory: path.join(directory, "runtime"),
      env: {},
      homeDirectory,
    });
    assert.equal(resolved.path, target);
    assert.equal(resolved.source, "default-cache");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
