import assert from "node:assert/strict";
import test from "node:test";
import { findMountForPath, parseMountInfo } from "../lib/disk-storage.mjs";

test("parses mount points without depending on a fixed data-disk path", () => {
  const mounts = parseMountInfo([
    "36 29 8:1 / / rw,relatime - ext4 /dev/vda1 rw",
    "37 36 8:2 / /mnt/fast\\040disk rw,relatime - xfs /dev/vdb1 rw",
    "38 29 0:5 / /proc rw,nosuid - proc proc rw",
  ].join("\n"));
  assert.equal(mounts[1].mountPoint, "/mnt/fast disk");
  assert.equal(mounts[1].source, "/dev/vdb1");
  assert.equal(findMountForPath(mounts, "/mnt/fast disk/project"), mounts[1]);
  assert.equal(findMountForPath(mounts, "/etc/hosts"), mounts[0]);
});
