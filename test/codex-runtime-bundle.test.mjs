import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectCodexRuntimeSource,
  prepareCodexRuntimeBundle,
} from "../lib/codex-runtime-bundle.mjs";

test("stages the complete standalone Codex package as an immutable content-addressed runtime", async () => {
  await withStandaloneFixture(async (fixture) => {
    const prepared = await prepareCodexRuntimeBundle({
      command: fixture.command,
      runtimeDirectory: fixture.runtime,
    });
    assert.equal(prepared.officialPackage, true);
    assert.equal(prepared.runtimeBundleReady, true);
    assert.equal(prepared.codeModeHostReady, true);
    assert.equal(prepared.version, "1.2.3");
    assert.match(prepared.directory, /codex-runtimes\/1\.2\.3-[a-f0-9]{64}$/u);
    assert.equal(await fs.readFile(path.join(prepared.directory, "codex-resources", "marker"), "utf8"), "resource\n");
    await fs.access(prepared.executablePath, fs.constants.X_OK);
    await fs.access(prepared.codeModeHostPath, fs.constants.X_OK);

    const repeated = await prepareCodexRuntimeBundle({
      command: fixture.command,
      runtimeDirectory: fixture.runtime,
    });
    assert.equal(repeated.directory, prepared.directory);
    assert.equal(repeated.treeSha256, prepared.treeSha256);
  });
});

test("rejects an official standalone package without its code-mode host", async () => {
  await withStandaloneFixture(async (fixture) => {
    await fs.rm(path.join(fixture.packageRoot, "bin", "codex-code-mode-host"));
    await assert.rejects(
      inspectCodexRuntimeSource({ command: fixture.command, requireOfficial: true }),
      /code-mode host is missing/u,
    );
    await assert.rejects(
      prepareCodexRuntimeBundle({ command: fixture.command, runtimeDirectory: fixture.runtime }),
      /code-mode host is missing/u,
    );
  });
});

test("rejects a nonfunctional code-mode host before publishing the staged runtime", async () => {
  await withStandaloneFixture(async (fixture) => {
    await fs.writeFile(
      path.join(fixture.packageRoot, "bin", "codex-code-mode-host"),
      "#!/bin/sh\nexit 7\n",
      { mode: 0o755 },
    );
    await assert.rejects(
      prepareCodexRuntimeBundle({ command: fixture.command, runtimeDirectory: fixture.runtime }),
      /compatibility probe failed/u,
    );
  });
});

test("copies a legacy fake command for isolated-user tests without claiming bundle readiness", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-legacy-"));
  const command = path.join(root, "private", "fake-codex");
  const runtime = path.join(root, "runtime");
  try {
    await fs.chmod(root, 0o755);
    await fs.mkdir(path.dirname(command), { recursive: true, mode: 0o700 });
    await fs.writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const prepared = await prepareCodexRuntimeBundle({ command, runtimeDirectory: runtime });
    assert.equal(prepared.officialPackage, false);
    assert.equal(prepared.runtimeBundleReady, false);
    assert.equal(prepared.codeModeHostReady, false);
    assert.notEqual(prepared.executablePath, command);
    await fs.access(prepared.executablePath, fs.constants.X_OK);
  } finally {
    await fs.chmod(root, 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function withStandaloneFixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-standalone-"));
  const packageRoot = path.join(root, "releases", "1.2.3-x86_64-unknown-linux-musl");
  const command = path.join(root, "bin", "codex");
  const runtime = path.join(root, "runtime");
  try {
    await fs.chmod(root, 0o755);
    await Promise.all([
      fs.mkdir(path.join(packageRoot, "bin"), { recursive: true }),
      fs.mkdir(path.join(packageRoot, "codex-resources"), { recursive: true }),
      fs.mkdir(path.join(packageRoot, "codex-path"), { recursive: true }),
      fs.mkdir(path.dirname(command), { recursive: true }),
    ]);
    await fs.writeFile(path.join(packageRoot, "codex-package.json"), `${JSON.stringify({
      layoutVersion: 1,
      version: "1.2.3",
      target: "x86_64-unknown-linux-musl",
      variant: "codex",
      entrypoint: "bin/codex",
      resourcesDir: "codex-resources",
      pathDir: "codex-path",
    })}\n`);
    await fs.writeFile(path.join(packageRoot, "bin", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(
      path.join(packageRoot, "bin", "codex-code-mode-host"),
      "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then echo 'Usage: codex-code-mode-host [OPTIONS]'; else exit 2; fi\n",
      { mode: 0o755 },
    );
    await fs.writeFile(path.join(packageRoot, "codex-resources", "marker"), "resource\n", { mode: 0o644 });
    await fs.writeFile(path.join(packageRoot, "codex-path", "rg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.symlink(path.join(packageRoot, "bin", "codex"), command);
    await operation({ root, packageRoot, command, runtime });
  } finally {
    await fs.chmod(root, 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}
