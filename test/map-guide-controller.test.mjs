import assert from "node:assert/strict";
import test from "node:test";
import {
  mapGuideDisplayValue,
  mapGuidePositionFromDisplay,
  normalizeMapGuide,
  normalizeMapGuides,
  snapBoundsToMapGuides,
} from "../public/map-editor/map-guide-controller.js";

const tiledMap = { tilewidth: 16, tileheight: 32 };

test("normalizes bounded window-local map guides", () => {
  const guide = normalizeMapGuide({
    id: "guide-1",
    orientation: "vertical",
    position: 48,
    unit: "tile",
    locked: true,
    visible: false,
  });
  assert.deepEqual(guide, {
    id: "guide-1",
    orientation: "vertical",
    position: 48,
    unit: "tile",
    locked: true,
    visible: false,
  });
  assert.deepEqual(normalizeMapGuides([
    guide,
    { ...guide },
    { id: "bad", orientation: "diagonal", position: 0 },
  ]), [guide]);
  assert.throws(() => normalizeMapGuide({ id: "../bad", orientation: "vertical", position: 1 }));
});

test("converts exact guide values between pixel and tile units", () => {
  assert.equal(mapGuideDisplayValue({ orientation: "vertical", position: 48, unit: "tile" }, tiledMap), 3);
  assert.equal(mapGuideDisplayValue({ orientation: "horizontal", position: 48, unit: "tile" }, tiledMap), 1.5);
  assert.equal(mapGuidePositionFromDisplay(2.5, "vertical", "tile", tiledMap), 40);
  assert.equal(mapGuidePositionFromDisplay(-12, "horizontal", "pixel", tiledMap), -12);
});

test("snaps image edges and centers to the nearest visible guide", () => {
  const snapped = snapBoundsToMapGuides({ x: 11, y: 22, width: 20, height: 16 }, [
    { id: "x", orientation: "vertical", position: 30, visible: true },
    { id: "y", orientation: "horizontal", position: 39, visible: true },
    { id: "hidden", orientation: "vertical", position: 11, visible: false },
  ], { tolerance: 2 });
  assert.deepEqual(snapped, { dx: -1, dy: 1 });
  assert.deepEqual(snapBoundsToMapGuides(
    { x: 0, y: 0, width: 10, height: 10 },
    [{ id: "far", orientation: "vertical", position: 30, visible: true }],
    { tolerance: 4 },
  ), { dx: 0, dy: 0 });
});
