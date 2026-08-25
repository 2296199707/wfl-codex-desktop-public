import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersistentSshServerStore } from "../lib/persistent-ssh-servers.mjs";
import { PersistentSshToolService } from "../lib/persistent-ssh-tool-service.mjs";

const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "test-private-key-material-that-must-stay-encrypted",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");

class FakeSshConnector {
  constructor() {
    this.installs = [];
    this.connections = [];
    this.removals = [];
  }

  async install(input) {
    this.installs.push(input);
    return {
      hostKeyFingerprint: "SHA256:ZmFrZS1ob3N0LWZpbmdlcnByaW50",
      hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKey",
    };
  }

  async connect(input) {
    const client = new FakeSshClient();
    this.connections.push({ input, client });
    return {
      client,
      fingerprint: "SHA256:ZmFrZS1ob3N0LWZpbmdlcnByaW50",
      hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKey",
    };
  }

  async remove(input) {
    this.removals.push(input);
    return { removed: true };
  }
}

class FakeSshClient extends EventEmitter {
  constructor() {
    super();
    this.ended = false;
    this.stream = null;
  }

  exec(command, callback) {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = () => stream.emit("close", null, "CLOSED");
    this.stream = stream;
    callback(null, stream);
    if (command.endsWith("wait-for-toggle")) return;
    queueMicrotask(() => {
      stream.emit("data", "ok\n");
      stream.emit("close", 0, null);
    });
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.stream?.emit("close", null, "DISCONNECTED");
  }
}

function fakeKeyGenerator() {
  return Promise.resolve({
    privateKey: PRIVATE_KEY,
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKey ignored-comment",
    cleanup: async () => {},
  });
}

function algorithmKeyGenerator(_directory, _id, _marker, algorithm = "ed25519") {
  const rsa = algorithm === "rsa-3072";
  return Promise.resolve({
    privateKey: `${PRIVATE_KEY}${rsa ? "rsa" : "ed25519"}`,
    publicKey: `${rsa ? "ssh-rsa" : "ssh-ed25519"} AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKey${rsa ? "RSA" : "ED"}`,
    cleanup: async () => {},
  });
}

class RejectingSshConnector extends FakeSshConnector {
  constructor({ rejectInstalls = 2 } = {}) {
    super();
    this.rejectInstalls = rejectInstalls;
  }

  async install(input) {
    this.installs.push(input);
    if (this.installs.length <= this.rejectInstalls) {
      throw Object.assign(new Error("public key rejected"), {
        statusCode: 424,
        passwordFallback: {
          hostKeyFingerprint: "SHA256:ZmFrZS1ob3N0LWZpbmdlcnByaW50",
          hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKey",
        },
      });
    }
    return {
      hostKeyFingerprint: "SHA256:ZmFrZS1ob3N0LWZpbmdlcnByaW50",
      hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKey",
    };
  }
}

function brokerRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok) {
          const error = new Error(response.error);
          error.statusCode = response.statusCode;
          finish(error);
        } else {
          finish(null, response.result);
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      if (!settled) finish(new Error("broker closed before responding"));
    });
  });
}

