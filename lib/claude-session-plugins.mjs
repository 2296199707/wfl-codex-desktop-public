import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";

export const MAX_CLAUDE_SESSION_PLUGINS = 8;
export const MAX_CLAUDE_PLUGIN_URLS = 4;
const MAX_PLUGIN_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_PLUGIN_EXPANDED_BYTES = 200 * 1024 * 1024;
const MAX_PLUGIN_ENTRIES = 5_000;
const MAX_PLUGIN_MANIFEST_BYTES = 1024 * 1024;
const MAX_PLUGIN_URL_LENGTH = 2_048;
const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";

export function normalizeClaudePluginDirectories(value, { strict = false } = {}) {
  if (value === undefined || value === null || value === "") return [];
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : null;
  return normalizeStringList(entries, {
    maximum: MAX_CLAUDE_SESSION_PLUGINS,
    strict,
    label: "Claude 会话插件路径",
    validate: (entry) => entry.length <= 4_096 && !/[\0\r\n]/.test(entry),
  });
}

export function normalizeClaudePluginUrls(value, { strict = false } = {}) {
  if (value === undefined || value === null || value === "") return [];
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : null;
  const normalized = normalizeStringList(entries, {
    maximum: MAX_CLAUDE_PLUGIN_URLS,
    strict,
    label: "Claude 会话插件 URL",
    validate: (entry) => entry.length <= MAX_PLUGIN_URL_LENGTH && !/[\0\r\n]/.test(entry),
  });
  if (!Array.isArray(normalized)) return normalized;
  try {
    return normalized.map(normalizePublicPluginUrl);
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

export async function resolveClaudePluginDirectories(value, { cwd, projectRoot }) {
  const entries = normalizeClaudePluginDirectories(value, { strict: true });
  if (!entries.length) return [];
  let realCwd;
  let realProjectRoot;
  try {
    [realCwd, realProjectRoot] = await Promise.all([fs.realpath(cwd), fs.realpath(projectRoot)]);
  } catch {
    throw inputError("Claude 工程目录不存在");
  }
  if (!pathWithin(realProjectRoot, realCwd)) throw inputError("Claude 工程目录超出账号范围");
  const resolved = [];
  for (const entry of entries) {
    const requested = path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(realCwd, entry);
    if (!pathWithin(realCwd, requested)) throw inputError("Claude 会话插件必须位于当前工程内");
    let stat;
    let realPath;
    try {
      [stat, realPath] = await Promise.all([fs.lstat(requested), fs.realpath(requested)]);
    } catch {
      throw inputError("Claude 会话插件路径不存在或不可访问");
    }
    if (stat.isSymbolicLink() || !pathWithin(realCwd, realPath)) {
      throw inputError("Claude 会话插件不能使用符号链接或工程外路径");
    }
    if (stat.isDirectory()) await validatePluginDirectory(realPath);
    else if (stat.isFile() && realPath.toLowerCase().endsWith(".zip")) {
      if (stat.size <= 0 || stat.size > MAX_PLUGIN_ARCHIVE_BYTES) {
        throw inputError("Claude 会话插件 ZIP 必须小于 50 MiB");
      }
      assertSafeClaudePluginArchive(await fs.readFile(realPath));
    } else {
      throw inputError("Claude 会话插件必须是目录或 .zip 文件");
    }
    if (!resolved.includes(realPath)) resolved.push(realPath);
  }
  return resolved;
}

export async function materializeClaudePluginUrls(urls, {
  directory,
  uid = null,
  gid = null,
  downloader = downloadClaudePluginUrl,
} = {}) {
  const normalized = normalizeClaudePluginUrls(urls, { strict: true });
  if (!normalized.length) return [];
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  if (Number.isInteger(uid) && Number.isInteger(gid)) await fs.chown(directory, uid, gid);
  const paths = [];
  for (const url of normalized) {
    const target = path.join(directory, `${crypto.createHash("sha256").update(url).digest("hex")}.zip`);
    let usable = false;
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_PLUGIN_ARCHIVE_BYTES) {
        throw new Error("unsafe cache");
      }
      assertSafeClaudePluginArchive(await fs.readFile(target));
      usable = true;
    } catch (error) {
      if (error?.code !== "ENOENT") await fs.rm(target, { force: true }).catch(() => {});
    }
    if (!usable) {
      const downloaded = await downloader(url, { maxBytes: MAX_PLUGIN_ARCHIVE_BYTES });
      const buffer = Buffer.isBuffer(downloaded) ? downloaded : downloaded?.buffer;
      if (!Buffer.isBuffer(buffer) || buffer.length <= 0 || buffer.length > MAX_PLUGIN_ARCHIVE_BYTES) {
        throw inputError("Claude URL 插件下载结果无效或超过 50 MiB");
      }
      assertSafeClaudePluginArchive(buffer);
      const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(temporary, buffer, { mode: 0o600, flag: "wx" });
      try {
        if (Number.isInteger(uid) && Number.isInteger(gid)) await fs.chown(temporary, uid, gid);
        await fs.rename(temporary, target);
        await fs.chmod(target, 0o600);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    }
    paths.push(target);
  }
  return paths;
}

export async function downloadClaudePluginUrl(rawUrl, { maxBytes = MAX_PLUGIN_ARCHIVE_BYTES } = {}) {
  let current = normalizePublicPluginUrl(rawUrl);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const url = new URL(current);
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw inputError("Claude URL 插件域名解析到了本地或私有网络");
    }
    const response = await requestPinned(url, addresses[0], maxBytes);
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      if (!response.location || redirect === 3) throw inputError("Claude URL 插件重定向无效或过多");
      current = normalizePublicPluginUrl(new URL(response.location, url).toString());
      continue;
    }
    if (response.statusCode !== 200) throw inputError(`Claude URL 插件下载失败（HTTP ${response.statusCode}）`);
    return response.buffer;
  }
  throw inputError("Claude URL 插件下载失败");
}

