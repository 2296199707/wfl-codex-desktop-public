import fs from "node:fs";

const statePath = process.env.FAKE_CODEX_CONFIG_PATH;
const initial = {
  model_provider: process.env.FAKE_CODEX_INITIAL_PROVIDER || "openai",
  model_providers: {},
};
if (process.env.FAKE_CODEX_INITIAL_MODEL !== "unset") {
  initial.model = process.env.FAKE_CODEX_INITIAL_MODEL || "gpt-original";
}
let config = readState();

readRequests();

function readRequests() {
  const chunk = Buffer.allocUnsafe(4096);
  let buffered = "";
  while (true) {
    const bytesRead = fs.readSync(0, chunk, 0, chunk.length, null);
    if (bytesRead === 0) return;
    buffered += chunk.toString("utf8", 0, bytesRead);
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      handleRequest(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
}

function handleRequest(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!Object.hasOwn(request, "id")) return;
  try {
    write({ id: request.id, result: responseFor(request.method, request.params || {}) });
  } catch (error) {
    write({ id: request.id, error: { code: -32000, message: error.message } });
  }
}

function responseFor(method, params) {
  if (method === "initialize") return { userAgent: "fake-config-codex" };
  if (method === "config/read") return { config, layers: [] };
  if (method === "config/batchWrite") {
    for (const edit of params.edits || []) applyEdit(edit.keyPath, edit.value);
    fs.writeFileSync(statePath, `${JSON.stringify(config, null, 2)}\n`);
    return { status: "ok" };
  }
  if (method === "thread/list") {
    if (process.env.FAKE_CODEX_FAIL_THREAD === "1") throw new Error("fake thread readiness failure");
    if (process.env.CODEX_DESKTOP_PROVIDER_KEY !== process.env.FAKE_EXPECTED_PROVIDER_KEY) {
      throw new Error("provider key was not supplied to Codex");
    }
    return { data: [], nextCursor: null };
  }
  throw new Error(`Unsupported fake method: ${method}`);
}

function applyEdit(keyPath, value) {
  if (keyPath.startsWith("model_providers.")) {
    config.model_providers ||= {};
    config.model_providers[keyPath.slice("model_providers.".length)] = value;
  } else {
    config[keyPath] = value;
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(initial);
    throw error;
  }
}

function write(message) {
  fs.writeSync(1, `${JSON.stringify(message)}\n`);
}
