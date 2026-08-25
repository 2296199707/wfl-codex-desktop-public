import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeClaudePluginArchive,
  materializeClaudePluginUrls,
  normalizeClaudePluginUrls,
  resolveClaudePluginDirectories,
} from "../lib/claude-session-plugins.mjs";

test("Claude session plugins stay project-bounded and URL archives are materialized safely", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-session-plugin-"));
  try {
    const project = path.join(root, "projects", "fixture");
    const plugin = path.join(project, "plugins", "reviewer");
    const outside = path.join(root, "outside");
    await Promise.all([
      fs.mkdir(path.join(plugin, ".claude-plugin"), { recursive: true }),
      fs.mkdir(outside),
    ]);
    await fs.writeFile(
      path.join(plugin, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "fixture-reviewer" })}\n`,
    );
    const resolved = await resolveClaudePluginDirectories(["plugins/reviewer"], {
      cwd: project,
      projectRoot: path.join(root, "projects"),
    });
    assert.deepEqual(resolved, [plugin]);

    await fs.symlink(outside, path.join(project, "linked-plugin"));
    await assert.rejects(
      resolveClaudePluginDirectories(["linked-plugin"], {
        cwd: project,
        projectRoot: path.join(root, "projects"),
      }),
      /符号链接|工程外/,
    );
    await assert.rejects(
      resolveClaudePluginDirectories([outside], {
        cwd: project,
        projectRoot: path.join(root, "projects"),
      }),
      /当前工程内/,
    );

    const archive = storedZip({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "downloaded-reviewer" }),
      "commands/review.md": "Review the current changes.",
    });
    assert.equal(assertSafeClaudePluginArchive(archive), true);
    assert.throws(
      () => assertSafeClaudePluginArchive(storedZip({
        ".claude-plugin/plugin.json": "{}",
        "../escape": "unsafe",
      })),
      /越界路径/,
    );
    assert.throws(
      () => normalizeClaudePluginUrls(["https://127.0.0.1/plugin.zip"], { strict: true }),
      /公开 HTTPS/,
    );
    assert.throws(
      () => normalizeClaudePluginUrls(["https://plugins.example.test/plugin.zip?token=secret"], { strict: true }),
      /无查询参数/,
    );

    let downloads = 0;
    const directory = path.join(root, "state", "plugins");
    const first = await materializeClaudePluginUrls(
      ["https://plugins.example.test/reviewer.zip"],
      {
        directory,
        downloader: async () => {
          downloads += 1;
          return archive;
        },
      },
    );
    const second = await materializeClaudePluginUrls(
      ["https://plugins.example.test/reviewer.zip"],
      {
        directory,
        downloader: async () => {
          downloads += 1;
          return archive;
        },
      },
    );
    assert.deepEqual(second, first);
    assert.equal(downloads, 1);
    assert.equal((await fs.stat(first[0])).mode & 0o777, 0o600);
    assert.doesNotMatch(first[0], /reviewer\.zip/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function storedZip(files) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const [name, rawContent] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const content = Buffer.from(rawContent);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, nameBuffer);
    localOffset += local.length + nameBuffer.length + content.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}
