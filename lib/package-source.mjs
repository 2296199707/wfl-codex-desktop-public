import fs from "node:fs/promises";
import path from "node:path";
import { parseMinimumNodeEngine } from "./node-runtime-compatibility.mjs";
import { assertReleaseVersionMetadata } from "./release-version-metadata.mjs";
import { RESCUE_COMPONENT_VERSION } from "./rescue-component.mjs";

export const PACKAGE_MANIFEST_NAME = ".codex-package.json";
export const CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY = "codex-runtime-bundle-v1";
export const CODEX_RUNTIME_BUNDLE_PACKAGE_ASSETS = Object.freeze([
  "lib/codex-compatibility.mjs",
  "lib/codex-prerequisite.mjs",
  "lib/codex-protocol-coverage.mjs",
  "lib/codex-runtime-bundle.mjs",
  "lib/codex-runtime-capabilities.mjs",
  "test/fixtures/codex-app-server-0.149.0-client-methods.json",
  "test/fixtures/codex-app-server-0.149.0-notifications.json",
  "test/fixtures/codex-app-server-0.149.0-schema-manifest.json",
  "test/fixtures/codex-app-server-0.149.0-server-methods.json",
]);
export const IMAGE_EXECUTION_PACKAGE_CAPABILITY = "image-execution-worker-v1";
export const IMAGE_EXECUTION_PACKAGE_ASSETS = Object.freeze([
  "lib/image-atomic-save.mjs",
  "lib/image-canvas-plan.mjs",
  "lib/image-execution-queue.mjs",
  "lib/image-execution-settings.mjs",
  "lib/image-file.mjs",
  "lib/image-outpaint.mjs",
  "lib/image-partial-preview-store.mjs",
  "lib/image-project-anchor.mjs",
  "lib/image-provider-tool-service.mjs",
  "lib/image-provider-user.mjs",
  "lib/image-quota-reservations.mjs",
  "lib/image-secure-input.mjs",
  "lib/image-worker-runner.mjs",
  "lib/image-zero-compression.mjs",
  "lib/openai-image.mjs",
  "public/image-attachment-context.js",
  "public/image-context-policy.js",
  "public/image-studio.css",
  "public/image-studio.js",
  "public/visual-review.css",
  "public/visual-review.js",
  "scripts/image-execution-worker.mjs",
  "scripts/image-provider-mcp.mjs",
]);

export const MAP_EDITOR_PACKAGE_CAPABILITY = "browser-map-editor-v1";
export const MAP_EDITOR_PACKAGE_ASSETS = Object.freeze([
  "lib/map-ai-access-store.mjs",
  "lib/map-ai-approval-policy.mjs",
  "lib/map-ai-managed-authorization-store.mjs",
  "lib/map-ai-project-scope.mjs",
  "lib/map-ai-managed-task-store.mjs",
  "lib/map-ai-managed-task-executor.mjs",
  "lib/map-ai-patch-worker-runner.mjs",
  "lib/map-ai-patch-proposal-store.mjs",
  "lib/map-ai-protected-targets.mjs",
  "lib/map-ai-resource-candidate-store.mjs",
  "lib/map-ai-resource-upload-store.mjs",
  "lib/map-ai-risk.mjs",
  "lib/map-ai-tool-service.mjs",
  "lib/map-ai-managed-tool-service.mjs",
  "lib/map-collaboration-policy-store.mjs",
  "lib/map-runtime-capabilities.mjs",
  "lib/map-ai-diff.mjs",
  "lib/map-asset-publication.mjs",
  "lib/map-file-sessions.mjs",
  "lib/map-project-catalog.mjs",
  "lib/map-project-create.mjs",
  "lib/map-project-import.mjs",
  "lib/map-project-resource-write.mjs",
  "lib/map-recovery-project-scan.mjs",
  "lib/map-project-tileset-create.mjs",
  "lib/map-project-world-create.mjs",
  "lib/map-project-sessions.mjs",
  "lib/map-image-input-store.mjs",
  "lib/map-image-job-store.mjs",
  "lib/map-render-cache.mjs",
  "lib/map-render-jobs.mjs",
  "lib/map-render-preview.mjs",
  "lib/map-render-settings.mjs",
  "lib/map-render-worker-runner.mjs",
  "lib/map-resource-catalog.mjs",
  "lib/map-revision-store.mjs",
  "lib/map-save-sessions.mjs",
  "lib/map-selection-image-target.mjs",
  "public/map-editor.html",
  "public/tileset-editor.html",
  "public/world-editor.html",
  "public/character-editor.html",
  "public/character-editor/character-editor.css",
  "public/character-editor/character-editor.js",
  "public/character-editor/character-animation-model.js",
  "public/game-work-mode.js",
  "public/map-project-session.js",
  "public/map-editor/map-ai-lease-revoke.js",
  "public/map-editor/map-ai-proposals.js",
  "public/map-editor/map-account-session-guard.js",
  "public/map-editor/map-editor.css",
  "public/map-editor/map-editor.js",
  "public/map-editor/map-editor-view-state.js",
  "public/map-editor/map-guide-controller.js",
  "public/map-editor/map-gamepad-controller.js",
  "public/map-editor/tileset-editor.css",
  "public/map-editor/tileset-editor.js",
  "public/map-editor/world-editor.css",
  "public/map-editor/world-editor.js",
  "public/map-editor/map-image-apply.js",
  "public/map-editor/map-image-boundary.js",
  "public/map-editor/map-image-candidates.js",
  "public/map-editor/map-asset-library.js",
  "public/map-editor/map-object-model.js",
  "public/map-editor/map-conversation-channel.js",
  "public/map-editor/map-tab-channel.js",
  "public/map-editor/map-selection-image-target.js",
  "public/map-editor/pixi-viewer.js",
  "public/map-editor/render-page.js",
  "public/map-editor/tile-selection-model.js",
  "public/map-editor/tile-stamp-library.js",
  "public/map-editor/tile-tool-model.js",
  "public/map-editor/terrain-brush-model.js",
  "public/map-editor/tiled-gid-reuse.js",
  "public/map-editor/tiled-project-types.js",
  "public/map-editor/tiled-composite.js",
  "public/map-editor/tiled-template.js",
  "public/map-editor/tiled-ai-patch.js",
  "public/map-editor/tiled-ai-patch-worker.js",
  "public/map-editor/tiled-ai-patch-worker-client.js",
  "public/map-editor/tiled-automap.js",
  "public/map-editor/tiled-automap-worker.js",
  "public/map-editor/tiled-automap-worker-client.js",
  "public/map-editor/tiled-document.js",
  "public/map-editor/tiled-edit-document.js",
  "public/map-editor/tiled-fill.js",
  "public/map-editor/tiled-fill-worker.js",
  "public/map-editor/tiled-fill-worker-client.js",
  "public/map-editor/tiled-render-model.js",
  "public/map-editor/tiled-tile-codec.js",
  "public/map-editor/tiled-tileset-import.js",
  "public/map-editor/tiled-tileset-edit-document.js",
  "public/map-editor/tiled-tileset-model.js",
  "public/map-editor/tiled-world.js",
  "public/map-editor/tiled-world-navigation.js",
  "scripts/map-ai-mcp.mjs",
  "scripts/map-ai-managed-mcp.mjs",
  "scripts/map-ai-patch-worker.mjs",
  "scripts/benchmark-map-fill.mjs",
  "scripts/benchmark-map-workspace.mjs",
  "scripts/map-render-worker.mjs",
  "scripts/validate-map-selection-image.mjs",
  "scripts/validate-tiled-map.mjs",
]);

