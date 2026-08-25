import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { WindowsHostAgent } from "./agent.mjs";
import {
  defaultConfigPath,
  normalizeServerUrl,
  publicHostConfig,
  readHostConfig,
  writeHostConfig,
} from "./config.mjs";

const command = process.argv[2] || "status";
const configPath = option("--config") || defaultConfigPath();

if (command === "pair") await pair();
else if (command === "start") await start();
else if (command === "status") await status();
else {
  process.stderr.write("Usage: node src/main.mjs <pair|start|status> [--config PATH]\n");
  process.exitCode = 2;
}

async function pair() {
  const prompt = readline.createInterface({ input, output });
  try {
    const serverUrl = normalizeServerUrl(option("--server") || await prompt.question("WFL HTTPS address: "));
    const code = String(option("--code") || await prompt.question("One-time pairing code: ")).trim().toUpperCase();
    const workspaceInput = option("--workspace") || await prompt.question("Creator workspace (absolute path): ");
    if (!workspaceInput.trim() || !path.isAbsolute(workspaceInput.trim())) {
      throw new Error("Creator workspace must be an explicit absolute path");
    }
    const workspaceRoot = await fs.realpath(path.resolve(workspaceInput.trim()));
    const projectInput = option("--project") || await prompt.question(`Codex project (Enter for ${workspaceRoot}): `);
    const projectPath = await fs.realpath(path.resolve(projectInput.trim() || workspaceRoot));
    const deviceName = option("--name") || os.hostname();
    const response = await fetch(`${serverUrl}/api/windows-host/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        name: deviceName,
        platform: "windows",
        agentVersion: "0.1.0",
        protocolVersion: 1,
      }),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `Pairing failed with HTTP ${response.status}`);
    await writeHostConfig({
      version: 1,
      serverUrl,
      deviceId: value.device.id,
      token: value.token,
      deviceName,
      workspaceRoot,
      projects: [{ id: "default", name: path.basename(projectPath), path: projectPath }],
    }, configPath);
    process.stdout.write(`Paired ${deviceName}. Config: ${configPath}\n`);
  } finally {
    prompt.close();
  }
}

async function start() {
  const config = await readHostConfig(configPath);
  const agent = await new WindowsHostAgent(config).initialize();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await agent.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  agent.start();
  process.stdout.write(`WFL Windows Host ${config.deviceName} started (outbound only). Press Ctrl+C to stop.\n`);
}

async function status() {
  try {
    const config = await readHostConfig(configPath);
    process.stdout.write(`${JSON.stringify(publicHostConfig(config), null, 2)}\n`);
  } catch (error) {
    if (error.code === "ENOENT") {
      process.stdout.write(`Not paired. Run: node src/main.mjs pair\nConfig: ${configPath}\n`);
      return;
    }
    throw error;
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
