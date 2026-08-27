import {
  normalizeTiledProjectPath,
  resolveTiledProjectReference,
} from "./tiled-document.js?v=0.44.56-beta";
import { TILED_FLIP_FLAGS, decodeGlobalTileId } from "./tiled-render-model.js?v=0.44.56-beta";

const DEFAULT_MAX_RULE_FILES = 128;
const DEFAULT_MAX_RULES = 10_000;
const DEFAULT_MAX_CANDIDATES = 5_000_000;
const DEFAULT_MAX_CHANGES = 1_000_000;
const BASE_GID_MASK = 0x0fff_ffff;
const FLIP_MASK = (
  TILED_FLIP_FLAGS.horizontal
  | TILED_FLIP_FLAGS.vertical
  | TILED_FLIP_FLAGS.diagonal
  | TILED_FLIP_FLAGS.rotatedHex120
) >>> 0;
const SUPPORTED_MATCH_TYPES = new Set(["Empty", "Ignore", "Negate", "NonEmpty", "Other"]);

export class TiledAutomapError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = "TiledAutomapError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * Parse one Tiled rules.txt file. Paths are resolved against the list file,
 * constrained to the project, and annotated with the active map filter.
 */
export function parseTiledAutomappingRulesList(source, options = {}) {
  const sourcePath = rulesPath(options.sourcePath);
  const targetMapPath = options.targetMapPath
    ? normalizeTiledProjectPath(options.targetMapPath)
    : null;
  const targetName = targetMapPath?.split("/").at(-1) || null;
  const entries = [];
  let filter = "*";
  for (const [index, rawLine] of String(source ?? "").replace(/^\uFEFF/u, "").split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      filter = normalizeMapFilter(line.slice(1, -1), index + 1);
      continue;
    }
    if (line.includes("\0") || /^[a-z][a-z\d+.-]*:/iu.test(line) || line.startsWith("/")) {
      throw automapError(
        "TILED_AUTOMAP_RULE_PATH_INVALID",
        `Automapping 规则清单第 ${index + 1} 行必须使用工程内相对路径`,
        { sourcePath, line: index + 1 },
      );
    }
    let resolvedPath;
    try {
      resolvedPath = resolveTiledProjectReference(sourcePath, line.replaceAll("\\", "/"));
    } catch (cause) {
      throw automapError(
        "TILED_AUTOMAP_RULE_PATH_OUTSIDE_PROJECT",
        `Automapping 规则清单第 ${index + 1} 行离开了工程目录`,
        { sourcePath, line: index + 1 },
        { cause },
      );
    }
    const extension = resolvedPath.toLowerCase().endsWith(".txt")
      ? "list"
      : resolvedPath.toLowerCase().endsWith(".tmj") ? "map" : null;
    if (!extension) {
      throw automapError(
        "TILED_AUTOMAP_RULE_EXTENSION_UNSUPPORTED",
        `Automapping 规则只支持 .txt 清单和 .tmj 规则地图：${resolvedPath}`,
        { sourcePath, line: index + 1, resolvedPath },
      );
    }
    entries.push(Object.freeze({
      path: resolvedPath,
      kind: extension,
      filter,
      applies: targetName ? mapFilterMatches(filter, targetName) : true,
      sourcePath,
      line: index + 1,
    }));
  }
  return Object.freeze(entries);
}

/** Resolve nested rules.txt files without executing or parsing rule maps. */
export async function loadTiledAutomappingRules(options = {}) {
  const initialPath = normalizeTiledProjectPath(options.rulesPath || "");
  const targetMapPath = normalizeTiledProjectPath(options.targetMapPath || "");
  const loadText = options.loadText;
  if (typeof loadText !== "function") throw new TypeError("loadText must be a function");
  const maximumFiles = boundedLimit(options.maxFiles, DEFAULT_MAX_RULE_FILES, "maxFiles");
  if (initialPath.toLowerCase().endsWith(".tmj")) {
    return Object.freeze({
      rulesPath: initialPath,
      entries: Object.freeze([{ path: initialPath, sourcePath: initialPath, line: 1, filter: "*" }]),
      listPaths: Object.freeze([]),
    });
  }
  if (!initialPath.toLowerCase().endsWith(".txt")) {
    throw automapError("TILED_AUTOMAP_RULES_FILE_INVALID", "Automapping 入口必须是 .txt 或 .tmj 文件");
  }
  const active = new Set();
  const listPaths = [];
  const entries = [];
  let loadedFiles = 0;
  const visit = async (listPath) => {
    throwIfAborted(options.signal);
    if (active.has(listPath)) {
      throw automapError(
        "TILED_AUTOMAP_RULE_LIST_CYCLE",
        `Automapping 规则清单存在循环引用：${listPath}`,
        { listPath },
      );
    }
    if (loadedFiles >= maximumFiles) {
      throw automapError(
        "TILED_AUTOMAP_RULE_FILE_LIMIT",
        `Automapping 规则文件超过上限 ${maximumFiles}`,
        { maximumFiles },
      );
    }
    active.add(listPath);
    loadedFiles += 1;
    listPaths.push(listPath);
    let text;
    try {
      text = await loadText(listPath, { signal: options.signal });
    } catch (cause) {
      throw automapError(
        "TILED_AUTOMAP_RULE_FILE_READ_FAILED",
        `无法读取 Automapping 规则清单 ${listPath}`,
        { listPath },
        { cause },
      );
    }
    const parsed = parseTiledAutomappingRulesList(text, { sourcePath: listPath, targetMapPath });
    for (const entry of parsed) {
      if (!entry.applies) continue;
      if (entry.kind === "list") await visit(entry.path);
      else entries.push(Object.freeze({
        path: entry.path,
        sourcePath: entry.sourcePath,
        line: entry.line,
        filter: entry.filter,
      }));
    }
    active.delete(listPath);
  };
  await visit(initialPath);
  return Object.freeze({
    rulesPath: initialPath,
    entries: Object.freeze(entries),
    listPaths: Object.freeze(listPaths),
  });
}

