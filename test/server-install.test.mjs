import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const installer = await fs.readFile(new URL("../scripts/install-server.sh", import.meta.url), "utf8");
const accessWizard = await fs.readFile(
  new URL("../scripts/configure-access.sh", import.meta.url),
  "utf8",
);
const entrypoint = await fs.readFile(new URL("../install.sh", import.meta.url), "utf8");
const backup = await fs.readFile(new URL("../scripts/backup.mjs", import.meta.url), "utf8");
const release = await fs.readFile(new URL("../scripts/release.mjs", import.meta.url), "utf8");
const unitInstaller = await fs.readFile(
  new URL("../scripts/install-service-units.mjs", import.meta.url),
  "utf8",
);
const doctor = await fs.readFile(new URL("../scripts/server-doctor.mjs", import.meta.url), "utf8");
const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8");
const chineseReadme = await fs.readFile(new URL("../README.zh-CN.md", import.meta.url), "utf8");
const deploymentGuide = await fs.readFile(
  new URL("../docs/server-deployment.zh-CN.md", import.meta.url),
  "utf8",
);
const updateGuide = await fs.readFile(new URL("../docs/SERVER-UPDATES.md", import.meta.url), "utf8");
const packageManifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(await fs.readFile(new URL("../package-lock.json", import.meta.url), "utf8"));

test("fresh-server install orders verified source, prerequisites, authorization, and checked release", () => {
  const installFlow = installer.slice(installer.indexOf("printf '[1/10]"));
  const steps = [
    "apt-get install",
    "check_package_archive",
    "bootstrap_package_git",
    "check_release_source",
    "install_codex_if_needed",
    "npm ci",
    "install_playwright_dependencies_if_needed",
    "install_playwright_browser",
    "npm run setup:check",
    "configuring Codex authorization",
    "npm run set-password",
    "install-service-units.mjs --install-system --main-only",
    "release_args=(--wait)",
    "scripts/release.mjs",
    "install-service-units.mjs --install-system --include-rescue",
    "server-doctor.mjs",
    "run_access_wizard",
  ];
  for (let index = 1; index < steps.length; index += 1) {
    assert.ok(
      installFlow.indexOf(steps[index - 1]) < installFlow.indexOf(steps[index]),
      `${steps[index - 1]} must run before ${steps[index]}`,
    );
  }
  assert.ok(
    installer.indexOf("node scripts/migrate-claude-component.mjs")
      < installer.indexOf("npm ci\ninstall_playwright_dependencies_if_needed"),
    "legacy Claude migration must run before npm ci",
  );
  assert.match(installer, /debian\|ubuntu/);
  assert.match(installer, /Node\.js 22 or newer/);
  assert.match(installer, /HEAD must match pushed tag.*origin\/stable/);
  assert.match(installer, /codex_cli_meets_baseline/);
  assert.match(installer, /sort -V/);
  assert.equal((installer.match(/codex login status >\/dev\/null 2>&1/g) || []).length, 3);
  assert.match(installer, /Ports 4317-4321 remain private on loopback/);
  assert.match(installer, /install -y .*quota/);
  assert.match(installer, /install -y .*ffmpeg.*x11vnc.*xauth.*xclip.*xdotool.*xvfb/);
  assert.match(installer, /Installing platform-specific optional packages required by image processing/);
  assert.match(installer, /Preserving an existing bundled Claude Code installation before npm ci/);
  assert.doesNotMatch(installer, /npm ci --omit=optional/);
  assert.equal(packageManifest.dependencies?.["@anthropic-ai/claude-code"], undefined);
  assert.equal(packageManifest.optionalDependencies?.["@anthropic-ai/claude-code"], undefined);
  assert.equal(Object.keys(packageLock.packages || {}).some((name) => name.includes("anthropic") || name.includes("claude-code")), false);
  assert.match(entrypoint, /scripts\/install-server\.sh/);
  assert.doesNotMatch(installer, /(?:cp|rsync)[^\n]*\.codex-desktop/);
  assert.doesNotMatch(installer, /(?:cp|rsync)[^\n]*(?:auth\.json|providers\.enc)/);
  assert.match(unitInstaller, /const includeRescue = process\.argv\.includes\("--include-rescue"\)/);
  assert.match(unitInstaller, /const mainOnly = !includeRescue/);
  assert.match(installer, /codex_cli_meets_baseline/);
  assert.match(installer, /sort -V/);
});

