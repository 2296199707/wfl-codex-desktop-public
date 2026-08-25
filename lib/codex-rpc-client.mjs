import { spawn } from "node:child_process";

export class CodexRpcClient {
  constructor({
    command = process.env.CODEX_DESKTOP_CODEX_BIN || "codex",
    cwd = process.cwd(),
    environment = process.env,
    clientVersion = "installer",
    clientName = "wfl-codex-desktop-installer",
    clientTitle = "WFL Codex Desktop Installer",
    requestTimeoutMs = 30_000,
  } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.environment = environment;
    this.clientVersion = clientVersion;
    this.clientName = clientName;
    this.clientTitle = clientTitle;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.exitPromise = null;
  }

  async start() {
    if (this.child) return;
    const child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: this.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stderr.resume();
    child.stdin.on("error", (error) => this.handleExit(error, child));
    this.exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.handleExit(new Error(`Codex app-server exited (${code ?? signal})`), child);
        resolve();
      });
      child.once("error", (error) => {
        this.handleExit(error, child);
        resolve();
      });
    });
    await this.request("initialize", {
      clientInfo: {
        name: this.clientName,
        title: this.clientTitle,
        version: this.clientVersion,
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
        requestAttestation: false,
      },
    });
    this.write({ method: "initialized" });
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  async close() {
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    let timeout;
    await Promise.race([
      this.exitPromise,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, 3_000);
      }),
    ]);
    clearTimeout(timeout);
    if (this.child === child) {
      child.kill("SIGKILL");
      this.handleExit(new Error("Codex app-server close timed out"), child);
    }
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleMessage(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  handleMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Codex RPC request failed"));
      else pending.resolve(message.result);
    } else if (message.method && Object.hasOwn(message, "id")) {
      this.write({ id: message.id, error: { code: -32601, message: "Installer does not support server requests" } });
    }
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is offline");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleExit(error, expectedChild = this.child) {
    if (!this.child || this.child !== expectedChild) return;
    this.child = null;
    this.buffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
