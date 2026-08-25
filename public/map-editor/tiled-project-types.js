const PROPERTY_TYPES = new Set([
  "bool", "color", "file", "float", "int", "object", "string", "class", "enum", "list",
]);
const ENUM_STORAGE_TYPES = new Set(["string", "int"]);

export class TiledProjectTypesError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TiledProjectTypesError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Normalize the propertyTypes section of a Tiled .tiled-project file.  The
 * registry is intentionally independent from the editor so maps opened from
 * a temporary project still get the same safe primitive controls.
 */
export function parseTiledProjectTypes(document = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw typesError("TILED_PROJECT_INVALID", "Tiled 项目必须是对象");
  }
  if (document.propertyTypes === undefined) return emptyRegistry();
  if (!Array.isArray(document.propertyTypes)) {
    throw typesError("TILED_PROJECT_PROPERTY_TYPES_INVALID", "Tiled propertyTypes 必须是数组");
  }
  const classes = new Map();
  const enums = new Map();
  for (const [index, raw] of document.propertyTypes.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw typesError("TILED_PROJECT_PROPERTY_TYPE_INVALID", `propertyTypes[${index}] 必须是对象`);
    }
    const name = typeName(raw.name, `propertyTypes[${index}] 名称`);
    const kind = String(raw.type || "").toLowerCase();
    if (kind === "class") {
      if (classes.has(name) || enums.has(name)) throw typesError("TILED_PROJECT_TYPE_DUPLICATE", `类型 ${name} 重复`);
      const members = Array.isArray(raw.members) ? raw.members.map((member, memberIndex) => (
        normalizeMember(member, `${name}.members[${memberIndex}]`)
      )) : [];
      const defaults = Object.fromEntries(members.map((member) => [member.name, cloneJsonValue(member.defaultValue)]));
      classes.set(name, Object.freeze({ name, type: "class", members: Object.freeze(members), defaults: freezeJson(defaults) }));
    } else if (kind === "enum") {
      if (classes.has(name) || enums.has(name)) throw typesError("TILED_PROJECT_TYPE_DUPLICATE", `类型 ${name} 重复`);
      const values = enumValues(raw.values, `${name}.values`);
      const storageType = ENUM_STORAGE_TYPES.has(String(raw.storageType || "").toLowerCase())
        ? String(raw.storageType).toLowerCase()
        : "string";
      enums.set(name, Object.freeze({
        name,
        type: "enum",
        values: Object.freeze(values),
        storageType,
        valuesAsFlags: raw.valuesAsFlags === true,
      }));
    } else {
      throw typesError("TILED_PROJECT_TYPE_KIND_INVALID", `类型 ${name} 必须是 class 或 enum`);
    }
  }
  return freezeRegistry({ classes, enums });
}

export function emptyTiledProjectTypes() {
  return emptyRegistry();
}

export function tiledPropertyControl(property, registry = emptyRegistry()) {
  const rawType = String(property?.type || "string").toLowerCase();
  if (!PROPERTY_TYPES.has(rawType)) return Object.freeze({ type: rawType, editable: false, preserveOnly: true });
  if (rawType === "class") {
    const name = propertyTypeName(property);
    const definition = registry.classes.get(name);
    return Object.freeze({ type: "class", propertyType: name, definition: definition || null, editable: Boolean(definition) });
  }
  if (rawType === "enum") {
    const name = propertyTypeName(property);
    const definition = registry.enums.get(name);
    return Object.freeze({
      type: "enum",
      propertyType: name,
      definition: definition || null,
      editable: Boolean(definition),
      values: definition?.values || Object.freeze([]),
      valuesAsFlags: definition?.valuesAsFlags === true,
    });
  }
  if (rawType === "list") {
    const itemType = normalizeItemType(property?.propertyType ?? property?.propertytype ?? property?.itemType);
    return Object.freeze({
      type: "list",
      itemType,
      editable: PROPERTY_TYPES.has(itemType) && itemType !== "list",
      preserveOnly: itemType === "list" || !PROPERTY_TYPES.has(itemType),
    });
  }
  return Object.freeze({ type: rawType, editable: true, preserveOnly: false });
}

export function normalizeTiledPropertyValue(property, value, registry = emptyRegistry(), options = {}) {
  const control = tiledPropertyControl(property, registry);
  if (control.preserveOnly || !control.editable) return cloneJsonValue(value);
  if (control.type === "bool") return value === true;
  if (control.type === "int" || control.type === "object") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw typesError("TILED_PROPERTY_VALUE_INVALID", `${control.type} 属性必须是安全整数`);
    return number;
  }
  if (control.type === "float") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw typesError("TILED_PROPERTY_VALUE_INVALID", "float 属性必须是有限数字");
    return number;
  }
  if (control.type === "file") return typeof value === "string" ? value : "";
  if (control.type === "color" || control.type === "string") return String(value ?? "");
  if (control.type === "enum") return normalizeEnumValue(value, control.definition);
  if (control.type === "list") {
    if (!Array.isArray(value)) throw typesError("TILED_PROPERTY_VALUE_INVALID", "List 属性必须是数组");
    return value.map((item) => {
      // Tiled 1.12 stores list items as {type, value} property records.  A
      // few older exporters emitted primitive arrays; accept both while
      // retaining the record wrapper and any unknown item fields.
      if (item && typeof item === "object" && !Array.isArray(item) && "value" in item) {
        const itemProperty = {
          ...item,
          type: item.type || control.itemType,
          ...(item.propertyType || item.propertytype
            ? { propertyType: item.propertyType || item.propertytype }
            : {}),
        };
        return { ...cloneJsonValue(item), value: normalizeTiledPropertyValue(itemProperty, item.value, registry, options) };
      }
      const itemProperty = { type: control.itemType };
      return normalizeTiledPropertyValue(itemProperty, item, registry, options);
    });
  }
  if (control.type === "class") return normalizeClassValue(value, control.definition, registry);
  return cloneJsonValue(value);
}

