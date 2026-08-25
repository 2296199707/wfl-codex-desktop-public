import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_PREVIEW_SLOT_COUNT,
  PublicOriginConfigStore,
  isConfiguredPreviewOrigin,
  normalizePublicOrigin,
  previewSessionOrigin,
  previewOriginCandidates,
  previewOriginSlot,
} from "../lib/public-origin-config.mjs";

test("public Origin config starts unconfigured and never guesses a public domain", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-public-origin-"));
  try {
    const store = await new PublicOriginConfigStore(root).initialize();
    assert.deepEqual(store.snapshot(), {
      version: 1,
      mode: "unconfigured",
      publicOrigin: null,
      previewBaseDomain: null,
      previewOrigins: [],
      slotCount: 0,
      isolation: "pool",
      confirmedBy: null,
      confirmedAt: null,
      source: null,
      disabledBy: null,
      disabledAt: null,
      disabledReason: null,
    });
    assert.equal(await fs.stat(path.join(root, "public-origin.json")).catch(() => null), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a damaged public Origin file fails closed to sandbox mode without blocking boot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-public-origin-"));
  try {
    const file = path.join(root, "public-origin.json");
    await fs.writeFile(file, "{not-json\n", { mode: 0o600 });
    const store = await new PublicOriginConfigStore(root).initialize();
    assert.equal(store.snapshot().mode, "unconfigured");
    assert.ok(store.loadError);
    assert.match(await fs.readFile(file, "utf8"), /not-json/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("explicit confirmation creates a fixed per-instance preview Origin pool", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-public-origin-"));
  try {
    const store = await new PublicOriginConfigStore(root, { now: () => 123 }).initialize();
    const confirmed = await store.confirm({
      publicOrigin: "https://codex.customer.example",
      confirmedBy: "owner-1",
      source: "owner",
    });
    assert.equal(confirmed.mode, "confirmed");
    assert.equal(confirmed.publicOrigin, "https://codex.customer.example");
    assert.deepEqual(confirmed.previewOrigins, [
      "https://preview-1.codex.customer.example",
      "https://preview-2.codex.customer.example",
      "https://preview-3.codex.customer.example",
      "https://preview-4.codex.customer.example",
    ]);
    assert.equal(confirmed.confirmedAt, 123);
    assert.equal(confirmed.disabledBy, null);
    assert.equal(confirmed.disabledAt, null);
    assert.equal(confirmed.disabledReason, null);
    assert.equal((await fs.stat(path.join(root, "public-origin.json"))).mode & 0o777, 0o600);

    const restored = await new PublicOriginConfigStore(root).initialize();
    assert.deepEqual(restored.snapshot(), confirmed);
    assert.deepEqual(previewOriginSlot(confirmed.previewOrigins[2], {
      configuredOrigins: confirmed.previewOrigins,
    }), { origin: confirmed.previewOrigins[2], slot: 3 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("candidate discovery is ordered and does not trust an untrusted Host", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-public-origin-"));
  try {
    const store = await new PublicOriginConfigStore(root).initialize();
    const candidates = store.candidates({
      accessState: { hostname: "access.example.test" },
      forwardedHost: "proxy.example.test",
      forwardedProtocol: "https",
      requestHost: "attacker.example.test",
      requestProtocol: "https",
      trustedProxy: false,
    });
    assert.deepEqual(candidates.map((entry) => entry.origin), [
      "https://access.example.test",
      "https://attacker.example.test",
    ]);
    assert.equal(candidates.some((entry) => entry.origin.includes("proxy.example.test")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trusted forwarded Host is accepted only as a confirmation candidate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-public-origin-"));
  try {
    const store = await new PublicOriginConfigStore(root).initialize();
    const candidates = store.candidates({
      forwardedHost: "codex.example.test",
      forwardedProtocol: "https",
      trustedProxy: true,
    });
    assert.equal(candidates[0].origin, "https://codex.example.test");
    assert.equal(candidates[0].requiresOwnerConfirmation, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("public Origin validation rejects paths, credentials, private hosts, and HTTP public origins", () => {
  assert.equal(normalizePublicOrigin("https://Example.TEST/"), "https://example.test");
  assert.equal(normalizePublicOrigin("http://127.0.0.1:4317", { allowLoopback: true }), "http://127.0.0.1:4317");
  for (const value of [
    "https://user:pass@example.test",
    "https://example.test/path",
    "http://example.test",
    "https://127.0.0.1",
    "https://[::1]",
    "https://[fe80::1]",
    "https://[::ffff:127.0.0.1]",
    "https://*.example.test",
  ]) {
    assert.throws(() => normalizePublicOrigin(value), /Origin|主机|HTTPS/);
  }
});

test("preview candidates are deterministic and bounded", () => {
  assert.deepEqual(previewOriginCandidates({ publicOrigin: "https://wfl.example", slotCount: 2 }), [
    "https://preview-1.wfl.example",
    "https://preview-2.wfl.example",
  ]);
  assert.equal(previewOriginCandidates({ publicOrigin: "https://wfl.example" }).length, DEFAULT_PREVIEW_SLOT_COUNT);
  assert.throws(() => previewOriginCandidates({ publicOrigin: "https://wfl.example", slotCount: 17 }), /槽位/);
});

test("session isolation accepts only short-lived per-session preview hosts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-public-origin-"));
  try {
    const store = await new PublicOriginConfigStore(root, {
      randomBytes: () => Buffer.alloc(12, 7),
    }).initialize();
    const config = await store.confirm({
      publicOrigin: "https://wfl.example",
      previewBaseDomain: "preview.wfl.example",
      isolation: "session",
      confirmedBy: "owner",
    });
    const sessionOrigin = previewSessionOrigin({
      previewBaseDomain: config.previewBaseDomain,
      randomBytes: () => Buffer.alloc(12, 7),
    });
    assert.equal(config.isolation, "session");
    assert.equal(isConfiguredPreviewOrigin(config, sessionOrigin), true);
    assert.equal(isConfiguredPreviewOrigin(config, "https://preview-1.preview.wfl.example"), false);
    assert.equal(isConfiguredPreviewOrigin(config, "https://preview-session-aaaaaaaaaaaaaaaaaaaaaaaa.other.example"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("disabling a confirmed Origin returns to safe unconfigured mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-public-origin-"));
  try {
    const store = await new PublicOriginConfigStore(root, { now: () => 456 }).initialize();
    await store.confirm({ publicOrigin: "https://wfl.example", confirmedBy: "owner" });
    const disabled = await store.disable({ actor: "owner", reason: "certificate-not-ready" });
    assert.equal(disabled.mode, "unconfigured");
    assert.equal(disabled.publicOrigin, null);
    assert.equal(disabled.disabledBy, "owner");
    assert.equal(disabled.disabledAt, 456);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
