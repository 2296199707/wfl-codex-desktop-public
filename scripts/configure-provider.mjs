import { readSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRpcClient } from "../lib/codex-rpc-client.mjs";
import {
  managedProviderConfig,
  managedProviderId,
  ProviderStore,
  providerFallbackFromCodexConfig,
  providerRuntimeEnvironment,
} from "../lib/provider-store.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stateDir = path.resolve(
  process.env.CODEX_DESKTOP_STATE_DIR || path.join(projectDir, ".codex-desktop"),
);

if (process.argv.includes("--configured")) {
  try {
    await fs.access(path.join(stateDir, "providers.enc.json"));
    const store = await new ProviderStore(stateDir).initialize();
    process.exitCode = store.snapshot().activeId ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
} else {
  await configureProvider();
}

async function configureProvider() {
  const [name, baseUrl, model, apiKey] = await readPrivateInput();
  await ensureCodexHome();
  const store = await new ProviderStore(stateDir).initialize();
  if (store.snapshot().activeId) throw new Error("An API provider is already active; preserve it or use the web provider center");

  const created = await store.create({ name, baseUrl, model, apiKey });
  const profile = store.getProfile(created.id);
  const providerId = managedProviderId(created.id);
  const client = new CodexRpcClient({
    cwd: projectDir,
    environment: cleanProviderEnvironment(providerRuntimeEnvironment(profile)),
    clientVersion: await readVersion(),
  });
  let currentConfig = null;
  let fallbackConfig = null;
  let configWritten = false;
  try {
    await client.start();
    const current = await client.request("config/read", { includeLayers: false, cwd: projectDir });
    currentConfig = {
      providerId: current.config?.model_provider || "openai",
      model: current.config?.model || null,
    };
    fallbackConfig = providerFallbackFromCodexConfig(current.config);
    await client.request("config/batchWrite", {
      edits: [
        {
          keyPath: `model_providers.${providerId}`,
          value: managedProviderConfig(profile),
          mergeStrategy: "replace",
        },
        { keyPath: "model_provider", value: providerId, mergeStrategy: "replace" },
        { keyPath: "model", value: profile.model || null, mergeStrategy: "replace" },
      ],
      reloadUserConfig: false,
    });
    configWritten = true;
    const verified = await client.request("config/read", { includeLayers: false, cwd: projectDir });
    if (verified.config?.model_provider !== providerId || (profile.model && verified.config?.model !== profile.model)) {
      throw new Error("Codex did not activate the requested API provider configuration");
    }
    const threads = await client.request("thread/list", {
      limit: 1,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
    });
    if (!Array.isArray(threads?.data)) throw new Error("Codex thread readiness check failed");
    if (!store.snapshot().fallback) await store.setFallback(fallbackConfig);
    await store.setActive(created.id);
    console.log(`Configured encrypted API provider "${profile.name}"${profile.model ? ` for model ${profile.model}` : ""}.`);
  } catch (error) {
    if (configWritten && currentConfig) {
      await client.request("config/batchWrite", {
        edits: [
          { keyPath: "model_provider", value: currentConfig.providerId, mergeStrategy: "replace" },
          { keyPath: "model", value: currentConfig.model, mergeStrategy: "replace" },
        ],
        reloadUserConfig: false,
      }).catch(() => {});
    }
    await store.setActive(null).catch(() => {});
    await store.remove(created.id).catch(() => {});
    throw error;
  } finally {
    await client.close();
  }
}

async function readPrivateInput() {
  const chunks = [];
  let size = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(4096, 8193 - size));
    const bytesRead = readSync(0, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    size += bytesRead;
    if (size > 8192) throw new Error("Provider input is too large");
    chunks.push(chunk.subarray(0, bytesRead));
  }
  const input = Buffer.concat(chunks, size);
  const values = input.toString("utf8").split("\0");
  if (values.at(-1) === "") values.pop();
  if (values.length !== 4) {
    throw new Error(`Provider input must contain four NUL-delimited fields (received ${values.length})`);
  }
  return values;
}

function cleanProviderEnvironment(runtimeEnvironment) {
  const environment = { ...process.env };
  delete environment.CODEX_DESKTOP_PROVIDER_KEY;
  return { ...environment, ...runtimeEnvironment };
}

async function readVersion() {
  return (await fs.readFile(path.join(projectDir, "VERSION"), "utf8")).trim();
}

async function ensureCodexHome() {
  const directory = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}
