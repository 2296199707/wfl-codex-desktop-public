import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createAuthRecord, writeAuth } from "../../lib/auth.mjs";

const projectDirectory = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const fakeCodex = path.join(projectDirectory, "test", "fixtures", "fake-codex-app-server.mjs");
const screenshots = path.join(projectDirectory, "test-results");
const password = "owner-password-1234";
let baseUrl;
let browser;
let child;
let directory;
let inviteToken;
let ownerCookie;
let ownerProviderId;
let serverOutput = "";

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-multi-user-browser-"));
  const projectRoot = path.join(directory, "projects");
  const defaultProject = path.join(projectRoot, "owner-workspace");
  const stateDirectory = path.join(directory, "state");
  const fakeBin = path.join(directory, "bin");
  const codexSkillDirectory = path.join(defaultProject, ".codex", "skills", "release-check");
  await Promise.all([
    fs.mkdir(defaultProject, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    fs.mkdir(codexSkillDirectory, { recursive: true }),
    fs.mkdir(screenshots, { recursive: true }),
  ]);
  await fs.writeFile(
    path.join(codexSkillDirectory, "SKILL.md"),
    "---\nname: release-check\ndescription: Check release readiness\n---\n\nInspect the current release.\n",
  );
  const authFile = path.join(directory, "auth.json");
  await writeAuth(authFile, createAuthRecord("owner", password));
  await fs.writeFile(
    path.join(fakeBin, "codex"),
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
    { mode: 0o755 },
  );
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_DEFAULT_PROJECT: defaultProject,
      CODEX_DESKTOP_AUTH_FILE: authFile,
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_SOURCE_DIR: projectDirectory,
      CODEX_DESKTOP_RUNTIME_DIR: path.join(directory, "runtime"),
      CODEX_DESKTOP_RESCUE_MODE: "0",
      CODEX_DESKTOP_RESCUE_SLOT: "",
      CODEX_DESKTOP_RESCUE_SESSION_DIR: "",
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_BACKEND_ENTRY: "",
      CODEX_DESKTOP_MULTI_USER_ROOT: path.join(directory, "managed-users"),
      CODEX_DESKTOP_MULTI_USER_TEST_MODE: "1",
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      FAKE_CODEX_PROJECT: defaultProject,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (serverOutput = `${serverOutput}${chunk}`.slice(-12_000)));
  child.stderr.on("data", (chunk) => (serverOutput = `${serverOutput}${chunk}`.slice(-12_000)));
  await waitForOutput(child, "WFL Codex Desktop v");
  await waitForDeepReady(baseUrl);

  const authorization = `Basic ${Buffer.from(`owner:${password}`).toString("base64")}`;
  const enabled = await fetch(`${baseUrl}/api/multi-user/enable`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "multi-user-enable",
    },
    body: JSON.stringify({ password }),
  });
  assert.equal(
    enabled.status,
    202,
    `multi-user enable failed: ${await enabled.clone().text()}\n${serverOutput}`,
  );
  ownerCookie = cookieFrom(enabled);
  const announcement = await fetch(`${baseUrl}/api/announcement/publish`, {
    method: "POST",
    headers: {
      Cookie: ownerCookie,
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "announcement-publish",
    },
    body: JSON.stringify({
      category: "update",
      title: "Browser test announcement",
      body: "All signed-in users can read this published update.",
    }),
  });
  assert.equal(announcement.status, 200);
  const provider = await fetch(`${baseUrl}/api/providers`, {
    method: "POST",
    headers: { Cookie: ownerCookie, Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Browser assigned provider",
      baseUrl: "https://browser.example/v1",
      model: "gpt-smoke",
      apiKey: "browser-provider-secret",
    }),
  });
  assert.equal(provider.status, 201);
  ownerProviderId = (await provider.json()).profile.id;
  const invited = await fetch(`${baseUrl}/api/multi-user/invites`, {
    method: "POST",
    headers: {
      Cookie: ownerCookie,
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "multi-user-invite",
    },
    body: JSON.stringify({ role: "member", quotaBytes: 1024 ** 3, expiresHours: 2 }),
  });
  assert.equal(invited.status, 201);
  inviteToken = (await invited.json()).invite.token;
  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
});

after(async () => {
  await browser?.close();
  child?.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child?.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  await fs.rm(directory, { recursive: true, force: true });
});

