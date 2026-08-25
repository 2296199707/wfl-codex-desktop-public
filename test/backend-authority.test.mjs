import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackendAuthorityStore, readSelectedBackendPort } from "../lib/backend-authority.mjs";

test("writer authority is monotonic, idempotent for one instance, and fences the old writer", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-backend-authority-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 1_000;
  const store = new BackendAuthorityStore(directory, { now: () => ++now });

  const first = await store.claim({ backendInstanceId: "backend-instance-a", port: 4318 });
  assert.equal(first.writerEpoch, 1);
  assert.deepEqual(
    await store.claim({ backendInstanceId: "backend-instance-a", port: 4318 }),
    first,
  );
  await store.assertCurrent({
    backendInstanceId: "backend-instance-a",
    writerEpoch: first.writerEpoch,
    port: 4318,
  });

  const second = await store.claim({
    backendInstanceId: "backend-instance-b",
    port: 4319,
    expectedWriterEpoch: first.writerEpoch,
  });
  assert.equal(second.writerEpoch, 2);
  await assert.rejects(
    store.assertCurrent({
      backendInstanceId: "backend-instance-a",
      writerEpoch: first.writerEpoch,
      port: 4318,
    }),
    { code: "ERR_BACKEND_WRITER_FENCED" },
  );
  assert.equal((await fs.stat(path.join(directory, "writer-authority.json"))).mode & 0o777, 0o600);
});

test("writer transfer rejects a stale expected epoch", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-backend-authority-conflict-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new BackendAuthorityStore(directory);
  await store.claim({ backendInstanceId: "backend-instance-a", port: 4318 });

  await assert.rejects(
    store.claim({
      backendInstanceId: "backend-instance-b",
      port: 4319,
      expectedWriterEpoch: 8,
    }),
    { code: "ERR_BACKEND_AUTHORITY_CONFLICT" },
  );
  assert.equal((await store.read()).backendInstanceId, "backend-instance-a");
});

test("selected backend port is strict and may be absent only when requested", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-backend-port-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.equal(await readSelectedBackendPort(directory, { allowMissing: true }), null);
  await fs.writeFile(path.join(directory, "active-port"), "4319\n");
  assert.equal(await readSelectedBackendPort(directory), 4319);
  await fs.writeFile(path.join(directory, "active-port"), "not-a-port\n");
  await assert.rejects(readSelectedBackendPort(directory), { code: "ERR_BACKEND_AUTHORITY_INVALID" });
});

test("the backend service uses the lightweight entry instead of importing server directly", async () => {
  const template = await fs.readFile(
    new URL("../systemd/wfl-codex-desktop-backend@.service.template", import.meta.url),
    "utf8",
  );
  assert.match(template, /CODEX_DESKTOP_BACKEND_SOURCE_DIR=.*slots\/%i/);
  assert.match(template, /ExecStart=.*SOURCE_DIR.*scripts\/backend-entry\.mjs/);
  assert.doesNotMatch(template, /ExecStart=.*slots\/%i\/server\.mjs/);
});

