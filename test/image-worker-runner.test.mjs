import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createImageWorkerRunner, verifyImageWorkerFiles } from "../lib/image-worker-runner.mjs";
import { IMAGE_EXECUTION_PRESETS } from "../lib/image-execution-settings.mjs";

function jobFixture(id = "a".repeat(36), payload = { request: { prompt: "private prompt" }, imageApi: { apiKey: "private-key" } }) {
  return {
    id,
    identity: { userId: "user-a" },
    payload,
    settings: { version: 1, revision: 1, preset: "stable", config: structuredClone(IMAGE_EXECUTION_PRESETS.stable) },
  };
}

test("image runner uses a transient systemd cgroup and sends secrets only through stdin", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-runner-systemd-"));
  const previousSentinel = process.env.WFL_IMAGE_SECRET_SENTINEL;
  process.env.WFL_IMAGE_SECRET_SENTINEL = "must-not-reach-worker";
  let runner;
  try {
    const argumentsPath = path.join(root, "arguments.json");
    const stdinPath = path.join(root, "stdin.json");
    const fakeSystemd = path.join(root, "fake-systemd-run.mjs");
    const fakeWorker = path.join(root, "fake-worker.mjs");
    await fs.writeFile(fakeSystemd, [
      "#!/usr/bin/env node",
      "import { spawn } from 'node:child_process';",
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));`,
      "const separator = process.argv.indexOf('--');",
      "const child = spawn(process.argv[separator + 1], process.argv.slice(separator + 2), { stdio: 'inherit' });",
      "child.on('exit', (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code ?? 1));",
    ].join("\n"), { mode: 0o755 });
    await fs.writeFile(fakeWorker, [
      "import crypto from 'node:crypto';",
      "import fs from 'node:fs/promises';",
      "import path from 'node:path';",
      "const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);",
      "const raw = Buffer.concat(chunks).toString('utf8');",
      `await fs.writeFile(${JSON.stringify(stdinPath)}, raw);`,
      "const input = JSON.parse(raw);",
      "const data = Buffer.from('bounded-worker-output');",
      "await fs.writeFile(path.join(input.outputDirectory, 'output-01.png'), data);",
      "const file = { path: 'output-01.png', size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), width: 1, height: 1, format: 'png', mediaType: 'image/png' };",
      "console.log(JSON.stringify({ protocolVersion: 1, id: input.id, type: 'started' }));",
      "console.log(JSON.stringify({ protocolVersion: 1, id: input.id, type: 'phase', phase: 'provider' }));",
      "console.log(JSON.stringify({ protocolVersion: 1, id: input.id, type: 'usage', usage: { totalTokens: 1 }, providerRequestId: 'request-1' }));",
      "console.log(JSON.stringify({ protocolVersion: 1, id: input.id, type: 'completed', result: { files: [file], usage: { totalTokens: 1 } } }));",
    ].join("\n"));
    let workerEnvironment;
    runner = createImageWorkerRunner({
      runtimeDirectory: path.join(root, "runtime"),
      workerPath: fakeWorker,
      systemdRunCommand: fakeSystemd,
      unitIsActive: async () => false,
      spawnProcess: (command, args, options) => {
        if (command === fakeSystemd) workerEnvironment = options.env;
        return spawn(command, args, options);
      },
    });
    const events = [];
    let usageProcessed = false;
    const result = await runner(jobFixture(), { onEvent: async (event) => {
      if (event.type === "usage") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        usageProcessed = true;
      }
      events.push(event);
    } });
    const args = JSON.parse(await fs.readFile(argumentsPath, "utf8"));
    const joined = args.join(" ");
    assert.match(joined, /MemoryMax=1024M/u);
    assert.match(joined, /MemorySwapMax=0/u);
    assert.match(joined, /RuntimeMaxSec=600s/u);
    assert.match(joined, /KillMode=control-group/u);
    assert.match(joined, /OOMPolicy=stop/u);
    assert.match(joined, /ProtectSystem=strict/u);
    assert.match(joined, /TemporaryFileSystem=.*:ro/u);
    assert.match(joined, /BindPaths=.*\/runtime\/[a-f0-9]{36}/u);
    assert.match(joined, /ReadWritePaths=/u);
    assert.match(joined, /UMask=0077/u);
    assert.match(joined, /NoNewPrivileges=yes/u);
    assert.match(joined, /PrivateTmp=yes/u);
    assert.match(joined, /PrivateDevices=yes/u);
    assert.match(joined, /ProtectHome=yes/u);
    assert.match(joined, /ProtectKernelLogs=yes/u);
    assert.match(joined, /ProtectClock=yes/u);
    assert.match(joined, /ProtectHostname=yes/u);
    assert.match(joined, /ProtectProc=invisible/u);
    assert.match(joined, /ProcSubset=pid/u);
    assert.match(joined, /RestrictNamespaces=yes/u);
    assert.match(joined, /RestrictRealtime=yes/u);
    assert.match(joined, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/u);
    assert.match(joined, /SystemCallArchitectures=native/u);
    assert.doesNotMatch(joined, /private-key|private prompt/u);
    assert.equal(workerEnvironment.WFL_IMAGE_SECRET_SENTINEL, undefined);
    assert.equal(workerEnvironment.OPENAI_API_KEY, undefined);
    assert.equal(workerEnvironment.SESSION_TOKEN, undefined);
    assert.equal(workerEnvironment.HOME.startsWith(result.taskDirectory), true);
    assert.equal(workerEnvironment.TMPDIR.startsWith(result.taskDirectory), true);
    const stdin = await fs.readFile(stdinPath, "utf8");
    assert.match(stdin, /private-key/u);
    assert.match(stdin, /private prompt/u);
    assert.equal(usageProcessed, true);
    assert.deepEqual(events, [
      { type: "phase", phase: "provider" },
      { type: "usage", usage: { totalTokens: 1 }, providerRequestId: "request-1" },
    ]);
    assert.equal(await fs.readFile(result.files[0].absolutePath, "utf8"), "bounded-worker-output");
    await result.dispose();
    assert.equal(await fs.stat(result.taskDirectory).catch((error) => error.code), "ENOENT");
  } finally {
    if (previousSentinel === undefined) delete process.env.WFL_IMAGE_SECRET_SENTINEL;
    else process.env.WFL_IMAGE_SECRET_SENTINEL = previousSentinel;
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("image runner completes prepareTask before spawning and cleans a failed preparation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-runner-prepare-"));
  let spawnCalls = 0;
  const runner = createImageWorkerRunner({
    runtimeDirectory: path.join(root, "runtime"),
    prepareTask: async (_job, context) => {
      assert.equal((await fs.stat(context.taskDirectory)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(context.inputDirectory)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(context.outputDirectory)).mode & 0o777, 0o700);
      throw Object.assign(new Error("authorization revoked"), { code: "IMAGE_AUTH_REVOKED" });
    },
    spawnProcess: () => {
      spawnCalls += 1;
      throw new Error("must not spawn");
    },
  });
  try {
    await assert.rejects(runner(jobFixture("c".repeat(36))), (error) => error.code === "IMAGE_AUTH_REVOKED");
    assert.equal(spawnCalls, 0);
    assert.deepEqual(await fs.readdir(path.join(root, "runtime")), []);
  } finally {
    await runner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("image runner snapshots the task resource budget before its first asynchronous boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-runner-frozen-settings-"));
  const fakeWorker = path.join(root, "fake-worker.mjs");
  const observed = [];
  let releaseInitialization;
  const initializationGate = new Promise((resolve) => { releaseInitialization = resolve; });
  await fs.writeFile(fakeWorker, "process.stdin.resume();\n");
  const runner = createImageWorkerRunner({
    runtimeDirectory: path.join(root, "runtime"),
    workerPath: fakeWorker,
    unitIsActive: async () => {
      await initializationGate;
      return false;
    },
    spawnProcess: (command, args, options) => {
      observed.push({ command, args, options });
      return spawn(command, args, options);
    },
  });
  try {
    // Force recovery to consult unitIsActive and hold the runner at its first await.
    const staleId = "9".repeat(36);
    const stale = path.join(root, "runtime", staleId);
    await fs.mkdir(stale, { recursive: true });
    await fs.utimes(stale, new Date(0), new Date(0));
    const task = jobFixture("8".repeat(36));
    task.settings.config.worker.memoryMb = 1_024;
    task.settings.config.worker.taskTimeoutMs = 600_000;
    const running = runner(task);
    task.settings.config.worker.memoryMb = 65_536;
    task.settings.config.worker.taskTimeoutMs = 1_000;
    releaseInitialization();
    await assert.rejects(running);
    const launch = observed.find((entry) => entry.command === "systemd-run");
    assert.ok(launch);
    assert.ok(launch.args.includes("--property=MemoryMax=1024M"));
    assert.ok(launch.args.includes("--property=RuntimeMaxSec=600s"));
    assert.equal(launch.args.includes("--property=MemoryMax=65536M"), false);
  } finally {
    releaseInitialization?.();
    await runner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("abandoned task recovery retains data when systemd activity cannot be established", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-runner-recovery-fail-closed-"));
  const runtime = path.join(root, "runtime");
  const staleId = "7".repeat(36);
  const stale = path.join(runtime, staleId);
  const fakeSystemctl = path.join(root, "fake-systemctl.mjs");
  await fs.mkdir(stale, { recursive: true });
  await fs.utimes(stale, new Date(0), new Date(0));
  await fs.writeFile(fakeSystemctl, "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o755 });
  const runner = createImageWorkerRunner({
    runtimeDirectory: runtime,
    systemctlCommand: fakeSystemctl,
    now: () => Date.now(),
  });
  try {
    await runner.initialize();
    assert.equal((await fs.stat(stale)).isDirectory(), true);
  } finally {
    await runner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("image runner preserves safe structured provider errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-runner-errors-"));
  let runner;
  try {
    const fakeWorker = path.join(root, "fake-worker.mjs");
    await fs.writeFile(fakeWorker, [
      "const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);",
      "const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
      "const error = { code: 'IMAGE_SIZE_MISMATCH', statusCode: 502, message: 'size mismatch', type: 'invalid_request_error', stage: 'provider', operation: 'outpaint', reason: 'provider_size_unsupported', model: 'gpt-image-2', requestedSize: '2512x944', providerSize: '1536x1024', sourceSize: '1672x941', preserveSource: 'seamless', alignmentPolicy: 'rescale-and-crop', providerStatusCode: 400, requestedWidth: 1024, requestedHeight: 1024, actualWidth: 512, actualHeight: 512, moderationDetails: { category: 'safe' }, apiKey: 'must-not-leak', internalTrace: 'must-not-leak' };",
      "console.log(JSON.stringify({ protocolVersion: 1, id: input.id, type: 'error', error }));",
      "process.exitCode = 1;",
    ].join("\n"));
    runner = createImageWorkerRunner({
      runtimeDirectory: path.join(root, "runtime"),
      workerPath: fakeWorker,
      useSystemd: false,
    });
    await assert.rejects(
      runner(jobFixture("d".repeat(36))),
      (error) => (
        error.code === "IMAGE_SIZE_MISMATCH"
        && error.type === "invalid_request_error"
        && error.providerStatusCode === 400
        && error.stage === "provider"
        && error.operation === "outpaint"
        && error.reason === "provider_size_unsupported"
        && error.model === "gpt-image-2"
        && error.requestedSize === "2512x944"
        && error.providerSize === "1536x1024"
        && error.sourceSize === "1672x941"
        && error.preserveSource === "seamless"
        && error.alignmentPolicy === "rescale-and-crop"
        && error.requestedWidth === 1024
        && error.actualWidth === 512
        && error.moderationDetails.category === "safe"
        && !Object.hasOwn(error, "apiKey")
        && !Object.hasOwn(error, "internalTrace")
      ),
    );
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("image runner maps an unexplained SIGKILL-style exit to the task memory budget", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-runner-oom-"));
  let runner;
  try {
    const fakeWorker = path.join(root, "fake-worker.mjs");
    await fs.writeFile(fakeWorker, [
      "const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);",
      "process.exit(137);",
    ].join("\n"));
    runner = createImageWorkerRunner({
      runtimeDirectory: path.join(root, "runtime"),
      workerPath: fakeWorker,
      useSystemd: false,
      unitIsActive: async () => false,
    });
    await assert.rejects(
      runner(jobFixture("e".repeat(36))),
      (error) => error.code === "IMAGE_WORKER_MEMORY_EXCEEDED" && error.statusCode === 502,
    );
    assert.deepEqual(await fs.readdir(path.join(root, "runtime")), []);
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("image runner cancellation stops only its transient unit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-runner-cancel-"));
  let runner;
  try {
    const fakeSystemd = path.join(root, "fake-systemd-run.mjs");
    const fakeWorker = path.join(root, "fake-worker.mjs");
    await fs.writeFile(fakeSystemd, [
      "#!/usr/bin/env node",
      "import { spawn } from 'node:child_process';",
      "const separator = process.argv.indexOf('--');",
      "const child = spawn(process.argv[separator + 1], process.argv.slice(separator + 2), { stdio: 'inherit' });",
      "child.on('exit', (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code ?? 1));",
    ].join("\n"), { mode: 0o755 });
    await fs.writeFile(fakeWorker, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
    const stopped = [];
    runner = createImageWorkerRunner({
      runtimeDirectory: path.join(root, "runtime"),
      workerPath: fakeWorker,
      systemdRunCommand: fakeSystemd,
      stopUnit: async (unit) => stopped.push(unit),
    });
    const controller = new AbortController();
    const job = jobFixture("b".repeat(36));
    job.settings.config.worker.cancelGraceMs = 100;
    const running = runner(job, { signal: controller.signal });
    while (runner.status().workerCount !== 1) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await assert.rejects(running, (error) => error.code === "IMAGE_TASK_CANCELED");
    assert.deepEqual(stopped, [`wfl-codex-image-${"b".repeat(36)}.service`]);
    assert.deepEqual(await fs.readdir(path.join(root, "runtime")), []);
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("image runner rejects changed or escaping worker manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-runner-verify-"));
  try {
    const output = path.join(root, "output");
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, "image.png"), "image");
    const sha256 = crypto.createHash("sha256").update("image").digest("hex");
    const file = {
      path: "image.png", size: 5, sha256, width: 1, height: 1, format: "png", mediaType: "image/png",
    };
    assert.equal((await verifyImageWorkerFiles(output, [file]))[0].sha256, sha256);
    await assert.rejects(
      verifyImageWorkerFiles(output, [{ ...file, path: "../image.png" }]),
      (error) => error.code === "IMAGE_WORKER_MANIFEST_INVALID",
    );
    await assert.rejects(
      verifyImageWorkerFiles(output, [{ ...file, sha256: "0".repeat(64) }]),
      (error) => error.code === "IMAGE_WORKER_MANIFEST_INVALID",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
