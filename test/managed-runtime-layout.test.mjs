import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertManagedRuntimeLayout } from "../lib/managed-runtime-layout.mjs";

test("managed runtime layout verifies real paths, identity, and private modes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-managed-layout-"));
  try {
    const home = path.join(directory, "home");
    const codexHome = path.join(home, ".codex");
    const projectRoot = path.join(home, "projects");
    const defaultProject = path.join(projectRoot, "workspace");
    const privateTemp = path.join(home, "tmp");
    const stateDirectory = path.join(directory, "state");
    await Promise.all([
      fs.mkdir(codexHome, { recursive: true, mode: 0o700 }),
      fs.mkdir(defaultProject, { recursive: true, mode: 0o700 }),
      fs.mkdir(privateTemp, { recursive: true, mode: 0o700 }),
      fs.mkdir(stateDirectory, { mode: 0o700 }),
    ]);
    for (const target of [home, codexHome, projectRoot, defaultProject, privateTemp, stateDirectory]) {
      await fs.chmod(target, 0o700);
    }
    const stat = await fs.stat(home);
    const user = {
      uid: stat.uid,
      gid: stat.gid,
      home,
      codexHome,
      projectRoot,
      defaultProject,
      stateDirectory,
    };
    const verified = await assertManagedRuntimeLayout(user);
    assert.equal(verified.homeReal, await fs.realpath(home));
    assert.equal(verified.stateDirectory, await fs.realpath(stateDirectory));

    await fs.chmod(codexHome, 0o750);
    await assert.rejects(assertManagedRuntimeLayout(user), /private directory permissions are too broad/);
    await fs.chmod(codexHome, 0o700);

    await assert.rejects(
      assertManagedRuntimeLayout({ ...user, uid: user.uid + 1 }),
      /directory owner is invalid/,
    );

    const outside = path.join(directory, "outside");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.rm(defaultProject, { recursive: true });
    await fs.symlink(outside, defaultProject, "dir");
    await assert.rejects(assertManagedRuntimeLayout(user), /escaped its home/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