test("an unselected backend entry exposes only standby readiness and creates no application state", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-backend-standby-"));
  const stateDirectory = path.join(directory, "state");
  const projectDirectory = path.join(directory, "project");
  const backendSourceDirectory = path.join(directory, "backend-source");
  const port = await reservePort();
  await fs.mkdir(backendSourceDirectory, { recursive: true });
  // Keep this fixture focused on the no-application-state standby contract.
  // Candidate archives intentionally advertise the real Codex runtime bundle;
  // using a tiny manifest without that capability avoids making this test
  // depend on a host Codex installation while preserving the production gate.
  await Promise.all([
    fs.writeFile(path.join(backendSourceDirectory, "package.json"), JSON.stringify({
      name: "wfl-backend-standby-fixture",
      version: "0.0.0-test",
    })),
    fs.writeFile(path.join(backendSourceDirectory, ".codex-package.json"), JSON.stringify({
      format: 2,
      name: "wfl-backend-standby-fixture",
      version: "0.0.0-test",
      capabilities: [],
    })),
  ]);
  await fs.writeFile(path.join(directory, "active-port"), `${port === 4318 ? 4319 : 4318}\n`);
  const child = spawn(process.execPath, [
    new URL("../scripts/backend-entry.mjs", import.meta.url).pathname,
  ], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      HOME: path.join(directory, "home"),
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_CONVERSATION_SIDECAR: "1",
      CODEX_DESKTOP_RUNTIME_DIR: directory,
      CODEX_DESKTOP_BACKEND_SOURCE_DIR: backendSourceDirectory,
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_PROJECT_ROOT: directory,
      CODEX_DESKTOP_DEFAULT_PROJECT: projectDirectory,
      CODEX_DESKTOP_CODEX_BIN: process.execPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => child.exitCode === null ? child.once("exit", resolve) : resolve());
    await fs.rm(directory, { recursive: true, force: true });
  });

  const readiness = await waitForJson(`http://127.0.0.1:${port}/internal/standby-ready`, child, () => output);
  assert.equal(readiness.response.status, 200);
  assert.equal(readiness.data.standby, true);
  assert.equal(readiness.data.primary, false);
  assert.equal(readiness.data.runtimeBundleRequired, false);
  assert.match(readiness.data.backendInstanceId, /^[0-9a-f-]{36}$/);
  await assert.rejects(fs.access(stateDirectory), { code: "ENOENT" });
  await assert.rejects(fs.access(projectDirectory), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(directory, "home")), { code: "ENOENT" });

  const activation = await fetch(`http://127.0.0.1:${port}/internal/activate-primary`, { method: "POST" });
  assert.equal(activation.status, 409);
  await assert.rejects(fs.access(stateDirectory), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(directory, "home")), { code: "ENOENT" });
});

test("an authorized standby can promote before selector commit", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-backend-preselector-primary-"));
  const backendSourceDirectory = path.join(directory, "backend-source");
  const port = await reservePort();
  const selectedPort = port === 4318 ? 4319 : 4318;
  const backendInstanceId = "backend-instance-promoted";
  await fs.mkdir(backendSourceDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(backendSourceDirectory, "package.json"), JSON.stringify({
      name: "wfl-backend-promotion-fixture",
      version: "0.0.0-test",
    })),
    fs.writeFile(path.join(backendSourceDirectory, ".codex-package.json"), JSON.stringify({
      format: 2,
      name: "wfl-backend-promotion-fixture",
      version: "0.0.0-test",
      capabilities: [],
    })),
    fs.writeFile(path.join(backendSourceDirectory, "server.mjs"), [
      "import http from 'node:http';",
      "const port = Number(process.env.PORT);",
      "const instance = process.env.CODEX_DESKTOP_BACKEND_INSTANCE_ID;",
      "const server = http.createServer((request, response) => {",
      "  response.setHeader('Content-Type', 'application/json');",
      "  if (request.url === '/internal/codex-ready') { response.end(JSON.stringify({ ok: true, version: '0.0.0-test', codexReady: true, threadListReady: true })); return; }",
      "  if (request.url === '/internal/backend-identity') { response.end(JSON.stringify({ ok: true, version: '0.0.0-test', port, backendInstanceId: instance, primary: true, selected: false, authoritative: true, standby: false })); return; }",
      "  response.writeHead(404).end();",
      "});",
      "server.listen(port, '127.0.0.1');",
      "process.once('SIGTERM', () => server.close(() => process.exit(0)));",
      "",
    ].join("\n")),
    fs.writeFile(path.join(directory, "active-port"), `${selectedPort}\n`),
  ]);
  await new BackendAuthorityStore(directory).claim({ backendInstanceId, port });
  const child = spawn(process.execPath, [
    new URL("../scripts/backend-entry.mjs", import.meta.url).pathname,
  ], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_RUNTIME_DIR: directory,
      CODEX_DESKTOP_BACKEND_SOURCE_DIR: backendSourceDirectory,
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: backendInstanceId,
      CODEX_DESKTOP_CODEX_BIN: process.execPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => child.exitCode === null ? child.once("exit", resolve) : resolve());
    await fs.rm(directory, { recursive: true, force: true });
  });

  const standby = await waitForJson(`http://127.0.0.1:${port}/internal/standby-ready`, child, () => output);
  assert.equal(standby.data.standby, true);
  const activation = await fetch(`http://127.0.0.1:${port}/internal/activate-primary`, { method: "POST" });
  assert.equal(activation.status, 202);
  const primary = await waitForJson(`http://127.0.0.1:${port}/internal/codex-ready`, child, () => output);
  assert.equal(primary.data.threadListReady, true);
  assert.equal(Number((await fs.readFile(path.join(directory, "active-port"), "utf8")).trim()), selectedPort);
});