export function mergeTiledClassDefaults(value, definition, registry = emptyRegistry()) {
  if (!definition || definition.type !== "class") return cloneJsonValue(value || {});
  return normalizeClassValue({ ...definition.defaults, ...(value && typeof value === "object" ? value : {}) }, definition, registry);
}

function normalizeMember(raw, label) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw typesError("TILED_PROJECT_MEMBER_INVALID", `${label} 必须是对象`);
  const name = typeName(raw.name, `${label} name`);
  const type = String(raw.type || "string").toLowerCase();
  if (!PROPERTY_TYPES.has(type)) throw typesError("TILED_PROJECT_MEMBER_TYPE_INVALID", `${label} type 无效`);
  return Object.freeze({
    name,
    type,
    propertyType: propertyTypeName(raw) || null,
    defaultValue: cloneJsonValue(raw.value ?? raw.defaultValue ?? defaultForType(type)),
  });
}

function normalizeClassValue(value, definition, registry) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw typesError("TILED_PROPERTY_VALUE_INVALID", "Class 属性必须是对象");
  }
  if (!definition) return cloneJsonValue(value);
  const result = { ...definition.defaults };
  for (const member of definition.members) {
    if (!(member.name in value)) continue;
    result[member.name] = normalizeTiledPropertyValue({
      type: member.type,
      ...(member.propertyType ? { propertyType: member.propertyType } : {}),
    }, value[member.name], registry);
  }
  for (const [key, item] of Object.entries(value)) if (!definition.members.some((member) => member.name === key)) result[key] = cloneJsonValue(item);
  return result;
}

function normalizeEnumValue(value, definition) {
  if (!definition) return cloneJsonValue(value);
  if (definition.valuesAsFlags) {
    if (definition.storageType === "int") {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0) throw typesError("TILED_PROPERTY_VALUE_INVALID", "Enum flags 必须是非负整数");
      return number;
    }
    const values = Array.isArray(value) ? value : String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
    if (values.some((item) => !definition.values.includes(item))) throw typesError("TILED_PROPERTY_VALUE_INVALID", "Enum flags 包含未知值");
    return values.join(",");
  }
  if (definition.storageType === "int") {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || !definition.values.includes(number)) throw typesError("TILED_PROPERTY_VALUE_INVALID", "Enum 整数值不在定义中");
    return number;
  }
  const text = String(value ?? "");
  if (!definition.values.includes(text)) throw typesError("TILED_PROPERTY_VALUE_INVALID", "Enum 字符串值不在定义中");
  return text;
}

function propertyTypeName(value) {
  const name = value?.propertyType ?? value?.propertytype ?? value?.typeName;
  return typeof name === "string" ? name.trim() : "";
}

function normalizeItemType(value) {
  const type = String(value || "string").toLowerCase();
  return PROPERTY_TYPES.has(type) ? type : "string";
}

function enumValues(value, label) {
  if (!Array.isArray(value) || !value.length) throw typesError("TILED_PROJECT_ENUM_VALUES_INVALID", `${label} 必须是非空数组`);
  const values = value.map((item, index) => {
    if (!(typeof item === "string" || Number.isSafeInteger(item))) throw typesError("TILED_PROJECT_ENUM_VALUE_INVALID", `${label}[${index}] 无效`);
    return item;
  });
  if (new Set(values).size !== values.length) throw typesError("TILED_PROJECT_ENUM_DUPLICATE", `${label} 不能重复`);
  return values;
}

function typeName(value, label) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) throw typesError("TILED_PROJECT_TYPE_NAME_INVALID", `${label} 无效`);
  return name;
}

function defaultForType(type) {
  if (type === "bool") return false;
  if (type === "int" || type === "float" || type === "object") return 0;
  if (type === "class" || type === "list") return type === "list" ? [] : {};
  return "";
}

function emptyRegistry() {
  return freezeRegistry({ classes: new Map(), enums: new Map() });
}

function freezeRegistry({ classes, enums }) {
  return Object.freeze({
    classes,
    enums,
    classNames: Object.freeze([...classes.keys()]),
    enumNames: Object.freeze([...enums.keys()]),
  });
}

function cloneJsonValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function freezeJson(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    value.forEach(freezeJson);
  } else {
    Object.values(value).forEach(freezeJson);
  }
  return Object.freeze(value);
}

function typesError(code, message, details = {}) {
  return new TiledProjectTypesError(code, message, details);
}
