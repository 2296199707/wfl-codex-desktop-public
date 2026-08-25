import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseDocument, stringify } from "yaml";

const MAX_DEFINITIONS = 64;
const MAX_DEFINITION_BYTES = 256 * 1024;
const MAX_BODY_LENGTH = 100_000;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_TOOL_RULES = 64;
const MAX_TOOL_RULE_LENGTH = 256;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AGENT_MODELS = new Set(["inherit", "haiku", "sonnet", "opus"]);
const AGENT_PERMISSION_MODES = new Set(["default", "acceptEdits", "auto", "manual", "dontAsk", "plan"]);
const AGENT_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export class ClaudeExtensionStore {
  constructor({ configDirectory, uid = null, gid = null }) {
    this.configDirectory = path.resolve(configDirectory);
    this.skillsDirectory = path.join(this.configDirectory, "skills");
    this.agentsDirectory = path.join(this.configDirectory, "agents");
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
  }

  async listSkills() {
    const entries = await safeDirectoryEntries(this.skillsDirectory);
    const skills = [];
    for (const entry of entries.slice(0, MAX_DEFINITIONS)) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !NAME_PATTERN.test(entry.name)) continue;
      const definition = await readDefinition(path.join(this.skillsDirectory, entry.name, "SKILL.md"));
      if (!definition) continue;
      skills.push(publicSkill(entry.name, definition));
    }
    return skills.sort((left, right) => left.name.localeCompare(right.name));
  }

  async saveSkill(input, { existingName = null } = {}) {
    const name = normalizeName(input?.name, "Skill 名称无效");
    const originalName = existingName === null ? null : normalizeName(existingName, "Skill 名称无效");
    if (originalName && originalName !== name) throw extensionError(400, "Skill 名称不能直接修改");
    await this.ensureBaseDirectory(this.skillsDirectory);
    const directory = path.join(this.skillsDirectory, name);
    const target = path.join(directory, "SKILL.md");
    const existing = await readDefinition(target);
    if (originalName && !existing) throw extensionError(404, "Claude Skill 不存在");
    if (!originalName && existing) throw extensionError(409, "Claude Skill 名称已存在");
    if (!originalName && (await this.listSkills()).length >= MAX_DEFINITIONS) {
      throw extensionError(400, "Claude Skill 数量已达上限");
    }
    await ensureSafeDirectory(directory, { create: true });
    await this.applyOwnership(directory);
    const definition = normalizeSkillInput(input, existing);
    await this.atomicWrite(target, serializeDefinition(definition.metadata, definition.body));
    return publicSkill(name, definition);
  }

  async removeSkill(name) {
    const normalized = normalizeName(name, "Skill 名称无效");
    const directory = path.join(this.skillsDirectory, normalized);
    const definition = await readDefinition(path.join(directory, "SKILL.md"));
    if (!definition) throw extensionError(404, "Claude Skill 不存在");
    await ensureSafeDirectory(directory);
    await fs.rm(directory, { recursive: true, force: false });
    await syncDirectory(this.skillsDirectory);
    return { deleted: true, name: normalized };
  }

  async listAgents() {
    const entries = await safeDirectoryEntries(this.agentsDirectory);
    const agents = [];
    for (const entry of entries.slice(0, MAX_DEFINITIONS)) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".md")) continue;
      const name = entry.name.slice(0, -3);
      if (!NAME_PATTERN.test(name)) continue;
      const definition = await readDefinition(path.join(this.agentsDirectory, entry.name));
      if (!definition) continue;
      agents.push(publicAgent(name, definition));
    }
    return agents.sort((left, right) => left.name.localeCompare(right.name));
  }

  async saveAgent(input, { existingName = null } = {}) {
    const name = normalizeName(input?.name, "Agent 名称无效");
    const originalName = existingName === null ? null : normalizeName(existingName, "Agent 名称无效");
    if (originalName && originalName !== name) throw extensionError(400, "Agent 名称不能直接修改");
    await this.ensureBaseDirectory(this.agentsDirectory);
    const target = path.join(this.agentsDirectory, `${name}.md`);
    const existing = await readDefinition(target);
    if (originalName && !existing) throw extensionError(404, "Claude Agent 不存在");
    if (!originalName && existing) throw extensionError(409, "Claude Agent 名称已存在");
    if (!originalName && (await this.listAgents()).length >= MAX_DEFINITIONS) {
      throw extensionError(400, "Claude Agent 数量已达上限");
    }
    const definition = normalizeAgentInput(input, existing);
    await this.atomicWrite(target, serializeDefinition(definition.metadata, definition.body));
    return publicAgent(name, definition);
  }

  async removeAgent(name) {
    const normalized = normalizeName(name, "Agent 名称无效");
    const target = path.join(this.agentsDirectory, `${normalized}.md`);
    const definition = await readDefinition(target);
    if (!definition) throw extensionError(404, "Claude Agent 不存在");
    await assertSafeFile(target);
    await fs.unlink(target);
    await syncDirectory(this.agentsDirectory);
    return { deleted: true, name: normalized };
  }

  async ensureBaseDirectory(directory) {
    await ensureSafeDirectory(this.configDirectory, { create: true });
    await ensureSafeDirectory(directory, { create: true });
    await this.applyOwnership(directory);
  }

  async atomicWrite(target, content) {
    if (Buffer.byteLength(content) > MAX_DEFINITION_BYTES) throw extensionError(400, "Claude 扩展文件过大");
    const directory = path.dirname(target);
    const existing = await fs.lstat(target).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw extensionError(400, "Claude 扩展文件不安全");
    }
    const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(content);
      if (this.uid !== null && this.gid !== null) await handle.chown(this.uid, this.gid);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
      await syncDirectory(directory);
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async applyOwnership(target) {
    if (this.uid !== null && this.gid !== null) await fs.chown(target, this.uid, this.gid);
  }
}

