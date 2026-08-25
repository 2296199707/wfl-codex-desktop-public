import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseTiledDocument,
  serializeTiledDocument,
  TILED_COMPATIBILITY_BASELINE,
  TILED_SUPPORT_LEVELS,
} from "../public/map-editor/tiled-document.js";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tiled");

test("Tiled 1.12.2 map fixture round-trips and reports preserve-only semantics", async () => {
  const source = await fixture("maps", "tiled-1.12.2-features.tmj");
  const parsed = parseTiledDocument(source, {
    expectedKind: "map",
    sourcePath: "maps/tiled-1.12.2-features.tmj",
  });

  assert.equal(TILED_COMPATIBILITY_BASELINE, "1.12.2");
  assert.equal(parsed.document.tiledversion, TILED_COMPATIBILITY_BASELINE);
  assert.equal(parsed.diagnostics.some(({ severity }) => severity === "error"), false);
  assert.deepEqual(uniqueFeatures(parsed.diagnostics), [
    "image-layer-transparent-color",
    "list-property",
    "object-template-instance",
  ]);
  assertCompatibilityWarningContract(parsed.diagnostics);
  assert.deepEqual(JSON.parse(serializeTiledDocument(parsed)), JSON.parse(source));
});

test("Tiled 1.12.2 tileset fixture round-trips Wang, collision, probability, and list data", async () => {
  const source = await fixture("tiles", "tiled-1.12.2-features.tsj");
  const parsed = parseTiledDocument(source, {
    expectedKind: "tileset",
    sourcePath: "tiles/tiled-1.12.2-features.tsj",
  });

  assert.equal(parsed.diagnostics.some(({ severity }) => severity === "error"), false);
  assert.deepEqual(uniqueFeatures(parsed.diagnostics), [
    "list-property",
    "tile-collision-object-group",
    "tileset-wang-sets",
  ]);
  assertCompatibilityWarningContract(parsed.diagnostics);
  assert.equal(parsed.document.wangsets[0].wangtiles[0].wangid.length, 8);
  assert.deepEqual(JSON.parse(serializeTiledDocument(parsed)), JSON.parse(source));
});

test("Tiled 1.12.2 baseline accepts all five supported orientations", async () => {
  const baseline = JSON.parse(await fixture("maps", "tiled-1.12.2-features.tmj"));
  const orientations = [
    ["orthogonal", {}],
    ["isometric", {}],
    ["staggered", { staggeraxis: "y", staggerindex: "odd" }],
    ["hexagonal", { hexsidelength: 8, staggeraxis: "x", staggerindex: "even" }],
    ["oblique", { skewx: 4, skewy: 2 }],
  ];

  for (const [orientation, fields] of orientations) {
    const document = structuredClone(baseline);
    document.orientation = orientation;
    delete document.hexsidelength;
    delete document.skewx;
    delete document.skewy;
    delete document.staggeraxis;
    delete document.staggerindex;
    Object.assign(document, fields);
    const parsed = parseTiledDocument(JSON.stringify(document), {
      expectedKind: "map",
      sourcePath: `maps/${orientation}.tmj`,
    });
    assert.equal(
      parsed.diagnostics.some(({ severity }) => severity === "error"),
      false,
      `${orientation} should not produce structural errors`,
    );
    assert.equal(parsed.document.orientation, orientation);
  }
});

test("freezes project, world, template, and modern Automapping inputs", async () => {
  const project = JSON.parse(await fixture("project", "game.tiled-project"));
  const world = JSON.parse(await fixture("worlds", "game.world"));
  const template = JSON.parse(await fixture("templates", "portal.tx"));
  const rules = (await fixture("automapping", "rules.txt")).trim().split(/\r?\n/u);

  assert.equal(project.compatibilityVersion, "1.12");
  assert.equal(project.extensionsPath, "extensions");
  assert.equal(project.propertyTypes.some(({ type }) => type === "class"), true);
  assert.equal(project.propertyTypes.some(({ type }) => type === "enum"), true);
  assert.equal(world.type, "world");
  assert.equal(world.onlyShowAdjacentMaps, true);
  assert.equal(world.maps.length, 2);
  assert.equal(world.patterns.length, 1);
  assert.equal(template.type, "template");
  assert.equal(template.object.class, "Portal");
  const ruleMap = JSON.parse(await fixture("automapping", "basic.tmj"));
  const advancedRuleMap = JSON.parse(await fixture("automapping", "advanced.tmj"));
  const advancedTileset = JSON.parse(await fixture("automapping", "advanced-fixture.tsj"));
  assert.deepEqual(rules, [
    "# Tiled 1.12.2 modern Automapping rule fixture",
    "basic.tmj",
  ]);
  assert.equal(ruleMap.layers.some(({ name }) => name === "input_Ground"), true);
  assert.equal(ruleMap.layers.some(({ name }) => name === "output_Decor"), true);
  assert.equal(ruleMap.tilesets[0].source, "automap-fixture.tsj");
  assert.equal(advancedRuleMap.layers.some(({ name }) => name === "rule_options"), true);
  assert.equal(advancedTileset.tiles.some((tile) => (
    tile.properties?.some(({ name, value }) => name === "MatchType" && value === "Other")
  )), true);
});

function assertCompatibilityWarningContract(diagnostics) {
  const warnings = diagnostics.filter(({ code }) => code === "tiled-feature-preserved-only");
  assert.ok(warnings.length > 0);
  for (const warning of warnings) {
    assert.equal(warning.severity, "warning");
    assert.equal(typeof warning.feature, "string");
    assert.equal(warning.support.parse, TILED_SUPPORT_LEVELS.full);
    assert.equal(warning.support.save, TILED_SUPPORT_LEVELS.full);
    assert.ok(Object.values(TILED_SUPPORT_LEVELS).includes(warning.support.render));
    assert.ok(Object.values(TILED_SUPPORT_LEVELS).includes(warning.support.edit));
  }
}

function uniqueFeatures(diagnostics) {
  return [...new Set(diagnostics.map(({ feature }) => feature).filter(Boolean))].sort();
}

async function fixture(...segments) {
  return fs.readFile(path.join(fixtureRoot, ...segments), "utf8");
}