/**
 * Compile the modern (Tiled 1.9+) tile-layer rule model. Legacy regions_*
 * maps and object outputs are rejected explicitly instead of approximated.
 */
export function compileTiledAutomappingRuleMap(ruleDocument, options = {}) {
  validateMap(ruleDocument, "规则地图");
  validateSupportedOrientation(ruleDocument, "规则地图");
  const rulePath = normalizeTiledProjectPath(options.rulePath || "rules.tmj");
  const remapGid = typeof options.remapGid === "function" ? options.remapGid : identityGid;
  const layers = flattenLayers(ruleDocument.layers);
  const legacy = layers.find(({ layer }) => /^regions(?:_|$)/iu.test(layer.name || ""));
  if (legacy) {
    throw automapError(
      "TILED_AUTOMAP_LEGACY_REGIONS_UNSUPPORTED",
      `规则地图 ${rulePath} 使用旧版 ${legacy.layer.name} 图层；当前只支持 Tiled 1.9+ 连续区域规则`,
      { rulePath, layer: legacy.layer.name },
    );
  }
  const matchTypes = matchTypeByGid(ruleDocument, options.tilesets || []);
  const inputSets = new Map();
  const outputSets = new Map();
  const inputCells = new Set();
  const outputCells = new Set();
  const optionAreas = [];
  for (const { layer } of layers) {
    const name = String(layer.name || "");
    if (name.startsWith("//")) continue;
    if (name.toLowerCase() === "rule_options") {
      if (layer.type !== "objectgroup") {
        throw automapError("TILED_AUTOMAP_RULE_OPTIONS_INVALID", "rule_options 必须是对象层", { rulePath });
      }
      optionAreas.push(...compileOptionAreas(layer, ruleDocument));
      continue;
    }
    const input = parseInputLayerName(name);
    if (input) {
      if (layer.type !== "tilelayer") {
        throw automapError("TILED_AUTOMAP_INPUT_LAYER_INVALID", `${name} 必须是瓦片层`, { rulePath, layer: name });
      }
      assertDecodedLayer(layer, rulePath);
      const set = mapEntry(inputSets, input.index, () => new Map());
      const condition = mapEntry(set, input.target, () => ({ yes: [], no: [] }));
      condition[input.negative ? "no" : "yes"].push(compileInputLayer(layer));
      for (const cell of nonemptyLayerCells(layer)) inputCells.add(cellKey(cell.x, cell.y));
      continue;
    }
    const output = parseOutputLayerName(name);
    if (output) {
      if (layer.type === "objectgroup") {
        throw automapError(
          "TILED_AUTOMAP_OBJECT_OUTPUT_UNSUPPORTED",
          `规则地图 ${rulePath} 的对象输出 ${name} 尚未支持`,
          { rulePath, layer: name },
        );
      }
      if (layer.type !== "tilelayer") {
        throw automapError("TILED_AUTOMAP_OUTPUT_LAYER_INVALID", `${name} 必须是瓦片层`, { rulePath, layer: name });
      }
      assertDecodedLayer(layer, rulePath);
      const set = mapEntry(outputSets, output.index, () => ({
        index: output.index,
        probability: 1,
        layers: [],
      }));
      const probability = numericProperty(layer.properties, "Probability", null);
      if (probability !== null) set.probability = Math.max(0, probability);
      set.layers.push({ layer, target: output.target });
      for (const cell of nonemptyLayerCells(layer)) outputCells.add(cellKey(cell.x, cell.y));
      continue;
    }
  }
  if (!inputSets.size) {
    throw automapError("TILED_AUTOMAP_INPUT_MISSING", `规则地图 ${rulePath} 没有 input_<name> 图层`, { rulePath });
  }
  if (!outputSets.size) {
    throw automapError("TILED_AUTOMAP_OUTPUT_MISSING", `规则地图 ${rulePath} 没有 output_<name> 图层`, { rulePath });
  }
  const components = connectedComponents(new Set([...inputCells, ...outputCells]));
  const defaults = ruleOptions(ruleDocument.properties);
  const rules = [];
  for (const component of components) {
    const inputRegion = new Set([...component].filter((key) => inputCells.has(key)));
    const outputRegion = new Set([...component].filter((key) => outputCells.has(key)));
    if (!inputRegion.size || !outputRegion.size) continue;
    const inputBounds = cellBounds(inputRegion);
    let optionsForRule = { ...defaults };
    for (const area of optionAreas) {
      if ([...component].every((key) => areaContains(area, parseCellKey(key)))) {
        optionsForRule = { ...optionsForRule, ...area.options };
      }
    }
    const compiledInputs = [];
    for (const [index, targets] of inputSets) {
      const compiled = compileInputSet(index, targets, inputRegion, inputBounds, matchTypes, remapGid);
      if (compiled) compiledInputs.push(compiled);
    }
    const unconditional = compileOutputSet(outputSets.get(""), outputRegion, matchTypes, remapGid);
    const random = [];
    for (const [index, outputSet] of outputSets) {
      if (!index) continue;
      const compiled = compileOutputSet(outputSet, outputRegion, matchTypes, remapGid);
      if (compiled?.writes.length) random.push(compiled);
    }
    if (!compiledInputs.length || (!unconditional?.writes.length && !random.length)) continue;
    rules.push(Object.freeze({
      id: `${rulePath}#${rules.length + 1}`,
      rulePath,
      order: rules.length,
      inputRegion: Object.freeze([...inputRegion]),
      outputRegion: Object.freeze([...outputRegion]),
      inputBounds: Object.freeze(inputBounds),
      inputs: Object.freeze(compiledInputs),
      unconditional,
      random: Object.freeze(random),
      options: Object.freeze(optionsForRule),
    }));
  }
  const maximumRules = boundedLimit(options.maxRules, DEFAULT_MAX_RULES, "maxRules");
  if (rules.length > maximumRules) {
    throw automapError("TILED_AUTOMAP_RULE_LIMIT", `规则地图包含 ${rules.length} 条规则，超过上限 ${maximumRules}`);
  }
  return Object.freeze({
    rulePath,
    rules: Object.freeze(rules),
    options: Object.freeze({
      deleteTiles: booleanProperty(ruleDocument.properties, "DeleteTiles", false),
      matchOutsideMap: booleanProperty(ruleDocument.properties, "MatchOutsideMap", false),
      overflowBorder: booleanProperty(ruleDocument.properties, "OverflowBorder", false),
      wrapBorder: booleanProperty(ruleDocument.properties, "WrapBorder", false),
      matchInOrder: booleanProperty(ruleDocument.properties, "MatchInOrder", false),
      automappingRadius: Math.max(0, integerProperty(ruleDocument.properties, "AutomappingRadius", 0)),
    }),
    inputTargets: Object.freeze([...new Set([...inputSets.values()].flatMap((set) => [...set.keys()]))]),
    outputTargets: Object.freeze([...new Set([...outputSets.values()].flatMap((set) => set.layers.map(({ target }) => target)))]),
  });
}

