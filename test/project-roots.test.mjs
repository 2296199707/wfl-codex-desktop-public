import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProjectRoots,
  projectRootContains,
  projectRootForPath,
  projectRootId,
  publicProjectRoots,
} from "../lib/project-roots.mjs";

test("normalizes multiple project storage roots and selects the most specific root", () => {
  const roots = normalizeProjectRoots("/srv:/www:/srv");
  assert.deepEqual(roots, ["/srv", "/www"]);
  assert.equal(projectRootContains("/www", "/www/game"), true);
  assert.equal(projectRootContains("/www", "/www2/game"), false);
  assert.equal(projectRootForPath(roots, "/www/game"), "/www");
  assert.equal(projectRootForPath(roots, "/opt/game"), null);
});

test("publishes stable root IDs and marks the default storage location", () => {
  const roots = publicProjectRoots(["/srv", "/www"], "/srv/workspace");
  assert.equal(roots.length, 2);
  assert.equal(roots[0].id, projectRootId("/srv"));
  assert.equal(roots[0].isDefault, true);
  assert.equal(roots[1].isDefault, false);
});

test("rejects unsafe or oversized project root configuration", () => {
  assert.throws(() => normalizeProjectRoots("/srv:/tmp/with space"), /有效的绝对路径/);
  assert.throws(() => normalizeProjectRoots("/srv/../etc"), /有效的绝对路径/);
  assert.throws(() => normalizeProjectRoots(Array.from({ length: 9 }, (_, index) => `/data/${index}`)), /最多支持/);
});
