import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProviderStore } from "../lib/provider-store.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configureScript = path.join(projectDir, "scripts", "configure-provider.mjs");
const fixture = fileURLToPath(new URL("./fixtures/fake-codex-config-server.mjs", import.meta.url));

test("guided provider configuration uses Codex RPC and persists no plaintext key", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-provider-config-"));
  const apiKey = "installer-provider-secret";
  try {
    const result = await runConfigure(directory, { apiKey });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(apiKey));
    assert.equal((await fs.stat(path.join(directory, "codex-home"))).mode & 0o777, 0o700);

    const store = await new ProviderStore(path.join(directory, "state")).initialize();
    const snapshot = store.snapshot();
    assert.ok(snapshot.activeId);
    assert.equal(snapshot.fallback.providerId, "openai");
    assert.equal(snapshot.fallback.model, "gpt-original");
    assert.equal(store.getActiveProfile().apiKey, apiKey);
    const encrypted = await fs.readFile(path.join(directory, "state", "providers.enc.json"), "utf8");
    assert.doesNotMatch(encrypted, new RegExp(apiKey));
    assert.equal((await fs.stat(path.join(directory, "state", "providers.enc.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(directory, "state", "provider-store.key"))).mode & 0o777, 0o600);

    const config = JSON.parse(await fs.readFile(path.join(directory, "codex-config.json"), "utf8"));
    assert.equal(config.model_provider, `desktop-${snapshot.activeId}`);
    assert.equal(config.model, "model-guided");
    assert.equal(config.model_providers[config.model_provider].wire_api, "responses");
    assert.equal(config.model_providers[config.model_provider].env_key, "CODEX_DESKTOP_PROVIDER_KEY");

    const configured = await runProcess(process.execPath, [configureScript, "--configured"], {
      ...process.env,
      CODEX_DESKTOP_STATE_DIR: path.join(directory, "state"),
    });
    assert.equal(configured.code, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("configured check does not create an empty provider store", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-provider-check-"));
  try {
    const stateDirectory = path.join(directory, "missing-state");
    const result = await runProcess(process.execPath, [configureScript, "--configured"], {
      ...process.env,
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
    });
    assert.equal(result.code, 1);
    await assert.rejects(fs.access(stateDirectory), { code: "ENOENT" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("guided provider configuration may defer the model to the home-page selector", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-provider-no-model-"));
  try {
    const result = await runConfigure(directory, { apiKey: "model-later-secret", model: "" });
    assert.equal(result.code, 0, result.stderr);
    const store = await new ProviderStore(path.join(directory, "state")).initialize();
    assert.equal(store.getActiveProfile().model, null);
    const config = JSON.parse(await fs.readFile(path.join(directory, "codex-config.json"), "utf8"));
    assert.equal(config.model, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("guided provider configuration replaces an orphaned desktop fallback", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-provider-orphan-"));
  try {
    const result = await runConfigure(directory, {
      apiKey: "replacement-secret",
      initialProvider: "desktop-p-deadbeefcafe",
      initialModel: "orphaned-model",
    });
    assert.equal(result.code, 0, result.stderr);
    const store = await new ProviderStore(path.join(directory, "state")).initialize();
    assert.deepEqual(store.snapshot().fallback, { providerId: "openai", model: null });
    assert.ok(store.snapshot().activeId);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("guided provider configuration rolls back activation when Codex readiness fails", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-provider-rollback-"));
  try {
    const result = await runConfigure(directory, { apiKey: "rollback-secret", failThread: true });
    assert.notEqual(result.code, 0);
    const store = await new ProviderStore(path.join(directory, "state")).initialize();
    assert.equal(store.snapshot().activeId, null);
    assert.equal(store.snapshot().profiles.length, 0);
    const config = JSON.parse(await fs.readFile(path.join(directory, "codex-config.json"), "utf8"));
    assert.equal(config.model_provider, "openai");
    assert.equal(config.model, "gpt-original");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function runConfigure(directory, {
  apiKey,
  model = "model-guided",
  failThread = false,
  initialProvider = "openai",
  initialModel = "gpt-original",
}) {
  const wrapper = path.join(directory, "fake-codex");
  await fs.writeFile(
    wrapper,
    `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(fixture).href)}).catch((error) => { console.error(error); process.exitCode = 1; });\n`,
    { mode: 0o700 },
  );
  return runProcess(process.execPath, [configureScript], {
    ...process.env,
    CODEX_DESKTOP_CODEX_BIN: wrapper,
    CODEX_HOME: path.join(directory, "codex-home"),
    CODEX_DESKTOP_STATE_DIR: path.join(directory, "state"),
    FAKE_CODEX_CONFIG_PATH: path.join(directory, "codex-config.json"),
    FAKE_EXPECTED_PROVIDER_KEY: apiKey,
    FAKE_CODEX_INITIAL_PROVIDER: initialProvider,
    FAKE_CODEX_INITIAL_MODEL: initialModel,
    ...(failThread ? { FAKE_CODEX_FAIL_THREAD: "1" } : {}),
  }, `Guided API\0https://api.example.test/v1\0${model}\0${apiKey}\0`);
}

function runProcess(command, args, environment, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectDir,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