/**
 * Produce a deterministic, bounded tile diff without mutating targetDocument.
 * Multiple compiled rule maps are applied in caller-provided order.
 */
export function previewTiledAutomapping(targetDocument, compiledRuleMaps, options = {}) {
  validateMap(targetDocument, "目标地图");
  validateSupportedOrientation(targetDocument, "目标地图");
  const maps = Array.isArray(compiledRuleMaps) ? compiledRuleMaps : [compiledRuleMaps];
  if (!maps.length || maps.some((entry) => !entry?.rules || !entry?.options)) {
    throw automapError("TILED_AUTOMAP_COMPILED_RULES_INVALID", "Automapping 需要已编译的规则地图");
  }
  const seed = normalizeSeed(options.seed ?? 1);
  const random = seededRandom(seed);
  const maximumCandidates = boundedLimit(options.maxCandidates, DEFAULT_MAX_CANDIDATES, "maxCandidates");
  const maximumChanges = boundedLimit(options.maxChanges, DEFAULT_MAX_CHANGES, "maxChanges");
  const targetLayers = flattenLayers(targetDocument.layers).filter(({ layer }) => layer.type === "tilelayer");
  for (const { layer } of targetLayers) assertDecodedLayer(layer, options.targetPath || "目标地图");
  const working = new Map();
  const originalLayers = new Map();
  for (const { layer } of targetLayers) {
    const entry = createWorkingLayer(layer);
    working.set(layer.id, entry);
    originalLayers.set(layer.id, layer);
  }
  const created = new Map();
  const changeLog = new Map();
  const matchLog = [];
  let candidateCount = 0;
  const findTarget = (name, create = false) => {
    const existing = targetLayers.find(({ layer }) => layer.name === name)?.layer || null;
    if (existing) return working.get(existing.id);
    if (!create) return null;
    if (!created.has(name)) created.set(name, createMissingWorkingLayer(name, targetDocument));
    return created.get(name);
  };
  const context = {
    targetDocument,
    findTarget,
    random,
    signal: options.signal,
    whileDrawing: options.whileDrawing === true,
    maximumCandidates,
    maximumChanges,
    changeLog,
    matchLog,
    countCandidate() {
      candidateCount += 1;
      if (candidateCount > maximumCandidates) {
        throw automapError(
          "TILED_AUTOMAP_CANDIDATE_LIMIT",
          `Automapping 扫描候选超过上限 ${maximumCandidates}`,
          { maximumCandidates },
        );
      }
    },
  };
  for (const compiled of maps) applyCompiledRuleMap(compiled, context, options.region || null);
  const changes = [...changeLog.values()]
    .filter((change) => change.before !== change.after)
    .sort(compareChanges)
    .map((change) => Object.freeze({ ...change }));
  const additions = [...created.values()]
    .filter((entry) => changes.some((change) => change.layerName === entry.name && change.layerId === null))
    .map((entry) => Object.freeze({ layer: Object.freeze({ ...entry.layer }) }));
  return Object.freeze({
    seed,
    targetPath: options.targetPath ? normalizeTiledProjectPath(options.targetPath) : null,
    changes: Object.freeze(changes),
    additions: Object.freeze(additions),
    matches: Object.freeze(matchLog.map((match) => Object.freeze({ ...match }))),
    stats: Object.freeze({
      ruleMaps: maps.length,
      rules: maps.reduce((sum, map) => sum + map.rules.length, 0),
      candidates: candidateCount,
      matches: matchLog.length,
      changes: changes.length,
      addedLayers: additions.length,
    }),
  });
}

