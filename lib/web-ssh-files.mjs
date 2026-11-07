import crypto from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export class WebSshFiles {
  constructor(client) {
    this.client = client;
    this.operations = new Set();
    this.closed = false;
  }

  async run(operation, { signal } = {}) {
    if (this.closed) throw fileError(410, "SSH 会话已关闭，请重新连接");
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.operations.add(controller);
    let sftp;
    const failed = () => controller.abort(fileError(502, "文件传输通道中断，终端连接不受影响"));
    try {
      sftp = await openSftp(this.client, controller.signal);
      sftp.on("error", failed);
      sftp.once("close", failed);
      return await operation(new SftpFiles(sftp, controller.signal));
    } catch (error) {
      throw controller.signal.aborted ? canceled(controller.signal) : publicFileError(error);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.operations.delete(controller);
      sftp?.removeListener("close", failed);
      sftp?.end();
    }
  }

  close() {
    this.closed = true;
    for (const controller of this.operations) controller.abort(fileError(410, "SSH 会话已关闭"));
  }
}

class SftpFiles {
  constructor(sftp, signal) { this.sftp = sftp; this.signal = signal; }

  async list(value = ".") {
    const directory = await this.call("realpath", remotePath(value));
    const entries = await this.call("readdir", directory);
    return {
      path: directory, parent: path.posix.dirname(directory),
      entries: entries.filter((entry) => ![".", ".."].includes(entry.filename)).map((entry) => ({
        name: entry.filename, path: path.posix.join(directory, entry.filename),
        kind: entry.attrs.isDirectory() ? "directory" : entry.attrs.isFile() ? "file"
          : entry.attrs.isSymbolicLink() ? "link" : "other",
        size: entry.attrs.size, modifiedAt: entry.attrs.mtime * 1000,
      })).sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory")
        || a.name.localeCompare(b.name)),
    };
  }

  async upload(value, input, { overwrite = false } = {}) {
    const requested = remotePath(value);
    const name = path.posix.basename(requested);
    if ([".", "..", "/"].includes(name)) throw fileError(400, "请指定上传文件名");
    const directory = await this.call("realpath", path.posix.dirname(requested));
    const destination = path.posix.join(directory, name);
    const existing = await this.statIfPresent(destination);
    if (existing?.isDirectory()) throw fileError(409, "目标是目录，请指定一个文件名");
    if (existing && !overwrite) throw fileError(409, "文件已存在；如需覆盖，请先勾选允许覆盖");
    const temporary = path.posix.join(directory, `.wfl-upload-${crypto.randomBytes(16).toString("hex")}.tmp`);
    let created = false;
    let committed = false;
    let bytes = 0;
    const handle = await this.openUpload(temporary, existing ? existing.mode & 0o777 : 0o666);
    created = true;
    const output = this.sftp.createWriteStream(temporary, { handle });
    const count = (chunk) => { bytes += chunk.length; };
    input.on("data", count);
    try {
      await pipeline(input, output, { signal: this.signal });
      if (!overwrite && await this.statIfPresent(destination)) throw fileError(409, "目标文件已出现，未覆盖；请刷新目录");
      if (overwrite) {
        try {
          await this.call("ext_openssh_rename", temporary, destination);
        } catch (error) {
          if (error.code !== 8) throw error;
          await this.call("rename", temporary, destination);
        }
      } else await this.call("rename", temporary, destination);
      committed = true;
      return { uploaded: true, path: destination, size: bytes };
    } finally {
      input.removeListener("data", count);
      if (created && !committed) await removeTemporary(this.sftp, temporary);
    }
  }

  async download(value, output, prepare) {
    const remote = remotePath(value);
    const description = await this.describe(remote);
    const input = this.sftp.createReadStream(remote);
    prepare(description);
    await pipeline(input, output, { signal: this.signal });
  }

  async describe(value) {
    const remote = remotePath(value);
    const attrs = await this.call("stat", remote);
    if (!attrs.isFile()) throw fileError(400, "请选择文件下载，目录不能直接下载");
    return { name: path.posix.basename(remote), size: attrs.size };
  }

  async statIfPresent(remote) {
    try { return await this.call("lstat", remote); }
    catch (error) { if (error.code === 2) return null; throw error; }
  }

  openUpload(temporary, mode) {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) { reject(canceled(this.signal)); return; }
      let timer;
      const abort = () => {
        timer = setTimeout(() => { this.sftp.end(); reject(canceled(this.signal)); }, 2_000);
        timer.unref();
      };
      this.signal.addEventListener("abort", abort, { once: true });
      const done = async (error, handle) => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", abort);
        if (error) { reject(error); return; }
        if (this.signal.aborted) {
          await removeTemporary(this.sftp, temporary);
          try { this.sftp.close(handle, () => {}); } catch {}
          reject(canceled(this.signal));
        } else resolve(handle);
      };
      try { this.sftp.open(temporary, "wx", mode, done); }
      catch (error) { void done(error); }
    });
  }

  call(method, ...args) {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) { reject(canceled(this.signal)); return; }
      const abort = () => reject(canceled(this.signal));
      this.signal.addEventListener("abort", abort, { once: true });
      const done = (error, result) => {
        this.signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result);
      };
      try { this.sftp[method](...args, done); }
      catch (error) {
        if (error.message === "Server does not support this extended request") error.code = 8;
        done(error);
      }
    });
  }
}

function openSftp(client, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(canceled(signal)); return; }
    const abort = () => reject(canceled(signal));
    signal.addEventListener("abort", abort, { once: true });
    try {
      client.sftp((error, sftp) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) { sftp?.on("error", () => {}); sftp?.end(); reject(canceled(signal)); }
        else if (error) reject(error);
        else resolve(sftp);
      });
    } catch (error) { signal.removeEventListener("abort", abort); reject(error); }
  });
}

function removeTemporary(sftp, temporary) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    timer.unref();
    try { sftp.unlink(temporary, () => { clearTimeout(timer); resolve(); }); }
    catch { clearTimeout(timer); resolve(); }
  });
}

function remotePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) throw fileError(400, "远程文件路径无效");
  return value;
}

function canceled(signal) {
  return signal.reason?.statusCode ? signal.reason : fileError(499, "文件传输已取消，终端连接不受影响");
}

function publicFileError(error) {
  if (error.statusCode) return error;
  if (error.code === 2) return fileError(404, "远程文件或目录不存在");
  if (error.code === 3) return fileError(403, "SSH 账号没有访问此文件或目录的权限");
  if (error.code === 8) return fileError(424, "服务器不支持此文件操作，终端连接不受影响");
  return fileError(502, "远程文件操作失败，请检查目录、权限及服务器 SFTP 支持；终端连接不受影响");
}

function fileError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
