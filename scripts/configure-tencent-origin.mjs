#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PublicOriginConfigStore } from "../lib/public-origin-config.mjs";
import {
  buildPreviewDnsPlan,
  TencentCloudCredentialStore,
  TencentCloudDnsClient,
  TencentCloudSetupStore,
} from "../lib/tencent-cloud-dns.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.resolve(process.env.CODEX_DESKTOP_SOURCE_DIR || path.dirname(scriptDirectory));
const stateDirectory = path.resolve(process.env.CODEX_DESKTOP_STATE_DIR || path.join(sourceDirectory, ".codex-desktop"));
const runtimeDirectory = path.resolve(process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(sourceDirectory, ".codex-runtime"));
const setupId = process.env.CODEX_DESKTOP_TENCENT_SETUP_ID || optionValue("--setup-id");
const setupStore = await new TencentCloudSetupStore(stateDirectory).initialize();
const setup = setupStore.snapshot();
if (!setupId || setup.id !== setupId || setup.status !== "running") throw new Error("腾讯云向导任务身份无效");
const applied = [];
let nginxBackup = null;
let nginxChanged = false;
let credentials;
let publicOrigin;
let input;
let client;

try {
  const credentialsStore = await new TencentCloudCredentialStore(stateDirectory).initialize();
  credentials = credentialsStore.credentials();
  const publicOriginStore = await new PublicOriginConfigStore(stateDirectory).initialize();
  publicOrigin = publicOriginStore.snapshot();
  if (publicOrigin.mode !== "confirmed") throw new Error("公开 Origin 尚未确认");
  input = setup.input || {};
  client = new TencentCloudDnsClient(credentials);
  const plan = buildPreviewDnsPlan({
    publicOrigin: publicOrigin.publicOrigin,
    previewBaseDomain: publicOrigin.previewBaseDomain,
    previewOrigins: publicOrigin.previewOrigins,
    slotCount: publicOrigin.slotCount,
    isolation: publicOrigin.isolation,
    zoneDomain: input.zoneDomain || credentials.zoneDomain,
    targetType: input.targetType || credentials.targetType,
    target: input.target || credentials.target,
    managePublicOrigin: input.managePublicOrigin === true,
  });
  await setupStore.update({ phase: "dns", detail: `正在写入 ${plan.length} 条腾讯云 DNSPod 记录` });
  for (const record of plan) {
    const result = await client.upsertRecord({
      zoneDomain: input.zoneDomain || credentials.zoneDomain,
      subDomain: record.subDomain,
      recordType: record.recordType,
      value: record.value,
      ttl: record.ttl,
      replaceExisting: input.replaceExisting === true,
    });
    applied.push({ ...record, result });
    await setupStore.update({
      records: applied.map((entry) => ({ host: entry.host, action: entry.result.action })),
      detail: `已处理 ${applied.length}/${plan.length} 条 DNS 记录`,
    });
  }

  let certificate = { requested: false, certName: null, path: null };
  if (input.issueCertificate === true) {
    await setupStore.update({ phase: "certificate", detail: "正在使用 DNS-01 申请或续期 Let's Encrypt 证书" });
    const domains = certificateDomains(publicOrigin);
    const certName = `wfl-codex-${new URL(publicOrigin.publicOrigin).hostname.replace(/[^a-z0-9-]/gi, "-")}`.slice(0, 80);
    await ensureManagedNginxEligible();
    await issueCertificate({ domains, certName });
    certificate = {
      requested: true,
      certName,
      path: `/etc/letsencrypt/live/${certName}/fullchain.pem`,
    };
    await setupStore.update({ phase: "proxy", certificate, detail: "正在将证书和预览域名写入受管 Nginx 配置" });
    const result = await installManagedNginx({ domains, certName, publicOriginHost: new URL(publicOrigin.publicOrigin).hostname });
    nginxBackup = result.backup;
    nginxChanged = result.changed;
  }

  await setupStore.update({ phase: "verifying", detail: "DNS、证书和反向代理配置已完成，等待公网解析传播" });
  await setupStore.update({
    status: "completed",
    phase: "completed",
    detail: input.issueCertificate === true
      ? "腾讯云 DNS、Let's Encrypt 证书和受管 Nginx 已配置；公网 DNS 可能仍需数分钟传播"
      : "腾讯云 DNS 已配置；证书和反向代理未请求修改",
    completedAt: Date.now(),
  });
} catch (error) {
  if (nginxChanged && nginxBackup) await restoreNginx(nginxBackup).catch(() => {});
  await rollbackDns(applied).catch(() => {});
  await setupStore.update({
    status: "failed",
    phase: "failed",
    detail: "腾讯云 DNS/证书向导失败，已尝试恢复本次修改",
    error: publicError(error),
    completedAt: Date.now(),
  }).catch(() => {});
  throw error;
}

