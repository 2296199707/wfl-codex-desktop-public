import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const html = await fs.readFile(new URL("../public/users.html", import.meta.url), "utf8");
const app = await fs.readFile(new URL("../public/users.js", import.meta.url), "utf8");
const css = await fs.readFile(new URL("../public/users.css", import.meta.url), "utf8");
const opsCss = await fs.readFile(new URL("../public/ops.css", import.meta.url), "utf8");
const version = (await fs.readFile(new URL("../VERSION", import.meta.url), "utf8")).trim();

test("user management page registers unique and complete elements", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  const registry = app.match(/const elements = Object\.fromEntries\(\[[\s\S]*?\]\.map/)?.[0];
  assert.ok(registry);
  const registeredIds = [...registry.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((match) => match[1]);
  for (const id of registeredIds) assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
});

test("management and operations pages keep vertical touch scrolling on their scroll containers", () => {
  assert.match(css, /main \{[^\n]*overflow: auto;[^\n]*touch-action: pan-y;[^\n]*-webkit-overflow-scrolling: touch;/);
  assert.match(css, /\.user-list \{[^\n]*touch-action: pan-y;[^\n]*-webkit-overflow-scrolling: touch;/);
  assert.match(css, /\.user-detail \{[^\n]*touch-action: pan-y;[^\n]*-webkit-overflow-scrolling: touch;/);
  assert.match(opsCss, /\.ops-main \{[^\n]*touch-action: pan-y;[^\n]*-webkit-overflow-scrolling: touch;/);
  assert.match(opsCss, /\.ops-tabs \{[^\n]*touch-action: pan-x;[^\n]*-webkit-overflow-scrolling: touch;/);
});

test("user management is local, responsive, and version synchronized", () => {
  assert.match(html, /name="viewport"/);
  assert.match(html, /src="\/vendor\/lucide\/lucide\.min\.js(?:\?v=[^"]+)?"/);
  assert.match(html, new RegExp(`/i18n\\.js\\?v=${version.replaceAll(".", "\\.")}`));
  assert.match(html, /data-language-toggle/);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
  assert.match(css, /@media \(max-width: 860px\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /body:has\(dialog\[open\]\)/);
  assert.match(css, /\.dialog-body[^\n]*overflow-y: auto/);
  assert.match(css, /html\[data-embed="ops"\]/);
  assert.match(app, /embeddedInOps/);
  assert.match(app, /"\/ops#users"/);
  assert.match(html, new RegExp(`/users\\.css\\?v=${version.replaceAll(".", "\\.")}`));
  assert.match(html, new RegExp(`/users\\.js\\?v=${version.replaceAll(".", "\\.")}`));
  assert.match(html, new RegExp(`v${version.replaceAll(".", "\\.")}`));
});

test("user management exposes guarded defaults, tiers, account, provider, and sharing workflows", () => {
  for (const id of ["savePolicyButton", "addTierButton", "tierDialog", "userTierSelect", "userTierExpiresAt", "applyTierButton", "createInviteButton", "currentTierStatus", "currentTierName", "currentTierMeta", "currentProviderStatus", "currentProviderName", "currentProviderMeta", "officialLoginPermission", "defaultOfficialLogin", "tierOfficialLogin", "codexWorkspaceMessagesPermission", "defaultCodexWorkspaceMessages", "tierCodexWorkspaceMessages", "codexRemoteDiffPermission", "defaultCodexRemoteDiff", "tierCodexRemoteDiff", "codexFeedbackPermission", "defaultCodexFeedback", "tierCodexFeedback", "totalUsage", "fiveHourUsage", "sevenDayUsage", "monthlyUsage", "todayUsage", "fiveHourLimit", "weeklyLimit", "monthlyLimit", "providerState", "assignProviderButton", "unassignProviderButton", "imageProviderState", "imageProviderSelect", "imageModelInput", "imagePresetInput", "imageSizeInput", "imageOutputFormatInput", "imageOutputCompressionInput", "imageBackgroundInput", "imageModerationInput", "imageResultCountInput", "imagePartialImagesInput", "imageTimeoutInput", "imageMaxInputBytesPerImageInput", "imageMaxInputBytesTotalInput", "imageMaxOutputBytesPerImageInput", "imageMaxResponseBytesInput", "assignImageProviderButton", "unassignImageProviderButton", "createShareButton"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /\/api\/multi-user\/settings/);
  assert.match(app, /fiveHourTokenLimit/);
  assert.match(app, /weeklyTokenLimit/);
  assert.match(app, /monthlyTokenLimit/);
  assert.match(app, /officialLogin/);
  assert.match(app, /codexWorkspaceMessages/);
  assert.match(app, /codexRemoteDiff/);
  assert.match(app, /codexFeedback/);
  assert.match(app, /action: "multi-user-invite"/);
  assert.match(app, /action: "multi-user-user-update"/);
  assert.match(app, /action: "multi-user-provider-assign"/);
  assert.match(app, /action: "multi-user-provider-unassign"/);
  assert.match(app, /action: "multi-user-image-provider-assign"/);
  assert.match(app, /action: "multi-user-image-provider-unassign"/);
  assert.match(app, /action: "multi-user-policy-update"/);
  assert.match(app, /"multi-user-tier-create"/);
  assert.match(app, /"multi-user-tier-update"/);
  assert.match(app, /action: "multi-user-tier-remove"/);
  assert.match(app, /action: "multi-user-tier-apply"/);
  assert.match(app, /tierExpiresAt/);
  assert.match(app, /长期有效/);
  assert.match(html, /id="userImageModelPresets"[\s\S]*gpt-image-2/);
  assert.match(html, /id="imagePresetInput"[\s\S]*value="generation-only"[\s\S]*value="openai-gpt-image-2"/);
  assert.match(html, /id="imageSizeInput"[^>]*type="text"[^>]*auto/);
  assert.match(app, /preset: elements\.imagePresetInput\.value/);
  assert.match(app, /defaults: \{/);
  assert.match(app, /limits: imageProviderLimitsDraft\(\)/);
  assert.match(app, /imageProvider\?\.defaults \|\| \{\}/);
  assert.match(app, /imageProvider\?\.limits \|\| \{\}/);
  assert.doesNotMatch(app, /imagePresetInput\.addEventListener/);
  assert.match(app, /providerStateLabel/);
  assert.match(app, /renderCurrentAssignments/);
  assert.match(app, /分配已保存，等待运行时同步/);
  assert.match(app, /reportingStatus === "idle"/);
  assert.match(app, /本周期暂无对话/);
  assert.match(app, /user\.tokenUsage\?\.total/);
  assert.match(app, /user\.tokenUsage\?\.fiveHour/);
  assert.match(app, /user\.tokenUsage\?\.sevenDay/);
  assert.match(app, /user\.tokenUsage\?\.monthly/);
  assert.match(app, /user\.tokenUsage\?\.today/);
  assert.match(app, /action: "multi-user-project-share"/);
  assert.match(app, /method: "DELETE", action: "multi-user-project-unshare"/);
  assert.doesNotMatch(app, /localStorage[^\n]*(?:password|apiKey|invite)/i);
});
