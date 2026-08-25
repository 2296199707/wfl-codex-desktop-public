import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildPreviewDnsPlan,
  relativeSubDomain,
  TencentCloudCredentialStore,
  TencentCloudDnsClient,
  TencentCloudSetupStore,
} from "../lib/tencent-cloud-dns.mjs";
import { PublicOriginConfigStore } from "../lib/public-origin-config.mjs";

test("Tencent Cloud credential store masks secrets and writes private state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-tencent-dns-"));
  const store = await new TencentCloudCredentialStore(directory, { now: () => 123 }).initialize();
  const snapshot = await store.save({
    secretId: "AKIDexample123456",
    secretKey: "secret-key-example",
    region: "ap-guangzhou",
    zoneDomain: "wflai.chat",
    targetType: "A",
    target: "203.0.113.8",
    certificateEmail: "owner@example.com",
  });
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.secretId, "AKIDex***3456");
  assert.equal(snapshot.target, "203.0.113.8");
  assert.equal(snapshot.updatedAt, 123);
  const file = path.join(directory, "tencent-cloud-dns.json");
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o077, 0);
  const contents = await fs.readFile(file, "utf8");
  assert.match(contents, /secret-key-example/);
});

test("preview DNS plan creates fixed pool or wildcard session records", () => {
  const pool = buildPreviewDnsPlan({
    publicOrigin: "https://wflai.chat",
    previewBaseDomain: "preview.wflai.chat",
    slotCount: 2,
    isolation: "pool",
    zoneDomain: "wflai.chat",
    targetType: "A",
    target: "203.0.113.8",
  });
  assert.deepEqual(pool.map((record) => record.subDomain), ["preview-1.preview", "preview-2.preview"]);
  const session = buildPreviewDnsPlan({
    publicOrigin: "https://wflai.chat",
    previewBaseDomain: "preview.wflai.chat",
    isolation: "session",
    zoneDomain: "wflai.chat",
    targetType: "CNAME",
    target: "wflai.chat",
  });
  assert.deepEqual(session.map((record) => record.subDomain), ["*.preview"]);
  assert.equal(relativeSubDomain("wflai.chat", "wflai.chat"), "@");
});

test("Tencent Cloud DNS client uses TC3 authorization and refuses conflicting records", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    return new Response(JSON.stringify({
      Response: {
        RecordList: [{ RecordId: 12, RecordLine: "默认", Value: "198.51.100.10" }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new TencentCloudDnsClient({
    secretId: "AKIDexample123456",
    secretKey: "secret-key-example",
    fetchImpl,
    now: () => 1_700_000_000_000,
  });
  await assert.rejects(
    client.upsertRecord({
      zoneDomain: "wflai.chat",
      subDomain: "preview-1.preview",
      recordType: "A",
      value: "203.0.113.8",
    }),
    /已存在不同/,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].headers.Authorization, /^TC3-HMAC-SHA256 Credential=AKIDexample123456\//);
  assert.equal(calls[0].headers["X-TC-Action"], "DescribeRecordList");
});

test("DNSPod no-data responses are empty and wildcard records are matched locally", async () => {
  const calls = [];
  const client = new TencentCloudDnsClient({
    secretId: "AKIDexample123456",
    secretKey: "secret-key-example",
    fetchImpl: async (_url, options) => {
      const action = options.headers["X-TC-Action"];
      const payload = JSON.parse(options.body);
      calls.push({ action, payload });
      if (action === "DescribeRecordList") {
        return new Response(JSON.stringify({
          Response: {
            Error: { Code: "ResourceNotFound.NoDataOfRecord", Message: "记录列表为空。" },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ Response: { RecordId: 42 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const created = await client.upsertRecord({
    zoneDomain: "wflai.chat",
    subDomain: "preview",
    recordType: "A",
    value: "203.0.113.8",
  });
  assert.equal(created.action, "created");
  assert.equal(calls[0].action, "DescribeRecordList");
  assert.equal(calls[1].action, "CreateRecord");

  const wildcardCalls = [];
  const wildcardClient = new TencentCloudDnsClient({
    secretId: "AKIDexample123456",
    secretKey: "secret-key-example",
    fetchImpl: async (_url, options) => {
      const action = options.headers["X-TC-Action"];
      wildcardCalls.push({ action, payload: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        Response: {
          RecordList: [{ RecordId: 43, Name: "*.preview", Line: "默认", Type: "A", Value: "198.51.100.8" }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(
    wildcardClient.upsertRecord({
      zoneDomain: "wflai.chat",
      subDomain: "*.preview",
      recordType: "A",
      value: "203.0.113.8",
    }),
    /已存在不同/,
  );
  assert.equal(wildcardCalls[0].payload.Subdomain, undefined);
});

test("Tencent setup worker fails closed before DNS mutation for a root wildcard", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-tencent-worker-"));
  const runtime = path.join(directory, "runtime");
  await fs.mkdir(runtime);
  await fs.writeFile(path.join(runtime, "access.json"), JSON.stringify({ managedBy: "nginx-certbot" }));
  await new TencentCloudCredentialStore(directory).initialize().then((store) => store.save({
    secretId: "AKIDexample123456",
    secretKey: "secret-key-example",
    region: "ap-guangzhou",
    zoneDomain: "wflai.chat",
    targetType: "A",
    target: "203.0.113.8",
    certificateEmail: "owner@example.com",
  }));
  await new PublicOriginConfigStore(directory).initialize().then((store) => store.confirm({
    publicOrigin: "https://wflai.chat",
    previewBaseDomain: "wflai.chat",
    slotCount: 2,
    isolation: "session",
    confirmedBy: "owner",
  }));
  const setupStore = await new TencentCloudSetupStore(directory).initialize();
  const setup = await setupStore.begin({
    id: "tencent-worker-test-1234",
    actor: "owner",
    input: {
      zoneDomain: "wflai.chat",
      targetType: "A",
      target: "203.0.113.8",
      issueCertificate: true,
      isolation: "session",
    },
  });
  const result = await runNode(new URL("../scripts/configure-tencent-origin.mjs", import.meta.url), {
    CODEX_DESKTOP_SOURCE_DIR: path.resolve(new URL("..", import.meta.url).pathname),
    CODEX_DESKTOP_STATE_DIR: directory,
    CODEX_DESKTOP_RUNTIME_DIR: runtime,
    CODEX_DESKTOP_TENCENT_SETUP_ID: setup.id,
  });
  assert.notEqual(result.code, 0);
  await setupStore.initialize();
  const status = setupStore.snapshot();
  assert.equal(status.status, "failed");
  assert.match(status.error, /独立预览子域名/);
});

function runNode(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script.pathname], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}
