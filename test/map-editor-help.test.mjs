import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [html, css, editor] = await Promise.all([
  fs.readFile(new URL("../public/map-editor.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.css", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.js", import.meta.url), "utf8"),
]);

test("map editor exposes discoverable in-product help for every input family", () => {
  for (const id of ["helpButton", "statusHelpButton", "helpDialog", "closeHelpButton", "confirmHelpButton"]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "gu")) || []).length, 1);
    assert.match(editor, new RegExp(`["']${id}["']`, "u"));
  }
  assert.match(html, /鼠标、触控笔与触屏/u);
  assert.match(html, /键盘/u);
  assert.match(html, /标准手柄/u);
  assert.match(html, /AI 修改先成为提案，不会自动应用或保存/u);
  assert.match(html, /双指[\s\S]*?同时平移和缩放/u);
  assert.match(html, /左摇杆 \/ D-pad[\s\S]*?平移/u);
  assert.match(css, /\.map-help-dialog/u);
  assert.match(css, /@media \(max-width: 420px\)[\s\S]*?#helpButton[\s\S]*?\.status-help-button/u);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.map-help-sections/u);
});

test("help shortcut stays out of text inputs and does not change existing commands", () => {
  assert.match(editor, /!editingText[\s\S]*?event\.key === "\?"[\s\S]*?event\.key === "F1"/u);
  assert.match(editor, /const dialogOpen = Boolean\(document\.querySelector\("dialog\[open\]"\)\)/u);
  assert.match(editor, /if \(dialogOpen\) return/u);
  assert.match(editor, /v: "select"[\s\S]*?h: "hand"[\s\S]*?b: "brush"[\s\S]*?f: "fill"/u);
  assert.equal((editor.match(/setInteractionMode\(normalized, handlersForTool\(normalized\)\)/gu) || []).length, 1);
  assert.match(editor, /function showEditorHelp\(\)[\s\S]*?showModal\(\)/u);
  for (const command of [
    /event\.key\.toLowerCase\(\) === "s"/u,
    /event\.key\.toLowerCase\(\) === "z"/u,
    /event\.key\.toLowerCase\(\) === "y"/u,
    /event\.key === "0"/u,
    /event\.key === "Escape"/u,
  ]) assert.match(editor, command);
});