test("invite registration and role-specific settings remain bounded on mobile and tablet", { timeout: 40_000 }, async () => {
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const memberPage = await memberContext.newPage();
  memberPage.setDefaultTimeout(8_000);
  const pageErrors = [];
  memberPage.on("pageerror", (error) => pageErrors.push(error.message));
  await memberPage.goto(`${baseUrl}/login.html?invite=${encodeURIComponent(inviteToken)}`, { waitUntil: "domcontentloaded" });
  await memberPage.locator("#registerTab[aria-selected=true]").waitFor();
  await assertNoHorizontalOverflow(memberPage);
  await memberPage.screenshot({ path: path.join(screenshots, "multi-user-register-mobile.png"), fullPage: true });

  await memberPage.locator("#usernameInput").fill("browser.member");
  await memberPage.locator("#passwordInput").fill("member-password-1234");
  await Promise.all([
    memberPage.waitForURL(`${baseUrl}/`),
    memberPage.locator("#submitButton").click(),
  ]);
  await waitForCodexConnection(memberPage);
  await memberPage.locator("#announcementDialog").waitFor({ state: "visible" });
  assert.equal(await memberPage.locator("#announcementTitle").innerText(), "Browser test announcement");
  assert.equal(await memberPage.locator("#announcementEditor").isHidden(), true);
  await memberPage.locator('#announcementDialog .modal-header [value="cancel"]').click();
  const memberAccount = await memberPage.evaluate(() => fetch("/api/account").then((response) => response.json()));
  assert.equal(memberAccount.user.displayName, "browser.member");
  const permissionResponse = await fetch(`${baseUrl}/api/multi-user/users/${memberAccount.user.id}`, {
    method: "PATCH",
    headers: {
      Cookie: ownerCookie,
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "multi-user-user-update",
    },
    body: JSON.stringify({
      permissions: {
        customProviders: true,
        officialLogin: true,
        projectSharing: true,
        codexSkills: true,
        codexPlugins: false,
        codexApps: false,
        codexMcp: false,
        codexMigration: false,
        claudeRuntime: true,
        claudeStructuredOutput: true,
        claudeUltraReview: true,
        claudeProjectPurge: true,
        claudeBetaHeaders: true,
      },
    }),
  });
  assert.equal(permissionResponse.status, 200);
  const assignResponse = await fetch(`${baseUrl}/api/multi-user/users/${memberAccount.user.id}/provider`, {
    method: "POST",
    headers: {
      Cookie: ownerCookie,
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "multi-user-provider-assign",
    },
    body: JSON.stringify({ providerId: ownerProviderId, monthlyTokenLimit: 100_000 }),
  });
  assert.equal(assignResponse.status, 201);
  await memberPage.reload({ waitUntil: "domcontentloaded" });
  await waitForCodexConnection(memberPage);
  await memberPage.locator("#promptInput").fill("member browser send smoke");
  await memberPage.locator("#sendButton").click();
  await memberPage.getByText("member browser send smoke", { exact: true }).waitFor();
  await memberPage.locator("#systemStatus").getByText(/空间/).waitFor();
  assert.doesNotMatch(await memberPage.locator("#systemStatus").innerText(), /CPU|内存|磁盘/);
  assert.equal(await memberPage.locator("#versionButton").isVisible(), true);
  assert.equal(await memberPage.locator("#pluginButton").isHidden(), true);
  assert.equal(await memberPage.locator("#codexExtensionsButton").isVisible(), true);
  await memberPage.locator("#codexExtensionsButton").click();
  await memberPage.locator("#codexExtensionDialog").waitFor({ state: "visible" });
  await memberPage.locator(".codex-extension-card", { hasText: "Release Check" }).waitFor();
  assert.equal(await memberPage.locator("#codexMigrationTab").isHidden(), true);
  await assertBoundedByViewport(memberPage, "#codexExtensionDialog", { width: 390, height: 844 });
  await memberPage.locator("#codexExtensionCloseButton").click();
  await memberPage.locator("#versionButton").click();
  await memberPage.locator("#versionDialog").waitFor({ state: "visible" });
  assert.equal(await memberPage.locator("#sourceVersionTile").isHidden(), true);
  assert.equal(await memberPage.locator("#remoteVersionTile").isHidden(), true);
  assert.equal(await memberPage.locator("#codexUpdatePanel").isHidden(), true);
  assert.match(await memberPage.locator("#versionNotes").innerText(), /## \[\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\]/);
  await assertBoundedByViewport(memberPage, "#versionDialog", { width: 390, height: 844 });
  await memberPage.locator('#versionDialog .modal-header [value="cancel"]').click();
  await memberPage.locator("#accountButton").click();
  await memberPage.locator("#accountAddProviderButton").scrollIntoViewIfNeeded();
  await memberPage.locator("#accountAddProviderButton").click();
  await memberPage.locator("#providerDialog").waitFor({ state: "visible" });
  assert.equal(await memberPage.locator("#providerEditorTitle").innerText(), "供应商设置");
  assert.equal(await memberPage.locator("#addProviderButton").isVisible(), true);
  await memberPage.locator("#providerCloseButton").click();
  await memberPage.locator("#settingsButton").click();
  await memberPage.locator("#settingsDialog").waitFor({ state: "visible" });
  await memberPage.waitForTimeout(220);
  assert.match(await memberPage.locator("#accountSummary").innerText(), /browser\.member.*普通用户/);
  assert.match(await memberPage.locator("#accountSummary").innerText(), /已用.*GB/);
  assert.match(await memberPage.locator("#accountSummary").innerText(), /Token.*10 万/);
  assert.equal(await memberPage.locator("#userManagementLink").isHidden(), true);
  await assertBoundedByViewport(memberPage, "#settingsDialog", { width: 390, height: 844 });
  await assertNoHorizontalOverflow(memberPage);
  await memberPage.screenshot({ path: path.join(screenshots, "multi-user-member-mobile.png"), fullPage: true });
  await memberPage.locator("#multiUserSection").scrollIntoViewIfNeeded();
  await memberPage.screenshot({ path: path.join(screenshots, "multi-user-member-account-mobile.png"), fullPage: true });
  await memberPage.locator('#settingsDialog [value="cancel"]').first().click();
  await memberPage.locator("#accountButton").click();
  await memberPage.locator("#accountDialog").waitFor({ state: "visible" });
  assert.equal(await memberPage.locator("#accountDialog .settings-body").evaluate((element) => element.scrollTop), 0);
  assert.equal(await memberPage.locator("#accountPlan").innerText(), "自定义套餐");
  assert.match(await memberPage.locator("#accountTierExpiresAt").innerText(), /不设到期时间/);
  assert.match(await memberPage.locator("#accountMonthlyLimit").innerText(), /10 万/);
  assert.match(await memberPage.locator("#accountFiveHourReset").innerText(), /重置|解锁/);
  for (const selector of ["#accountTotalTokenUsage", "#accountSevenDayTokenUsage", "#accountTodayTokenUsage"]) {
    assert.match(await memberPage.locator(selector).innerText(), /^(?:[\d,. 万亿]+|0|未上报)$/);
  }
  assert.match(await memberPage.locator("#accountIsolationMode").innerText(), /独立目录/);
  assert.match(await memberPage.locator("#accountCodexSkillsPermission").innerText(), /允许 Skills/);
  assert.match(await memberPage.locator("#accountCodexMcpPermission").innerText(), /管理员授权/);
  assert.equal(await memberPage.locator("#accountAdminShortcuts").isHidden(), true);
  assert.equal(await memberPage.locator("#announcementShortcutBadge").isHidden(), true);
  await assertBoundedByViewport(memberPage, "#accountDialog", { width: 390, height: 844 });
  await assertNoHorizontalOverflow(memberPage);
  await memberPage.screenshot({ path: path.join(screenshots, "multi-user-personal-drawer-mobile.png"), fullPage: true });
  await memberPage.locator("#accountAnnouncementButton").click();
  await memberPage.locator("#announcementDialog").waitFor({ state: "visible" });
  assert.equal(await memberPage.locator("#announcementTitle").innerText(), "Browser test announcement");
  assert.equal(await memberPage.locator("#announcementEditor").isHidden(), true);
  await assertBoundedByViewport(memberPage, "#announcementDialog", { width: 390, height: 844 });
  await assertNoHorizontalOverflow(memberPage);
  await memberPage.screenshot({ path: path.join(screenshots, "multi-user-announcement-mobile.png"), fullPage: true });
  await memberPage.locator('#announcementDialog .modal-header [value="cancel"]').click();
  await memberPage.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  assert.equal(await memberPage.evaluate(() => (
    Object.keys(sessionStorage).filter((key) => /^codexDesktop\.threadSnapshots\.v[1-4]:/.test(key)).length
  )), 0);
  await memberPage.locator("#accountButton").click();
  await Promise.all([
    memberPage.waitForURL(/\/login\.html/),
    memberPage.locator("#accountLogoutButton").click(),
  ]);
  assert.equal(await memberPage.evaluate(() => (
    Object.keys(sessionStorage).filter((key) => /^codexDesktop\.threadSnapshots\.v[1-4]:/.test(key)).length
  )), 0);
  assert.deepEqual(pageErrors, []);
  await memberContext.close();

  const ownerContext = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  const ownerToken = ownerCookie.split("=", 2)[1];
  await ownerContext.addCookies([{ name: "codex_user_session", value: ownerToken, url: baseUrl }]);
  const ownerPage = await ownerContext.newPage();
  ownerPage.setDefaultTimeout(8_000);
  await ownerPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(ownerPage);
  await ownerPage.locator("#announcementDialog").waitFor({ state: "visible" });
  assert.equal(await ownerPage.locator("#announcementEditor").isHidden(), true);
  await ownerPage.locator('#announcementDialog .modal-header [value="cancel"]').click();
  await ownerPage.locator("#accountButton").click();
  await ownerPage.locator("#accountDialog").waitFor({ state: "visible" });
  assert.equal(await ownerPage.locator("#accountPlan").innerText(), "主机所有者空间");
  assert.equal(await ownerPage.locator("#accountAssignedApiName").innerText(), "所有者 · 无套餐限额");
  assert.equal(await ownerPage.locator("#accountAssignedQuotaSection").isVisible(), true);
  for (const selector of ["#accountFiveHourUsage", "#accountSevenDayTokenUsage", "#accountMonthlyUsage"]) {
    const usage = ownerPage.locator(selector);
    assert.equal(await usage.isVisible(), true);
    assert.match(await usage.innerText(), /^(?:[\d,. 万亿]+|0|未上报)$/);
  }
  await ownerPage.locator("#accountAnnouncementButton").click();
  await ownerPage.locator("#announcementDialog").waitFor({ state: "visible" });
  assert.equal(await ownerPage.locator("#announcementEditor").isVisible(), true);
  assert.equal(await ownerPage.locator("#publishAnnouncementButton").isVisible(), true);
  await ownerPage.locator('#announcementDialog .modal-header [value="cancel"]').click();
  await ownerPage.locator("#settingsButton").click();
  await ownerPage.locator("#settingsDialog").waitFor({ state: "visible" });
  await ownerPage.waitForTimeout(220);
  assert.equal(await ownerPage.locator("#userManagementLink").isVisible(), true);
  await assertBoundedByViewport(ownerPage, "#settingsDialog", { width: 1024, height: 768 });
  await assertNoHorizontalOverflow(ownerPage);
  await ownerPage.goto(`${baseUrl}/users`, { waitUntil: "domcontentloaded" });
  await ownerPage.locator("#userEditor:not([hidden])").waitFor();
  assert.equal(await ownerPage.locator(".user-row").count(), 2);
  const ownerRow = ownerPage.locator(".user-row").filter({
    has: ownerPage.locator("strong").filter({ hasText: /^owner$/ }),
  });
  assert.equal(await ownerRow.count(), 1);
  assert.match(await ownerRow.locator("small").innerText(), /未分配 API/);
  await ownerPage.locator("#closeDetailButton").click();
  await ownerPage.locator("body:not(.user-drawer-open)").waitFor();
  await ownerRow.click();
  await ownerPage.locator("#userRoleLabel").getByText("OWNER", { exact: true }).waitFor();
  assert.equal(await ownerPage.locator("#userTierSelect").inputValue(), "");
  assert.match(await ownerPage.locator("#currentProviderMeta").innerText(), /使用 Codex 原配置/);
  for (const selector of ["#fiveHourUsage", "#sevenDayUsage", "#monthlyUsage"]) {
    const usage = ownerPage.locator(selector);
    assert.equal(await usage.isVisible(), true);
    assert.match(await usage.innerText(), /^(?:[\d,. 万亿]+|0|未上报)$/);
  }
  const memberRow = ownerPage.locator(".user-row").filter({
    has: ownerPage.locator("strong").filter({ hasText: /^browser\.member$/ }),
  });
  assert.equal(await memberRow.count(), 1);
  await ownerPage.locator("#closeDetailButton").click();
  await ownerPage.locator("body:not(.user-drawer-open)").waitFor();
  await memberRow.click();
  await ownerPage.locator("#userRoleLabel").getByText("MEMBER", { exact: true }).waitFor();
  assert.equal(await ownerPage.locator("#policyPanel").isVisible(), true);
  assert.equal(await ownerPage.locator("#defaultCustomProviders").isChecked(), true);
  assert.equal(await ownerPage.locator("#defaultCodexSkills").isChecked(), false);
  assert.equal(await ownerPage.locator(".tier-item").count(), 1);
  assert.equal(await ownerPage.locator("#userTierSelect option").count(), 2);
  assert.equal(await ownerPage.locator("#userTierExpiresAt").isVisible(), true);
  await ownerPage.locator("#addTierButton").click();
  await ownerPage.locator("#tierDialog").waitFor({ state: "visible" });
  assert.equal(await ownerPage.locator("#tierCodexSkills").isVisible(), true);
  assert.equal(await ownerPage.locator("#tierCodexMcp").isVisible(), true);
  for (const selector of [
    "#tierClaudeStructuredOutput",
    "#tierClaudeUltraReview",
    "#tierClaudeProjectPurge",
    "#tierClaudeBetaHeaders",
  ]) assert.equal(await ownerPage.locator(selector).isVisible(), true);
  await assertBoundedByViewport(ownerPage, "#tierDialog", { width: 1024, height: 768 });
  await ownerPage.locator('#tierDialog [value="cancel"]').first().click();
  await ownerPage.locator("#tierDialog").waitFor({ state: "hidden" });
  assert.equal(await ownerPage.locator(".quota-window-grid input").count(), 3);
  assert.equal(await ownerPage.locator("#codexSkillsPermission").isChecked(), true);
  assert.equal(await ownerPage.locator("#codexPluginsPermission").isChecked(), false);
  for (const selector of [
    "#claudeStructuredOutputPermission",
    "#claudeUltraReviewPermission",
    "#claudeProjectPurgePermission",
    "#claudeBetaHeadersPermission",
  ]) assert.equal(await ownerPage.locator(selector).isChecked(), true);
  for (const selector of ["#totalUsage", "#fiveHourUsage", "#sevenDayUsage", "#monthlyUsage", "#todayUsage"]) {
    assert.equal(await ownerPage.locator(selector).isVisible(), true);
  }
  assert.equal(await ownerPage.locator("#imageProviderSelect option").count(), 1);
  await ownerPage.locator("#imageModelInput").fill("gpt-image-2.0");
  assert.equal(await ownerPage.locator("#imageSizeInput").getAttribute("list"), "userImageSizePresets");
  await ownerPage.locator("#imageSizeInput").fill("1536x1024");
  await ownerPage.locator("#imageQualityInput").selectOption("high");
  assert.equal(await ownerPage.locator("#assignImageProviderButton").isDisabled(), false);
  const imageAssigned = ownerPage.waitForResponse((response) => (
    response.url().includes("/image-provider") && response.request().method() === "POST"
  ), { timeout: 20_000 });
  await ownerPage.locator("#assignImageProviderButton").click();
  assert.equal((await imageAssigned).status(), 201);
  await ownerPage.locator("#imageProviderState").getByText(/gpt-image-2\.0/).waitFor();
  assert.equal(await ownerPage.locator("#imageSizeInput").inputValue(), "1536x1024");
  assert.equal(await ownerPage.locator("#imageQualityInput").inputValue(), "high");
  await assertNoHorizontalOverflow(ownerPage);
  await ownerPage.screenshot({ path: path.join(screenshots, "user-management-tablet.png"), fullPage: true });
  await ownerContext.close();

  const ownerMobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ownerMobileContext.addCookies([{ name: "codex_user_session", value: ownerToken, url: baseUrl }]);
  const ownerMobilePage = await ownerMobileContext.newPage();
  ownerMobilePage.setDefaultTimeout(8_000);
  await ownerMobilePage.goto(`${baseUrl}/users`, { waitUntil: "domcontentloaded" });
  await ownerMobilePage.locator("#userEditor:not([hidden])").waitFor();
  assert.equal(await ownerMobilePage.locator("#policyPanel").isVisible(), true);
  await ownerMobilePage.locator("#closeDetailButton").click();
  await ownerMobilePage.locator("body:not(.user-drawer-open)").waitFor();
  const mobileMemberRow = ownerMobilePage.locator(".user-row").filter({
    has: ownerMobilePage.locator("strong").filter({ hasText: /^browser\.member$/ }),
  });
  await mobileMemberRow.click();
  await ownerMobilePage.locator("#claudePermissionSection > summary").click();
  await ownerMobilePage.locator("#claudeBetaHeadersPermission").scrollIntoViewIfNeeded();
  for (const selector of [
    "#claudeStructuredOutputPermission",
    "#claudeUltraReviewPermission",
    "#claudeProjectPurgePermission",
    "#claudeBetaHeadersPermission",
  ]) {
    assert.equal(await ownerMobilePage.locator(selector).isVisible(), true);
    assert.equal(await ownerMobilePage.locator(selector).isChecked(), true);
  }
  assert.ok(
    await ownerMobilePage.locator(".user-detail").evaluate((element) => element.scrollTop) > 0,
    "the mobile user drawer must scroll independently to Claude permissions",
  );
  await assertNoHorizontalOverflow(ownerMobilePage);
  await ownerMobilePage.screenshot({ path: path.join(screenshots, "user-management-mobile.png"), fullPage: true });
  await ownerMobilePage.goto(`${baseUrl}/ops#backups`, { waitUntil: "domcontentloaded" });
  await ownerMobilePage.locator('[data-view-panel="backups"]:not([hidden])').waitFor();
  await assertNoHorizontalOverflow(ownerMobilePage);
  await ownerMobilePage.screenshot({ path: path.join(screenshots, "backup-center-mobile.png"), fullPage: true });
  await ownerMobileContext.close();
});

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] || "";
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function waitForOutput(processHandle, marker) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start")), 8000);
    let output = "";
    processHandle.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes(marker)) return;
      clearTimeout(timer);
      resolve();
    });
    processHandle.stderr.on("data", (chunk) => (output += chunk));
    processHandle.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (${code})\n${output}`));
    });
  });
}

async function waitForDeepReady(url) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/internal/codex-ready`).catch(() => null);
    if (response?.ok && (await response.json()).threadListReady) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Codex readiness timed out");
}

