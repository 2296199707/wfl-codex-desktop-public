const DEFAULT_DEAD_ZONE = 0.18;
const DEFAULT_PAN_PIXELS_PER_SECOND = 420;
const DEFAULT_ZOOM_RATE = 1.25;
const MAX_FRAME_SECONDS = 0.05;

export class MapGamepadController {
  constructor(options = {}) {
    this.eventTarget = options.eventTarget || globalThis.window;
    this.getGamepads = options.getGamepads || (() => globalThis.navigator?.getGamepads?.() || []);
    this.requestFrame = options.requestAnimationFrame || ((callback) => globalThis.requestAnimationFrame(callback));
    this.cancelFrame = options.cancelAnimationFrame || ((handle) => globalThis.cancelAnimationFrame(handle));
    this.isBlocked = typeof options.isBlocked === "function" ? options.isBlocked : () => false;
    this.onPan = typeof options.onPan === "function" ? options.onPan : () => {};
    this.onZoom = typeof options.onZoom === "function" ? options.onZoom : () => {};
    this.onAction = typeof options.onAction === "function" ? options.onAction : () => {};
    this.onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
    this.deadZone = boundedNumber(options.deadZone, DEFAULT_DEAD_ZONE, 0, 0.95, "deadZone");
    this.panSpeed = boundedNumber(
      options.panPixelsPerSecond,
      DEFAULT_PAN_PIXELS_PER_SECOND,
      1,
      10_000,
      "panPixelsPerSecond",
    );
    this.zoomRate = boundedNumber(options.zoomRate, DEFAULT_ZOOM_RATE, 0.01, 10, "zoomRate");
    this.frameHandle = null;
    this.lastTimestamp = null;
    this.activeIndex = null;
    this.activeId = "";
    this.pressedButtons = new Set();
    this.started = false;
    this.boundConnected = (event) => this.handleConnectionChange(event?.gamepad, true);
    this.boundDisconnected = (event) => this.handleConnectionChange(event?.gamepad, false);
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.eventTarget?.addEventListener?.("gamepadconnected", this.boundConnected);
    this.eventTarget?.addEventListener?.("gamepaddisconnected", this.boundDisconnected);
    this.selectActiveGamepad();
    if (this.activeIndex !== null) this.schedule();
    return this;
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.eventTarget?.removeEventListener?.("gamepadconnected", this.boundConnected);
    this.eventTarget?.removeEventListener?.("gamepaddisconnected", this.boundDisconnected);
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.lastTimestamp = null;
    this.pressedButtons.clear();
    this.setActive(null);
  }

  handleConnectionChange(gamepad, connected) {
    if (!this.started || !gamepad || !Number.isSafeInteger(gamepad.index) || gamepad.index < 0) return;
    if (!connected && gamepad.index === this.activeIndex) this.setActive(null);
    this.selectActiveGamepad();
    if (this.activeIndex !== null) this.schedule();
  }

  selectActiveGamepad() {
    const gamepads = safeGamepads(this.getGamepads);
    const current = this.activeIndex === null ? null : gamepads.find((entry) => entry?.index === this.activeIndex);
    if (validGamepad(current)) {
      this.setActive(current);
      return current;
    }
    const next = gamepads.filter(validGamepad).sort((left, right) => left.index - right.index)[0] || null;
    this.setActive(next);
    return next;
  }

  setActive(gamepad) {
    const index = validGamepad(gamepad) ? gamepad.index : null;
    const id = index === null ? "" : String(gamepad.id || `Gamepad ${index + 1}`).slice(0, 160);
    const changed = index !== this.activeIndex || id !== this.activeId;
    this.activeIndex = index;
    this.activeId = id;
    if (changed) {
      this.pressedButtons.clear();
      this.lastTimestamp = null;
      this.onStatus(Object.freeze({ connected: index !== null, index, id }));
    }
  }

  schedule() {
    if (!this.started || this.activeIndex === null || this.frameHandle !== null) return;
    this.frameHandle = this.requestFrame((timestamp) => this.frame(timestamp));
  }

  frame(timestamp) {
    this.frameHandle = null;
    if (!this.started) return;
    const gamepad = this.selectActiveGamepad();
    if (!gamepad) return;
    const now = Number.isFinite(Number(timestamp)) ? Number(timestamp) : 0;
    const elapsed = this.lastTimestamp === null
      ? 1 / 60
      : Math.max(0, Math.min(MAX_FRAME_SECONDS, (now - this.lastTimestamp) / 1000));
    this.lastTimestamp = now;
    if (this.isBlocked()) this.capturePressedButtons(gamepad);
    else this.applyInput(gamepad, elapsed);
    this.schedule();
  }

  applyInput(gamepad, elapsedSeconds) {
    const dpadX = buttonValue(gamepad, 15) - buttonValue(gamepad, 14);
    const dpadY = buttonValue(gamepad, 13) - buttonValue(gamepad, 12);
    const panX = clampUnit(normalizedAxis(gamepad.axes?.[0], this.deadZone) + dpadX);
    const panY = clampUnit(normalizedAxis(gamepad.axes?.[1], this.deadZone) + dpadY);
    if (panX || panY) {
      this.onPan(Object.freeze({
        x: -panX * this.panSpeed * elapsedSeconds,
        y: -panY * this.panSpeed * elapsedSeconds,
      }));
    }
    const zoom = normalizedAxis(gamepad.axes?.[3], this.deadZone);
    if (zoom) this.onZoom(Math.exp(-zoom * this.zoomRate * elapsedSeconds));

    const nextPressed = pressedButtonIndexes(gamepad);
    for (const [index, action] of GAMEPAD_ACTIONS) {
      if (nextPressed.has(index) && !this.pressedButtons.has(index)) this.onAction(action);
    }
    this.pressedButtons = nextPressed;
  }

  capturePressedButtons(gamepad) {
    this.pressedButtons = pressedButtonIndexes(gamepad);
  }
}

const GAMEPAD_ACTIONS = Object.freeze(new Map([
  [0, "primary"],
  [1, "cancel"],
  [2, "select-tool"],
  [3, "hand-tool"],
  [9, "fit"],
]));

function validGamepad(value) {
  return Boolean(value && value.connected !== false && Number.isSafeInteger(value.index) && value.index >= 0);
}

function safeGamepads(read) {
  try {
    return Array.from(read() || []);
  } catch {
    return [];
  }
}

function normalizedAxis(value, deadZone) {
  const number = clampUnit(Number(value) || 0);
  const magnitude = Math.abs(number);
  if (magnitude <= deadZone) return 0;
  return Math.sign(number) * ((magnitude - deadZone) / (1 - deadZone));
}

function buttonValue(gamepad, index) {
  const button = gamepad.buttons?.[index];
  if (!button) return 0;
  if (button.pressed === true) return 1;
  return clampUnit(Math.max(0, Number(button.value) || 0));
}

function pressedButtonIndexes(gamepad) {
  const indexes = new Set();
  for (const index of GAMEPAD_ACTIONS.keys()) {
    if (buttonValue(gamepad, index) >= 0.5) indexes.add(index);
  }
  return indexes;
}

function clampUnit(value) {
  return Math.max(-1, Math.min(1, Number(value) || 0));
}

function boundedNumber(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return number;
}
