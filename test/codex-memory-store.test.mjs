import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexMemoryStore,
  normalizeCodexMemorySettings,
  publicCodexMemoryConfiguration,
  redactMemorySecrets,
} from "../lib/codex-memory-store.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-codex-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "state");
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const store = await new CodexMemoryStore({
    stateDirectory,
    codexHome,
    now: () => 1_785_000_000_000,
  }).initialize();
  return { root, stateDirectory, codexHome, store };
}

test("persists bounded native per-thread memory mode state", async (t) => {
  const { stateDirectory, codexHome, store } = await fixture(t);
  assert.equal(store.threadMode("thread-1"), null);
  assert.deepEqual(await store.setThreadMode("thread-1", "disabled"), {
    threadId: "thread-1",
    mode: "disabled",
    updatedAt: 1_785_000_000_000,
  });
  const restored = await new CodexMemoryStore({ stateDirectory, codexHome }).initialize();
  assert.equal(restored.threadMode("thread-1").mode, "disabled");
  await assert.rejects(() => store.setThreadMode("thread-1", "read-only"), /模式无效/);
});

test("lists and safely previews only current account memory text", async (t) => {
  const { codexHome, store } = await fixture(t);
  const directory = path.join(codexHome, "memories", "durable");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "facts.md");
  await fs.writeFile(file, "API_KEY=sk_this_should_never_reach_browser\nUseful preference", { mode: 0o600 });

  const files = await store.listMemories();
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "durable/facts.md");
  const preview = await store.readMemory(files[0].path);
  assert.equal(preview.redacted, true);
  assert.doesNotMatch(preview.content, /sk_this/);
  assert.match(preview.content, /Useful preference/);
  await assert.rejects(() => store.readMemory("../config.toml"), /路径无效/);

  await fs.symlink(file, path.join(directory, "linked.md"));
  await assert.rejects(() => store.listMemories(), /符号链接/);
});

test("rejects memory directories owned by another account identity", async (t) => {
  const { root, codexHome } = await fixture(t);
  await fs.mkdir(path.join(codexHome, "memories"), { mode: 0o700 });
  const stat = await fs.stat(path.join(codexHome, "memories"));
  const store = await new CodexMemoryStore({
    stateDirectory: path.join(root, "other-state"),
    codexHome,
    uid: stat.uid + 1,
    gid: stat.gid,
  }).initialize();
  await assert.rejects(() => store.listMemories(), /属主/);
});

test("normalizes native memory settings and applies documented defaults", () => {
  assert.deepEqual(normalizeCodexMemorySettings({
    featureEnabled: true,
    useMemories: true,
    generateMemories: false,
    disableOnExternalContext: true,
  }), {
    featureEnabled: true,
    useMemories: true,
    generateMemories: false,
    disableOnExternalContext: true,
  });
  assert.throws(() => normalizeCodexMemorySettings({
    featureEnabled: true,
    useMemories: "yes",
    generateMemories: false,
    disableOnExternalContext: true,
  }), /布尔值/);
  assert.deepEqual(publicCodexMemoryConfiguration({
    config: { features: {}, memories: {} },
  }), {
    featureEnabled: false,
    useMemories: true,
    generateMemories: true,
    disableOnExternalContext: false,
    supported: true,
    stage: null,
  });
});

test("redacts common credentials from memory previews", () => {
  const redacted = redactMemorySecrets([
    "password: correct-horse-battery-staple",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "token=eyJabcdefghijk.abcdefghijkl.abcdefghijkl",
    "github=gho_abcdefghijklmnop",
  ].join("\n"));
  assert.doesNotMatch(redacted, /correct-horse|abcdefghijklmnopqrstuvwxyz|eyJabcdefghijk|gho_abcdefghijklmnop/);
});