/** Apply an accepted preview as exactly one TiledEditDocument undo entry. */
export function applyTiledAutomappingPreview(editDocument, preview, options = {}) {
  if (!editDocument?.runBatch || !editDocument?.beginTileStroke) {
    throw new TypeError("editDocument must be a TiledEditDocument");
  }
  if (!preview || !Array.isArray(preview.changes) || !Array.isArray(preview.additions)) {
    throw automapError("TILED_AUTOMAP_PREVIEW_INVALID", "Automapping 预览无效");
  }
  const label = options.label || `AutoMap（seed ${preview.seed}）`;
  const tilesetAdditions = Array.isArray(options.tilesetAdditions)
    ? options.tilesetAdditions
    : [];
  const apply = () => {
    for (const addition of tilesetAdditions) {
      const reference = addition?.reference || addition;
      editDocument.addTileset(reference, { label: "AutoMap 加入规则瓦片集" });
    }
    const layerIds = new Map();
    for (const addition of preview.additions) {
      const added = editDocument.addLayer(addition.layer, { label: `AutoMap 新建图层 ${addition.layer.name}` });
      layerIds.set(addition.layer.name, added.id);
    }
    const groups = new Map();
    for (const change of preview.changes) {
      const layerId = change.layerId ?? layerIds.get(change.layerName);
      if (!Number.isSafeInteger(layerId)) {
        throw automapError(
          "TILED_AUTOMAP_TARGET_LAYER_MISSING",
          `Automapping 目标图层不存在：${change.layerName}`,
          { layerName: change.layerName },
        );
      }
      mapEntry(groups, layerId, () => []).push(change);
    }
    for (const [layerId, changes] of groups) {
      const transaction = editDocument.beginTileStroke(layerId, {
        kind: "tile-automap",
        label,
        seed: preview.seed,
      });
      try {
        for (const change of changes) transaction.set(change.x, change.y, change.after);
        transaction.commit();
      } catch (error) {
        transaction.cancel();
        throw error;
      }
    }
  };
  if (options.existingBatch === true) {
    if (!editDocument.activeBatch) throw new TypeError("existingBatch requires an active Tiled edit batch");
    apply();
    return { changed: true, entry: null, result: null };
  }
  return editDocument.runBatch(label, apply);
}

function applyCompiledRuleMap(compiled, context, requestedRegion) {
  const mapOptions = {
    ...compiled.options,
    matchOutsideMap: compiled.options.matchOutsideMap
      || compiled.options.overflowBorder
      || compiled.options.wrapBorder
      || context.targetDocument.infinite === true,
  };
  const radius = requestedRegion && context.whileDrawing === true
    ? compiled.options.automappingRadius
    : 0;
  const region = normalizedApplyRegion(context.targetDocument, requestedRegion, radius);
  if (mapOptions.deleteTiles) deleteOutputTiles(compiled, context, region);
  if (mapOptions.matchInOrder) {
    for (const rule of compiled.rules) {
      const applied = new Map();
      scanRule(rule, compiled, context, region, mapOptions, (position) => {
        applyRuleAt(rule, position, context, applied, mapOptions);
      });
    }
    return;
  }
  const matches = compiled.rules.map((rule) => {
    const positions = [];
    scanRule(rule, compiled, context, region, mapOptions, (position) => positions.push(position));
    return positions;
  });
  for (const [index, rule] of compiled.rules.entries()) {
    const applied = new Map();
    for (const position of matches[index]) applyRuleAt(rule, position, context, applied, mapOptions);
  }
}

function scanRule(rule, compiled, context, region, mapOptions, matched) {
  if (rule.options.disabled) return;
  const width = rule.inputBounds.maxX - rule.inputBounds.minX + 1;
  const height = rule.inputBounds.maxY - rule.inputBounds.minY + 1;
  const bounds = ruleCandidateBounds(context.targetDocument, region, width, height, mapOptions.matchOutsideMap);
  if (!bounds) return;
  const modX = Math.max(1, rule.options.modX);
  const modY = Math.max(1, rule.options.modY);
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    if (positiveModulo(y + rule.options.offsetY, modY) !== 0) continue;
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      if (positiveModulo(x + rule.options.offsetX, modX) !== 0) continue;
      throwIfAborted(context.signal);
      context.countCandidate();
      if (rule.options.probability < 1 && context.random() >= rule.options.probability) continue;
      if (rule.inputs.some((input) => inputSetMatches(input, x, y, context, mapOptions))) {
        matched({ x, y, compiledRulePath: compiled.rulePath });
      }
    }
  }
}

function inputSetMatches(inputSet, originX, originY, context, mapOptions) {
  for (const target of inputSet.targets) {
    const layer = context.findTarget(target.name, false);
    for (const position of target.positions) {
      const value = readWorkingTile(
        layer,
        originX + position.x,
        originY + position.y,
        context.targetDocument,
        mapOptions,
      );
      if (position.any.length && !position.any.some((condition) => conditionMatches(condition, value))) return false;
      if (position.none.some((condition) => conditionMatches(condition, value))) return false;
    }
  }
  return inputSet.targets.length > 0 || inputSet.hasIgnore;
}

function applyRuleAt(rule, position, context, applied, mapOptions) {
  const selected = weightedOutput(rule.random, context.random);
  const sets = [rule.unconditional, selected].filter(Boolean);
  const writes = sets.flatMap((set) => set.writes.map((write) => ({
    ...write,
    x: position.x + write.x - rule.inputBounds.minX,
    y: position.y + write.y - rule.inputBounds.minY,
  })));
  if (rule.options.noOverlappingOutput) {
    for (const write of writes) {
      const target = context.findTarget(write.target, false);
      if (target?.locked && !rule.options.ignoreLock) continue;
      if (applied.get(write.target)?.has(cellKey(write.x, write.y))) return;
    }
  }
  let changed = false;
  for (const write of writes) {
    const target = context.findTarget(write.target, write.gid !== 0);
    if (!target || (target.locked && !rule.options.ignoreLock)) continue;
    if (!context.targetDocument.infinite && !insideFiniteMap(context.targetDocument, write.x, write.y)) {
      if (context.targetDocument.width <= 0 || context.targetDocument.height <= 0) continue;
      if (mapOptions.wrapBorder) {
        write.x = positiveModulo(write.x, context.targetDocument.width);
        write.y = positiveModulo(write.y, context.targetDocument.height);
      } else continue;
    }
    if (writeWorkingTile(target, write.x, write.y, write.gid, context, rule)) changed = true;
    if (rule.options.noOverlappingOutput) mapEntry(applied, write.target, () => new Set()).add(cellKey(write.x, write.y));
  }
  context.matchLog.push({
    ruleId: rule.id,
    rulePath: rule.rulePath,
    x: position.x,
    y: position.y,
    changed,
    outputIndex: selected?.index || null,
  });
}