async function waitForCodexConnection(page) {
  try {
    await page.waitForFunction(
      () => document.getElementById("connectionText")?.textContent === "Codex 已连接",
      null,
      { timeout: 15_000 },
    );
  } catch (error) {
    const connection = await page.locator("#connectionText").textContent().catch(() => "missing");
    throw new Error(`Codex connection timed out (${connection})\n${serverOutput}`, { cause: error });
  }
}

async function assertNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    layout: [document.documentElement, document.body, ...document.querySelectorAll(".ops-shell, .ops-titlebar, .ops-tabs, .ops-main, .ops-view:not([hidden])")]
      .map((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          name: element.className || element.tagName,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          left: box.left,
          right: box.right,
          width: box.width,
          cssWidth: style.width,
          minWidth: style.minWidth,
          maxWidth: style.maxWidth,
          overflowX: style.overflowX,
        };
      }),
    overflow: [...document.querySelectorAll("body *:not(.ops-tabs):not(.ops-tabs *)")]
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { tag: element.tagName, id: element.id, className: element.className, left: box.left, right: box.right, width: box.width };
      })
      .filter((entry) => entry.left < -1 || entry.right > document.documentElement.clientWidth + 1)
      .sort((left, right) => right.right - left.right)
      .slice(0, 12),
  }));
  assert.ok(dimensions.documentWidth <= dimensions.viewportWidth + 1, JSON.stringify(dimensions));
}

async function assertBoundedByViewport(page, selector, viewport) {
  const box = await page.locator(selector).boundingBox();
  const detail = JSON.stringify({
    box,
    viewport,
    innerWidth: await page.evaluate(() => window.innerWidth),
    styles: await page.locator(selector).evaluate((element) => {
      const style = getComputedStyle(element);
      return { position: style.position, inset: style.inset, margin: style.margin, width: style.width, maxWidth: style.maxWidth };
    }),
  });
  assert.ok(box && box.x >= 0 && box.y >= 0, `${selector} is outside the viewport: ${detail}`);
  assert.ok(box.x + box.width <= viewport.width + 1, `${selector} exceeds viewport width: ${detail}`);
  assert.ok(box.y + box.height <= viewport.height + 1, `${selector} exceeds viewport height: ${detail}`);
}