test("fresh-server install resumes quietly and falls back when the Codex endpoint is blocked", () => {
  assert.match(installer, /if prerequisites_ready; then/);
  assert.match(installer, /skipping APT/);
  assert.match(installer, /Dpkg::Use-Pty=0/);
  assert.match(installer, /APT::Color=0/);
  assert.match(installer, /NEEDRESTART_MODE=a/);
  assert.match(installer, /--connect-timeout 5 --max-time 20 --retry 1/);
  assert.match(installer, /--retry-max-time 25/);
  assert.match(installer, /CODEX_NON_INTERACTIVE=1 sh "\$installer"/);
  assert.match(installer, /npm install --global "@openai\/codex@\$\{CODEX_CLI_VERSION\}" --no-audit --no-fund/);
  assert.match(installer, /playwright-dependencies-ready/);
  assert.match(installer, /ensure-playwright-browser\.mjs --install/);
  assert.doesNotMatch(installer, /timeout --foreground "\$\{timeout_seconds\}s"/);
  assert.doesNotMatch(installer, /playwright install --with-deps/);
  assert.ok(
    installer.indexOf("https://chatgpt.com/codex/install.sh") <
    installer.indexOf('npm install --global "@openai/codex@${CODEX_CLI_VERSION}"'),
    "the official installer endpoint must be tried before the npm fallback",
  );
  assert.equal((installer.match(/verify-package-source\.mjs/g) || []).length, 1);
});

test("installation docs state every required source and use the standard checkout path", () => {
  for (const document of [readme, chineseReadme, deploymentGuide]) {
    assert.match(document, /APT/);
    assert.match(document, /registry\.npmjs\.org/);
    assert.match(document, /cdn\.playwright\.dev/);
    assert.match(document, /deb\.nodesource\.com/);
    assert.match(document, /https:\/\/chatgpt\.com\/codex\/install\.sh/);
    assert.match(document, /@openai\/codex/);
  }
  for (const document of [readme, chineseReadme, deploymentGuide, updateGuide]) {
    assert.doesNotMatch(document, /\/srv\/wfl-rpg/);
    assert.match(document, /\/srv\/wfl-codex-desktop/);
  }
  for (const document of [readme, chineseReadme, deploymentGuide]) {
    assert.match(document, /wfl-codex-desktop-v[0-9A-Za-z.-]+\.tar\.gz\.sha256/);
    assert.match(document, /tar -xzf wfl-codex-desktop-v[0-9A-Za-z.-]+\.tar\.gz/);
    const archives = [...document.matchAll(/tar -xzf\s+(wfl-codex-desktop-v\S+)/g)]
      .map((match) => match[1]);
    assert.ok(archives.length > 0);
    for (const archive of archives) assert.match(archive, /\.tar\.gz$/);
  }
});

