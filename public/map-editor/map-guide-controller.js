const GUIDE_ORIENTATIONS = new Set(["vertical", "horizontal"]);
const GUIDE_UNITS = new Set(["pixel", "tile"]);
const MAX_GUIDES = 256;
const MAX_POSITION = 1_000_000_000;

export function normalizeMapGuides(value) {
  if (!Array.isArray(value) || value.length > MAX_GUIDES) return [];
  const ids = new Set();
  const guides = [];
  for (const entry of value) {
    try {
      const guide = normalizeMapGuide(entry);
      if (ids.has(guide.id)) continue;
      ids.add(guide.id);
      guides.push(guide);
    } catch {
      // A corrupt local guide must not prevent the map from opening.
    }
  }
  return guides;
}

export function normalizeMapGuide(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid map guide");
  }
  const id = String(value.id || "");
  const orientation = String(value.orientation || "");
  const position = Number(value.position);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)
    || !GUIDE_ORIENTATIONS.has(orientation)
    || !Number.isFinite(position)
    || Math.abs(position) > MAX_POSITION) {
    throw new TypeError("Invalid map guide");
  }
  return Object.freeze({
    id,
    orientation,
    position,
    unit: GUIDE_UNITS.has(value.unit) ? value.unit : "pixel",
    locked: value.locked === true,
    visible: value.visible !== false,
  });
}

export function mapGuideDisplayValue(guide, document) {
  const unitSize = guideUnitSize(guide.orientation, guide.unit, document);
  return Number(guide.position) / unitSize;
}

export function mapGuidePositionFromDisplay(value, orientation, unit, document) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError("辅助线位置必须是有限数字");
  const position = number * guideUnitSize(orientation, unit, document);
  if (Math.abs(position) > MAX_POSITION) throw new TypeError("辅助线位置超出范围");
  return position;
}

export function snapBoundsToMapGuides(bounds, guides, options = {}) {
  if (!bounds || !Array.isArray(guides)) return { dx: 0, dy: 0 };
  const tolerance = Math.max(0, Number(options.tolerance) || 0);
  const verticalCandidates = [
    Number(bounds.x),
    Number(bounds.x) + Number(bounds.width) / 2,
    Number(bounds.x) + Number(bounds.width),
  ];
  const horizontalCandidates = [
    Number(bounds.y),
    Number(bounds.y) + Number(bounds.height) / 2,
    Number(bounds.y) + Number(bounds.height),
  ];
  return {
    dx: closestGuideDelta(verticalCandidates, guides, "vertical", tolerance),
    dy: closestGuideDelta(horizontalCandidates, guides, "horizontal", tolerance),
  };
}

export class MapGuideController {
  constructor(options) {
    this.host = options.host;
    this.topRuler = options.topRuler;
    this.leftRuler = options.leftRuler;
    this.layer = options.layer;
    this.panel = options.panel;
    this.panelButton = options.panelButton;
    this.closeButton = options.closeButton;
    this.visibleInput = options.visibleInput;
    this.unitInput = options.unitInput;
    this.addVerticalButton = options.addVerticalButton;
    this.addHorizontalButton = options.addHorizontalButton;
    this.list = options.list;
    this.emptyState = options.emptyState;
    this.document = options.document;
    this.screenToWorld = options.screenToWorld;
    this.worldToScreen = options.worldToScreen;
    this.onChange = options.onChange || (() => {});
    this.refreshIcons = options.refreshIcons || (() => {});
    this.guides = [];
    this.guidesVisible = true;
    this.defaultUnit = "pixel";
    this.drag = null;
    this.sequence = 0;
    this.boundPointerMove = (event) => this.handlePointerMove(event);
    this.boundPointerUp = (event) => this.handlePointerUp(event);
    this.bind();
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(this.host);
  }

  restore(value = {}) {
    this.guides = normalizeMapGuides(value.guides).map((guide) => ({ ...guide }));
    this.guidesVisible = value.guidesVisible !== false;
    this.defaultUnit = GUIDE_UNITS.has(value.guideUnit) ? value.guideUnit : "pixel";
    this.sequence = this.guides.reduce((maximum, guide) => {
      const match = guide.id.match(/-(\d+)$/u);
      return Math.max(maximum, Number(match?.[1]) || 0);
    }, 0);
    this.render();
  }