test("persistent SSH profiles encrypt keys and disabled profiles disappear from AI visibility", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-persistent-ssh-"));
  const connector = new FakeSshConnector();
  try {
    const store = await new PersistentSshServerStore(stateDirectory, {
      connector,
      keyGenerator: fakeKeyGenerator,
      now: () => 1_800_000_000_000,
    }).initialize();
    const server = await store.create({
      name: "Test server",
      host: "server.example.com",
      port: 22,
      username: "deploy",
      workingDirectory: "/srv/project",
      password: "one-time-password-that-must-not-persist",
    });

    assert.equal(server.enabled, true);
    assert.equal(store.snapshot({ enabledOnly: true }).length, 1);
    const storeText = await fs.readFile(
      path.join(stateDirectory, "plugin-data", "persistent-ssh-servers", "servers.json"),
      "utf8",
    );
    assert.doesNotMatch(storeText, /one-time-password-that-must-not-persist/);
    assert.doesNotMatch(storeText, /test-private-key-material/);
    assert.match(storeText, /aes-256-gcm/);
    const masterMode = (await fs.stat(
      path.join(stateDirectory, "plugin-data", "persistent-ssh-servers", "master.key"),
    )).mode & 0o777;
    assert.equal(masterMode, 0o600);

    await store.setEnabled(server.id, false);
    assert.equal(store.snapshot().find((entry) => entry.id === server.id).enabled, false);
    assert.deepEqual(store.snapshot({ enabledOnly: true }), []);
    await assert.rejects(store.execute(server.id, "uname -a"), /不可用/);

    const restored = await new PersistentSshServerStore(stateDirectory, {
      connector,
      keyGenerator: fakeKeyGenerator,
    }).initialize();
    assert.equal(restored.snapshot()[0].enabled, false);
    await restored.close();
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("persistent SSH retries RSA-3072 after an ED25519 rejection and pins the host key", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-persistent-ssh-fallback-"));
  const connector = new RejectingSshConnector({ rejectInstalls: 1 });
  try {
    const store = await new PersistentSshServerStore(stateDirectory, {
      connector,
      keyGenerator: algorithmKeyGenerator,
    }).initialize();
    const server = await store.create({
      name: "RSA fallback",
      host: "server.example.com",
      username: "deploy",
      password: "one-time-password",
    });
    assert.equal(server.authMode, "public-key");
    assert.equal(server.keyAlgorithm, "rsa-3072");
    assert.equal(connector.installs.length, 2);
    assert.equal(connector.installs[0].expectedFingerprint, null);
    assert.equal(
      connector.installs[1].expectedFingerprint,
      "SHA256:ZmFrZS1ob3N0LWZpbmdlcnByaW50",
    );
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("persistent SSH only stores an encrypted password after explicit compatibility consent", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-persistent-ssh-password-"));
  const password = "password-that-must-not-be-plain-text";
  try {
    const rejected = new PersistentSshServerStore(stateDirectory, {
      connector: new RejectingSshConnector(),
      keyGenerator: algorithmKeyGenerator,
    });
    await rejected.initialize();
    await assert.rejects(
      rejected.create({
        name: "Rejected",
        host: "server.example.com",
        username: "deploy",
        password,
      }),
      (error) => error.code === "ERR_PERSISTENT_SSH_PUBLIC_KEY_REJECTED" && error.passwordCompatibilityAvailable,
    );
    assert.deepEqual(rejected.snapshot(), []);

    const connector = new RejectingSshConnector();
    const store = await new PersistentSshServerStore(stateDirectory, {
      connector,
      keyGenerator: algorithmKeyGenerator,
    }).initialize();
    const server = await store.create({
      name: "Password compatibility",
      host: "server.example.com",
      username: "deploy",
      password,
      allowPasswordCompatibility: true,
    });
    assert.equal(server.authMode, "password");
    assert.equal(server.keyAlgorithm, null);
    const storeText = await fs.readFile(
      path.join(stateDirectory, "plugin-data", "persistent-ssh-servers", "servers.json"),
      "utf8",
    );
    assert.doesNotMatch(storeText, new RegExp(password));
    assert.match(storeText, /encryptedPassword/);

    await store.test(server.id);
    assert.equal(connector.connections.at(-1).input.password, password);
    assert.equal(connector.connections.at(-1).input.privateKey, undefined);
    await store.revoke(server.id);
    assert.equal(connector.removals.length, 0);
    assert.deepEqual(store.snapshot(), []);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("persistent SSH reuses one authenticated connection for sequential commands", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-persistent-ssh-pool-"));
  const connector = new FakeSshConnector();
  try {
    const store = await new PersistentSshServerStore(stateDirectory, {
      connector,
      keyGenerator: algorithmKeyGenerator,
    }).initialize();
    const server = await store.create({
      name: "Pooled",
      host: "server.example.com",
      username: "deploy",
      password: "password",
    });

    const first = await store.execute(server.id, "printf first");
    const second = await store.execute(server.id, "printf second");
    assert.equal(first.exitCode, 0);
    assert.equal(second.exitCode, 0);
    assert.equal(connector.connections.length, 1);

    connector.connections[0].client.emit("close");
    await store.execute(server.id, "printf reconnected");
    assert.equal(connector.connections.length, 2);
    await store.close();
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("persistent SSH retries only a transient pre-auth transport disconnect", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-persistent-ssh-retry-"));
  let attempts = 0;
  const connector = new FakeSshConnector();
  const originalConnect = connector.connect.bind(connector);
  connector.connect = async (input) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("SSH handshake socket closed before authentication");
      error.code = "ECONNRESET";
      throw error;
    }
    return originalConnect(input);
  };
  try {
    const store = await new PersistentSshServerStore(stateDirectory, {
      connector,
      keyGenerator: algorithmKeyGenerator,
    }).initialize();
    const server = await store.create({
      name: "Retry",
      host: "server.example.com",
      username: "deploy",
      password: "password",
    });
    const result = await store.execute(server.id, "printf retry");
    assert.equal(result.exitCode, 0);
    assert.equal(attempts, 2);
    await store.close();
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("persistent SSH broker never lists or executes a disabled server", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-persistent-ssh-broker-"));
  let enabled = true;
  const service = new PersistentSshToolService({
    directory,
    userId: "u-test",
    list: () => enabled
      ? [{ id: "pssh-enabled", name: "Debug", enabled: true }]
      : [],
    execute: async ({ serverId }) => {
      if (!enabled || serverId !== "pssh-enabled") {
        throw Object.assign(new Error("SSH 服务器不可用"), { statusCode: 404 });
      }
      return {
        id: serverId,
        name: "Debug",
        exitCode: 0,
        signal: null,
        stdout: "ok\n",
        stderr: "",
        truncated: false,
      };
    },
  });
  try {
    await service.start();
    const visible = await brokerRequest(service.socketPath, { version: 1, action: "list" });
    assert.deepEqual(visible, [{ id: "pssh-enabled", name: "Debug", enabled: true }]);
    enabled = false;
    const hidden = await brokerRequest(service.socketPath, { version: 1, action: "list" });
    assert.deepEqual(hidden, []);
    await assert.rejects(
      brokerRequest(service.socketPath, {
        version: 1,
        action: "execute",
        serverId: "pssh-enabled",
        command: "uname -a",
      }),
      (error) => error.statusCode === 404 && /不可用/.test(error.message),
    );
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("persistent SSH broker uses a bounded Unix socket path in a long runtime directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-persistent-ssh-long-runtime-"));
  const directory = path.join(root, "runtime", "ssh-tools");
  const service = new PersistentSshToolService({
    directory,
    userId: "u-0000000000000000",
    list: () => [],
    execute: async () => ({ exitCode: 0 }),
  });
  try {
    // The previous user-id-bearing filename pushed this fixture beyond
    // Linux's 107-byte sockaddr_un pathname limit.
    assert.ok(Buffer.byteLength(path.join(
      directory,
      "ssh-u-0000000000000000-000000000000000000000000.sock",
    )) > 107);
    assert.ok(Buffer.byteLength(service.socketPath) <= 107);
    await service.start();
    assert.deepEqual(
      await brokerRequest(service.socketPath, { version: 1, action: "list" }),
      [],
    );
    assert.equal((await fs.stat(service.socketPath)).mode & 0o777, 0o600);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("persistent SSH fails closed when its private key file is missing or insecure", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-persistent-ssh-"));
  const connector = new FakeSshConnector();
  try {
    const store = await new PersistentSshServerStore(stateDirectory, {
      connector,
      keyGenerator: fakeKeyGenerator,
    }).initialize();
    await store.create({
      name: "Protected",
      host: "server.example.com",
      username: "deploy",
      password: "one-time-password",
    });
    const directory = path.join(stateDirectory, "plugin-data", "persistent-ssh-servers");
    const masterKeyPath = path.join(directory, "master.key");
    await fs.chmod(masterKeyPath, 0o644);
    const tightened = await new PersistentSshServerStore(stateDirectory, {
      connector,
      keyGenerator: fakeKeyGenerator,
    }).initialize();
    assert.equal((await fs.stat(masterKeyPath)).mode & 0o777, 0o600);
    assert.equal(tightened.loadError, null);

    await fs.rm(masterKeyPath);
    const missingKey = await new PersistentSshServerStore(stateDirectory, {
      connector,
      keyGenerator: fakeKeyGenerator,
    }).initialize();
    assert.ok(missingKey.loadError);
    assert.deepEqual(missingKey.snapshot({ enabledOnly: true }), []);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("turning off a persistent SSH profile interrupts an already running command", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-persistent-ssh-"));
  const connector = new FakeSshConnector();
  try {
    const store = await new PersistentSshServerStore(stateDirectory, {
      connector,
      keyGenerator: fakeKeyGenerator,
    }).initialize();
    const server = await store.create({
      name: "Long task",
      host: "server.example.com",
      port: 22,
      username: "deploy",
      password: "one-time-password",
    });
    const execution = store.execute(server.id, "wait-for-toggle");
    await new Promise((resolve) => setImmediate(resolve));
    await store.setEnabled(server.id, false);
    const result = await execution;
    assert.equal(result.signal, "DISCONNECTED");
    assert.equal(connector.connections.at(-1).client.ended, true);
    assert.deepEqual(store.snapshot({ enabledOnly: true }), []);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("revoking a persistent SSH profile removes its dedicated remote key before forgetting it", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-persistent-ssh-"));
  const connector = new FakeSshConnector();
  try {
    const store = await new PersistentSshServerStore(stateDirectory, {
      connector,
      keyGenerator: fakeKeyGenerator,
    }).initialize();
    const server = await store.create({
      name: "Disposable",
      host: "server.example.com",
      port: 2222,
      username: "deploy",
      password: "one-time-password",
    });
    await store.revoke(server.id);
    assert.equal(connector.removals.length, 1);
    assert.equal(connector.removals[0].marker, `wfl-persistent-access-${server.id}`);
    assert.deepEqual(store.snapshot(), []);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});
