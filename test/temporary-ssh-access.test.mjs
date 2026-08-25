import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SshPasswordControl, sshPasswordSystemdArguments } from "../lib/ssh-password-control.mjs";
import { TemporarySshAccessService } from "../lib/temporary-ssh-access.mjs";
import { temporarySshCommandArguments } from "../lib/temporary-ssh-command.mjs";
import { updateAuthorizedKeysWithSftp } from "../lib/temporary-ssh-connector.mjs";
import {
  assertSafeSshControlPath,
  OPENSSH_CONTROL_TEMP_SUFFIX_BUDGET_BYTES,
  SSH_UNIX_SOCKET_MAX_BYTES,
  temporarySshControlDirectory,
  temporarySshControlPath,
} from "../lib/temporary-ssh-paths.mjs";

const connectorSource = await fs.readFile(new URL("../lib/temporary-ssh-connector.mjs", import.meta.url), "utf8");
const passwordControlSource = await fs.readFile(new URL("../lib/ssh-password-control.mjs", import.meta.url), "utf8");
const pluginCliSource = await fs.readFile(new URL("../scripts/plugin-ssh-access.mjs", import.meta.url), "utf8");

test("temporary SSH connector uses a Cloudflare-safe dependency status for remote failures", () => {
  assert.match(connectorSource, /statusCode: 424, sshAttemptFailed: true/);
  assert.match(connectorSource, /updateAuthorizedKeysWithSftp/);
  assert.match(connectorSource, /ext_openssh_rename/);
  assert.match(connectorSource, /error\.passwordFallback/);
  assert.match(passwordControlSource, /WFL_CODEX_ASKPASS_SOCKET/);
  assert.match(passwordControlSource, /PreferredAuthentications=password/);
  assert.match(passwordControlSource, /systemd-run/);
  assert.match(passwordControlSource, /RuntimeMaxSec/);
  assert.match(passwordControlSource, /--wait/);
  assert.match(pluginCliSource, /temporarySshCommandArguments/);
});

test("password SSH masters use an isolated unit for exactly the remaining authorization window", () => {
  const password = "must-never-enter-process-arguments";
  const args = sshPasswordSystemdArguments({
    controlPath: "/run/wfl-codex/ssh-0123456789abcdef.ctl",
    expiresAt: 8_200_000,
    now: 1_000_000,
    environment: {
      SSH_ASKPASS: "/srv/app/scripts/ssh-askpass.mjs",
      WFL_CODEX_ASKPASS_SOCKET: "/run/wfl-codex/ssh-0123456789abcdef.ctl.askpass",
    },
    masterArgs: ["-M", "root@example.test"],
  });

  assert.ok(args.includes("--property=RuntimeMaxSec=7200s"));
  assert.ok(args.includes("/usr/bin/ssh"));
  assert.doesNotMatch(JSON.stringify(args), new RegExp(password));
});

test("production SSH control paths leave room for OpenSSH temporary socket suffixes", () => {
  const runtimeDirectory = "/srv/wfl-codex-desktop/.codex-runtime";
  const controlDirectory = temporarySshControlDirectory(runtimeDirectory);
  const controlPath = temporarySshControlPath(controlDirectory, "ssh-0123456789abcdef");

  assert.match(controlPath, /^\/run\/wfl-codex-ssh\/[a-f0-9]{12}\/ssh-[a-f0-9]{16}\.ctl$/);
  assert.equal(assertSafeSshControlPath(controlPath), controlPath);
  assert.ok(
    Buffer.byteLength(controlPath) + OPENSSH_CONTROL_TEMP_SUFFIX_BUDGET_BYTES
      <= SSH_UNIX_SOCKET_MAX_BYTES,
  );
  assert.ok(Buffer.byteLength(`${controlPath}.askpass`) <= SSH_UNIX_SOCKET_MAX_BYTES);
  assert.throws(
    () => assertSafeSshControlPath(`/tmp/${"x".repeat(90)}.ctl`),
    (error) => error.code === "SSH_CONTROL_PATH_TOO_LONG" && /路径过长/.test(error.message),
  );
});