function deleteOutputTiles(compiled, context, region) {
  const occupied = new Set();
  for (const name of compiled.inputTargets) {
    const layer = context.findTarget(name, false);
    if (!layer) continue;
    for (const cell of workingLayerCells(layer)) {
      if (cell.gid && pointInRegion(cell.x, cell.y, region)) occupied.add(cellKey(cell.x, cell.y));
    }
  }
  for (const name of compiled.outputTargets) {
    const layer = context.findTarget(name, false);
    if (!layer || layer.locked) continue;
    for (const key of occupied) {
      const { x, y } = parseCellKey(key);
      writeWorkingTile(layer, x, y, 0, context, { id: `${compiled.rulePath}#DeleteTiles`, rulePath: compiled.rulePath });
    }
  }
}

function compileInputSet(index, targets, inputRegion, inputBounds, matchTypes, remapGid) {
  const compiledTargets = [];
  let hasIgnore = false;
  for (const [targetName, condition] of [...targets].sort(([left], [right]) => left.localeCompare(right))) {
    const usedTiles = collectUsedTiles(condition.yes, inputRegion, matchTypes, remapGid);
    const positions = [];
    for (const key of inputRegion) {
      const { x, y } = parseCellKey(key);
      const any = [];
      const none = [];
      let negate = false;
      for (const inputLayer of condition.yes) {
        const compiled = inputCondition(inputLayer, x, y, false, usedTiles, matchTypes, remapGid);
        any.push(...compiled.any);
        none.push(...compiled.none);
        negate ||= compiled.negate;
        hasIgnore ||= compiled.ignore;
      }
      for (const inputLayer of condition.no) {
        const compiled = inputCondition(inputLayer, x, y, true, usedTiles, matchTypes, remapGid);
        any.push(...compiled.any);
        none.push(...compiled.none);
        negate ||= compiled.negate;
        hasIgnore ||= compiled.ignore;
      }
      let optimizedAny = uniqueConditions(negate ? none : any);
      let optimizedNone = uniqueConditions(negate ? any : none);
      if (optimizedAny.length) {
        const denied = new Set(optimizedNone.map(conditionKey));
        optimizedAny = optimizedAny.filter((entry) => !denied.has(conditionKey(entry)));
        optimizedNone = [];
        if (!optimizedAny.length) return null;
      }
      if (optimizedAny.length || optimizedNone.length) {
        positions.push(Object.freeze({
          x: x - inputBounds.minX,
          y: y - inputBounds.minY,
          any: Object.freeze(optimizedAny),
          none: Object.freeze(optimizedNone),
        }));
      }
    }
    if (positions.length) compiledTargets.push(Object.freeze({ name: targetName, positions: Object.freeze(positions) }));
  }
  if (!compiledTargets.length && !hasIgnore) return null;
  return Object.freeze({ index, targets: Object.freeze(compiledTargets), hasIgnore });
}

function inputCondition(inputLayer, x, y, negative, usedTiles, matchTypes, remapGid) {
  const encoded = layerTileAt(inputLayer.layer, x, y);
  if (!encoded) {
    if (!inputLayer.strictEmpty) return EMPTY_INPUT_RESULT;
    return negative
      ? { any: [], none: [EMPTY_CONDITION], negate: false, ignore: false }
      : { any: [EMPTY_CONDITION], none: [], negate: false, ignore: false };
  }
  const matchType = matchTypes.get(decodeGlobalTileId(encoded).gid) || "Tile";
  if (matchType === "Ignore") return { any: [], none: [], negate: false, ignore: true };
  if (matchType === "Negate") return { any: [], none: [], negate: true, ignore: false };
  const positive = [];
  const denied = [];
  if (matchType === "Empty") positive.push(EMPTY_CONDITION);
  else if (matchType === "NonEmpty") denied.push(EMPTY_CONDITION);
  else if (matchType === "Other") denied.push(...usedTiles);
  else positive.push(exactCondition(remapGid(encoded), inputLayer.flagsMask));
  return negative
    ? { any: denied, none: positive, negate: false, ignore: false }
    : { any: positive, none: denied, negate: false, ignore: false };
}

function compileOutputSet(outputSet, outputRegion, matchTypes, remapGid) {
  if (!outputSet) return null;
  const writes = [];
  for (const { layer, target } of outputSet.layers) {
    for (const key of outputRegion) {
      const { x, y } = parseCellKey(key);
      const encoded = layerTileAt(layer, x, y);
      if (!encoded) continue;
      const matchType = matchTypes.get(decodeGlobalTileId(encoded).gid) || "Tile";
      if (matchType === "Tile") writes.push(Object.freeze({ target, x, y, gid: Number(remapGid(encoded)) >>> 0 }));
      else if (matchType === "Empty") writes.push(Object.freeze({ target, x, y, gid: 0 }));
    }
  }
  return Object.freeze({
    index: outputSet.index,
    probability: Number.isFinite(outputSet.probability) ? Math.max(0, outputSet.probability) : 1,
    writes: Object.freeze(writes),
  });
}