export function assertSafeClaudePluginArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_PLUGIN_ARCHIVE_BYTES) {
    throw inputError("Claude 会话插件 ZIP 无效或超过 50 MiB");
  }
  const eocd = findEndOfCentralDirectory(buffer);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (
    entries <= 0
    || entries > MAX_PLUGIN_ENTRIES
    || centralOffset + centralSize > eocd
    || centralOffset + centralSize > buffer.length
  ) throw inputError("Claude 会话插件 ZIP 目录无效或条目过多");
  let offset = centralOffset;
  let expandedBytes = 0;
  let manifestFound = false;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw inputError("Claude 会话插件 ZIP 中央目录损坏");
    }
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (!nameLength || end > buffer.length) throw inputError("Claude 会话插件 ZIP 条目无效");
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    validateArchiveEntryName(name);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) throw inputError("Claude 会话插件 ZIP 不能包含符号链接");
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_PLUGIN_EXPANDED_BYTES) {
      throw inputError("Claude 会话插件 ZIP 解压后不能超过 200 MiB");
    }
    if (name === PLUGIN_MANIFEST) manifestFound = true;
    offset = end;
  }
  if (offset !== centralOffset + centralSize || !manifestFound) {
    throw inputError("Claude 会话插件 ZIP 缺少根目录 .claude-plugin/plugin.json");
  }
  return true;
}

function normalizeStringList(entries, { maximum, strict, label, validate }) {
  const fail = (message) => {
    if (strict) throw inputError(message);
    return [];
  };
  if (!entries || entries.length > maximum) return fail(`${label}最多 ${maximum} 个`);
  const output = [];
  for (const raw of entries) {
    const entry = typeof raw === "string" ? raw.trim() : "";
    if (!entry) continue;
    if (!validate(entry)) return fail(`${label}包含无效值`);
    if (!output.includes(entry)) output.push(entry);
  }
  return output;
}

function normalizePublicPluginUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw inputError("Claude URL 插件必须使用无凭据的公开 HTTPS .zip 地址");
  }
  if (
    url.toString().length > MAX_PLUGIN_URL_LENGTH
    || url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || !url.pathname.toLowerCase().endsWith(".zip")
    || !isPublicHostname(url.hostname)
  ) throw inputError("Claude URL 插件必须使用无凭据、无查询参数的公开 HTTPS .zip 地址");
  return url.toString();
}

