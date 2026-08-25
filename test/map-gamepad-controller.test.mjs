import assert from "node:assert/strict";
import test from "node:test";
import { MapGamepadController } from "../public/map-editor/map-gamepad-controller.js";

test("gamepad uses fixed pan, zoom, and edge-triggered action mappings", () => {
  const target = new FakeEventTarget();
  const frames = new ManualFrames();
  const gamepad = makeGamepad();
  const pan = [];
  const zoom = [];
  const actions = [];
  const statuses = [];
  const controller = new MapGamepadController({
    eventTarget: target,
    getGamepads: () => [gamepad],
    requestAnimationFrame: frames.request,
    cancelAnimationFrame: frames.cancel,
    onPan: (value) => pan.push(value),
    onZoom: (value) => zoom.push(value),
    onAction: (value) => actions.push(value),
    onStatus: (value) => statuses.push(value),
  }).start();
  assert.equal(statuses.at(-1).connected, true);
  gamepad.axes = [1, -1, 0, 1];
  gamepad.buttons[0] = { pressed: true, value: 1 };
  frames.fire(16);
  assert.equal(pan.length, 1);
  assert.ok(pan[0].x < 0 && pan[0].y > 0);
  assert.ok(zoom[0] < 1);
  assert.deepEqual(actions, ["primary"]);
  frames.fire(32);
  assert.deepEqual(actions, ["primary"]);
  gamepad.buttons[0] = { pressed: false, value: 0 };
  frames.fire(48);
  gamepad.buttons[0] = { pressed: true, value: 1 };
  frames.fire(64);
  assert.deepEqual(actions, ["primary", "primary"]);
  controller.stop();
  assert.equal(frames.size, 0);
  assert.equal(statuses.at(-1).connected, false);
});

test("blocked gamepad input captures held buttons without replaying them after unblock", () => {
  const frames = new ManualFrames();
  const gamepad = makeGamepad();
  const actions = [];
  let blocked = true;
  gamepad.buttons[1] = { pressed: true, value: 1 };
  const controller = new MapGamepadController({
    getGamepads: () => [gamepad],
    eventTarget: new FakeEventTarget(),
    requestAnimationFrame: frames.request,
    cancelAnimationFrame: frames.cancel,
    isBlocked: () => blocked,
    onAction: (action) => actions.push(action),
  }).start();
  frames.fire(16);
  blocked = false;
  frames.fire(32);
  assert.deepEqual(actions, []);
  gamepad.buttons[1] = { pressed: false, value: 0 };
  frames.fire(48);
  gamepad.buttons[1] = { pressed: true, value: 1 };
  frames.fire(64);
  assert.deepEqual(actions, ["cancel"]);
  controller.stop();
});

test("disconnect switches deterministically to the lowest connected index", () => {
  const target = new FakeEventTarget();
  const frames = new ManualFrames();
  const first = makeGamepad(3, "third");
  const second = makeGamepad(1, "first");
  let pads = [first, second];
  const statuses = [];
  const controller = new MapGamepadController({
    eventTarget: target,
    getGamepads: () => pads,
    requestAnimationFrame: frames.request,
    cancelAnimationFrame: frames.cancel,
    onStatus: (status) => statuses.push(status),
  }).start();
  assert.equal(statuses.at(-1).index, 1);
  second.connected = false;
  pads = [first, second];
  target.emit("gamepaddisconnected", second);
  assert.equal(statuses.at(-1).index, 3);
  controller.stop();
});

function makeGamepad(index = 0, id = "test-pad") {
  return {
    index,
    id,
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
  };
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
  emit(type, gamepad) { this.listeners.get(type)?.({ gamepad }); }
}

class ManualFrames {
  constructor() {
    this.callbacks = new Map();
    this.next = 1;
    this.request = (callback) => {
      const id = this.next++;
      this.callbacks.set(id, callback);
      return id;
    };
    this.cancel = (id) => this.callbacks.delete(id);
  }
  get size() { return this.callbacks.size; }
  fire(time) {
    const [id, callback] = this.callbacks.entries().next().value || [];
    if (!callback) throw new Error("No requested frame");
    this.callbacks.delete(id);
    callback(time);
  }
}
