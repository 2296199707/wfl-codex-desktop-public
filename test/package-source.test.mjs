import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_RUNTIME_BUNDLE_PACKAGE_ASSETS,
  CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY,
  createPackageManifest,
  IMAGE_EXECUTION_PACKAGE_ASSETS,
  IMAGE_EXECUTION_PACKAGE_CAPABILITY,
  MAP_EDITOR_PACKAGE_ASSETS,
  MAP_EDITOR_PACKAGE_CAPABILITY,
  inspectPackageSource,
  PACKAGE_MANIFEST_NAME,
} from "../lib/package-source.mjs";

test("release package manifests bind the archive to one version and source commit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-package-source-"));
  const version = "1.2.3";
  const commit = "a".repeat(40);
  try {
    await Promise.all([
      fs.mkdir(path.join(directory, "public"), { recursive: true }),
      fs.mkdir(path.join(directory, "public", "character-editor"), { recursive: true }),
      fs.mkdir(path.join(directory, "scripts"), { recursive: true }),
      fs.mkdir(path.join(directory, "lib"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(directory, "VERSION"), `${version}\n`),
      fs.writeFile(path.join(directory, "package.json"), JSON.stringify({
        name: "test-package",
        version,
        engines: { node: ">=22" },
      })),
      fs.writeFile(path.join(directory, "CHANGELOG.md"), `## [${version}] - 2026-07-20\n`),
      fs.writeFile(path.join(directory, "server.mjs"), ""),
      fs.writeFile(path.join(directory, "gateway.mjs"), ""),
      fs.writeFile(
        path.join(directory, "public", "index.html"),
        `<html data-version="${version}" data-asset-version="${version}"></html>\n`,
      ),
      fs.writeFile(
        path.join(directory, "public", "app.js"),
        `const UI_VERSION = "${version}";\nconst UI_VERSION_LABEL = "${version}";\n`,
      ),
      fs.writeFile(path.join(directory, "scripts", "install-server.sh"), ""),
      ...CODEX_RUNTIME_BUNDLE_PACKAGE_ASSETS.map(async (relativePath) => {
        const target = path.join(directory, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, "");
      }),
      ...IMAGE_EXECUTION_PACKAGE_ASSETS.map(async (relativePath) => {
        const target = path.join(directory, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, "");
      }),
      ...MAP_EDITOR_PACKAGE_ASSETS.map(async (relativePath) => {
        const target = path.join(directory, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(
          target,
          relativePath === "public/character-editor/character-editor.js"
            ? "const imageStudio = import(`/image-studio.js?v=${encodeURIComponent(ASSET_VERSION)}`);\n"
            : "",
        );
      }),
      fs.writeFile(
        path.join(directory, PACKAGE_MANIFEST_NAME),
        JSON.stringify(createPackageManifest({ name: "test-package", version, sourceCommit: commit })),
      ),
    ]);

    const source = await inspectPackageSource(directory, { expectedCommit: commit });
    assert.equal(source.version, version);
    assert.equal(source.manifest.sourceCommit, commit);
    assert.equal(source.manifest.format, 2);
    assert.equal(source.manifest.stateSchema, 1);
    assert.equal(source.packageJson.engines.node, ">=22");
    assert.deepEqual(source.manifest.capabilities, [
      "deployment-recovery-v1",
      "owner-rescue-v3",
      "main-standby-handoff-v1",
      CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY,
      IMAGE_EXECUTION_PACKAGE_CAPABILITY,
      MAP_EDITOR_PACKAGE_CAPABILITY,
    ]);
    for (const relativePath of [
      "public/character-editor.html",
      "public/character-editor/character-editor.css",
      "public/character-editor/character-editor.js",
      "public/character-editor/character-animation-model.js",
    ]) {
      assert.ok(MAP_EDITOR_PACKAGE_ASSETS.includes(relativePath), `${relativePath} is missing from the map package`);
    }
    await fs.rm(path.join(directory, "scripts", "image-execution-worker.mjs"));
    await assert.rejects(
      inspectPackageSource(directory),
      /ENOENT/,
    );
    await fs.writeFile(path.join(directory, "scripts", "image-execution-worker.mjs"), "");
    await fs.rm(path.join(directory, MAP_EDITOR_PACKAGE_ASSETS.at(-1)));
    await assert.rejects(
      inspectPackageSource(directory),
      /ENOENT/,
    );
    await fs.writeFile(path.join(directory, MAP_EDITOR_PACKAGE_ASSETS.at(-1)), "");
    await assert.rejects(
      inspectPackageSource(directory, { expectedCommit: "b".repeat(40) }),
      /does not match the fetched release commit/,
    );
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({
      name: "test-package",
      version,
      engines: { node: "^22" },
    }));
    await assert.rejects(
      inspectPackageSource(directory),
      /无法识别的 Node.js 要求/,
    );
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({
      name: "test-package",
      version,
      engines: { node: ">=22" },
    }));
    const incompleteManifest = createPackageManifest({ name: "test-package", version, sourceCommit: commit });
    delete incompleteManifest.capabilities;
    await fs.writeFile(path.join(directory, PACKAGE_MANIFEST_NAME), JSON.stringify(incompleteManifest));
    await assert.rejects(
      inspectPackageSource(directory),
      /missing its deployment recovery capability/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
