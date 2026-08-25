import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectCodexInstallation } from "../lib/codex-prerequisite.mjs";

test("recognizes the official Codex CLI and app-server capability", async () => {
  const fixture = await fakeCodex(`case "$1" in
  --version) echo "codex-cli 1.2.3" ;;
  app-server) echo "Usage: codex app-server [OPTIONS]" ;;
  *) exit 2 ;;
esac`);
  try {
    assert.deepEqual(await inspectCodexInstallation({ command: fixture.command }), {
      version: "codex-cli 1.2.3",
      appServerReady: true,
    });
  } finally {
    await fixture.remove();
  }
});

test("rejects unrelated commands and Codex builds without app-server", async () => {
  const unrelated = await fakeCodex('echo "other-cli 1.0.0"');
  const incomplete = await fakeCodex(`case "$1" in
  --version) echo "codex-cli 1.2.3" ;;
  *) echo "Usage: codex" ;;
esac`);
  try {
    await assert.rejects(inspectCodexInstallation({ command: unrelated.command }), /not the official Codex CLI/);
    await assert.rejects(inspectCodexInstallation({ command: incomplete.command }), /does not provide app-server/);
  } finally {
    await Promise.all([unrelated.remove(), incomplete.remove()]);
  }
});

test("discovers the official standalone install outside a non-interactive PATH", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-prerequisite-home-"));
  const binDirectory = path.join(home, ".local", "bin");
  const command = path.join(binDirectory, "codex");
  const previous = {
    home: process.env.HOME,
    path: process.env.PATH,
    command: process.env.CODEX_DESKTOP_CODEX_BIN,
  };
  await fs.mkdir(binDirectory, { recursive: true });
  await fs.writeFile(command, `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 1.2.3" ;;
  app-server) echo "Usage: codex app-server [OPTIONS]" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  try {
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    delete process.env.CODEX_DESKTOP_CODEX_BIN;
    assert.deepEqual(await inspectCodexInstallation(), {
      version: "codex-cli 1.2.3",
      appServerReady: true,
    });
  } finally {
    if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    if (previous.command === undefined) delete process.env.CODEX_DESKTOP_CODEX_BIN;
    else process.env.CODEX_DESKTOP_CODEX_BIN = previous.command;
    await fs.rm(home, { recursive: true, force: true });
  }
});

async function fakeCodex(body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fake-codex-prerequisite-"));
  const command = path.join(directory, "codex");
  await fs.writeFile(command, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return {
    command,
    remove: () => fs.rm(directory, { recursive: true, force: true }),
  };
}
