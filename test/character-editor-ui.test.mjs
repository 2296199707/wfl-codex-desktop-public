import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return fs.readFile(new URL(relativePath, root), "utf8");
}

test("character editor exposes recoverable editing controls", async () => {
  const html = await read("public/character-editor.html");
  const script = await read("public/character-editor/character-editor.js");
  const css = await read("public/character-editor/character-editor.css");

  for (const id of [
    "undoButton", "redoButton", "conflictActions", "reloadRemoteButton", "saveAsDraftButton", "downloadDraftButton",
    "spriteSheetCanvas", "clipDirectionSelect", "duplicateClipButton", "deleteClipButton",
    "moveClipUpButton", "moveClipDownButton",
    "aiGenerateButton", "aiEditButton",
    "projectSelect", "projectFileSelect", "switchProjectButton", "refreshProjectsButton",
  ]) assert.match(html, new RegExp(`id="${id}"`, "u"));
  assert.match(script, /confirmDiscardChanges\(/u);
  assert.match(script, /state\.undoStack/u);
  assert.match(script, /state\.redoStack/u);
  assert.match(script, /Number\(error\?\.status \?\? error\?\.statusCode\) === 409/u);
  assert.match(script, /loadSearchEntries\(query, kinds\)/u);
  assert.match(script, /const character = requestedCharacter \|\|/u);
  assert.match(script, /wfl-character-animation-exists/u);
  assert.match(script, /source\.version/u);
  assert.match(script, /downloadLocalDraft/u);
  assert.match(script, /saveDraftAs/u);
  assert.match(script, /selectSpriteFrame/u);
  assert.match(script, /moveTimelineFrame/u);
  assert.match(script, /direction: elements\.clipDirectionSelect\.value/u);
  assert.match(script, /context: "character-editor"/u);
  assert.match(script, /initialOperation: operation/u);
  assert.match(script, /initialPrompt: characterImagePrompt\(operation\)/u);
  assert.match(script, /applyCharacterImageCandidate\(/u);
  assert.match(script, /normalizeCharacterImageOutputPath\(/u);
  assert.match(script, /canPreserveSpriteGrid\(/u);
  assert.match(script, /clipDurationMs\(clip\)/u);
  assert.match(script, /clip\.loop === false/u);
  assert.match(script, /state\.sourceLoadToken/u);
  assert.match(script, /保存角色清单后生效/u);
  assert.match(script, /resetOnMissing: true/u);
  assert.match(script, /clearCharacterState\(\)/u);
  assert.match(script, /map-project-resource-not-found/u);
  assert.match(script, /resetOnMissing = false/u);
  assert.match(script, /fetch\("\/api\/projects", \{ cache: "no-store" \}\)/u);
  assert.match(script, /switchSelectedProject()/u);
  assert.match(script, /state\.document && state\.characterPath/u);
  assert.match(script, /state\.initialSelectionPending/u);
  assert.match(script, /const isCurrentSave = \(\) =>/u);
  assert.match(script, /saveProjectLoadToken/u);
  assert.match(script, /saveLoadToken/u);
  assert.match(script, /if \(!isCurrentSave\(\)\) return;/u);
  assert.match(script, /isMissingCharacterResource\(/u);
  assert.match(css, /\.conflict-actions\[hidden\]\s*\{\s*display:\s*none\s*;\s*\}/u);
  assert.match(css, /frame-row\[data-selected="true"\]/u);
  assert.match(css, /ai-candidate-hint/u);
});