test("a runtime-bundle release verifies the complete Codex package before exposing standby readiness", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-backend-runtime-standby-"));
  const releaseDirectory = path.join(directory, "release");
  const packageRoot = path.join(directory, "codex", "1.2.3-x86_64-unknown-linux-musl");
  const command = path.join(directory, "bin", "codex");
  const port = await reservePort();
  await fs.chmod(directory, 0o755);
  await Promise.all([
    fs.mkdir(releaseDirectory, { recursive: true }),
    fs.mkdir(path.join(packageRoot, "bin"), { recursive: true }),
    fs.mkdir(path.join(packageRoot, "codex-resources"), { recursive: true }),
    fs.mkdir(path.join(packageRoot, "codex-path"), { recursive: true }),
    fs.mkdir(path.dirname(command), { recursive: true }),
  ]);
  await fs.writeFile(path.join(releaseDirectory, "package.json"), JSON.stringify({ version: "9.8.7" }));
  await fs.writeFile(path.join(releaseDirectory, ".codex-package.json"), JSON.stringify({
    capabilities: ["codex-runtime-bundle-v1"],
  }));
  await fs.writeFile(path.join(packageRoot, "codex-package.json"), JSON.stringify({
    layoutVersion: 1,
    version: "1.2.3",
    target: "x86_64-unknown-linux-musl",
    variant: "codex",
    entrypoint: "bin/codex",
    resourcesDir: "codex-resources",
    pathDir: "codex-path",
  }));
  await fs.writeFile(path.join(packageRoot, "bin", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(
    path.join(packageRoot, "bin", "codex-code-mode-host"),
    "#!/bin/sh\necho 'Usage: codex-code-mode-host [OPTIONS]'\n",
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(packageRoot, "codex-resources", "marker"), "resource\n");
  await fs.writeFile(path.join(packageRoot, "codex-path", "marker"), "path\n");
  await fs.symlink(path.join(packageRoot, "bin", "codex"), command);
  await fs.writeFile(path.join(directory, "active-port"), `${port === 4318 ? 4319 : 4318}\n`);

  const child = spawn(process.execPath, [new URL("../scripts/backend-entry.mjs", import.meta.url).pathname], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_RUNTIME_DIR: directory,
      CODEX_DESKTOP_BACKEND_SOURCE_DIR: releaseDirectory,
      CODEX_DESKTOP_CODEX_BIN: command,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => child.exitCode === null ? child.once("exit", resolve) : resolve());
    await fs.rm(directory, { recursive: true, force: true });
  });

  const readiness = await waitForJson(`http://127.0.0.1:${port}/internal/standby-ready`, child, () => output);
  assert.equal(readiness.data.version, "9.8.7");
  assert.equal(readiness.data.runtimeBundleRequired, true);
  assert.equal(readiness.data.runtimeBundleReady, true);
  assert.equal(readiness.data.codeModeHostReady, true);
  assert.equal(readiness.data.codexVersion, "1.2.3");
  assert.equal(readiness.data.codexTarget, "x86_64-unknown-linux-musl");
  assert.match(readiness.data.codexRuntimeSha256, /^[a-f0-9]{64}$/u);
  assert.match(readiness.data.codexCodeModeHostSha256, /^[a-f0-9]{64}$/u);
  await fs.access(path.join(directory, "codex-runtimes", `1.2.3-${readiness.data.codexRuntimeSha256}`));
});

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForJson(url, child, output) {
  const deadline = Date.now() + 3_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend entry exited ${child.exitCode}: ${output()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(250) });
      return { response, data: await response.json() };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Backend entry did not become ready: ${lastError?.message}; ${output()}`);
}
