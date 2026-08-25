import crypto from "node:crypto";
import ssh2 from "ssh2";

const { Client } = ssh2;
const MAX_AUTHORIZED_KEYS_BYTES = 1024 * 1024;

export class TemporarySshConnector {
  constructor({ timeoutMs = 15_000 } = {}) {
    this.timeoutMs = timeoutMs;
  }

  async install({
    target,
    password,
    authorizedKeyLine,
    marker,
    privateKey,
    expectedFingerprint = null,
  }) {
    let passwordConnection;
    let passwordFallback = null;
    try {
      passwordConnection = await this.connect({ ...target, password, expectedFingerprint });
      passwordFallback = hostKeyResponse(passwordConnection);
      try {
        await updateAuthorizedKeysWithSftp(passwordConnection.client, {
          addLine: authorizedKeyLine,
          timeoutMs: this.timeoutMs,
        });
      } catch {
        const expectedFingerprint = passwordConnection.fingerprint;
        passwordConnection.client.end();
        passwordConnection = await this.connect({ ...target, password, expectedFingerprint });
        await execute(passwordConnection.client, installCommand(authorizedKeyLine), this.timeoutMs);
      }
      try {
        const verified = await this.connect({
          ...target,
          privateKey,
          expectedFingerprint: passwordConnection.fingerprint,
        });
        verified.client.end();
      } catch {
        await updateAuthorizedKeysWithSftp(passwordConnection.client, {
          removeMarker: marker,
          timeoutMs: this.timeoutMs,
        }).catch(() => execute(passwordConnection.client, removeCommand(marker), this.timeoutMs).catch(() => {}));
        const error = connectorError("服务器未接受临时公钥，已回滚授权");
        error.passwordFallback = {
          hostKeyFingerprint: passwordConnection.fingerprint,
          hostKey: passwordConnection.hostKey,
        };
        throw error;
      }
      return {
        hostKeyFingerprint: passwordConnection.fingerprint,
        hostKey: passwordConnection.hostKey,
      };
    } catch (error) {
      // Once password authentication and host-key verification succeeded, the
      // caller may safely choose a password-compatible persistent mode. Keep
      // the host identity attached to every post-auth installation failure.
      if (passwordFallback && !error.passwordFallback) {
        await rollbackMarker(passwordConnection, marker, this.timeoutMs);
        error.passwordFallback = passwordFallback;
      }
      if (error.statusCode) throw error;
      const wrapped = connectorError("SSH 密码认证失败、主机不可达或服务器拒绝临时密钥");
      if (passwordFallback) wrapped.passwordFallback = passwordFallback;
      throw wrapped;
    } finally {
      passwordConnection?.client.end();
    }
  }

  async remove({ target, privateKey, marker, expectedFingerprint }) {
    let connection;
    try {
      connection = await this.connect({ ...target, privateKey, expectedFingerprint });
      try {
        await updateAuthorizedKeysWithSftp(connection.client, {
          removeMarker: marker,
          timeoutMs: this.timeoutMs,
        });
      } catch {
        connection.client.end();
        connection = await this.connect({ ...target, privateKey, expectedFingerprint });
        await execute(connection.client, removeCommand(marker), this.timeoutMs);
      }
      return { removed: true };
    } catch {
      throw connectorError("无法连接目标服务器撤销临时密钥；密钥到期后仍会被 SSH 拒绝");
    } finally {
      connection?.client.end();
    }
  }

