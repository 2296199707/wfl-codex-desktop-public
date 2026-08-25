import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CONFIG_VERSION = 1;

export function defaultConfigPath() {
  const localAppData = process.env.LOCALAPPDATA;
  if (process.platform === "win32" && localAppData) {
    return path.join(localAppData, "WFL Codex Desktop", "windows-host.json");
  }
  return path.join(os.homedir(), ".wfl-codex-desktop", "windows-host.json");
}

export async function readHostConfig(configPath = defaultConfigPath()) {
  const source = JSON.parse(await fs.readFile(configPath, "utf8"));
  return normalizeConfig(source, configPath);
}

export async function writeHostConfig(value, configPath = defaultConfigPath()) {
  const config = normalizeConfig(value, configPath);
  const configDirectory = path.dirname(configPath);
  await fs.mkdir(configDirectory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") await restrictWindowsAcl(configDirectory, { directory: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (process.platform === "win32") await restrictWindowsAcl(temporary);
    await fs.rename(temporary, configPath);
    await fs.chmod(configPath, 0o600).catch(() => {});
    if (process.platform === "win32") await restrictWindowsAcl(configPath);
    return config;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export function publicHostConfig(config) {
  return {
    version: config.version,
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    deviceName: config.deviceName,
    workspaceRoot: config.workspaceRoot,
    projects: config.projects.map(({ id, name }) => ({ id, name })),
    tokenStored: Boolean(config.token),
  };
}

export function normalizeServerUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("WFL server URL is invalid");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("WFL server URL cannot contain credentials or query data");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Remote WFL servers require HTTPS");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function deviceWebSocketUrl(serverUrl) {
  const url = new URL(normalizeServerUrl(serverUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/device/ws`;
  return url.toString();
}

function normalizeConfig(value, configPath) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== CONFIG_VERSION) {
    throw new Error("Windows Host config version is unsupported");
  }
  const workspaceRoot = absolutePath(value.workspaceRoot, "Creator workspace");
  const projects = Array.isArray(value.projects) ? value.projects.map((project) => ({
    id: opaqueId(project?.id, "project ID"),
    name: boundedName(project?.name, "project name"),
    path: absolutePath(project?.path, "Codex project"),
  })) : [];
  if (!projects.length || projects.length > 32) throw new Error("At least one local project is required");
  return {
    version: CONFIG_VERSION,
    serverUrl: normalizeServerUrl(value.serverUrl),
    deviceId: opaqueId(value.deviceId, "device ID"),
    token: normalizeToken(value.token),
    deviceName: boundedName(value.deviceName, "device name"),
    workspaceRoot,
    projects,
    configPath,
  };
}

function absolutePath(value, label) {
  const input = String(value || "").trim();
  if (!input || !path.isAbsolute(input)) throw new Error(`${label} must be an absolute path`);
  if (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(input)) {
    throw new Error(`${label} must be on a local Windows drive`);
  }
  return path.resolve(input);
}

function opaqueId(value, label) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error(`Invalid ${label}`);
  return id;
}

function boundedName(value, label) {
  const name = String(value || "").trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error(`Invalid ${label}`);
  return name;
}

function normalizeToken(value) {
  const token = String(value || "");
  if (!/^wfl_device_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid device token");
  return token;
}

async function restrictWindowsAcl(configPath, { directory = false } = {}) {
  const username = process.env.USERNAME;
  if (!username) throw new Error("Cannot determine the current Windows user for config ACL");
  const grant = directory ? `${username}:(OI)(CI)F` : `${username}:F`;
  await run("icacls.exe", [configPath, "/inheritance:r", "/grant:r", grant]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true, shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
