import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [html, app, styles] = await Promise.all([
  fs.readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
]);

test("version center renders Codex protocol state and reviewed coverage", () => {
  for (const id of [
    "codexVersionApplicability",
    "codexVersionApplicabilityText",
    "codexCompatibilityPanel",
    "codexCompatibilityToggle",
    "codexCompatibilityDetails",
    "codexCompatibilityCounts",
    "codexCompatibilityDrift",
    "codexCompatibilityDecision",
    "keepCodexUpdateButton",
    "rollbackCodexUpdateButton",
    "codexCompatibilityDeferred",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /function renderCodexCompatibility\(snapshot, pendingDecision/);
  assert.match(app, /function renderCodexVersionApplicability\(snapshot\)/);
  assert.match(app, /当前网页版本 v\$\{UI_VERSION_LABEL\} 适用于/);
  assert.match(app, /支持\$\{codexVersionDirectionLabel\(snapshot\)\}/);
  assert.match(app, /function codexVersionDirectionLabel\(snapshot\)/);
  assert.match(app, /当前 CLI 与兼容基线完全匹配/);
  assert.match(app, /可自行决定是否回退/);
  assert.match(app, /function decideCodexUpdate\(decision\)/);
  assert.match(app, /安全替代/);
});

test("Codex compatibility view has a compact two-column mobile layout", () => {
  assert.match(styles, /\.codex-compatibility-meta,[\s\S]*grid-template-columns: repeat\(4/);
  assert.match(styles, /@media[\s\S]*\.codex-compatibility-meta,[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(styles, /\.codex-compatibility-drift[\s\S]*overflow: auto/);
  assert.match(styles, /\.codex-compatibility-decision[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
});