  snapshot() {
    return Object.freeze({
      guides: this.guides.map((guide) => ({ ...guide })),
      guidesVisible: this.guidesVisible,
      guideUnit: this.defaultUnit,
    });
  }

  setPanelOpen(open) {
    const visible = Boolean(open);
    this.panel.hidden = !visible;
    this.panelButton.setAttribute("aria-expanded", String(visible));
  }

  updateTransform() {
    this.drawRulers();
    this.renderGuideLines();
  }

  snapBounds(bounds, tolerance) {
    if (!this.guidesVisible) return { dx: 0, dy: 0 };
    return snapBoundsToMapGuides(bounds, this.guides.filter((guide) => guide.visible), { tolerance });
  }

  addGuide(orientation, position = null) {
    if (!GUIDE_ORIENTATIONS.has(orientation) || this.guides.length >= MAX_GUIDES) return null;
    const center = this.screenToWorld({
      x: this.host.clientWidth / 2,
      y: this.host.clientHeight / 2,
    });
    const guide = {
      id: `guide-${Date.now().toString(36)}-${++this.sequence}`,
      orientation,
      position: Number.isFinite(position) ? position : orientation === "vertical" ? center.x : center.y,
      unit: this.defaultUnit,
      locked: false,
      visible: true,
    };
    this.guides.push(guide);
    this.commit();
    return guide;
  }

  bind() {
    this.panelButton.addEventListener("click", () => this.setPanelOpen(this.panel.hidden));
    this.closeButton.addEventListener("click", () => this.setPanelOpen(false));
    this.visibleInput.addEventListener("change", () => {
      this.guidesVisible = this.visibleInput.checked;
      this.commit();
    });
    this.unitInput.addEventListener("change", () => {
      this.defaultUnit = this.unitInput.value === "tile" ? "tile" : "pixel";
      this.commit();
    });
    this.addVerticalButton.addEventListener("click", () => this.addGuide("vertical"));
    this.addHorizontalButton.addEventListener("click", () => this.addGuide("horizontal"));
    this.topRuler.addEventListener("pointerdown", (event) => this.beginRulerDrag(event, "vertical"));
    this.leftRuler.addEventListener("pointerdown", (event) => this.beginRulerDrag(event, "horizontal"));
    this.layer.addEventListener("pointerdown", (event) => this.beginLineDrag(event));
    this.list.addEventListener("change", (event) => this.handleListChange(event));
    this.list.addEventListener("click", (event) => this.handleListClick(event));
    window.addEventListener("pointermove", this.boundPointerMove);
    window.addEventListener("pointerup", this.boundPointerUp);
    window.addEventListener("pointercancel", this.boundPointerUp);
  }

  beginRulerDrag(event, orientation) {
    if (event.button !== 0) return;
    event.preventDefault();
    const guide = this.addGuide(orientation, this.positionForPointer(event, orientation));
    if (guide) this.drag = { guideId: guide.id, pointerId: event.pointerId };
  }

  beginLineDrag(event) {
    const line = event.target instanceof Element ? event.target.closest("[data-guide-id]") : null;
    if (!line || event.button !== 0) return;
    const guide = this.guideById(line.dataset.guideId);
    if (!guide || guide.locked) return;
    event.preventDefault();
    event.stopPropagation();
    this.drag = { guideId: guide.id, pointerId: event.pointerId };
    line.classList.add("is-dragging");
  }

  handlePointerMove(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const guide = this.guideById(this.drag.guideId);
    if (!guide || guide.locked) return;
    guide.position = this.positionForPointer(event, guide.orientation);
    this.renderGuideLines();
    this.renderList();
  }

  handlePointerUp(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.drag = null;
    this.commit();
  }