function normalizeSkillInput(input, previous) {
  const metadata = safeMetadata(previous?.metadata);
  metadata.name = normalizeName(input?.name, "Skill 名称无效");
  metadata.description = boundedRequiredText(input?.description, MAX_DESCRIPTION_LENGTH, "Skill 描述不能为空");
  assignOptional(metadata, "allowed-tools", normalizeToolRules(input?.allowedTools).join(" "));
  assignOptionalBoolean(metadata, "disable-model-invocation", input?.disableModelInvocation === true);
  assignOptionalBoolean(metadata, "user-invocable", input?.userInvocable !== false, true);
  return { metadata, body: normalizeBody(input?.body, "Skill 指令不能为空") };
}

function normalizeAgentInput(input, previous) {
  const metadata = safeMetadata(previous?.metadata);
  metadata.name = normalizeName(input?.name, "Agent 名称无效");
  metadata.description = boundedRequiredText(input?.description, MAX_DESCRIPTION_LENGTH, "Agent 描述不能为空");
  assignOptional(metadata, "tools", normalizeToolRules(input?.tools).join(", "));
  assignOptional(metadata, "disallowedTools", normalizeToolRules(input?.disallowedTools).join(", "));
  const model = optionalEnum(input?.model, AGENT_MODELS, "Agent 模型无效");
  const permissionMode = optionalEnum(input?.permissionMode, AGENT_PERMISSION_MODES, "Agent 权限模式无效");
  const effort = optionalEnum(input?.effort, AGENT_EFFORTS, "Agent effort 无效");
  assignOptional(metadata, "model", model);
  assignOptional(metadata, "permissionMode", permissionMode);
  assignOptional(metadata, "effort", effort);
  assignOptional(metadata, "isolation", input?.worktree === true ? "worktree" : null);
  return { metadata, body: normalizeBody(input?.body, "Agent 系统提示不能为空") };
}

