import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [html, css, editor, viewer, packageSource] = await Promise.all([
  fs.readFile(new URL("../public/map-editor.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.css", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/pixi-viewer.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../lib/package-source.mjs", import.meta.url), "utf8"),
]);

test("map editor follows the visual viewport while a mobile keyboard changes usable space", () => {
  assert.match(html, /interactive-widget=resizes-content/u);
  assert.match(editor, /initializeVisualViewportLayout\(\)/u);
  assert.match(editor, /window\.visualViewport/u);
  assert.match(editor, /viewport\.addEventListener\("resize", schedule\)/u);
  assert.match(editor, /viewport\.addEventListener\("scroll", schedule\)/u);
  assert.match(editor, /root\.dataset\.softKeyboard/u);
  assert.match(css, /height: var\(--map-visual-viewport-height, 100dvh\)/u);
  assert.match(css, /max-height: calc\(var\(--map-visual-viewport-height, 100dvh\) - 16px\)/u);
});

test("notched devices reserve all four safe-area insets without changing editing quality", () => {
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(css, new RegExp(`--safe-${side}: env\\(safe-area-inset-${side}, 0px\\)`, "u"));
  }
  assert.match(css, /--topbar-height: calc\(58px \+ var\(--safe-top\)\)/u);
  assert.match(css, /--status-height: calc\(28px \+ var\(--safe-bottom\)\)/u);
  assert.match(css, /padding-right: var\(--safe-right\)/u);
  assert.match(css, /padding-left: var\(--safe-left\)/u);
});

test("mobile keeps every toolbar command reachable in a fixed horizontal strip", () => {
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.map-toolbar \{[\s\S]*?flex: 1 1 0;[\s\S]*?overflow-x: auto;[\s\S]*?touch-action: pan-x;/u);
  assert.match(css, /\.map-toolbar \.icon-button \{[\s\S]*?flex: 0 0 auto;/u);
  assert.match(html, /id="statusHelpButton"[^>]*aria-label="打开地图编辑器操作帮助"/u);
  assert.match(css, /@media \(max-width: 420px\)[\s\S]*?#helpButton[\s\S]*?\.status-help-button \{[\s\S]*?display: inline-grid/u);
});

test("mobile layer actions use a complete touch grid without horizontal overflow", () => {
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.layer-actions \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);[\s\S]*?overflow-x: visible;/u);
  assert.match(css, /\.layer-actions \.mini-icon-button \{[\s\S]*?height: 42px;[\s\S]*?min-height: 42px;/u);
  assert.match(css, /\.layer-action-divider \{\s*display: none;/u);
});

test("tablet starts with the overlay collaboration panel closed", () => {
  assert.match(editor, /collaborationOpen: matchMedia\("\(min-width: 1201px\)"\)\.matches/u);
  assert.match(editor, /collaborationScrim\.hidden = !state\.collaborationOpen \|\| matchMedia\("\(min-width: 1201px\)"\)\.matches/u);
});

test("pointer capture loss, backgrounding, and blur cancel incomplete tools instead of committing partial gestures", () => {
  assert.match(viewer, /addEventListener\("lostpointercapture"/u);
  assert.match(viewer, /cancelPointerInteractions\(\)/u);
  assert.match(viewer, /window\.addEventListener\("blur", this\.boundWindowInteractionBlur\)/u);
  assert.match(viewer, /document\.visibilityState === "hidden"/u);
  assert.match(viewer, /if \(cancelTool\) this\.interactionHandlers\.cancel\?\.\(\)/u);
  assert.match(viewer, /releasePointerCapture\(pointerId\)/u);
  assert.match(viewer, /removeEventListener\("blur", this\.boundWindowInteractionBlur\)/u);
});

test("visible map coordinates use the same integer rule as object transforms", () => {
  assert.match(editor, /const x = Math\.round\(point\.x\);/u);
  assert.match(editor, /const y = Math\.round\(point\.y\);/u);
  assert.match(editor, /x: Math\.round\(local\.x\),\s*y: Math\.round\(local\.y\),/u);
});

test("map editor exposes a fixed gamepad contract without adaptive mappings", () => {
  assert.match(editor, /new MapGamepadController\(/u);
  assert.match(editor, /onPan: \(\{ x, y \}\) => \{[\s\S]*?state\.viewer\?\.panByScreen\?\.\(x, y\)/u);
  assert.match(editor, /action === "primary"/u);
  assert.match(editor, /pointerType: "gamepad"/u);
  assert.match(editor, /action === "cancel"/u);
  assert.match(editor, /if \(mapGamepadOperationPending\(\)\) return/u);
  assert.match(editor, /action === "fit"/u);
  assert.doesNotMatch(editor, /gamepad[\s\S]{0,300}(?:hardwareConcurrency|deviceMemory|performance\.memory)/iu);
  assert.match(packageSource, /"public\/map-editor\/map-gamepad-controller\.js"/u);
});
