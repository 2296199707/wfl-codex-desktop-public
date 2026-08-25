import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const marker = "WFL Codex Desktop Repository Rules";

test("WFL deployment instructions remain scoped to the WFL repository", async (t) => {
  const instructions = await fs.readFile(path.join(projectDirectory, "AGENTS.md"), "utf8");
  assert.match(instructions, new RegExp(marker));
  assert.match(instructions, /rescue-active-port/);
  assert.match(instructions, /blue-green path/);

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-agents-scope-"));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const wflProject = path.join(temporaryRoot, "wfl-project");
  const unrelatedProject = path.join(temporaryRoot, "unrelated-project");
  const homeDirectory = path.join(temporaryRoot, "home");
  const codexHome = path.join(homeDirectory, ".codex");
  await Promise.all([
    fs.mkdir(wflProject, { recursive: true }),
    fs.mkdir(unrelatedProject, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
  ]);
  await fs.writeFile(path.join(wflProject, "AGENTS.md"), instructions);

  const wflPrompt = await renderPromptInput(wflProject, { homeDirectory, codexHome });
  if (wflPrompt.unsupported) {
    t.skip("installed Codex CLI does not provide debug prompt-input");
    return;
  }
  assert.match(wflPrompt.stdout, new RegExp(marker));

  const unrelatedPrompt = await renderPromptInput(unrelatedProject, { homeDirectory, codexHome });
  assert.equal(unrelatedPrompt.unsupported, false);
  assert.doesNotMatch(unrelatedPrompt.stdout, new RegExp(marker));
  assert.doesNotMatch(unrelatedPrompt.stdout, /rescue-active-port/);
});

function renderPromptInput(cwd, { homeDirectory, codexHome }) {
  const codexCommand = process.env.CODEX_DESKTOP_CODEX_BIN || "codex";
  return new Promise((resolve, reject) => {
    const child = spawn(codexCommand, ["debug", "prompt-input", "scope-probe"], {
      cwd,
      env: {
        ...process.env,
        HOME: homeDirectory,
        CODEX_HOME: codexHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      if (error.code === "ENOENT") resolve({ unsupported: true, stdout: "" });
      else reject(error);
    });
    child.once("exit", (code) => {
      if (code === 0) resolve({ unsupported: false, stdout });
      else if (/unrecognized subcommand|unknown command|unexpected argument/i.test(stderr)) {
        resolve({ unsupported: true, stdout: "" });
      } else {
        reject(new Error(stderr.trim() || `codex debug prompt-input exited with status ${code}`));
      }
    });
  });
}
