import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeTiledClassDefaults,
  normalizeTiledPropertyValue,
  parseTiledProjectTypes,
  tiledPropertyControl,
} from "../public/map-editor/tiled-project-types.js";

const registry = parseTiledProjectTypes({
  propertyTypes: [
    {
      name: "SpawnConfig",
      type: "class",
      members: [
        { name: "team", type: "string", value: "player" },
        { name: "enabled", type: "bool", value: true },
        { name: "stats", type: "class", propertyType: "Stats", value: { hp: 10 } },
      ],
    },
    {
      name: "Stats",
      type: "class",
      members: [{ name: "hp", type: "int", value: 10 }],
    },
    {
      name: "Biome",
      type: "enum",
      storageType: "string",
      values: ["forest", "desert"],
    },
    {
      name: "Flags",
      type: "enum",
      storageType: "int",
      values: [1, 2, 4],
      valuesAsFlags: true,
    },
  ],
});

test("parses nested Classes and string/integer Enums into a stable registry", () => {
  assert.deepEqual(registry.classNames, ["SpawnConfig", "Stats"]);
  assert.deepEqual(registry.enumNames, ["Biome", "Flags"]);
  assert.equal(registry.classes.get("SpawnConfig").defaults.team, "player");
  assert.deepEqual(registry.enums.get("Flags").values, [1, 2, 4]);
  assert.deepEqual(tiledPropertyControl({ type: "enum", propertyType: "Biome" }, registry).values, ["forest", "desert"]);
  assert.equal(tiledPropertyControl({ type: "class", propertyType: "Missing" }, registry).editable, false);
});

test("normalizes typed primitive, enum, list, and nested class values without dropping unknown fields", () => {
  assert.equal(normalizeTiledPropertyValue({ type: "int" }, "7", registry), 7);
  assert.equal(normalizeTiledPropertyValue({ type: "enum", propertyType: "Biome" }, "forest", registry), "forest");
  assert.deepEqual(normalizeTiledPropertyValue({ type: "list", propertyType: "int" }, ["1", 2], registry), [1, 2]);
  assert.deepEqual(
    normalizeTiledPropertyValue({ type: "class", propertyType: "SpawnConfig" }, {
      team: "enemy",
      stats: { hp: "20" },
      futureField: { keep: true },
    }, registry),
    { team: "enemy", enabled: true, stats: { hp: 20 }, futureField: { keep: true } },
  );
  assert.deepEqual(mergeTiledClassDefaults({ team: "enemy" }, registry.classes.get("SpawnConfig"), registry), {
    team: "enemy", enabled: true, stats: { hp: 10 },
  });
});

test("rejects duplicate types, unknown enum values, and malformed lists", () => {
  assert.throws(
    () => parseTiledProjectTypes({ propertyTypes: [{ name: "A", type: "enum", values: ["x"] }, { name: "A", type: "class" }] }),
    (error) => error.code === "TILED_PROJECT_TYPE_DUPLICATE",
  );
  assert.throws(
    () => normalizeTiledPropertyValue({ type: "enum", propertyType: "Biome" }, "ocean", registry),
    (error) => error.code === "TILED_PROPERTY_VALUE_INVALID",
  );
  assert.throws(
    () => normalizeTiledPropertyValue({ type: "list", propertyType: "int" }, "not-a-list", registry),
    (error) => error.code === "TILED_PROPERTY_VALUE_INVALID",
  );
});
