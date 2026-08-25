import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTiledDocument,
  TILED_COMPATIBILITY_BASELINE,
} from "../public/map-editor/tiled-document.js";
import {
  applyTiledAutomappingPreview,
  compileTiledAutomappingRuleMap,
  previewTiledAutomapping,
} from "../public/map-editor/tiled-automap.js";
import { TiledEditDocument } from "../public/map-editor/tiled-edit-document.js";
import { planTiledTilesetReuse } from "../public/map-editor/tiled-gid-reuse.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "test", "fixtures", "tiled");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-tiled-compatibility-"));

try {
  const projectRoot = path.join(temporaryRoot, "project");
  await Promise.all([
    fs.mkdir(path.join(projectRoot, "maps"), { recursive: true }),
    fs.mkdir(path.join(projectRoot, "tiles"), { recursive: true }),
    fs.mkdir(path.join(projectRoot, "templates"), { recursive: true }),
    fs.mkdir(path.join(projectRoot, "automapping"), { recursive: true }),
  ]);
  await Promise.all([
    copyFixture("maps", "tiled-1.12.2-features.tmj", projectRoot),
    copyFixture("maps", "tiled-1.12.2-objects.tmj", projectRoot),
    copyFixture("tiles", "tiled-1.12.2-features.tsj", projectRoot),
    copyFixture("templates", "portal.tx", projectRoot),
    copyFixture("automapping", "target.tmj", projectRoot),
    copyFixture("automapping", "basic.tmj", projectRoot),
    copyFixture("automapping", "rules.txt", projectRoot),
    copyFixture("automapping", "automap-fixture.svg", projectRoot),
    copyFixture("automapping", "automap-fixture.tsj", projectRoot),
    copyFixture("automapping", "automap-padding.svg", projectRoot),
    copyFixture("automapping", "automap-padding.tsj", projectRoot),
    copyFixture("automapping", "advanced-target.tmj", projectRoot),
    copyFixture("automapping", "advanced.tmj", projectRoot),
    copyFixture("automapping", "advanced-fixture.svg", projectRoot),
    copyFixture("automapping", "advanced-fixture.tsj", projectRoot),
  ]);

  const version = await runTiled(["--version"]);
  if (!version.stdout.includes(`Tiled ${TILED_COMPATIBILITY_BASELINE}`)) {
    throw new Error(`需要 Tiled ${TILED_COMPATIBILITY_BASELINE}，实际输出：${version.stdout.trim() || "未知"}`);
  }

  const sourceMap = path.join(projectRoot, "maps", "tiled-1.12.2-features.tmj");
  const sourceTileset = path.join(projectRoot, "tiles", "tiled-1.12.2-features.tsj");
  const sourceObjectMap = path.join(projectRoot, "maps", "tiled-1.12.2-objects.tmj");
  const outputMap = path.join(projectRoot, "maps", "roundtrip.tmj");
  const outputTileset = path.join(projectRoot, "tiles", "roundtrip.tsj");
  const outputObjectMap = path.join(projectRoot, "maps", "roundtrip-objects.tmj");
  const officialAutomapOutput = path.join(projectRoot, "automapping", "official-output.tmj");
  const officialAdvancedAutomapOutput = path.join(projectRoot, "automapping", "official-advanced-output.tmj");
  await runTiled(["--export-map", sourceMap, outputMap]);
  await runTiled(["--export-map", sourceObjectMap, outputObjectMap]);
  await runTiled(["--export-tileset", sourceTileset, outputTileset]);
  await runOfficialAutomapping({
    projectRoot,
    sourcePath: path.join(projectRoot, "automapping", "target.tmj"),
    rulesPath: path.join(projectRoot, "automapping", "rules.txt"),
    outputPath: officialAutomapOutput,
  });
  await runOfficialAutomapping({
    projectRoot,
    sourcePath: path.join(projectRoot, "automapping", "advanced-target.tmj"),
    rulesPath: path.join(projectRoot, "automapping", "advanced.tmj"),
    outputPath: officialAdvancedAutomapOutput,
  });

  const map = parseTiledDocument(await fs.readFile(outputMap), {
    expectedKind: "map",
    sourcePath: "maps/roundtrip.tmj",
  });
  const tileset = parseTiledDocument(await fs.readFile(outputTileset), {
    expectedKind: "tileset",
    sourcePath: "tiles/roundtrip.tsj",
  });
  const objectMap = parseTiledDocument(await fs.readFile(outputObjectMap), {
    expectedKind: "map",
    sourcePath: "maps/roundtrip-objects.tmj",
  });
  assertNoErrors(map.diagnostics, "Tiled 导出的 TMJ");
  assertNoErrors(tileset.diagnostics, "Tiled 导出的 TSJ");
  assertNoErrors(objectMap.diagnostics, "Tiled 导出的对象 TMJ");
  assertRoundTripSemantics(map.document, tileset.document);
  assertObjectRoundTripSemantics(objectMap.document);
  const automapping = await compareOfficialAutomapping({
    projectRoot,
    officialOutputPath: officialAutomapOutput,
    officialAdvancedOutputPath: officialAdvancedAutomapOutput,
  });

  process.stdout.write(`${JSON.stringify({
    tiledVersion: TILED_COMPATIBILITY_BASELINE,
    map: {
      layers: map.document.layers.length,
      listItems: map.document.properties[0].value.length,
      warningFeatures: uniqueFeatures(map.diagnostics),
    },
    tileset: {
      wangsets: tileset.document.wangsets.length,
      collisionObjects: tileset.document.tiles[0].objectgroup.objects.length,
      warningFeatures: uniqueFeatures(tileset.diagnostics),
    },
    objects: {
      count: objectMap.document.layers[0].objects.length,
      draworder: objectMap.document.layers[0].draworder,
    },
    automapping,
  }, null, 2)}\n`);
} finally {
  const relative = path.relative(os.tmpdir(), temporaryRoot);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function copyFixture(directory, name, projectRoot) {
  await fs.copyFile(
    path.join(fixtureRoot, directory, name),
    path.join(projectRoot, directory, name),
  );
}

async function runTiled(args) {
  const binary = process.env.WFL_TILED_BIN || "tiled";
  const command = process.env.DISPLAY ? binary : "xvfb-run";
  const commandArgs = process.env.DISPLAY ? args : ["-a", binary, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`Tiled 执行失败（code=${code}, signal=${signal || "none"}）：${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function runOfficialAutomapping({ projectRoot, sourcePath, rulesPath, outputPath }) {
  const configRoot = path.join(temporaryRoot, `tiled-config-${path.basename(outputPath, ".tmj")}`);
  const extensionDirectory = path.join(configRoot, "tiled", "extensions");
  await fs.mkdir(extensionDirectory, { recursive: true });
  const template = await fs.readFile(
    path.join(fixtureRoot, "automapping", "official-extension.js"),
    "utf8",
  );
  const extension = template
    .replace("__WFL_SOURCE_PATH__", JSON.stringify(sourcePath))
    .replace("__WFL_RULES_PATH__", JSON.stringify(rulesPath))
    .replace("__WFL_OUTPUT_PATH__", JSON.stringify(outputPath));
  await fs.writeFile(path.join(extensionDirectory, "wfl-official-automapping.js"), extension, "utf8");

  const binary = process.env.WFL_TILED_BIN || "tiled";
  const display = Boolean(process.env.DISPLAY);
  const command = display ? binary : "xvfb-run";
  const args = display
    ? ["--new-instance", sourcePath]
    : ["-a", binary, "--new-instance", sourcePath];
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, XDG_CONFIG_HOME: configRoot },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 15_000;
  try {
    for (;;) {
      try {
        await fs.access(outputPath);
        return;
      } catch {
        // The official editor session writes the file asynchronously after opening the map.
      }
      if (child.exitCode !== null) {
        throw new Error(`Tiled Automapping 提前退出（code=${child.exitCode}）：${stderr.trim() || stdout.trim()}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Tiled Automapping 超时：${stderr.trim() || stdout.trim() || "没有输出"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
    }
  }
}

async function compareOfficialAutomapping({ projectRoot, officialOutputPath, officialAdvancedOutputPath }) {
  const automappingRoot = path.join(projectRoot, "automapping");
  const [source, rule, official, definition, paddingDefinition] = await Promise.all([
    readMap(path.join(automappingRoot, "target.tmj"), "automapping/target.tmj"),
    readMap(path.join(automappingRoot, "basic.tmj"), "automapping/basic.tmj"),
    readMap(officialOutputPath, "automapping/official-output.tmj"),
    fs.readFile(path.join(automappingRoot, "automap-fixture.tsj"), "utf8").then(JSON.parse),
    fs.readFile(path.join(automappingRoot, "automap-padding.tsj"), "utf8").then(JSON.parse),
  ]);
  const definitions = new Map([
    ["automap-fixture.tsj", definition],
    ["automap-padding.tsj", paddingDefinition],
  ]);
  const sourceTilesets = describeFixtureTilesets(rule, definitions);
  const targetTilesets = describeFixtureTilesets(source, definitions);
  const reuse = planTiledTilesetReuse({
    sourceMapPath: "automapping/basic.tmj",
    targetMapPath: "automapping/target.tmj",
    sourceTilesets,
    targetTilesets,
  });
  const compiled = compileTiledAutomappingRuleMap(rule, {
    rulePath: "automapping/basic.tmj",
    tilesets: sourceTilesets,
    remapGid: reuse.remapGlobalTileId,
  });
  const preview = previewTiledAutomapping(source, compiled, {
    targetPath: "automapping/target.tmj",
    seed: 1,
  });
  const editor = new TiledEditDocument(source);
  applyTiledAutomappingPreview(editor, preview);
  const officialLayers = tileLayerData(official);
  const wflLayers = tileLayerData(editor.document);
  if (JSON.stringify(wflLayers) !== JSON.stringify(officialLayers)) {
    throw new Error(`Automapping 与 Tiled ${TILED_COMPATIBILITY_BASELINE} 结果不一致：WFL=${JSON.stringify(wflLayers)}，Tiled=${JSON.stringify(officialLayers)}`);
  }
  const advanced = await compareAdvancedOfficialAutomapping({ automappingRoot, officialAdvancedOutputPath });
  return {
    ruleMaps: 1,
    matches: preview.stats.matches,
    changes: preview.stats.changes,
    addedLayers: preview.stats.addedLayers,
    sourceFirstgid: reuse.mappings[0].sourceFirstgid,
    targetFirstgid: reuse.mappings[0].targetFirstgid,
    tileLayers: wflLayers,
    advanced,
  };
}

async function compareAdvancedOfficialAutomapping({ automappingRoot, officialAdvancedOutputPath }) {
  const [source, rule, official, definition] = await Promise.all([
    readMap(path.join(automappingRoot, "advanced-target.tmj"), "automapping/advanced-target.tmj"),
    readMap(path.join(automappingRoot, "advanced.tmj"), "automapping/advanced.tmj"),
    readMap(officialAdvancedOutputPath, "automapping/official-advanced-output.tmj"),
    fs.readFile(path.join(automappingRoot, "advanced-fixture.tsj"), "utf8").then(JSON.parse),
  ]);
  const sourceTilesets = describeFixtureTilesets(rule, new Map([["advanced-fixture.tsj", definition]]));
  const compiled = compileTiledAutomappingRuleMap(rule, {
    rulePath: "automapping/advanced.tmj",
    tilesets: sourceTilesets,
  });
  const preview = previewTiledAutomapping(source, compiled, {
    targetPath: "automapping/advanced-target.tmj",
    seed: 1,
  });
  const editor = new TiledEditDocument(source);
  applyTiledAutomappingPreview(editor, preview);
  const officialLayers = tileLayerData(official);
  const wflLayers = tileLayerData(editor.document);
  if (JSON.stringify(wflLayers) !== JSON.stringify(officialLayers)) {
    throw new Error(`高级 Automapping 与 Tiled ${TILED_COMPATIBILITY_BASELINE} 结果不一致：WFL=${JSON.stringify(wflLayers)}，Tiled=${JSON.stringify(officialLayers)}`);
  }
  return {
    rules: compiled.rules.length,
    matches: preview.stats.matches,
    changes: preview.stats.changes,
    tileLayers: wflLayers,
  };
}

function describeFixtureTilesets(map, definitions) {
  return map.tilesets.map((reference) => {
    const filename = path.posix.basename(reference.source || "");
    const definition = definitions.get(filename);
    if (!definition) throw new Error(`未知的 Automapping 对照瓦片集：${reference.source || "内嵌"}`);
    return {
      reference,
      definition,
      firstgid: reference.firstgid,
      maxLocalId: definition.tilecount - 1,
      sourcePath: `automapping/${filename}`,
    };
  });
}

async function readMap(filePath, sourcePath) {
  const parsed = parseTiledDocument(await fs.readFile(filePath), {
    expectedKind: "map",
    sourcePath,
  });
  assertNoErrors(parsed.diagnostics, sourcePath);
  return parsed.document;
}

function tileLayerData(map) {
  return flattenLayers(map.layers)
    .filter((layer) => layer.type === "tilelayer")
    .map((layer) => ({ name: layer.name, data: layer.data }));
}

function flattenLayers(layers) {
  return (Array.isArray(layers) ? layers : []).flatMap((layer) => [
    layer,
    ...(layer.type === "group" ? flattenLayers(layer.layers) : []),
  ]);
}

function assertNoErrors(diagnostics, label) {
  const errors = diagnostics.filter(({ severity }) => severity === "error");
  if (errors.length) throw new Error(`${label}未通过 WFL 校验：${errors[0].message}`);
}

function assertRoundTripSemantics(map, tileset) {
  const objects = map.layers.find(({ type }) => type === "objectgroup")?.objects || [];
  const checks = [
    [map.tiledversion === TILED_COMPATIBILITY_BASELINE, "TMJ tiledversion"],
    [map.layers[0]?.mode === "multiply", "layer blend mode"],
    [map.properties?.[0]?.type === "list" && map.properties[0].value.length === 2, "List property"],
    [objects[0]?.capsule === true, "capsule object"],
    [objects[0]?.opacity === 0.5, "object opacity"],
    [tileset.tiledversion === TILED_COMPATIBILITY_BASELINE, "TSJ tiledversion"],
    [tileset.tilerendersize === "grid", "tileset tile render size"],
    [tileset.fillmode === "preserve-aspect-fit", "tileset fill mode"],
    [tileset.objectalignment === "center", "tileset object alignment"],
    [tileset.wangsets?.length === 1, "Wang Set"],
    [tileset.tiles?.[0]?.objectgroup?.objects?.length === 1, "tile collision"],
  ];
  const failed = checks.find(([passed]) => !passed);
  if (failed) throw new Error(`Tiled 往返丢失或改写了 ${failed[1]}`);
}

function uniqueFeatures(diagnostics) {
  return [...new Set(diagnostics.map(({ feature }) => feature).filter(Boolean))].sort();
}

function assertObjectRoundTripSemantics(map) {
  const layer = map.layers.find(({ type }) => type === "objectgroup");
  const objects = layer?.objects || [];
  const checks = [
    [layer?.draworder === "index", "object draworder"],
    [objects.length === 10, "all stage 5 objects"],
    [objects.some(({ point }) => point === true), "point object"],
    [objects.some(({ ellipse }) => ellipse === true), "ellipse object"],
    [objects.some(({ capsule }) => capsule === true), "capsule object"],
    [objects.some(({ polygon }) => Array.isArray(polygon) && polygon.length === 4), "polygon object"],
    [objects.some(({ polyline }) => Array.isArray(polyline) && polyline.length === 3), "polyline object"],
    [objects.some(({ gid, rotation }) => gid === 1 && rotation === 30), "tile object"],
    [objects.some(({ text }) => text?.text === "Portal Ready" && text.underline === true), "text object"],
    [objects.some((object) => (object.class || object.type) === "SpawnPoint"), "spawn object"],
    [objects.some((object) => (object.class || object.type) === "Portal"), "portal object"],
  ];
  const failed = checks.find(([passed]) => !passed);
  if (failed) throw new Error(`Tiled 对象往返丢失或改写了 ${failed[1]}`);
}
