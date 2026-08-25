import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_RUNTIME_BUNDLE_PACKAGE_ASSETS,
  createPackageManifest,
  IMAGE_EXECUTION_PACKAGE_ASSETS,
  MAP_EDITOR_PACKAGE_ASSETS,
  PACKAGE_MANIFEST_NAME,
} from "../lib/package-source.mjs";

test("a release package can atomically acquire exact update metadata from a Git remote", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-package-git-"));
  const source = path.join(directory, "source");
  const remote = path.join(directory, "remote.git");
  const version = "1.2.3";
  try {
    await Promise.all([
      fs.mkdir(path.join(source, "public"), { recursive: true }),
      fs.mkdir(path.join(source, "public", "character-editor"), { recursive: true }),
      fs.mkdir(path.join(source, "scripts"), { recursive: true }),
      fs.mkdir(path.join(source, "lib"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(source, ".gitignore"), `${PACKAGE_MANIFEST_NAME}\n`),
      fs.writeFile(path.join(source, "VERSION"), `${version}\n`),
      fs.writeFile(path.join(source, "package.json"), JSON.stringify({
        name: "test-package",
        version,
        engines: { node: ">=22" },
      })),
      fs.writeFile(path.join(source, "CHANGELOG.md"), `## [${version}] - 2026-07-20\n`),
      fs.writeFile(path.join(source, "server.mjs"), ""),
      fs.writeFile(path.join(source, "gateway.mjs"), ""),
      fs.writeFile(
        path.join(source, "public", "index.html"),
        `<html data-version="${version}" data-asset-version="${version}"></html>\n`,
      ),
      fs.writeFile(
        path.join(source, "public", "app.js"),
        `const UI_VERSION = "${version}";\nconst UI_VERSION_LABEL = "${version}";\n`,
      ),
      fs.writeFile(path.join(source, "scripts", "install-server.sh"), ""),
      ...CODEX_RUNTIME_BUNDLE_PACKAGE_ASSETS.map(async (relativePath) => {
        const target = path.join(source, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, "");
      }),
      ...IMAGE_EXECUTION_PACKAGE_ASSETS.map(async (relativePath) => {
        const target = path.join(source, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, "");
      }),
      ...MAP_EDITOR_PACKAGE_ASSETS.map(async (relativePath) => {
        const target = path.join(source, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(
          target,
          relativePath === "public/character-editor/character-editor.js"
            ? "const imageStudio = import(`/image-studio.js?v=${encodeURIComponent(ASSET_VERSION)}`);\n"
            : "",
        );
      }),
    ]);
    await run("git", ["init", "--initial-branch=main"], source);
    await run("git", ["config", "user.name", "Package Test"], source);
    await run("git", ["config", "user.email", "package-test@example.invalid"], source);
    await run("git", ["add", "."], source);
    await run("git", ["commit", "-m", "release"], source);
    const commit = (await capture("git", ["rev-parse", "HEAD"], source)).trim();
    await run("git", ["tag", `v${version}`], source);
    await run("git", ["branch", "stable", commit], source);
    await run("git", ["clone", "--bare", source, remote], directory);
    await fs.rm(path.join(source, ".git"), { recursive: true, force: true });
    await fs.writeFile(
      path.join(source, PACKAGE_MANIFEST_NAME),
      `${JSON.stringify(createPackageManifest({ name: "test-package", version, sourceCommit: commit }))}\n`,
    );

    await capture(process.execPath, [
      path.resolve("scripts/bootstrap-package-git.mjs"),
      "--source",
      source,
      "--remote",
      remote,
    ], process.cwd());

    assert.equal((await capture("git", ["rev-parse", "HEAD"], source)).trim(), commit);
    assert.equal((await capture("git", ["rev-parse", "@{upstream}"], source)).trim(), commit);
    assert.equal(
      (await capture("git", ["rev-parse", "--symbolic-full-name", "@{upstream}"], source)).trim(),
      "refs/remotes/origin/stable",
    );
    assert.equal((await capture("git", ["status", "--porcelain", "--untracked-files=all"], source)).trim(), "");
    assert.equal((await capture("git", ["remote", "get-url", "origin"], source)).trim(), remote);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function capture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim())));
  });
}
