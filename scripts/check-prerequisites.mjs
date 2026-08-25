import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectCodexInstallation } from "../lib/codex-prerequisite.mjs";

try {
  const required = ["bwrap", "ffmpeg", "Xvfb", "xauth", "x11vnc", "xclip", "xdotool"];
  const resolved = await Promise.all(required.map(resolveCommand));
  const missing = required.filter((_command, index) => !resolved[index]);
  if (missing.length) throw new Error(`missing commands: ${missing.join(", ")}`);
  console.log("Server OAuth browser: available");
} catch (error) {
  console.error(`Server OAuth browser prerequisites are incomplete: ${error.message}`);
  console.error("Install bubblewrap, ffmpeg, Xvfb, xauth, x11vnc, xclip, and xdotool first.");
  process.exitCode = 1;
}

async function resolveCommand(command) {
  const directories = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, command);
    if (await fs.access(candidate, fsConstants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}

try {
  const codex = await inspectCodexInstallation();
  console.log(`Official Codex: ${codex.version}`);
  console.log("Codex app-server: available");
} catch (error) {
  console.error(error.message);
  console.error("Install Codex first: curl -fsSL https://chatgpt.com/codex/install.sh | sh");
  process.exitCode = 1;
}
