import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const [runtimeDirectory, stateDirectory, operationId] = process.argv.slice(2);
if (!runtimeDirectory || !stateDirectory || !operationId) throw new Error("Invalid legacy parent fixture arguments");

await fs.mkdir(runtimeDirectory, { recursive: true });
const lockPath = path.join(runtimeDirectory, "app-update.lock");
await fs.writeFile(lockPath, `${process.pid}\n`, { mode: 0o600 });
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectDirectory, "scripts", "release.mjs"), "--worker"], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
        CODEX_DESKTOP_STATE_DIR: stateDirectory,
        CODEX_DESKTOP_CANCEL_DECISION_MANAGED: "1",
      },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  process.exitCode = code;
} finally {
  await fs.rm(lockPath, { force: true });
}
