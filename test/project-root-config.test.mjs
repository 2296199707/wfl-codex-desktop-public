import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ProjectRootConfigStore, normalizeDataRoots } from "../lib/project-root-config.mjs";

test("keeps an unmounted data disk configured without creating it", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-project-root-config-");
  try {
    const primary = path.join(directory, "primary");
    const dataDisk = path.join(directory, "data-disk");
    await fs.mkdir(primary);
    const store = await new ProjectRootConfigStore(
      path.join(directory, "runtime", "project-roots.json"),
      { primaryRoot: primary },
    ).initialize();

    const saved = await store.setDataRoots([dataDisk]);
    assert.deepEqual(saved.dataRoots, [dataDisk]);
    assert.deepEqual(await store.resolveRoots(), [primary]);
    await assert.rejects(fs.access(dataDisk), { code: "ENOENT" });

    let snapshot = await store.snapshot({ defaultProject: path.join(primary, "workspace") });
    assert.equal(snapshot.dataRoots[0].status, "unavailable");
    assert.equal(snapshot.dataRoots[0].active, false);

    await fs.mkdir(dataDisk);
    assert.deepEqual(await store.resolveRoots(), [primary, dataDisk]);
    snapshot = await store.snapshot({ defaultProject: path.join(primary, "workspace") });
    assert.equal(snapshot.dataRoots[0].status, "active");
    assert.equal(snapshot.dataRoots[0].active, true);

    await fs.rm(dataDisk, { recursive: true });
    assert.deepEqual(await store.resolveRoots(), [primary]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("persists configured data disks across config store instances", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-project-root-persistence-");
  try {
    const primary = path.join(directory, "primary");
    const dataDisk = path.join(directory, "data-disk");
    const filePath = path.join(directory, "runtime", "project-roots.json");
    await fs.mkdir(primary);
    const first = await new ProjectRootConfigStore(filePath, { primaryRoot: primary }).initialize();
    await first.setDataRoots([dataDisk]);

    const restarted = await new ProjectRootConfigStore(filePath, {
      primaryRoot: primary,
      environmentRoots: [primary, path.join(directory, "different-disk")],
    }).initialize();
    assert.equal(restarted.hasPersistedConfig(), true);
    assert.deepEqual(restarted.configuredDataRoots(), [dataDisk]);
    assert.deepEqual(await restarted.resolveRoots(), [primary]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("validates data disk paths and removes duplicates", () => {
  const primary = "/srv/projects";
  assert.deepEqual(
    normalizeDataRoots(["", "/mnt/data", "/mnt/data"], primary),
    ["/mnt/data"],
  );
  assert.throws(() => normalizeDataRoots(["relative/path"], primary), /绝对路径/);
  assert.throws(() => normalizeDataRoots(["/mnt/../data"], primary), /绝对路径/);
  assert.throws(
    () => normalizeDataRoots(Array.from({ length: 8 }, (_, index) => `/mnt/data-${index}`), primary),
    /最多支持/,
  );
});
