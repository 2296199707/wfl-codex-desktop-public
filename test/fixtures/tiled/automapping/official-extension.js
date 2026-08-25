/*
 * Loaded as an isolated Tiled 1.12.2 extension by the compatibility script.
 * Placeholders are replaced with JSON string literals before execution.
 */
const sourcePath = __WFL_SOURCE_PATH__;
const rulesPath = __WFL_RULES_PATH__;
const outputPath = __WFL_OUTPUT_PATH__;

function runOfficialAutomapping(asset) {
  if (!asset || !asset.isTileMap || asset.fileName !== sourcePath) return;
  asset.autoMap(rulesPath);
  const format = tiled.mapFormatForFile(outputPath);
  if (!format) throw new Error(`Unable to resolve Tiled map format for: ${outputPath}`);
  const error = format.write(asset, outputPath);
  if (error) throw new Error(String(error));
}

tiled.assetOpened.connect(runOfficialAutomapping);
for (const asset of tiled.openAssets) runOfficialAutomapping(asset);
