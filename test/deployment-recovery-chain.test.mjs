import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const recoveryChain = fileURLToPath(
  new URL("../scripts/recover-interrupted-deployment.mjs", import.meta.url),
);

test("Codex recovery failure is recorded without preventing backend topology recovery", async () => {
  await withFixture(async (fixture) => {
    await fixture.writeRecoveryStep({ exitCode: 23 });
    const result = await fixture.run();

    assert.equal(result.code, 1);
    assert.match(result.stderr, /codex: recover-codex-update\.mjs failed \(23\)/);
    assert.equal(await fs.readFile(fixture.logPath, "utf8"), "codex\ntopology\n");
    const failure = JSON.parse(await fs.readFile(fixture.failurePath, "utf8"));
    assert.equal(failure.status, "failed");
    assert.deepEqual(failure.errors, [{
      stage: "codex",
      message: "recover-codex-update.mjs failed (23)",
    }]);
  });
});

test("successful recovery runs Codex before backend topology", async () => {
  await withFixture(async (fixture) => {
    await fixture.writeRecoveryStep({ exitCode: 0 });
    const result = await fixture.run();

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await fs.readFile(fixture.logPath, "utf8"), "codex\ntopology\n");
    await assert.rejects(fs.access(fixture.failurePath), { code: "ENOENT" });
  });
});

test("systemd recovery forwards the staged operation identity to topology recovery", async () => {
  await withFixture(async (fixture) => {
    await fixture.writeRecoveryStep({ exitCode: 0 });
    await fixture.writeManifest({
      operationId: "wfl-codex-release-v0-43-73-beta-1234567890",
      version: "0.43.73-beta",
    });
    const result = await fixture.run();

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.argsLogPath, "utf8")), [
      "--recover-staged",
      "--operation-id",
      "wfl-codex-release-v0-43-73-beta-1234567890",
      "--version",
      "0.43.73-beta",
    ]);
  });
});

test("systemd recovery forwards a matching watchdog token to topology recovery", async () => {
  await withFixture(async (fixture) => {
    await fixture.writeRecoveryStep({ exitCode: 0 });
    const operationId = "wfl-codex-release-v0-43-77-beta-1234567890";
    const watchToken = "12345678-1234-4123-8123-123456789abc";
    await fixture.writeManifest({
      operationId,
      version: "0.43.77-beta",
      watchToken,
      ownerPid: 4242,
      ownerStartTicks: "987654",
    });
    await fixture.writeWatchdog({ operationId, watchToken, ownerPid: 4242, ownerStartTicks: "987654" });

    const result = await fixture.run({ tokenLog: true });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await fs.readFile(fixture.tokenLogPath, "utf8"), `${watchToken}\n`);
  });
});

test("systemd recovery rejects a watchdog attestation that does not match the manifest", async () => {
  await withFixture(async (fixture) => {
    await fixture.writeRecoveryStep({ exitCode: 0 });
    const operationId = "wfl-codex-release-v0-43-77-beta-1234567890";
    await fixture.writeManifest({
      operationId,
      version: "0.43.77-beta",
      watchToken: "12345678-1234-4123-8123-123456789abc",
      ownerPid: 4242,
      ownerStartTicks: "987654",
    });
    await fixture.writeWatchdog({
      operationId,
      watchToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ownerPid: 4242,
      ownerStartTicks: "987654",
    });

    const result = await fixture.run({ tokenLog: true });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /watchdog identity does not match the staged deployment/);
    assert.equal(await fs.readFile(fixture.logPath, "utf8"), "codex\n");
    assert.equal(await fs.readFile(fixture.tokenLogPath, "utf8").catch(() => ""), "");
  });
});

async function withFixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-recovery-chain-"));
  const scriptsDirectory = path.join(root, "scripts");
  const logPath = path.join(root, "recovery.log");
  const argsLogPath = path.join(root, "recovery-args.json");
  const tokenLogPath = path.join(root, "recovery-token.log");
  const runtimeDirectory = path.join(root, "runtime");
  const failurePath = path.join(runtimeDirectory, "deployment-recovery-failure.json");
  try {
    await Promise.all([
      fs.mkdir(scriptsDirectory, { recursive: true }),
      fs.mkdir(runtimeDirectory, { recursive: true }),
    ]);
    await fs.writeFile(path.join(scriptsDirectory, "deploy.mjs"), [
      "import fs from 'node:fs/promises';",
      "await fs.appendFile(process.env.TEST_RECOVERY_LOG, 'topology\\n');",
      "if (process.env.TEST_RECOVERY_TOKEN_LOG) await fs.writeFile(process.env.TEST_RECOVERY_TOKEN_LOG, `${process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN || ''}\\n`);",
      "if (process.env.TEST_RECOVERY_ARGS_LOG) await fs.writeFile(process.env.TEST_RECOVERY_ARGS_LOG, JSON.stringify(process.argv.slice(2)));",
      "if (process.argv[2] !== '--recover-staged') process.exit(31);",
      "",
    ].join("\n"));
    await operation({
      logPath,
      argsLogPath,
      tokenLogPath,
      failurePath,
      async writeRecoveryStep({ exitCode }) {
        await fs.writeFile(path.join(scriptsDirectory, "recover-codex-update.mjs"), [
          "import fs from 'node:fs/promises';",
          "await fs.appendFile(process.env.TEST_RECOVERY_LOG, 'codex\\n');",
          `process.exit(${exitCode});`,
          "",
        ].join("\n"));
      },
      async writeManifest(value) {
        await fs.writeFile(
          path.join(runtimeDirectory, "prepared-deployment.json"),
          `${JSON.stringify(value)}\n`,
          { mode: 0o600 },
        );
      },
      async writeWatchdog({ operationId, watchToken, ownerPid, ownerStartTicks }) {
        const directory = path.join(runtimeDirectory, "deployment-watchdogs");
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, `${operationId}.json`), `${JSON.stringify({
          schemaVersion: 1,
          token: watchToken,
          operationId,
          ownerPid,
          ownerStartTicks,
          watcherPid: 4343,
          watcherStartTicks: "876543",
        })}\n`, { mode: 0o600 });
      },
      run({ tokenLog = false } = {}) {
        return spawnAndCollect(process.execPath, [recoveryChain], {
          ...process.env,
          CODEX_DESKTOP_SOURCE_DIR: root,
          CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
          TEST_RECOVERY_LOG: logPath,
          TEST_RECOVERY_ARGS_LOG: argsLogPath,
          ...(tokenLog ? { TEST_RECOVERY_TOKEN_LOG: tokenLogPath } : {}),
        });
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function spawnAndCollect(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