test("interactive installation confirms a plan and offers three loopback-safe access modes", () => {
  assert.match(installer, /\[\[ -t 0 && -t 1 \]\]/);
  assert.match(installer, /prepare_install_wizard/);
  assert.match(installer, /确认开始安装/);
  assert.match(installer, /此项必须明确选择/);
  assert.match(installer, /安装后待办/);
  assert.match(installer, /版本中心同步不可用/);
  assert.match(installer, /--non-interactive/);
  assert.match(installer, /--configure-access/);
  assert.doesNotMatch(installer, /--full-check/);
  assert.doesNotMatch(installer, /额外执行完整测试/);
  assert.match(installer, /不会运行仓库测试或浏览器冒烟/);
  assert.match(installer, /CODEX_DESKTOP_QUICK_CHECK_OFFLINE=1 npm run update:quick-check/);
  assert.match(installer, /CODEX_DESKTOP_PRECHECK_KIND=package/);
  assert.doesNotMatch(installer, /npm run check|npm run test:browser/);
  assert.match(installer, /PASSWORD_MODE="custom"/);
  assert.match(installer, /Codex authorization: deferred; configure it in the API provider center/);
  assert.match(installer, /sudo npm run server:access/);
  assert.match(installer, /sudo npm run server:password/);
  assert.match(installer, /sudo npm run server:updates/);
  assert.doesNotMatch(installer, /Reinstall with --git-remote/);
  assert.match(installer, /CODEX_DESKTOP_USERNAME="\$OWNER_USERNAME" CODEX_DESKTOP_NEW_PASSWORD="\$CUSTOM_PASSWORD" npm run set-password/);
  assert.match(installer, /OWNER_USERNAME="\$\{CODEX_DESKTOP_USERNAME:-codex\}"/);
  assert.match(installer, /OWNER_USERNAME_PLAN="保留现有所有者"/);
  assert.match(installer, /密码至少需要 16 个字符/);
  assert.match(installer, /初始模型 ID（可留空，之后在主页选择）/);
  assert.match(installer, /当前服务器已经配置独立只读 Deploy Key/);
  assert.match(installer, /prompt_choice choice "首次安装后如何授权 Codex？此项必须明确选择。" ""/);
  assert.match(installer, /prompt_choice choice "安装完成后准备如何访问网页？此项必须明确选择。" ""/);
  assert.match(installer, /OpenAI 官方账号设备登录/);
  assert.match(installer, /Responses 兼容 API 供应商/);
  assert.match(installer, /set \+x/);
  assert.match(installer, /validate_provider_plan/);
  assert.match(installer, /远程 API Base URL 必须使用 HTTPS/);
  assert.match(installer, /printf '%s\\0'.*PROVIDER_API_KEY/s);
  assert.match(installer, /node scripts\/configure-provider\.mjs/);
  assert.match(installer, /run_access_wizard/);
  for (const mode of ["existing-domain", "cloudflare", "local"]) {
    assert.match(accessWizard, new RegExp(mode));
  }
  assert.match(accessWizard, /proxy_pass http:\/\/127\.0\.0\.1:4317/);
  assert.match(accessWizard, /Cloudflare service setup/);
  assert.match(accessWizard, /本地电脑的 PowerShell（不是服务器终端）/);
  assert.match(accessWizard, /此项不会自动替你决定/);
  assert.match(accessWizard, /ssh -N -L 4317:127\.0\.0\.1:4317 -p <SSH端口> <SSH用户>@<服务器IP>/);
  assert.doesNotMatch(accessWizard, /listen (?:0\.0\.0\.0:)?431[789]/);
});

test("release packages require checksums and keep Git verification opt-in and exact", () => {
  assert.match(installer, /--archive PATH/);
  assert.match(installer, /--checksum PATH/);
  assert.match(installer, /--git-remote URL/);
  assert.match(installer, /sha256sum/);
  assert.match(installer, /bootstrap-package-git\.mjs/);
  assert.match(installer, /Git remote must use SSH with a read-only deploy key/);
  assert.match(installer, /Configured origin does not match --git-remote/);
  assert.match(installer, /flock -n/);
  assert.match(installer, /At least 2 GiB/);
  assert.match(backup, /PACKAGE_MANIFEST_NAME/);
  assert.match(release, /CODEX_DESKTOP_PACKAGE_SOURCE/);
  assert.match(release, /if \(packageSource\)/);
});

test("server installer writes portable units atomically and doctor performs deep readiness checks", () => {
  assert.match(unitInstaller, /\$\{name\}\.template/);
  assert.match(unitInstaller, /\/etc\/systemd\/system/);
  assert.match(unitInstaller, /await fs\.rename\(temporary, destination\)/);
  assert.match(unitInstaller, /ensureProjectDirectories/);
  assert.match(unitInstaller, /path\.join\(path\.dirname\(projectDir\), "workspace"\)/);
  assert.match(unitInstaller, /\["daemon-reload"\]/);
  assert.match(doctor, /wfl-codex-desktop-gateway\.service/);
  assert.match(doctor, /\/internal\/gateway-ready/);
  assert.match(doctor, /connectionPolicyVersion !== 8/);
  assert.match(doctor, /wfl-codex-desktop-rescue\.service/);
  assert.match(doctor, /127\.0\.0\.1:4321\/internal\/ready/);
  assert.match(doctor, /keepAliveTimeoutMs !== 120_000/);
  assert.match(doctor, /\/internal\/codex-ready/);
  assert.match(doctor, /threadListReady !== true/);
  assert.match(doctor, /Environment=HOST=127\.0\.0\.1/);
});
