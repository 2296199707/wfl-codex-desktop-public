import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAuthRecord,
  generatePassword,
  loadAuth,
  nextAuthCredentialRevision,
  writeAuth,
} from "../lib/auth.mjs";
import { normalizeRescueCredentialSource, publishRescueCredentialMirror } from "../lib/rescue-credential-mirror.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authFile = path.resolve(
  process.env.CODEX_DESKTOP_AUTH_FILE || path.join(APP_DIR, ".codex-desktop", "auth.json"),
);
const runtimeDirectory = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(APP_DIR, ".codex-runtime"),
);
const rescueCredentialMirror = path.resolve(
  process.env.CODEX_DESKTOP_RESCUE_CREDENTIAL_MIRROR
    || path.join(runtimeDirectory, "rescue-credentials", "current.json"),
);
const username = process.env.CODEX_DESKTOP_USERNAME || "codex";
const password = process.env.CODEX_DESKTOP_NEW_PASSWORD || generatePassword();
const hidePassword = process.env.CODEX_DESKTOP_HIDE_PASSWORD === "1";

const previousAuth = await loadAuth(authFile);
const auth = {
  ...createAuthRecord(username, password),
  credentialRevision: nextAuthCredentialRevision(previousAuth?.credentialRevision),
};
await writeAuth(authFile, auth);
const rescueSync = await publishRescueCredentialMirror({
  mirrorPath: rescueCredentialMirror,
  source: normalizeRescueCredentialSource({
    userId: "u-0000000000000000",
    username,
    role: "owner",
    status: "active",
    password: auth,
  }),
});

console.log(`Username: ${username}`);
console.log(`Password: ${hidePassword ? "updated" : password}`);
console.log(`Auth file: ${authFile}`);
console.log(`Rescue credentials: ${rescueSync?.state === "ready" ? `generation ${rescueSync.generation}` : "pending retry"}`);
console.log("Restart the server after changing the password.");
