import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeSshControlPath,
  ensurePrivateSshSocketDirectory,
} from "./temporary-ssh-paths.mjs";

const askpassProgram = fileURLToPath(new URL("../scripts/ssh-askpass.mjs", import.meta.url));

export class SshPasswordControl {
  constructor({ timeoutMs = 15_000, spawnProcess = spawn, useSystemd = spawnProcess === spawn } = {}) {
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
    this.useSystemd = useSystemd;
    this.children = new Map();
  }

  async start({ target, password, knownHostsPath, controlPath, expiresAt = Date.now() + 30 * 60 * 1000 }) {
    assertSafeSshControlPath(controlPath);
    const askpassSocketPath = `${controlPath}.askpass`;
    await ensurePrivateSshSocketDirectory(path.dirname(controlPath));
    await Promise.all([
      fs.rm(controlPath, { force: true }),
      fs.rm(askpassSocketPath, { force: true }),
    ]);

    let secret = String(password);
    let served = false;
    const askpassServer = net.createServer((socket) => {
      if (served) {
        socket.destroy();
        return;
      }
      served = true;
      socket.end(`${secret}\n`);
      secret = "";
    });
    try {
      await listenUnix(askpassServer, askpassSocketPath);
      await fs.chmod(askpassSocketPath, 0o600);
    } catch (error) {
      secret = "";
      askpassServer.close();
      await fs.rm(askpassSocketPath, { force: true });
      const wrapped = passwordControlError("无法创建本机 SSH 凭据通道");
      wrapped.code = error.code;
      throw wrapped;
    }

    const masterArgs = masterArguments(target, knownHostsPath, controlPath, this.timeoutMs);
    const masterEnvironment = sshEnvironment({ askpassSocketPath });
    const systemd = this.useSystemd && await systemdAvailable();
    const child = systemd
      ? this.spawnProcess("systemd-run", sshPasswordSystemdArguments({
        controlPath,
        expiresAt,
        environment: masterEnvironment,
        masterArgs,
      }), {
        env: sshEnvironment(),
        stdio: ["ignore", "ignore", "ignore"],
      })
      : this.spawnProcess("ssh", masterArgs, {
        env: masterEnvironment,
        stdio: ["ignore", "ignore", "ignore"],
      });
    this.children.set(controlPath, child);

    try {
      await waitForControl({
        child,
        controlPath,
        spawnProcess: this.spawnProcess,
        target,
        timeoutMs: this.timeoutMs,
      });
      child.unref?.();
      return { controlPath };
    } catch (error) {
      child.kill("SIGTERM");
      this.children.delete(controlPath);
      throw passwordControlError(classifyStartError(error));
    } finally {
      secret = "";
      askpassServer.close();
      await fs.rm(askpassSocketPath, { force: true });
    }
  }

  async check({ target, controlPath }) {
    try {
      await runControlCommand(this.spawnProcess, target, controlPath, "check", 3_000);
      return true;
    } catch {
      return false;
    }
  }

  async stop({ target, controlPath }) {
    await runControlCommand(this.spawnProcess, target, controlPath, "exit", 3_000).catch(() => {});
    this.children.get(controlPath)?.kill("SIGTERM");
    this.children.delete(controlPath);
    await Promise.all([
      fs.rm(controlPath, { force: true }),
      fs.rm(`${controlPath}.askpass`, { force: true }),
    ]);
  }
}

function masterArguments(target, knownHostsPath, controlPath, timeoutMs) {
  return [
    "-M",
    "-N",
    "-S", controlPath,
    "-p", String(target.port),
    "-o", "ControlPersist=no",
    "-o", "IdentitiesOnly=yes",
    "-o", "PubkeyAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "PreferredAuthentications=password",
    "-o", "NumberOfPasswordPrompts=1",
    "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-o", `UserKnownHostsFile=${knownHostsPath}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "StrictHostKeyChecking=yes",
    `${target.username}@${target.host}`,
  ];
}

export function sshPasswordSystemdArguments({ controlPath, expiresAt, environment, masterArgs, now = Date.now() }) {
  const id = path.basename(controlPath, ".ctl");
  if (!/^ssh-[a-f0-9]{16}$/.test(id)) throw new Error("Invalid SSH control unit ID");
  const lifetimeSeconds = Math.max(1, Math.ceil((Number(expiresAt) - now) / 1000));
  return [
    `--unit=wfl-codex-${id}`,
    "--quiet",
    "--wait",
    "--collect",
    "--property=Type=exec",
    `--property=RuntimeMaxSec=${lifetimeSeconds}s`,
    ...Object.entries(environment).map(([name, value]) => `--setenv=${name}=${value}`),
    "/usr/bin/ssh",
    ...masterArgs,
  ];
}

async function systemdAvailable() {
  try {
    await Promise.all([
      fs.access("/run/systemd/system"),
      fs.access("/usr/bin/systemd-run"),
    ]);
    return typeof process.getuid === "function" && process.getuid() === 0;
  } catch {
    return false;
  }
}

function sshEnvironment({ askpassSocketPath = "" } = {}) {
  return {
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME || "/root",
    LANG: "C",
    ...(askpassSocketPath ? {
      DISPLAY: "wfl-codex-ssh",
      SSH_ASKPASS: askpassProgram,
      SSH_ASKPASS_REQUIRE: "force",
      WFL_CODEX_ASKPASS_SOCKET: askpassSocketPath,
    } : {}),
  };
}

function listenUnix(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function waitForControl({ child, controlPath, spawnProcess, target, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  let exitCode = null;
  let exitError = null;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  child.once("error", (error) => {
    exited = true;
    exitCode = "spawn";
    exitError = error;
  });

  while (Date.now() < deadline) {
    if (exited) throw exitError || new Error(`ssh master exited (${exitCode})`);
    try {
      await runControlCommand(spawnProcess, target, controlPath, "check", 1_500);
      return;
    } catch {
      await delay(150);
    }
  }
  throw new Error("ssh master timed out");
}

function runControlCommand(spawnProcess, target, controlPath, operation, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("ssh", [
      "-S", controlPath,
      "-O", operation,
      "-p", String(target.port),
      `${target.username}@${target.host}`,
    ], {
      env: sshEnvironment(),
      stdio: "ignore",
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new Error(`ssh control ${operation} timed out`));
    }, timeoutMs);
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code) => {
      if (code === 0) finish(resolve);
      else finish(reject, new Error(`ssh control ${operation} failed (${code})`));
    });
  });
}

function classifyStartError(error) {
  if (error?.code === "ENOENT") return "本机缺少 OpenSSH 客户端，无法建立临时密码会话";
  if (error?.code === "SSH_CONTROL_PATH_TOO_LONG") {
    return "本机 SSH 控制套接字路径过长，无法建立临时密码会话";
  }
  return "目标服务器拒绝临时公钥，且临时密码会话建立失败";
}

function passwordControlError(message) {
  return Object.assign(new Error(message), { statusCode: 424, sshAttemptFailed: true });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