function publicSkill(name, definition) {
  return {
    name,
    description: boundedText(definition.metadata.description, MAX_DESCRIPTION_LENGTH) || "",
    allowedTools: normalizeToolRules(definition.metadata["allowed-tools"]),
    disableModelInvocation: definition.metadata["disable-model-invocation"] === true,
    userInvocable: definition.metadata["user-invocable"] !== false,
    body: definition.body,
  };
}

function publicAgent(name, definition) {
  return {
    name,
    description: boundedText(definition.metadata.description, MAX_DESCRIPTION_LENGTH) || "",
    tools: normalizeToolRules(definition.metadata.tools),
    disallowedTools: normalizeToolRules(definition.metadata.disallowedTools),
    model: AGENT_MODELS.has(definition.metadata.model) ? definition.metadata.model : null,
    permissionMode: AGENT_PERMISSION_MODES.has(definition.metadata.permissionMode) ? definition.metadata.permissionMode : null,
    effort: AGENT_EFFORTS.has(definition.metadata.effort) ? definition.metadata.effort : null,
    worktree: definition.metadata.isolation === "worktree",
    body: definition.body,
  };
}

async function readDefinition(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_DEFINITION_BYTES) return null;
    return parseDefinition(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function parseDefinition(source) {
  const normalized = String(source).replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return { metadata: {}, body: normalized.trim().slice(0, MAX_BODY_LENGTH) };
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) throw extensionError(400, "Claude 扩展 frontmatter 未闭合");
  const document = parseDocument(normalized.slice(4, end), { schema: "core", maxAliasCount: 0 });
  if (document.errors.length) throw extensionError(400, `Claude 扩展 frontmatter 无效: ${document.errors[0].message}`);
  const metadata = document.toJS({ maxAliasCount: 0 });
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw extensionError(400, "Claude 扩展 frontmatter 必须是对象");
  }
  return { metadata, body: normalized.slice(end + 5).trim().slice(0, MAX_BODY_LENGTH) };
}

function serializeDefinition(metadata, body) {
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`;
}

function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 100));
}

function normalizeName(value, message) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!NAME_PATTERN.test(name)) throw extensionError(400, message);
  return name;
}

function normalizeBody(value, message) {
  const body = typeof value === "string" ? value.trim() : "";
  if (!body || body.length > MAX_BODY_LENGTH) throw extensionError(400, message);
  return body;
}

function normalizeToolRules(value) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? splitToolRuleString(value) : [];
  const rules = [];
  for (const entry of source) {
    const rule = typeof entry === "string" ? entry.trim() : "";
    if (!rule || rule.length > MAX_TOOL_RULE_LENGTH || /[\r\n\0]/.test(rule)) continue;
    if (!rules.includes(rule)) rules.push(rule);
    if (rules.length >= MAX_TOOL_RULES) break;
  }
  return rules;
}

function splitToolRuleString(value) {
  const entries = [];
  let current = "";
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    else if (character === ")" && depth > 0) depth -= 1;
    if (depth === 0 && (character === "," || /\s/.test(character))) {
      if (current.trim()) entries.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

function optionalEnum(value, allowed, message) {
  if (value === null || value === undefined || value === "") return null;
  if (!allowed.has(value)) throw extensionError(400, message);
  return value;
}

function boundedRequiredText(value, maximum, message) {
  const text = boundedText(value, maximum);
  if (!text) throw extensionError(400, message);
  return text;
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.trim() && value.length <= maximum ? value.trim() : null;
}

function assignOptional(target, key, value) {
  if (value === null || value === undefined || value === "") delete target[key];
  else target[key] = value;
}

function assignOptionalBoolean(target, key, value, defaultValue = false) {
  if (value === defaultValue) delete target[key];
  else target[key] = value;
}

async function safeDirectoryEntries(directory) {
  try {
    await ensureSafeDirectory(directory);
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function ensureSafeDirectory(directory, { create = false } = {}) {
  if (create) await fs.mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw extensionError(400, "Claude 扩展目录不安全");
  await fs.chmod(directory, 0o700);
}

async function assertSafeFile(filePath) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw extensionError(400, "Claude 扩展文件不安全");
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function extensionError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