test("temporary SSH connector edits authorized_keys atomically through SFTP", async () => {
  const sftp = new FakeSftp();
  const client = { sftp: (callback) => callback(null, sftp) };
  const key = "ssh-ed25519 AAAATemporaryKey wfl-temporary-access-ssh-0123456789abcdef";

  await updateAuthorizedKeysWithSftp(client, { addLine: key, timeoutMs: 1000 });
  assert.equal(sftp.files.get("/root/.ssh/authorized_keys"), `${key}\n`);
  assert.equal(sftp.modes.get("/root/.ssh"), 0o700);
  assert.equal(sftp.modes.get("/root/.ssh/authorized_keys"), 0o600);
  assert.equal([...sftp.files.keys()].some((filename) => filename.includes(".wfl.")), false);

  await updateAuthorizedKeysWithSftp(client, {
    removeMarker: "wfl-temporary-access-ssh-0123456789abcdef",
    timeoutMs: 1000,
  });
  assert.equal(sftp.files.get("/root/.ssh/authorized_keys"), "");
  assert.equal(sftp.ended, true);
});

test("temporary SSH access persists no password and revokes both remote and local keys", async () => {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-ssh-access-"));
  const password = "temporary-password-must-not-persist";
  const calls = { install: 0, remove: 0, passwordObserved: false };
  const connector = {
    async install(input) {
      calls.install += 1;
      calls.passwordObserved = input.password === password;
      assert.match(input.authorizedKeyLine, /expiry-time="20260720020000Z"/);
      assert.match(input.authorizedKeyLine, /no-port-forwarding/);
      return {
        hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyzABCDEFG123456",
        hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestHostKey",
      };
    },
    async remove(input) {
      calls.remove += 1;
      assert.match(input.privateKey, /PRIVATE KEY/);
      return { removed: true };
    },
  };
  const now = Date.parse("2026-07-20T00:00:00.000Z");
  const service = await new TemporarySshAccessService(runtimeDirectory, {
    connector,
    now: () => now,
    ttlMs: 30 * 60 * 1000,
    keyGenerator: fakeKeyGenerator,
  }).initialize();

  try {
    const record = await service.authorize({
      host: "192.0.2.10",
      port: 22022,
      username: "root",
      durationMinutes: 120,
      password,
    });
    assert.equal(calls.install, 1);
    assert.equal(calls.passwordObserved, true);
    assert.equal(record.authMode, "public-key");
    assert.equal(record.expiresAt, now + 120 * 60 * 1000);
    assert.equal(Object.hasOwn(record, "privateKeyPath"), false);
    assert.equal(Object.hasOwn(record, "password"), false);

    const directory = path.join(runtimeDirectory, "plugin-data", "secure-ssh-access");
    const files = await fs.readdir(directory);
    const stored = await Promise.all(files.map((filename) => fs.readFile(path.join(directory, filename), "utf8")));
    assert.doesNotMatch(stored.join("\n"), new RegExp(password));
    const metadataPath = path.join(directory, `${record.id}.json`);
    assert.equal((await fs.stat(metadataPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(directory, record.id))).mode & 0o777, 0o600);
    assert.match(await fs.readFile(path.join(directory, `${record.id}.known_hosts`), "utf8"), /^\[192\.0\.2\.10\]:22022 ssh-ed25519 /);

    await service.revoke(record.id);
    assert.equal(calls.remove, 1);
    assert.deepEqual(service.snapshot(), []);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("temporary SSH access accepts only the bounded duration choices", async () => {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-ssh-duration-"));
  const service = await new TemporarySshAccessService(runtimeDirectory, {
    connector: { install: async () => assert.fail("invalid duration must fail before connecting") },
    keyGenerator: fakeKeyGenerator,
  }).initialize();
  try {
    await assert.rejects(
      service.authorize({ host: "example.com", username: "root", port: 22, password: "secret", durationMinutes: 180 }),
      (error) => error.statusCode === 400 && /30、60 或 120/.test(error.message),
    );
  } finally {
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("temporary SSH operations remain busy while queued and recover after a failure", async () => {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-ssh-queue-"));
  let markFirstStarted;
  let releaseFirstOperation;
  let markSecondStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const releaseFirst = new Promise((resolve) => { releaseFirstOperation = resolve; });
  const secondStarted = new Promise((resolve) => { markSecondStarted = resolve; });
  const service = await new TemporarySshAccessService(runtimeDirectory).initialize();
  try {
    const first = service.queueOperation(async () => {
      markFirstStarted();
      await releaseFirst;
      throw new Error("expected operation failure");
    });
    const second = service.queueOperation(async () => {
      markSecondStarted(service.pendingOperations);
      return "completed";
    });

    assert.equal(service.pendingOperations, 2);
    assert.equal(service.busy, true);
    await firstStarted;
    assert.equal(service.pendingOperations, 2);

    releaseFirstOperation();
    await assert.rejects(first, /expected operation failure/);
    assert.equal(await secondStarted, 1);
    assert.equal(await second, "completed");
    assert.equal(service.pendingOperations, 0);
    assert.equal(service.busy, false);
  } finally {
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("password-only SSH servers use a revocable control socket without persisting the password", async () => {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-ssh-password-control-"));
  const password = "password-only-secret";
  const calls = { start: 0, stop: 0, passwordObserved: false };
  const installed = {
    hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyzABCDEFG123456",
    hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestHostKey",
  };
  const connector = {
    async install() {
      throw Object.assign(new Error("public key rejected"), {
        statusCode: 424,
        passwordFallback: installed,
      });
    },
    async remove() {
      assert.fail("the connector already rolled back the rejected public key");
    },
  };
  const passwordControl = {
    async start(input) {
      calls.start += 1;
      calls.passwordObserved = input.password === password;
      assert.ok(Number.isFinite(input.expiresAt));
      await fs.writeFile(input.controlPath, "test control socket", { mode: 0o600 });
    },
    async check() {
      return true;
    },
    async stop() {
      calls.stop += 1;
    },
  };
  const service = await new TemporarySshAccessService(runtimeDirectory, {
    connector,
    passwordControl,
    keyGenerator: fakeKeyGenerator,
    controlDirectory: path.join(runtimeDirectory, "s"),
  }).initialize();

  try {
    const record = await service.authorize({
      host: "192.0.2.10",
      port: 22022,
      username: "root",
      password,
    });
    assert.equal(record.authMode, "password-control");
    assert.equal(calls.start, 1);
    assert.equal(calls.passwordObserved, true);

    const directory = path.join(runtimeDirectory, "plugin-data", "secure-ssh-access");
    const files = await fs.readdir(directory);
    assert.equal(files.some((filename) => /^ssh-[a-f0-9]{16}$/.test(filename)), false);
    assert.equal(files.some((filename) => filename.endsWith(".pub")), false);
    const stored = await Promise.all(files.map((filename) => fs.readFile(path.join(directory, filename), "utf8")));
    assert.doesNotMatch(stored.join("\n"), new RegExp(password));

    const commandArguments = temporarySshCommandArguments({
      ...record,
      controlPath: path.join(runtimeDirectory, "s", `${record.id}.ctl`),
    });
    assert.deepEqual(commandArguments.slice(0, 2), ["-S", path.join(runtimeDirectory, "s", `${record.id}.ctl`)]);
    assert.equal(commandArguments.includes("PreferredAuthentications=none"), true);
    assert.doesNotMatch(JSON.stringify(commandArguments), new RegExp(password));

    await service.revoke(record.id);
    assert.equal(calls.stop, 1);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("the SSH askpass helper reads a one-time secret from its Unix socket", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-ssh-askpass-"));
  const socketPath = path.join(directory, "askpass.sock");
  const secret = "socket-only-secret";
  const server = net.createServer((socket) => socket.end(`${secret}\n`));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    if (error.code === "EPERM") {
      context.skip("Unix sockets are disabled by the current test sandbox");
      return;
    }
    throw error;
  }

  try {
    const output = await captureProcess(process.execPath, [
      fileURLToPath(new URL("../scripts/ssh-askpass.mjs", import.meta.url)),
    ], {
      ...process.env,
      WFL_CODEX_ASKPASS_SOCKET: socketPath,
    });
    assert.equal(output, `${secret}\n`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the password control never places its secret in OpenSSH arguments or environment", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-ssh-control-"));
  const controlPath = path.join(directory, "control.sock");
  const secret = "control-socket-only-secret";
  let receivedSecret = "";
  let resolveSecret;
  const secretReceived = new Promise((resolve) => {
    resolveSecret = resolve;
  });
  const spawnProcess = (_command, args, options) => {
    const child = new EventEmitter();
    child.kill = () => {};
    child.unref = () => {};
    if (args.includes("-M")) {
      assert.doesNotMatch(JSON.stringify({ args, env: options.env }), new RegExp(secret));
      setImmediate(() => {
        const socket = net.createConnection(options.env.WFL_CODEX_ASKPASS_SOCKET);
        socket.on("data", (chunk) => {
          receivedSecret += chunk;
        });
        socket.once("close", resolveSecret);
      });
    } else {
      secretReceived.then(() => setImmediate(() => child.emit("exit", 0)));
    }
    return child;
  };
  const control = new SshPasswordControl({ timeoutMs: 2_000, spawnProcess });
  const target = { host: "192.0.2.10", port: 22022, username: "root" };

  try {
    await control.start({
      target,
      password: secret,
      knownHostsPath: path.join(directory, "known_hosts"),
      controlPath,
    });
  } catch (error) {
    if (error.code === "EPERM") {
      await fs.rm(directory, { recursive: true, force: true });
      context.skip("Unix sockets are disabled by the current test sandbox");
      return;
    }
    throw error;
  }

  try {
    assert.equal(receivedSecret, `${secret}\n`);
  } finally {
    await control.stop({ target, controlPath });
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("temporary SSH access rejects unsafe targets and corrupted paths", async () => {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-ssh-access-"));
  const outside = path.join(runtimeDirectory, "outside-key");
  await fs.writeFile(outside, "must remain");
  const directory = path.join(runtimeDirectory, "plugin-data", "secure-ssh-access");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "ssh-aaaaaaaaaaaaaaaa.json"), JSON.stringify({
    id: "ssh-aaaaaaaaaaaaaaaa",
    host: "example.com",
    port: 22,
    username: "root",
    marker: "wfl-temporary-access-ssh-aaaaaaaaaaaaaaaa",
    privateKeyPath: outside,
    publicKeyPath: `${outside}.pub`,
    knownHostsPath: `${outside}.known_hosts`,
    hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyzABCDEFG123456",
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
  }));
  try {
    const service = await new TemporarySshAccessService(runtimeDirectory, {
      connector: {},
      keyGenerator: fakeKeyGenerator,
    }).initialize();
    assert.deepEqual(service.snapshot(), []);
    assert.equal(await fs.readFile(outside, "utf8"), "must remain");
    await assert.rejects(
      service.authorize({ host: "https://example.com", port: 22, username: "root", password: "secret" }),
      /主机地址/,
    );
    await assert.rejects(
      service.authorize({ host: "example.com", port: 70000, username: "root", password: "secret" }),
      /端口/,
    );
  } finally {
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
});

async function fakeKeyGenerator(directory, id, marker) {
  const privateKeyPath = path.join(directory, id);
  const publicKeyPath = `${privateKeyPath}.pub`;
  await Promise.all([
    fs.writeFile(privateKeyPath, "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n", { mode: 0o600 }),
    fs.writeFile(publicKeyPath, `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey ${marker}\n`, { mode: 0o600 }),
  ]);
  return {
    privateKeyPath,
    publicKeyPath,
    publicKey: await fs.readFile(publicKeyPath, "utf8"),
  };
}

class FakeSftp {
  constructor() {
    this.files = new Map();
    this.modes = new Map();
    this.directories = new Set(["/root"]);
    this.ended = false;
  }

  realpath(_path, callback) {
    callback(null, "/root");
  }

  stat(filename, callback) {
    if (this.directories.has(filename)) {
      callback(null, { size: 0 });
      return;
    }
    if (this.files.has(filename)) {
      callback(null, { size: Buffer.byteLength(this.files.get(filename)) });
      return;
    }
    callback(Object.assign(new Error("No such file"), { code: 2 }));
  }

  mkdir(filename, options, callback) {
    this.directories.add(filename);
    this.modes.set(filename, options.mode);
    callback(null);
  }

  chmod(filename, mode, callback) {
    this.modes.set(filename, mode);
    callback(null);
  }

  readFile(filename, callback) {
    callback(null, Buffer.from(this.files.get(filename) || ""));
  }

  writeFile(filename, contents, options, callback) {
    this.files.set(filename, String(contents));
    this.modes.set(filename, options.mode);
    callback(null);
  }

  ext_openssh_rename(source, destination, callback) {
    this.files.set(destination, this.files.get(source));
    this.files.delete(source);
    this.modes.set(destination, this.modes.get(source));
    this.modes.delete(source);
    callback(null);
  }

  unlink(filename, callback) {
    this.files.delete(filename);
    callback(null);
  }

  end() {
    this.ended = true;
  }
}

function captureProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const environment = { ...env };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `${command} exited with status ${code}`));
    });
  });
}
