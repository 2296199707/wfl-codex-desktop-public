import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const css = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");

test("administrator image settings expose the complete schema v2 surface", () => {
  for (const id of [
    "imageApiPresetInput",
    "imageApiModelInput",
    "imageApiSizeInput",
    "imageApiQualityInput",
    "imageApiOutputFormatInput",
    "imageApiOutputCompressionInput",
    "imageApiBackgroundInput",
    "imageApiModerationInput",
    "imageApiNInput",
    "imageApiPartialImagesInput",
    "imageApiMaskInput",
    "imageApiMultiInput",
    "imageApiStreamingInput",
    "imageApiGenerateCustomSizeInput",
    "imageApiGenerateSizesInput",
    "imageApiEditCustomSizeInput",
    "imageApiEditSizesInput",
    "imageApiOutpaintCustomSizeInput",
    "imageApiOutpaintSizesInput",
    "imageApiProbeButton",
    "imageApiProbeStatus",
    "imageApiProbeResults",
    "imageApiMaxInputImagesInput",
    "imageApiMaxOutputsInput",
    "imageApiMaxPartialImagesInput",
    "imageApiTimeoutMsInput",
    "imageApiMaxInputBytesPerImageInput",
    "imageApiMaxInputBytesTotalInput",
    "imageApiMaxOutputBytesPerImageInput",
    "imageApiMaxResponseBytesInput",
  ]) assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);

  assert.match(html, /id="imageApiPresetInput"[\s\S]*value="generation-only"[\s\S]*value="openai-gpt-image-2"/);
  assert.match(html, /id="imageApiSizeInput"[^>]*list="imageApiSizePresets"[^>]*pattern="\(\?:auto\|/);
  assert.match(html, /name="imageApiOperation" value="outpaint"/);
  assert.match(html, /name="imageApiInputFormat" value="webp"/);
  assert.match(html, /name="imageApiOutputFormat" value="jpeg"/);
  assert.match(html, /name="imageApiQuality" value="high"/);
  assert.match(html, /name="imageApiBackground" value="opaque"/);
  assert.match(html, /name="imageApiModeration" value="low"/);
  assert.match(html, /按操作尺寸能力/);
  assert.match(html, /管理员手动声明真实供应商能力/);
  assert.match(html, /真实请求，可能计费；报告不会自动修改任何设置/);
});

test("image presets change only through the explicit administrator selector", () => {
  assert.match(app, /const IMAGE_API_ADMIN_PRESETS = Object\.freeze\(\{/);
  assert.match(app, /elements\.imageApiPresetInput\.addEventListener\("change", \(\) => \{[\s\S]*populateImageApiAdminFields\(preset\)/);
  assert.match(app, /function imageApiAdminPreset\(presetId\)/);
  assert.doesNotMatch(app, /imageApiModelInput\.addEventListener\([\s\S]{0,200}(?:preset|Preset)/);
  assert.doesNotMatch(app, /state\.imageApi\.model[\s\S]{0,120}(?:includes|startsWith|match)[\s\S]{0,120}(?:preset|Preset)/);
  assert.match(app, /acknowledgeCharges: true/);
  assert.match(app, /不会自动重试或修改能力设置/);
});

test("image settings submit complete nested settings while preserving unedited fields", () => {
  const collect = app.match(/function collectImageApiAdminSettings\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(collect, /const retainCurrent = state\.imageApi\.preset === preset/);
  assert.match(collect, /const baseline = retainCurrent \? state\.imageApi : presetDefaults/);
  assert.match(collect, /\.\.\.\(baseline\.capabilities \|\| \{\}\)/);
  assert.match(collect, /\.\.\.\(baseline\.limits \|\| \{\}\)/);
  assert.match(collect, /\.\.\.\(baseline\.defaults \|\| \{\}\)/);
  assert.match(collect, /operationCapabilities/);
  assert.match(collect, /return \{ preset, capabilities, operationCapabilities, limits, defaults \}/);
  assert.match(app, /body: JSON\.stringify\(\{[\s\S]*providerId: elements\.imageApiProviderInput\.value,[\s\S]*model: elements\.imageApiModelInput\.value\.trim\(\),[\s\S]*\.\.\.settings/);
  assert.match(app, /function setImageApiControlsEditable\(editable\)/);
  assert.match(app, /configured \? "此图片供应商由管理员分配" : "管理员尚未分配图片供应商"/);
});

test("image settings remain usable on narrow screens", () => {
  assert.match(css, /\.image-api-settings-grid \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*\.image-api-settings-grid,[\s\S]*\.image-api-capability-groups,[\s\S]*\.image-api-operation-size-grid \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.image-api-form-body \{[\s\S]*gap: 12px/);
});