export const MAP_EDITOR_RUNTIME_DEPENDENCY_ASSETS = Object.freeze([
  "node_modules/lucide/dist/umd/lucide.min.js",
  "node_modules/pixi.js/dist/pixi.min.js",
  "node_modules/pixi.js/dist/packages/advanced-blend-modes.min.js",
  "node_modules/pixi.js/dist/packages/unsafe-eval.min.js",
]);

export async function inspectPackageSource(directory, { expectedCommit = null } = {}) {
  const [versionText, packageText, changelog, manifestText] = await Promise.all([
    fs.readFile(path.join(directory, "VERSION"), "utf8"),
    fs.readFile(path.join(directory, "package.json"), "utf8"),
    fs.readFile(path.join(directory, "CHANGELOG.md"), "utf8"),
    fs.readFile(path.join(directory, PACKAGE_MANIFEST_NAME), "utf8"),
  ]);
  const version = versionText.trim();
  const packageJson = JSON.parse(packageText);
  const manifest = JSON.parse(manifestText);

  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Package source has an invalid semantic version");
  }
  if (packageJson.version !== version || manifest.version !== version) {
    throw new Error("Package source versions do not match");
  }
  parseMinimumNodeEngine(packageJson?.engines?.node);
  if (![1, 2].includes(manifest.format) || manifest.name !== packageJson.name) {
    throw new Error("Package source manifest is invalid");
  }
  if (manifest.rescueVersion !== undefined && manifest.rescueVersion !== RESCUE_COMPONENT_VERSION) {
    throw new Error(`Package source rescue component must be v${RESCUE_COMPONENT_VERSION}`);
  }
  if (manifest.format === 2 && !manifest.capabilities?.includes("deployment-recovery-v1")) {
    throw new Error("Package source is missing its deployment recovery capability");
  }
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(manifest.sourceCommit || "")) {
    throw new Error("Package source commit is invalid");
  }
  if (expectedCommit && manifest.sourceCommit.toLowerCase() !== expectedCommit.toLowerCase()) {
    throw new Error("Package source does not match the fetched release commit");
  }
  if (!changelog.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG.md has no v${version} entry`);
  }
  await assertReleaseVersionMetadata(directory, { expectedVersion: version });
  await Promise.all([
    fs.access(path.join(directory, "server.mjs")),
    fs.access(path.join(directory, "gateway.mjs")),
    fs.access(path.join(directory, "public", "index.html")),
    fs.access(path.join(directory, "scripts", "install-server.sh")),
    ...(manifest.capabilities?.includes(CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY)
      ? CODEX_RUNTIME_BUNDLE_PACKAGE_ASSETS.map((relativePath) => fs.access(path.join(directory, relativePath)))
      : []),
    ...(manifest.capabilities?.includes(IMAGE_EXECUTION_PACKAGE_CAPABILITY)
      ? IMAGE_EXECUTION_PACKAGE_ASSETS.map((relativePath) => fs.access(path.join(directory, relativePath)))
      : []),
    ...(manifest.capabilities?.includes(MAP_EDITOR_PACKAGE_CAPABILITY)
      ? MAP_EDITOR_PACKAGE_ASSETS.map((relativePath) => fs.access(path.join(directory, relativePath)))
      : []),
  ]);
  return { version, packageJson, manifest };
}

export function createPackageManifest({ name, version, sourceCommit, createdAt = new Date().toISOString() }) {
  return {
    format: 2,
    name,
    version,
    sourceCommit,
    stateSchema: 1,
    minimumStateSchema: 1,
    rescueVersion: RESCUE_COMPONENT_VERSION,
    capabilities: [
      "deployment-recovery-v1",
      "owner-rescue-v3",
      "main-standby-handoff-v1",
      CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY,
      IMAGE_EXECUTION_PACKAGE_CAPABILITY,
      MAP_EDITOR_PACKAGE_CAPABILITY,
    ],
    createdAt,
  };
}
