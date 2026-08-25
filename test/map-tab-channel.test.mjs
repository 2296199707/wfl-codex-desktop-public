import assert from "node:assert/strict";
import test from "node:test";
import {
  createMapEditorTabSignal,
  MAP_EDITOR_TAB_SIGNAL_TYPE,
  parseMapEditorTabSignal,
} from "../public/map-editor/map-tab-channel.js";

const base = {
  hostWindowId: "host-window-0001",
  editorInstanceId: "editor-window-0001",
  sessionId: "map-session-00000001",
  projectPath: "/srv/projects/game",
  relativePath: "maps/world.tmj",
  sentAt: 100,
};

test("creates and validates scoped map editor tab state", () => {
  const signal = createMapEditorTabSignal("state", { ...base, dirty: true, focused: true });
  assert.equal(signal.type, MAP_EDITOR_TAB_SIGNAL_TYPE);
  assert.equal(signal.dirty, true);
  assert.deepEqual(parseMapEditorTabSignal(signal, { hostWindowId: base.hostWindowId }), signal);
  assert.equal(parseMapEditorTabSignal(signal, { hostWindowId: "other-host-0001" }), null);
});

test("bounds snapshots and rejects traversal or mismatched identifiers", () => {
  const snapshot = createMapEditorTabSignal("snapshot", {
    hostWindowId: base.hostWindowId,
    sentAt: 101,
    tabs: [{
      editorInstanceId: base.editorInstanceId,
      projectPath: base.projectPath,
      relativePath: base.relativePath,
      dirty: false,
      active: true,
    }],
  });
  assert.equal(snapshot.tabs[0].active, true);
  assert.equal(parseMapEditorTabSignal({ ...base, type: MAP_EDITOR_TAB_SIGNAL_TYPE, action: "state", relativePath: "../private.tmj" }), null);
  assert.throws(() => createMapEditorTabSignal("focus-request", {
    hostWindowId: base.hostWindowId,
    editorInstanceId: base.editorInstanceId,
    targetEditorInstanceId: "short",
  }));
});

test("scopes an in-editor map switch to the current project session", () => {
  const signal = createMapEditorTabSignal("open-request", {
    ...base,
    projectSessionId: "project-session-0001",
    targetRelativePath: "maps/dungeon.tmj",
  });
  assert.equal(signal.targetRelativePath, "maps/dungeon.tmj");
  assert.equal(signal.projectSessionId, "project-session-0001");
  assert.deepEqual(parseMapEditorTabSignal(signal, { hostWindowId: base.hostWindowId }), signal);
  assert.equal(parseMapEditorTabSignal({ ...signal, targetRelativePath: "../outside.tmj" }, { hostWindowId: base.hostWindowId }), null);
});