function compileInputLayer(layer) {
  let flagsMask = (BASE_GID_MASK | FLIP_MASK) >>> 0;
  if (booleanProperty(layer.properties, "IgnoreHorizontalFlip", false)) flagsMask &= ~TILED_FLIP_FLAGS.horizontal;
  if (booleanProperty(layer.properties, "IgnoreVerticalFlip", false)) flagsMask &= ~TILED_FLIP_FLAGS.vertical;
  if (booleanProperty(layer.properties, "IgnoreDiagonalFlip", false)) flagsMask &= ~TILED_FLIP_FLAGS.diagonal;
  if (booleanProperty(layer.properties, "IgnoreHexRotate120", false)) flagsMask &= ~TILED_FLIP_FLAGS.rotatedHex120;
  return Object.freeze({
    layer,
    strictEmpty: booleanProperty(layer.properties, "AutoEmpty", booleanProperty(layer.properties, "StrictEmpty", false)),
    flagsMask: flagsMask >>> 0,
  });
}

function collectUsedTiles(inputLayers, inputRegion, matchTypes, remapGid) {
  const result = [];
  for (const inputLayer of inputLayers) {
    for (const key of inputRegion) {
      const { x, y } = parseCellKey(key);
      const encoded = layerTileAt(inputLayer.layer, x, y);
      if (!encoded) continue;
      const type = matchTypes.get(decodeGlobalTileId(encoded).gid) || "Tile";
      if (type === "Tile") result.push(exactCondition(remapGid(encoded), inputLayer.flagsMask));
      else if (type === "Empty") result.push(EMPTY_CONDITION);
    }
  }
  return uniqueConditions(result);
}

function matchTypeByGid(ruleDocument, loadedTilesets) {
  const byFirstgid = new Map();
  for (const entry of loadedTilesets) {
    if (Number.isSafeInteger(entry?.firstgid) && entry.definition) byFirstgid.set(entry.firstgid, entry.definition);
  }
  const result = new Map();
  for (const reference of Array.isArray(ruleDocument.tilesets) ? ruleDocument.tilesets : []) {
    const definition = reference.source ? byFirstgid.get(reference.firstgid) : reference;
    if (!definition) continue;
    for (const tile of Array.isArray(definition.tiles) ? definition.tiles : []) {
      const value = propertyValue(tile.properties, "MatchType", null);
      if (typeof value === "string" && SUPPORTED_MATCH_TYPES.has(value)) {
        result.set(reference.firstgid + tile.id, value);
      }
    }
  }
  return result;
}

function compileOptionAreas(layer, document) {
  const tileWidth = Math.max(1, Number(document.tilewidth) || 1);
  const tileHeight = Math.max(1, Number(document.tileheight) || 1);
  const areas = [];
  for (const object of Array.isArray(layer.objects) ? layer.objects : []) {
    if (object.rotation || object.ellipse || object.point || object.polygon || object.polyline || object.text || object.gid) {
      throw automapError(
        "TILED_AUTOMAP_RULE_OPTION_SHAPE_UNSUPPORTED",
        "rule_options 只支持未旋转的矩形对象",
        { objectId: object.id },
      );
    }
    const minX = Math.floor(Number(object.x || 0) / tileWidth);
    const minY = Math.floor(Number(object.y || 0) / tileHeight);
    const maxX = Math.ceil((Number(object.x || 0) + Number(object.width || 0)) / tileWidth) - 1;
    const maxY = Math.ceil((Number(object.y || 0) + Number(object.height || 0)) / tileHeight) - 1;
    areas.push(Object.freeze({ minX, minY, maxX, maxY, options: ruleOptions(object.properties, true) }));
  }
  return areas;
}

function ruleOptions(properties, partial = false) {
  const defaults = partial ? {} : {
    probability: 1,
    modX: 1,
    modY: 1,
    offsetX: 0,
    offsetY: 0,
    disabled: false,
    noOverlappingOutput: false,
    ignoreLock: false,
  };
  const result = { ...defaults };
  assignProperty(result, "probability", properties, "Probability", (value) => Math.max(0, Math.min(1, Number(value))));
  assignProperty(result, "modX", properties, "ModX", (value) => Math.max(1, Math.trunc(Number(value)) || 1));
  assignProperty(result, "modY", properties, "ModY", (value) => Math.max(1, Math.trunc(Number(value)) || 1));
  assignProperty(result, "offsetX", properties, "OffsetX", (value) => Math.trunc(Number(value)) || 0);
  assignProperty(result, "offsetY", properties, "OffsetY", (value) => Math.trunc(Number(value)) || 0);
  assignProperty(result, "disabled", properties, "Disabled", Boolean);
  assignProperty(result, "noOverlappingOutput", properties, "NoOverlappingOutput", Boolean);
  assignProperty(result, "ignoreLock", properties, "IgnoreLock", Boolean);
  return result;
}

function createWorkingLayer(layer) {
  return {
    id: layer.id,
    name: layer.name,
    locked: layer.locked === true,
    finite: Array.isArray(layer.data),
    startX: Number(layer.startx || 0),
    startY: Number(layer.starty || 0),
    width: Number(layer.width || 0),
    height: Number(layer.height || 0),
    cells: new Map(nonemptyLayerCells(layer).map(({ x, y, gid }) => [cellKey(x, y), gid])),
  };
}

function createMissingWorkingLayer(name, document) {
  const layer = {
    type: "tilelayer",
    name,
    width: document.infinite ? 0 : document.width,
    height: document.infinite ? 0 : document.height,
    opacity: 1,
    visible: true,
    x: 0,
    y: 0,
    ...(document.infinite ? { chunks: [] } : { data: new Array(document.width * document.height).fill(0) }),
  };
  return {
    id: null,
    name,
    locked: false,
    finite: !document.infinite,
    startX: 0,
    startY: 0,
    width: document.width,
    height: document.height,
    cells: new Map(),
    layer,
  };
}

function readWorkingTile(layer, x, y, document, mapOptions) {
  if (!layer) return 0;
  let targetX = x;
  let targetY = y;
  if (!document.infinite && !insideFiniteMap(document, x, y)) {
    if (mapOptions.wrapBorder) {
      targetX = positiveModulo(x, document.width);
      targetY = positiveModulo(y, document.height);
    } else if (mapOptions.overflowBorder) {
      targetX = Math.max(0, Math.min(document.width - 1, x));
      targetY = Math.max(0, Math.min(document.height - 1, y));
    } else return 0;
  }
  return layer.cells.get(cellKey(targetX, targetY)) || 0;
}