  positionForPointer(event, orientation) {
    const bounds = this.host.getBoundingClientRect();
    const point = this.screenToWorld({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
    return orientation === "vertical" ? point.x : point.y;
  }

  handleListChange(event) {
    const control = event.target instanceof HTMLElement ? event.target.closest("[data-guide-field]") : null;
    const row = control?.closest("[data-guide-id]");
    const guide = this.guideById(row?.dataset.guideId);
    if (!guide || !control) return;
    try {
      if (control.dataset.guideField === "position") {
        guide.position = mapGuidePositionFromDisplay(
          control.value,
          guide.orientation,
          guide.unit,
          this.document,
        );
      } else if (control.dataset.guideField === "unit") {
        guide.unit = control.value === "tile" ? "tile" : "pixel";
      }
      this.commit();
    } catch {
      this.renderList();
    }
  }

  handleListClick(event) {
    const button = event.target instanceof Element ? event.target.closest("[data-guide-action]") : null;
    const row = button?.closest("[data-guide-id]");
    const guide = this.guideById(row?.dataset.guideId);
    if (!guide || !button) return;
    const action = button.dataset.guideAction;
    if (action === "lock") guide.locked = !guide.locked;
    else if (action === "visible") guide.visible = !guide.visible;
    else if (action === "delete") this.guides = this.guides.filter((entry) => entry.id !== guide.id);
    this.commit();
  }

  guideById(id) {
    return this.guides.find((guide) => guide.id === id) || null;
  }

  commit() {
    this.render();
    this.onChange(this.snapshot());
  }

  render() {
    this.visibleInput.checked = this.guidesVisible;
    this.unitInput.value = this.defaultUnit;
    this.panelButton.classList.toggle("is-active", this.guidesVisible && this.guides.length > 0);
    this.drawRulers();
    this.renderGuideLines();
    this.renderList();
  }

  renderGuideLines() {
    const fragment = document.createDocumentFragment();
    if (this.guidesVisible) {
      for (const guide of this.guides) {
        if (!guide.visible) continue;
        const screen = this.worldToScreen({ x: guide.position, y: guide.position });
        const coordinate = guide.orientation === "vertical" ? screen.x : screen.y;
        const maximum = guide.orientation === "vertical" ? this.host.clientWidth : this.host.clientHeight;
        if (coordinate < -16 || coordinate > maximum + 16) continue;
        const line = document.createElement("button");
        line.type = "button";
        line.className = `map-guide-line is-${guide.orientation}${guide.locked ? " is-locked" : ""}`;
        line.dataset.guideId = guide.id;
        line.style.setProperty("--guide-position", `${coordinate}px`);
        line.title = `${guide.orientation === "vertical" ? "垂直" : "水平"}辅助线 ${formatGuideValue(guide, this.document)}`;
        line.setAttribute("aria-label", line.title);
        fragment.append(line);
      }
    }
    this.layer.replaceChildren(fragment);
  }

  renderList() {
    const fragment = document.createDocumentFragment();
    for (const guide of this.guides) {
      const row = document.createElement("div");
      row.className = "map-guide-row";
      row.dataset.guideId = guide.id;

      const orientation = document.createElement("span");
      orientation.className = "map-guide-orientation";
      orientation.title = guide.orientation === "vertical" ? "垂直辅助线" : "水平辅助线";
      orientation.textContent = guide.orientation === "vertical" ? "X" : "Y";

      const position = document.createElement("input");
      position.type = "number";
      position.step = guide.unit === "tile" ? "0.25" : "1";
      position.value = formatNumber(mapGuideDisplayValue(guide, this.document));
      position.dataset.guideField = "position";
      position.setAttribute("aria-label", `${guide.orientation === "vertical" ? "X" : "Y"} 位置`);
      position.disabled = guide.locked;

      const unit = document.createElement("select");
      unit.dataset.guideField = "unit";
      unit.setAttribute("aria-label", "辅助线单位");
      unit.append(option("pixel", "像素"), option("tile", "瓦片"));
      unit.value = guide.unit;
      unit.disabled = guide.locked;

      row.append(
        orientation,
        position,
        unit,
        guideActionButton("visible", guide.visible ? "eye" : "eye-off", guide.visible ? "隐藏辅助线" : "显示辅助线", guide.visible),
        guideActionButton("lock", guide.locked ? "lock-keyhole" : "lock-keyhole-open", guide.locked ? "解锁辅助线" : "锁定辅助线", guide.locked),
        guideActionButton("delete", "trash-2", "删除辅助线", false, true),
      );
      fragment.append(row);
    }
    this.list.replaceChildren(fragment);
    this.emptyState.hidden = this.guides.length > 0;
    this.refreshIcons();
  }

  drawRulers() {
    this.drawRuler(this.topRuler, "horizontal");
    this.drawRuler(this.leftRuler, "vertical");
  }

  drawRuler(canvas, direction) {
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#202421";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "#626b64";
    context.fillStyle = "#aeb7b0";
    context.lineWidth = 1;
    context.font = '9px "JetBrains Mono", monospace';
    context.textBaseline = "top";

    const horizontal = direction === "horizontal";
    const screenLength = horizontal ? width : height;
    const unitSize = guideUnitSize(horizontal ? "vertical" : "horizontal", this.defaultUnit, this.document);
    const firstWorld = this.screenToWorld({ x: 0, y: 0 });
    const lastWorld = this.screenToWorld({ x: horizontal ? screenLength : 0, y: horizontal ? 0 : screenLength });
    const first = (horizontal ? firstWorld.x : firstWorld.y) / unitSize;
    const last = (horizontal ? lastWorld.x : lastWorld.y) / unitSize;
    const pixelsPerUnit = Math.max(0.000001, screenLength / Math.max(0.000001, Math.abs(last - first)));
    const majorStep = niceStep(72 / pixelsPerUnit);
    const minorStep = majorStep / 5;
    const start = Math.floor(Math.min(first, last) / minorStep) * minorStep;
    const end = Math.max(first, last) + minorStep;
    let index = 0;
    for (let value = start; value <= end && index < 5_000; value += minorStep, index += 1) {
      const world = value * unitSize;
      const screen = this.worldToScreen({ x: world, y: world });
      const coordinate = horizontal ? screen.x : screen.y;
      const major = nearMultiple(value, majorStep);
      context.beginPath();
      if (horizontal) {
        context.moveTo(Math.round(coordinate) + 0.5, height);
        context.lineTo(Math.round(coordinate) + 0.5, major ? 8 : 16);
      } else {
        context.moveTo(width, Math.round(coordinate) + 0.5);
        context.lineTo(major ? 8 : 16, Math.round(coordinate) + 0.5);
      }
      context.stroke();
      if (major) {
        const label = formatNumber(value);
        if (horizontal) context.fillText(label, coordinate + 3, 2);
        else {
          context.save();
          context.translate(2, coordinate - 3);
          context.rotate(-Math.PI / 2);
          context.fillText(label, 0, 0);
          context.restore();
        }
      }
    }
  }

  destroy() {
    this.resizeObserver?.disconnect();
    window.removeEventListener("pointermove", this.boundPointerMove);
    window.removeEventListener("pointerup", this.boundPointerUp);
    window.removeEventListener("pointercancel", this.boundPointerUp);
  }
}

function guideUnitSize(orientation, unit, document) {
  if (unit !== "tile") return 1;
  const value = orientation === "vertical" ? document?.tilewidth : document?.tileheight;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

function closestGuideDelta(candidates, guides, orientation, tolerance) {
  let best = 0;
  let distance = tolerance + Number.EPSILON;
  for (const guide of guides) {
    if (guide.orientation !== orientation || guide.visible === false) continue;
    for (const candidate of candidates) {
      const delta = Number(guide.position) - candidate;
      if (Math.abs(delta) < distance) {
        distance = Math.abs(delta);
        best = delta;
      }
    }
  }
  return distance <= tolerance ? best : 0;
}

function guideActionButton(action, icon, label, active, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `mini-icon-button${active ? " is-active" : ""}${danger ? " is-danger" : ""}`;
  button.dataset.guideAction = action;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(active));
  const node = document.createElement("i");
  node.dataset.lucide = icon;
  button.append(node);
  return button;
}

function option(value, label) {
  const entry = document.createElement("option");
  entry.value = value;
  entry.textContent = label;
  return entry;
}

function formatGuideValue(guide, document) {
  const suffix = guide.unit === "tile" ? " 格" : " px";
  return `${formatNumber(mapGuideDisplayValue(guide, document))}${suffix}`;
}

function formatNumber(value) {
  return String(Math.round(Number(value) * 1_000) / 1_000);
}

function niceStep(value) {
  const normalized = Math.max(Number.EPSILON, Number(value) || 1);
  const power = 10 ** Math.floor(Math.log10(normalized));
  const fraction = normalized / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

function nearMultiple(value, step) {
  return Math.abs(value / step - Math.round(value / step)) < 0.00001;
}
