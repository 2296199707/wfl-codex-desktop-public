import test from "node:test";
import assert from "node:assert/strict";
import {
  CHARACTER_ANIMATION_SCHEMA,
  anchorOffset,
  clipDurationMs,
  clipFrameAt,
  createCharacterAnimationDocument,
  frameRect,
  gridFromImageSize,
  normalizeCharacterAnimationDocument,
  serializeCharacterAnimationDocument,
} from "../public/character-editor/character-animation-model.js";

test("character animation documents keep unknown fields and use a locked pixel anchor", () => {
  const document = createCharacterAnimationDocument({
    name: "hero",
    profile: "topdown-rpg",
    sourcePath: "assets/hero.png",
    sourceWidth: 128,
    sourceHeight: 64,
    source: { frameWidth: 32, frameHeight: 32, columns: 4, rows: 2, vendorField: { keep: true } },
    render: { referenceHeight: 48, customRenderField: "keep" },
    futureField: ["keep"],
    clips: [{ id: "walk-down", name: "向下行走", frames: [{ index: 0, durationMs: 90 }, { index: 1, durationMs: 110 }] }],
  });

  assert.equal(document.schema, CHARACTER_ANIMATION_SCHEMA);
  assert.deepEqual(document.futureField, ["keep"]);
  assert.deepEqual(document.source.vendorField, { keep: true });
  assert.equal(document.source.path, "assets/hero.png");
  assert.deepEqual(document.render.anchor, { x: 16, y: 32, unit: "pixel", locked: true });
  assert.equal(document.render.referenceHeight, 48);
  assert.equal(document.render.scaleMode, "reference-height");
  assert.equal(document.clips[0].frames[1].durationMs, 110);
});

test("frame rectangles and fixed-size preview metadata are deterministic", () => {
  const document = createCharacterAnimationDocument({
    sourcePath: "sprites/player.png",
    sourceWidth: 100,
    sourceHeight: 57,
    source: { frameWidth: 20, frameHeight: 25, marginX: 2, marginY: 1, spacingX: 3, spacingY: 5, columns: 4, rows: 2 },
  });
  assert.deepEqual(frameRect(document.source, 5), {
    x: 25,
    y: 31,
    width: 20,
    height: 25,
    column: 1,
    row: 1,
    index: 5,
  });
  assert.deepEqual(anchorOffset(document, 2), { x: 20, y: 50 });
  assert.deepEqual(gridFromImageSize({ imageWidth: 100, imageHeight: 57, frameWidth: 20, frameHeight: 25, marginX: 2, marginY: 1, spacingX: 3, spacingY: 5 }), { columns: 4, rows: 2 });
});

test("clip playback honors durations, loop mode and stable frame indices", () => {
  const document = createCharacterAnimationDocument({
    sourceWidth: 64,
    sourceHeight: 16,
    source: { frameWidth: 16, frameHeight: 16, columns: 4, rows: 1 },
    clips: [{ id: "attack", frames: [{ index: 0, durationMs: 100 }, { index: 1, durationMs: 200 }], loop: false }],
  });
  const clip = document.clips[0];
  assert.equal(clipDurationMs(clip), 300);
  assert.equal(clipFrameAt(clip, 0).index, 0);
  assert.equal(clipFrameAt(clip, 100).index, 1);
  assert.equal(clipFrameAt(clip, 999).index, 1);
  assert.match(serializeCharacterAnimationDocument(document), /"wfl\.character-animation\.v1"/u);
  assert.doesNotThrow(() => normalizeCharacterAnimationDocument(JSON.parse(serializeCharacterAnimationDocument(document))));
});

test("clip playback honors reverse and pingpong directions", () => {
  const document = createCharacterAnimationDocument({
    sourceWidth: 48,
    sourceHeight: 16,
    source: { frameWidth: 16, frameHeight: 16, columns: 3, rows: 1 },
    clips: [
      { id: "reverse", direction: "reverse", frames: [{ index: 0, durationMs: 10 }, { index: 1, durationMs: 20 }, { index: 2, durationMs: 30 }] },
      { id: "pingpong", direction: "pingpong", frames: [{ index: 0, durationMs: 10 }, { index: 1, durationMs: 20 }, { index: 2, durationMs: 30 }] },
    ],
  });
  assert.equal(clipFrameAt(document.clips[0], 0).index, 2);
  assert.equal(clipFrameAt(document.clips[0], 30).index, 1);
  assert.equal(clipDurationMs(document.clips[1]), 80);
  assert.equal(clipFrameAt(document.clips[1], 60).index, 1);
  assert.equal(clipFrameAt(document.clips[1], 70).index, 1);
});

test("invalid frame references and unsafe paths fail closed", () => {
  assert.throws(() => createCharacterAnimationDocument({
    sourceWidth: 32,
    sourceHeight: 32,
    source: { frameWidth: 16, frameHeight: 16, columns: 2, rows: 2 },
    clips: [{ id: "bad", frames: [{ index: 4, durationMs: 100 }] }],
  }), /超出精灵图网格/u);
  assert.throws(() => createCharacterAnimationDocument({ sourcePath: "../secret.png" }), /工程相对路径/u);
  assert.throws(() => createCharacterAnimationDocument({ sourcePath: "https://example.com/a.png" }), /工程相对路径/u);
});
