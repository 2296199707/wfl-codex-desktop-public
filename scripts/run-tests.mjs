import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDirectory = path.join(projectDirectory, "test");
const testFiles = (await fs.readdir(testDirectory))
  .filter((filename) => filename.endsWith(".test.mjs"))
  .sort();

for (const filename of testFiles) {
  await runTestFile(path.join(testDirectory, filename));
}

console.log(`Passed ${testFiles.length} test files`);

function runTestFile(filename) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [filename], {
      cwd: projectDirectory,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(filename)} failed (${code ?? signal})`));
    });
  });
}