async function issueCertificate({ domains, certName }) {
  const authHook = `${process.execPath} ${path.join(sourceDirectory, "scripts", "tencent-dns-certbot-auth.mjs")} --state-dir ${stateDirectory}`;
  const cleanupHook = `${process.execPath} ${path.join(sourceDirectory, "scripts", "tencent-dns-certbot-cleanup.mjs")} --state-dir ${stateDirectory}`;
  const args = [
    "certonly",
    "--manual",
    "--preferred-challenges", "dns",
    "--manual-auth-hook", authHook,
    "--manual-cleanup-hook", cleanupHook,
    "--non-interactive",
    "--agree-tos",
    "--email", credentials.certificateEmail,
    "--cert-name", certName,
    "--expand",
    "--deploy-hook", "systemctl reload nginx",
    ...domains.flatMap((domain) => ["-d", domain]),
  ];
  await run("certbot", args, { timeoutMs: 12 * 60 * 1000 });
  await Promise.all([
    fs.access(`/etc/letsencrypt/live/${certName}/fullchain.pem`),
    fs.access(`/etc/letsencrypt/live/${certName}/privkey.pem`),
  ]);
}

async function ensureManagedNginxEligible() {
  const access = await readJson(path.join(runtimeDirectory, "access.json"));
  if (access?.managedBy !== "nginx-certbot") throw new Error("当前不是 WFL 受管 Nginx；向导不会覆盖现有反向代理");
  const site = "/etc/nginx/sites-available/wfl-codex-desktop.conf";
  const stat = await fs.lstat(site);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("受管 Nginx 站点文件不安全");
  const content = await fs.readFile(site, "utf8");
  if (!content.includes("# Managed by WFL Codex Desktop access wizard.")) throw new Error("Nginx 站点不是 WFL 向导创建的");
  const enabled = "/etc/nginx/sites-enabled/wfl-codex-desktop.conf";
  const enabledStat = await fs.lstat(enabled);
  if (!enabledStat.isSymbolicLink() || path.resolve(await fs.realpath(enabled)) !== path.resolve(site)) {
    throw new Error("Nginx 受管站点启用链接不正确");
  }
}

async function installManagedNginx({ domains, certName, publicOriginHost }) {
  const site = "/etc/nginx/sites-available/wfl-codex-desktop.conf";
  const backupDirectory = path.join(runtimeDirectory, "nginx-backups");
  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backup = path.join(backupDirectory, `${setupId}.conf`);
  await fs.copyFile(site, backup);
  await fs.chmod(backup, 0o600);
  const temporary = `${site}.${process.pid}.tmp`;
  await fs.writeFile(temporary, managedNginxConfig({ domains, certName, publicOriginHost }), { mode: 0o644 });
  await fs.rename(temporary, site);
  try {
    await run("nginx", ["-t"], { timeoutMs: 15_000 });
    await run("systemctl", ["reload", "nginx"], { timeoutMs: 20_000 });
  } catch (error) {
    await fs.copyFile(backup, site);
    await run("nginx", ["-t"], { timeoutMs: 15_000 }).catch(() => {});
    await run("systemctl", ["reload", "nginx"], { timeoutMs: 20_000 }).catch(() => {});
    throw error;
  }
  return { changed: true, backup };
}

function managedNginxConfig({ domains, certName, publicOriginHost }) {
  const serverNames = domains.join(" ");
  return `# Managed by WFL Codex Desktop access wizard.\n# Tencent Cloud DNSPod and Let's Encrypt DNS-01 are managed from /ops.\nserver {\n    listen 80;\n    listen [::]:80;\n    server_name ${serverNames};\n    return 301 https://$host$request_uri;\n}\n\nserver {\n    listen 443 ssl;\n    listen [::]:443 ssl;\n    server_name ${serverNames};\n\n    ssl_certificate /etc/letsencrypt/live/${certName}/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/${certName}/privkey.pem;\n    include /etc/letsencrypt/options-ssl-nginx.conf;\n    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n\n    client_max_body_size 2g;\n    location / {\n        proxy_pass http://127.0.0.1:4317;\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto https;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_read_timeout 3600s;\n        proxy_send_timeout 3600s;\n    }\n}\n`;
}

async function restoreNginx(backup) {
  await fs.copyFile(backup, "/etc/nginx/sites-available/wfl-codex-desktop.conf");
  await run("nginx", ["-t"], { timeoutMs: 15_000 });
  await run("systemctl", ["reload", "nginx"], { timeoutMs: 20_000 });
}

async function rollbackDns(applied) {
  for (const entry of [...applied].reverse()) {
    if (entry.result.action === "unchanged") continue;
    await client.restoreRecord({
      zoneDomain: input.zoneDomain || credentials.zoneDomain,
      subDomain: entry.subDomain,
      recordType: entry.recordType,
      previous: entry.result.previous,
      createdRecordId: entry.result.createdRecordId,
      ttl: entry.ttl,
    }).catch(() => {});
  }
}

function certificateDomains(config) {
  const names = [new URL(config.publicOrigin).hostname];
  if (config.isolation === "session") names.push(`*.${config.previewBaseDomain}`);
  else names.push(...config.previewOrigins.map((origin) => new URL(origin).hostname));
  return [...new Set(names)];
}

function run(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-8_000)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function publicError(error) {
  return String(error?.message || error || "腾讯云向导失败").replace(/[\r\n]+/g, " ").slice(0, 512);
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