function writeWorkingTile(layer, x, y, gid, context, rule) {
  const key = cellKey(x, y);
  const beforeNow = layer.cells.get(key) || 0;
  const after = Number(gid) >>> 0;
  if (beforeNow === after) return false;
  const logKey = `${layer.id ?? `new:${layer.name}`}\0${key}`;
  const existing = context.changeLog.get(logKey);
  if (after) layer.cells.set(key, after);
  else layer.cells.delete(key);
  const change = {
    layerId: layer.id,
    layerName: layer.name,
    x,
    y,
    before: existing?.before ?? beforeNow,
    after,
    ruleId: rule.id,
    rulePath: rule.rulePath,
  };
  if (change.before === change.after) context.changeLog.delete(logKey);
  else context.changeLog.set(logKey, change);
  if (context.changeLog.size > context.maximumChanges) {
    throw automapError(
      "TILED_AUTOMAP_CHANGE_LIMIT",
      `Automapping 修改超过上限 ${context.maximumChanges}`,
      { maximumChanges: context.maximumChanges },
    );
  }
  return true;
}

function* workingLayerCells(layer) {
  for (const [key, gid] of layer.cells) yield { ...parseCellKey(key), gid };
}

function* nonemptyLayerCells(layer) {
  if (Array.isArray(layer.data)) {
    const startX = Number(layer.startx || 0);
    const startY = Number(layer.starty || 0);
    const width = Number(layer.width || 0);
    for (let index = 0; index < layer.data.length; index += 1) {
      const gid = Number(layer.data[index]) >>> 0;
      if (gid) yield { x: startX + index % width, y: startY + Math.floor(index / width), gid };
    }
    return;
  }
  for (const chunk of Array.isArray(layer.chunks) ? layer.chunks : []) {
    for (let index = 0; index < chunk.data.length; index += 1) {
      const gid = Number(chunk.data[index]) >>> 0;
      if (gid) yield { x: chunk.x + index % chunk.width, y: chunk.y + Math.floor(index / chunk.width), gid };
    }
  }
}

function layerTileAt(layer, x, y) {
  if (Array.isArray(layer.data)) {
    const startX = Number(layer.startx || 0);
    const startY = Number(layer.starty || 0);
    const width = Number(layer.width || 0);
    const height = Number(layer.height || 0);
    if (x < startX || y < startY || x >= startX + width || y >= startY + height) return 0;
    return Number(layer.data[(y - startY) * width + x - startX]) >>> 0;
  }
  const chunk = (layer.chunks || []).find((entry) => (
    x >= entry.x && y >= entry.y && x < entry.x + entry.width && y < entry.y + entry.height
  ));
  return chunk ? Number(chunk.data[(y - chunk.y) * chunk.width + x - chunk.x]) >>> 0 : 0;
}

function connectedComponents(cells) {
  const remaining = new Set(cells);
  const result = [];
  while (remaining.size) {
    const start = remaining.values().next().value;
    remaining.delete(start);
    const component = new Set([start]);
    const pending = [parseCellKey(start)];
    while (pending.length) {
      const { x, y } = pending.pop();
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const key = cellKey(x + dx, y + dy);
          if (!remaining.delete(key)) continue;
          component.add(key);
          pending.push({ x: x + dx, y: y + dy });
        }
      }
    }
    result.push(component);
  }
  return result.sort((left, right) => {
    const a = cellBounds(left);
    const b = cellBounds(right);
    return a.minY - b.minY || a.minX - b.minX;
  });
}

function normalizedApplyRegion(document, value, radius) {
  let region;
  if (value) {
    const x = integer(value.x, "region.x");
    const y = integer(value.y, "region.y");
    const width = positiveInteger(value.width, "region.width");
    const height = positiveInteger(value.height, "region.height");
    region = { minX: x, minY: y, maxX: x + width - 1, maxY: y + height - 1 };
  } else if (!document.infinite) {
    if (!document.width || !document.height) return null;
    region = { minX: 0, minY: 0, maxX: document.width - 1, maxY: document.height - 1 };
  } else {
    const cells = flattenLayers(document.layers)
      .filter(({ layer }) => layer.type === "tilelayer")
      .flatMap(({ layer }) => [...nonemptyLayerCells(layer)]);
    if (!cells.length) return null;
    region = cellBounds(new Set(cells.map(({ x, y }) => cellKey(x, y))));
  }
  if (!region) return null;
  return {
    minX: region.minX - radius,
    minY: region.minY - radius,
    maxX: region.maxX + radius,
    maxY: region.maxY + radius,
  };
}

function ruleCandidateBounds(document, region, width, height, matchOutsideMap) {
  if (!region) return null;
  let bounds = {
    minX: region.minX - width + 1,
    minY: region.minY - height + 1,
    maxX: region.maxX,
    maxY: region.maxY,
  };
  if (!document.infinite && !matchOutsideMap) {
    bounds = {
      minX: Math.max(0, bounds.minX),
      minY: Math.max(0, bounds.minY),
      maxX: Math.min(document.width - width, bounds.maxX),
      maxY: Math.min(document.height - height, bounds.maxY),
    };
  }
  return bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY ? bounds : null;
}

function pointInRegion(x, y, region) {
  return region && x >= region.minX && y >= region.minY && x <= region.maxX && y <= region.maxY;
}

function conditionMatches(condition, value) {
  if (condition.type === "empty") return value === 0;
  return ((Number(value) >>> 0) & condition.mask) === condition.gid;
}

