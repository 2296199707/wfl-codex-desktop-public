import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function loadOrCreateSessionToken(stateDirectory) {
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDirectory, 0o700);
  const tokenPath = path.join(stateDirectory, "session-token");
  try {
    const token = (await fs.readFile(tokenPath, "utf8")).trim();
    if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid session token");
    await fs.chmod(tokenPath, 0o600);
    return token;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const token = crypto.randomBytes(32).toString("base64url");
  try {
    await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = (await fs.readFile(tokenPath, "utf8")).trim();
    if (!TOKEN_PATTERN.test(existing)) throw new Error("Invalid session token");
    await fs.chmod(tokenPath, 0o600);
    return existing;
  }
}