async function validatePluginDirectory(root) {
  const manifestPath = path.join(root, PLUGIN_MANIFEST);
  let manifestStat;
  try {
    manifestStat = await fs.lstat(manifestPath);
  } catch {
    throw inputError("Claude 会话插件目录缺少 .claude-plugin/plugin.json");
  }
  if (
    !manifestStat.isFile()
    || manifestStat.isSymbolicLink()
    || manifestStat.size <= 0
    || manifestStat.size > MAX_PLUGIN_MANIFEST_BYTES
  ) throw inputError("Claude 会话插件 manifest 无效");
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (
      !manifest
      || typeof manifest !== "object"
      || Array.isArray(manifest)
      || typeof manifest.name !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.name)
    ) throw new Error("manifest");
  } catch {
    throw inputError("Claude 会话插件 manifest 不是有效 JSON 或缺少安全名称");
  }
  let entries = 0;
  let totalBytes = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > MAX_PLUGIN_ENTRIES) throw inputError("Claude 会话插件目录条目过多");
      const childPath = path.join(directory, child.name);
      const stat = await fs.lstat(childPath);
      if (stat.isSymbolicLink()) throw inputError("Claude 会话插件目录不能包含符号链接");
      if (stat.isDirectory()) pending.push(childPath);
      else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > MAX_PLUGIN_EXPANDED_BYTES) {
          throw inputError("Claude 会话插件目录不能超过 200 MiB");
        }
      } else {
        throw inputError("Claude 会话插件目录包含不支持的文件类型");
      }
    }
  }
}

function validateArchiveEntryName(name) {
  if (
    !name
    || name.length > 1_024
    || /[\0\r\n\\]/.test(name)
    || name.startsWith("/")
    || /^[A-Za-z]:/.test(name)
  ) throw inputError("Claude 会话插件 ZIP 包含不安全路径");
  const segments = name.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    throw inputError("Claude 会话插件 ZIP 包含越界路径");
  }
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      if (buffer.readUInt16LE(offset + 4) !== 0 || buffer.readUInt16LE(offset + 6) !== 0) {
        throw inputError("Claude 会话插件不支持分卷 ZIP");
      }
      if (
        buffer.readUInt16LE(offset + 8) === 0xffff
        || buffer.readUInt16LE(offset + 10) === 0xffff
        || buffer.readUInt32LE(offset + 12) === 0xffffffff
        || buffer.readUInt32LE(offset + 16) === 0xffffffff
      ) throw inputError("Claude 会话插件暂不支持 ZIP64");
      return offset;
    }
  }
  throw inputError("Claude 会话插件不是有效 ZIP");
}

function requestPinned(url, address, maxBytes) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      headers: {
        Accept: "application/zip, application/octet-stream;q=0.9",
        "Accept-Encoding": "identity",
        "User-Agent": "WFL-Codex-Desktop/Claude-Plugin-Validator",
      },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    }, (response) => {
      const statusCode = Number(response.statusCode) || 0;
      const location = response.headers.location || null;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        response.resume();
        resolve({ statusCode, location, buffer: null });
        return;
      }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        reject(inputError("Claude URL 插件超过 50 MiB"));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(inputError("Claude URL 插件超过 50 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ statusCode, location, buffer: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.setTimeout(20_000, () => request.destroy(inputError("Claude URL 插件下载超时")));
    request.on("error", (error) => reject(
      error?.status ? error : inputError("Claude URL 插件下载连接失败"),
    ));
    request.end();
  });
}

function isPublicHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (
    !normalized
    || normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
    || (!normalized.includes(".") && !net.isIP(normalized))
  ) return false;
  return !net.isIP(normalized) || isPublicAddress(normalized);
}

function isPublicAddress(address) {
  const normalized = String(address || "").toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const version = net.isIP(normalized);
  if (version === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return first >= 1
      && first <= 223
      && first !== 10
      && first !== 127
      && !(first === 100 && second >= 64 && second <= 127)
      && !(first === 169 && second === 254)
      && !(first === 172 && second >= 16 && second <= 31)
      && !(first === 192 && second === 168)
      && !(first === 198 && (second === 18 || second === 19));
  }
  if (version === 6) {
    return normalized !== "::"
      && normalized !== "::1"
      && !/^f[cd]/.test(normalized)
      && !/^fe[89ab]/.test(normalized);
  }
  return false;
}

function pathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
