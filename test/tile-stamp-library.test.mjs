import assert from "node:assert/strict";
import test from "node:test";
import {
  createTileStampLibrary,
  parseTileStampLibrary,
  removeNamedTileStamp,
  setNamedTileStampFavorite,
  sortedNamedTileStamps,
  tileStampLibraryStorageKey,
  touchNamedTileStamp,
  upsertNamedTileStamp,
} from "../public/map-editor/tile-stamp-library.js";

const stamp = {
  width: 2,
  height: 1,
  cells: [{ x: 0, y: 0, gid: 7 }, { x: 1, y: 0, gid: 8 }],
};

test("scopes named stamps to one account, project, and map", () => {
  const key = tileStampLibraryStorageKey({
    accountId: "account-1",
    projectPath: "/srv/projects/game one",
    relativePath: "maps/world.tmj",
  });
  assert.match(key, /^wfl-map-tile-stamps-v1:account-1:/u);
  assert.match(key, /world\.tmj/u);
  assert.throws(() => tileStampLibraryStorageKey({
    accountId: "account-1",
    projectPath: "/srv/projects/game",
    relativePath: "../other.tmj",
  }));
});

test("adds, replaces, favorites, uses, and removes immutable named stamps", () => {
  let library = createTileStampLibrary();
  library = upsertNamedTileStamp(library, { id: "stamp-1", name: "Stone road", stamp }, 100);
  assert.equal(library.entries.length, 1);
  assert.equal(library.entries[0].stamp.width, 2);

  library = upsertNamedTileStamp(library, {
    id: "ignored-new-id",
    name: " stone ROAD ",
    stamp: { width: 1, height: 1, cells: [{ x: 0, y: 0, gid: 9 }] },
  }, 200);
  assert.equal(library.entries.length, 1);
  assert.equal(library.entries[0].id, "stamp-1");
  assert.equal(library.entries[0].name, "stone ROAD");
  assert.equal(library.entries[0].stamp.cells[0].gid, 9);

  library = setNamedTileStampFavorite(library, "stamp-1", true, 300);
  const used = touchNamedTileStamp(library, "stamp-1", 400);
  library = used.library;
  assert.equal(used.entry.favorite, true);
  assert.equal(used.entry.lastUsedAt, 400);
  assert.equal(sortedNamedTileStamps(library)[0].id, "stamp-1");

  library = removeNamedTileStamp(library, "stamp-1");
  assert.deepEqual(library.entries, []);
});

test("rejects corrupt persisted stamp data without partially loading it", () => {
  assert.equal(parseTileStampLibrary({ version: 2, entries: [] }), null);
  assert.equal(parseTileStampLibrary({
    version: 1,
    entries: [{
      id: "bad",
      name: "Bad",
      stamp: { width: 2, height: 1, cells: [{ x: 0, y: 0, gid: 1 }] },
      favorite: false,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
    }],
  }), null);
});