function exactCondition(gid, mask) {
  const normalizedMask = Number(mask) >>> 0;
  return Object.freeze({ type: "exact", gid: (Number(gid) >>> 0) & normalizedMask, mask: normalizedMask });
}

const EMPTY_CONDITION = Object.freeze({ type: "empty" });
const EMPTY_INPUT_RESULT = Object.freeze({ any: [], none: [], negate: false, ignore: false });

function uniqueConditions(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = conditionKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function conditionKey(value) {
  return value.type === "empty" ? "empty" : `exact:${value.gid}:${value.mask}`;
}

function weightedOutput(outputs, random) {
  if (!outputs.length) return null;
  const total = outputs.reduce((sum, output) => sum + output.probability, 0);
  if (!(total > 0)) return outputs[0];
  let value = random() * total;
  for (const output of outputs) {
    value -= output.probability;
    if (value < 0) return output;
  }
  return outputs.at(-1);
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 0x1_0000_0000;
  };
}

function normalizeSeed(value) {
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw automapError("TILED_AUTOMAP_SEED_INVALID", "Automapping seed 必须是 0 到 4294967295 的整数");
  }
  return seed >>> 0;
}

function normalizeMapFilter(value, line) {
  const filter = String(value || "").trim();
  if (!filter || filter.includes("/") || filter.includes("\\") || /[\u0000-\u001f\u007f]/u.test(filter)) {
    throw automapError("TILED_AUTOMAP_FILTER_INVALID", `Automapping 地图筛选器第 ${line} 行无效`, { line });
  }
  return filter;
}

function mapFilterMatches(filter, filename) {
  const pattern = `^${filter.split("*").map(escapeRegExp).join(".*")}$`;
  return new RegExp(pattern, "u").test(filename);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function rulesPath(value) {
  const normalized = normalizeTiledProjectPath(value || "rules.txt");
  if (!normalized.toLowerCase().endsWith(".txt")) throw new TypeError("sourcePath must end in .txt");
  return normalized;
}

function parseInputLayerName(value) {
  const match = /^(inputnot|input)([^_]*)_(.+)$/iu.exec(value);
  return match ? { negative: match[1].toLowerCase() === "inputnot", index: match[2], target: match[3] } : null;
}

function parseOutputLayerName(value) {
  const match = /^output([^_]*)_(.+)$/iu.exec(value);
  return match ? { index: match[1], target: match[2] } : null;
}

function flattenLayers(layers, result = []) {
  for (const layer of Array.isArray(layers) ? layers : []) {
    result.push({ layer });
    if (layer?.type === "group") flattenLayers(layer.layers, result);
  }
  return result;
}

function validateMap(document, label) {
  if (!document || document.type !== "map" || !Array.isArray(document.layers)) {
    throw automapError("TILED_AUTOMAP_MAP_INVALID", `${label}必须是已解析的 Tiled TMJ 地图`);
  }
}

function validateSupportedOrientation(document, label) {
  const orientation = document.orientation || "orthogonal";
  if (["hexagonal", "staggered"].includes(orientation)) {
    throw automapError(
      "TILED_AUTOMAP_ORIENTATION_UNSUPPORTED",
      `${label}的 ${orientation} Automapping 尚未支持；Tiled 官方也注明六边形规则不完整`,
      { orientation },
    );
  }
}

function assertDecodedLayer(layer, rulePath) {
  if (typeof layer.data === "string" || layer.chunks?.some((chunk) => typeof chunk.data === "string")) {
    throw automapError(
      "TILED_AUTOMAP_LAYER_ENCODED",
      `Automapping 前必须先解码瓦片层 ${layer.name || layer.id}`,
      { rulePath, layerId: layer.id },
    );
  }
}

function cellBounds(cells) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const key of cells) {
    const { x, y } = typeof key === "string" ? parseCellKey(key) : key;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function parseCellKey(key) {
  const separator = key.indexOf(",");
  return { x: Number(key.slice(0, separator)), y: Number(key.slice(separator + 1)) };
}

function areaContains(area, point) {
  return point.x >= area.minX && point.y >= area.minY && point.x <= area.maxX && point.y <= area.maxY;
}

function insideFiniteMap(document, x, y) {
  return x >= 0 && y >= 0 && x < document.width && y < document.height;
}

function compareChanges(left, right) {
  return String(left.layerName).localeCompare(String(right.layerName)) || left.y - right.y || left.x - right.x;
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function propertyValue(properties, name, fallback) {
  const property = (Array.isArray(properties) ? properties : []).find((entry) => (
    String(entry?.name || "").toLowerCase() === name.toLowerCase()
  ));
  return property ? property.value : fallback;
}

function booleanProperty(properties, name, fallback) {
  const value = propertyValue(properties, name, fallback);
  return value === true || value === 1 || (typeof value === "string" && value.toLowerCase() === "true");
}

function numericProperty(properties, name, fallback) {
  const value = propertyValue(properties, name, fallback);
  if (value === fallback) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integerProperty(properties, name, fallback) {
  return Math.trunc(numericProperty(properties, name, fallback));
}

function assignProperty(target, key, properties, name, transform) {
  const sentinel = Symbol(name);
  const value = propertyValue(properties, name, sentinel);
  if (value !== sentinel) target[key] = transform(value);
}

function mapEntry(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}

function identityGid(value) {
  return Number(value) >>> 0;
}

function boundedLimit(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  return positiveInteger(value, name);
}

function integer(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} must be a safe integer`);
  return number;
}

function positiveInteger(value, name) {
  const number = integer(value, name);
  if (number <= 0) throw new TypeError(`${name} must be positive`);
  return number;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  const error = new Error("Automapping 已取消");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

function automapError(code, message, details = {}, options = {}) {
  return new TiledAutomapError(code, message, details, options);
}
