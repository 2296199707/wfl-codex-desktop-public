import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuth } from "../lib/auth.mjs";
import {
  normalizeRescueCredentialSource,
  publishRescueCredentialMirror,
} from "../lib/rescue-credential-mirror.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDirectory = path.resolve(
  process.env.CODEX_DESKTOP_STATE_DIR || path.join(appDir, ".codex-desktop"),
);
const runtimeDirectory = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(appDir, ".codex-runtime"),
);
const authFile = path.resolve(
  process.env.CODEX_DESKTOP_AUTH_FILE || path.join(stateDirectory, "auth.json"),
);
const mirrorFile = path.resolve(
  process.env.CODEX_DESKTOP_RESCUE_CREDENTIAL_MIRROR
    || path.join(runtimeDirectory, "rescue-credentials", "current.json"),
);
const packageJson = JSON.parse(await fs.readFile(path.join(appDir, "package.json"), "utf8"));

const source = await readMainOwnerCredential();
const status = await publishRescueCredentialMirror({
  mirrorPath: mirrorFile,
  source,
});

if (status?.state !== "ready") {
  throw new Error(status?.lastError || "备用站管理员凭据同步失败");
}

console.log(JSON.stringify({
  ok: true,
  mirrorFile,
  generation: status.generation,
  state: status.state,
}, null, 2));

async function readMainOwnerCredential() {
  const config = await readJson(path.join(stateDirectory, "multi-user.json"));
  const users = await readJson(path.join(stateDirectory, "users.json"));
  if (config?.ownerId && Array.isArray(users?.users)) {
    const owner = users.users.find((user) => user.id === config.ownerId);
    if (owner) {
      return normalizeRescueCredentialSource({
        userId: owner.id,
        username: owner.username,
        role: owner.role,
        status: owner.status,
        password: owner.password,
        sourceRevision: owner.password?.credentialRevision || 0,
        sourceVersion: packageJson.version,
      });
    }
  }
  const auth = await loadAuth(authFile);
  if (!auth) throw new Error(`主站管理员凭据不存在：${authFile}`);
  return normalizeRescueCredentialSource({
    userId: "u-0000000000000000",
    username: auth.username,
    role: "owner",
    status: "active",
    password: auth,
    sourceRevision: auth.credentialRevision || 0,
    sourceVersion: packageJson.version,
  });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