  connect({ host, port, username, password, privateKey, expectedFingerprint = null }) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let fingerprint = null;
      let hostKey = null;
      let settled = false;
      const finish = (operation) => (value) => {
        if (settled) return;
        settled = true;
        operation(value);
      };
      const fail = finish((error) => {
        client.end();
        reject(error);
      });
      client.once("error", fail);
      client.once("ready", finish(() => resolve({ client, fingerprint, hostKey })));
      client.connect({
        host,
        port,
        username,
        ...(password ? { password } : { privateKey }),
        readyTimeout: this.timeoutMs,
        keepaliveInterval: 5_000,
        keepaliveCountMax: 2,
        hostVerifier: (key) => {
          fingerprint = `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
          hostKey = `${readSshString(key)} ${key.toString("base64")}`;
          return !expectedFingerprint || fingerprint === expectedFingerprint;
        },
      });
    });
  }
}

export async function updateAuthorizedKeysWithSftp(client, {
  addLine = null,
  removeMarker = null,
  timeoutMs = 15_000,
} = {}) {
  if (Boolean(addLine) === Boolean(removeMarker)) throw new Error("Specify one authorized_keys operation");
  const sftp = await openSftp(client, timeoutMs);
  let temporaryPath = null;
  try {
    const home = String(await callSftp(sftp, "realpath", ["."], timeoutMs, "SSH SFTP 无法确定用户目录"));
    if (!home.startsWith("/") || home.includes("\0")) throw connectorError("SSH SFTP 返回了无效的用户目录");
    const sshDirectory = `${home.replace(/\/+$/, "")}/.ssh`;
    const authorizedKeysPath = `${sshDirectory}/authorized_keys`;
    await ensureSftpDirectory(sftp, sshDirectory, timeoutMs);
    const current = await readAuthorizedKeys(sftp, authorizedKeysPath, timeoutMs);
    const updated = updateAuthorizedKeysText(current, { addLine, removeMarker });
    if (updated === current) return;

    temporaryPath = `${authorizedKeysPath}.wfl.${crypto.randomBytes(6).toString("hex")}`;
    await callSftp(
      sftp,
      "writeFile",
      [temporaryPath, updated, { encoding: "utf8", mode: 0o600, flag: "wx" }],
      timeoutMs,
      "SSH SFTP 写入临时授权文件超时",
    );
    await callSftp(sftp, "chmod", [temporaryPath, 0o600], timeoutMs, "SSH SFTP 设置授权权限超时");
    if (typeof sftp.ext_openssh_rename !== "function") {
      throw connectorError("目标服务器不支持 SFTP 原子替换");
    }
    await callSftp(
      sftp,
      "ext_openssh_rename",
      [temporaryPath, authorizedKeysPath],
      timeoutMs,
      "SSH SFTP 替换授权文件超时",
    );
    temporaryPath = null;
  } finally {
    if (temporaryPath) {
      await callSftp(sftp, "unlink", [temporaryPath], timeoutMs, "SSH SFTP 清理临时文件超时").catch(() => {});
    }
    sftp.end();
  }
}

function openSftp(client, timeoutMs) {
  return timedCallback(
    (callback) => client.sftp(callback),
    timeoutMs,
    "SSH 已认证，但服务器 SFTP 子系统响应超时",
  );
}

async function ensureSftpDirectory(sftp, directory, timeoutMs) {
  try {
    await callSftp(sftp, "stat", [directory], timeoutMs, "SSH SFTP 检查 .ssh 目录超时");
  } catch (error) {
    if (!isMissingSftpPath(error)) throw error;
    await callSftp(sftp, "mkdir", [directory, { mode: 0o700 }], timeoutMs, "SSH SFTP 创建 .ssh 目录超时");
  }
  await callSftp(sftp, "chmod", [directory, 0o700], timeoutMs, "SSH SFTP 设置 .ssh 权限超时");
}

async function readAuthorizedKeys(sftp, filename, timeoutMs) {
  try {
    const attributes = await callSftp(sftp, "stat", [filename], timeoutMs, "SSH SFTP 检查授权文件超时");
    if (Number(attributes?.size || 0) > MAX_AUTHORIZED_KEYS_BYTES) {
      throw connectorError("目标服务器 authorized_keys 过大，拒绝自动修改");
    }
    const contents = await callSftp(sftp, "readFile", [filename], timeoutMs, "SSH SFTP 读取授权文件超时");
    return Buffer.isBuffer(contents) ? contents.toString("utf8") : String(contents || "");
  } catch (error) {
    if (isMissingSftpPath(error)) return "";
    throw error;
  }
}

function updateAuthorizedKeysText(current, { addLine, removeMarker }) {
  if (addLine) {
    if (current.split(/\r?\n/).includes(addLine)) return current;
    return `${current}${current && !current.endsWith("\n") ? "\n" : ""}${addLine}\n`;
  }
  const hadTrailingNewline = current.endsWith("\n");
  const kept = current.split(/\r?\n/).filter((line) => !line.includes(removeMarker));
  while (kept.length && kept.at(-1) === "") kept.pop();
  const updated = kept.join("\n");
  return updated ? `${updated}${hadTrailingNewline ? "\n" : ""}` : "";
}

function callSftp(sftp, method, args, timeoutMs, timeoutMessage) {
  return timedCallback((callback) => sftp[method](...args, callback), timeoutMs, timeoutMessage);
}

function timedCallback(start, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation(value);
    };
    const timer = setTimeout(() => finish(reject, connectorError(timeoutMessage)), timeoutMs);
    try {
      start((error, value) => {
        if (error) finish(reject, error);
        else finish(resolve, value);
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

function isMissingSftpPath(error) {
  return error?.code === 2 || /no such file/i.test(String(error?.message || ""));
}

function readSshString(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new Error("Invalid SSH host key");
  const length = buffer.readUInt32BE(0);
  if (length < 1 || length > 128 || 4 + length > buffer.length) throw new Error("Invalid SSH host key type");
  const value = buffer.subarray(4, 4 + length).toString("ascii");
  if (!/^(?:ssh-|ecdsa-sha2-|sk-)[A-Za-z0-9@._+-]+$/.test(value)) {
    throw new Error("Unsupported SSH host key type");
  }
  return value;
}

function execute(client, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stream = null;
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation(value);
    };
    const timer = setTimeout(() => {
      stream?.close();
      client.end();
      finish(reject, connectorError("SSH 远程操作超时"));
    }, timeoutMs);
    client.exec(command, (error, remoteStream) => {
      if (error) {
        finish(reject, error);
        return;
      }
      stream = remoteStream;
      let stderr = "";
      remoteStream.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-1_000);
      });
      remoteStream.on("close", (code) => {
        if (code === 0) finish(resolve);
        else finish(reject, connectorError(stderr.trim() ? "目标服务器拒绝修改 SSH 授权" : "SSH 远程操作失败"));
      });
    });
  });
}

function installCommand(line) {
  const quoted = shellQuote(line);
  return [
    "umask 077",
    'mkdir -p "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys"',
    'chmod 700 "$HOME/.ssh"',
    'chmod 600 "$HOME/.ssh/authorized_keys"',
    `grep -Fqx -- ${quoted} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${quoted} >>"$HOME/.ssh/authorized_keys"`,
  ].join("; ");
}

function removeCommand(marker) {
  const quoted = shellQuote(marker);
  return [
    'if [ -f "$HOME/.ssh/authorized_keys" ]',
    "then",
    'tmp=$(mktemp "$HOME/.ssh/authorized_keys.wfl.XXXXXX")',
    `grep -Fv -- ${quoted} "$HOME/.ssh/authorized_keys" >"$tmp" || true`,
    'chmod 600 "$tmp"',
    'mv "$tmp" "$HOME/.ssh/authorized_keys"',
    "fi",
  ].join("; ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function connectorError(message) {
  return Object.assign(new Error(message), { statusCode: 424, sshAttemptFailed: true });
}

function hostKeyResponse(connection) {
  if (!connection?.fingerprint || !connection?.hostKey) return null;
  return {
    hostKeyFingerprint: connection.fingerprint,
    hostKey: connection.hostKey,
  };
}

async function rollbackMarker(connection, marker, timeoutMs) {
  if (!connection?.client || !marker) return;
  await updateAuthorizedKeysWithSftp(connection.client, {
    removeMarker: marker,
    timeoutMs,
  }).catch(() => execute(connection.client, removeCommand(marker), timeoutMs).catch(() => {}));
}
