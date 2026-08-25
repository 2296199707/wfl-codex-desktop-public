import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const SSH_UNIX_SOCKET_MAX_BYTES = 107;
export const OPENSSH_CONTROL_TEMP_SUFFIX_BUDGET_BYTES = 24;

const CONTROL_ROOT = "/run/wfl-codex-ssh";

export function temporarySshControlDirectory(runtimeDirectory) {
  const runtimeKey = crypto
    .createHash("sha256")
    .update(path.resolve(runtimeDirectory))
    .digest("hex")
    .slice(0, 12);
  return path.join(CONTROL_ROOT, runtimeKey);
}

export function temporarySshControlPath(controlDirectory, id) {
  if (!/^ssh-[a-f0-9]{16}$/.test(String(id))) throw new Error("Invalid SSH control ID");
  return path.join(path.resolve(controlDirectory), `${id}.ctl`);
}

export function isExpectedTemporarySshControlPath({
  candidate,
  controlDirectory,
  dataDirectory,
  id,
}) {
  const value = String(candidate || "");
  return value === temporarySshControlPath(controlDirectory, id)
    || value === path.join(path.resolve(dataDirectory), `${id}.ctl`);
}

export function assertSafeSshControlPath(controlPath) {
  const value = String(controlPath || "");
  const controlBytes = Buffer.byteLength(value);
  const askpassBytes = Buffer.byteLength(`${value}.askpass`);
  if (
    !path.isAbsolute(value)
    || controlBytes + OPENSSH_CONTROL_TEMP_SUFFIX_BUDGET_BYTES > SSH_UNIX_SOCKET_MAX_BYTES
    || askpassBytes > SSH_UNIX_SOCKET_MAX_BYTES
  ) {
    const error = new Error("本机 SSH 控制套接字路径过长，无法建立临时密码会话");
    error.code = "SSH_CONTROL_PATH_TOO_LONG";
    error.statusCode = 500;
    error.sshAttemptFailed = true;
    throw error;
  }
  return value;
}

export async function ensurePrivateSshSocketDirectory(directory) {
  const resolved = path.resolve(directory);
  try {
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    const details = await fs.lstat(resolved);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : details.uid;
    if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== expectedUid) {
      throw new Error("Unsafe SSH socket directory");
    }
    await fs.chmod(resolved, 0o700);
    return resolved;
  } catch (cause) {
    const error = new Error("无法创建安全的本机 SSH 临时会话目录");
    error.code = "SSH_CONTROL_DIRECTORY_UNSAFE";
    error.statusCode = 500;
    error.sshAttemptFailed = true;
    error.cause = cause;
    throw error;
  }
}
