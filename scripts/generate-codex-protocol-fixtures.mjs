import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexProtocolCompatibility } from "../lib/codex-compatibility.mjs";
import { CODEX_PROTOCOL_BASELINE } from "../lib/codex-protocol-coverage.mjs";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureDirectory = path.join(projectDirectory, "test", "fixtures");
const arguments_ = process.argv.slice(2);
const checkOnly = arguments_.includes("--check");
if (arguments_.some((argument) => argument !== "--check") || new Set(arguments_).size !== arguments_.length) {
  throw new Error("Usage: node scripts/generate-codex-protocol-fixtures.mjs [--check]");
}

const baseline = (await capture("codex", ["--version"])).trim();
const version = baseline.match(/^codex-cli (\d+\.\d+\.\d+)$/)?.[1];
if (!version) throw new Error(`Unsupported Codex version string: ${baseline}`);
const reviewedVersion = CODEX_PROTOCOL_BASELINE.match(/^codex-cli (\d+\.\d+\.\d+)$/)?.[1];
if (!reviewedVersion) throw new Error(`Invalid reviewed Codex baseline: ${CODEX_PROTOCOL_BASELINE}`);

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-protocol-"));
try {
  const stableDirectory = path.join(temporaryDirectory, "stable");
  const experimentalDirectory = path.join(temporaryDirectory, "experimental");
  const stableTypeScriptDirectory = path.join(temporaryDirectory, "stable-typescript");
  const experimentalTypeScriptDirectory = path.join(temporaryDirectory, "experimental-typescript");
  await Promise.all([
    fs.mkdir(stableDirectory),
    fs.mkdir(experimentalDirectory),
    fs.mkdir(stableTypeScriptDirectory),
    fs.mkdir(experimentalTypeScriptDirectory),
  ]);
  await Promise.all([
    run("codex", ["app-server", "generate-json-schema", "--out", stableDirectory]),
    run("codex", [
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      experimentalDirectory,
    ]),
    run("codex", ["app-server", "generate-ts", "--out", stableTypeScriptDirectory]),
    run("codex", [
      "app-server",
      "generate-ts",
      "--experimental",
      "--out",
      experimentalTypeScriptDirectory,
    ]),
  ]);

  const [stable, experimental, stableTypeScript, experimentalTypeScript] = await Promise.all([
    protocolSurface(stableDirectory),
    protocolSurface(experimentalDirectory),
    typeScriptSurface(stableTypeScriptDirectory),
    typeScriptSurface(experimentalTypeScriptDirectory),
  ]);
  const prefix = `codex-app-server-${version}`;
  const schemaManifestName = `${prefix}-schema-manifest.json`;
  const generatedAt = checkOnly && version === reviewedVersion
    ? await existingGeneratedAt(path.join(fixtureDirectory, schemaManifestName))
    : new Date().toISOString();
  const fixtures = new Map([
    [`${prefix}-client-methods.json`, {
      baseline,
      command: "codex app-server generate-ts --experimental",
      stableMethods: stableTypeScript.clientRequests,
      methods: experimentalTypeScript.clientRequests,
      v2StableMethods: stable.clientRequests,
      v2ExperimentalMethods: experimental.clientRequests,
      legacyMethods: experimentalTypeScript.clientRequests.filter(
        (method) => !experimental.clientRequests.includes(method),
      ),
    }],
    [`${prefix}-server-methods.json`, {
      baseline,
      command: "codex app-server generate-ts --experimental",
      stableMethods: stableTypeScript.serverRequests,
      methods: experimentalTypeScript.serverRequests,
      v2StableMethods: stable.serverRequests,
      v2ExperimentalMethods: experimental.serverRequests,
    }],
    [`${prefix}-notifications.json`, {
      baseline,
      command: "codex app-server generate-ts --experimental",
      stable: {
        client: stableTypeScript.clientNotifications,
        server: stableTypeScript.serverNotifications,
      },
      experimental: {
        client: experimentalTypeScript.clientNotifications,
        server: experimentalTypeScript.serverNotifications,
      },
      v2Stable: {
        client: stable.clientNotifications,
        server: stable.serverNotifications,
      },
      v2Experimental: {
        client: experimental.clientNotifications,
        server: experimental.serverNotifications,
      },
      legacyServer: experimentalTypeScript.serverNotifications.filter(
        (method) => !experimental.serverNotifications.includes(method),
      ),
    }],
    [schemaManifestName, {
      baseline,
      generatedAt,
      commands: {
        stable: "codex app-server generate-json-schema --out <dir>",
        experimental: "codex app-server generate-json-schema --experimental --out <dir>",
      },
      stable: {
        counts: surfaceCounts(stable),
        sha256: stable.sha256,
      },
      experimental: {
        counts: surfaceCounts(experimental),
        sha256: experimental.sha256,
      },
      typescript: {
        stable: {
          counts: stableTypeScript.counts,
          sha256: stableTypeScript.sha256,
        },
        experimental: {
          counts: experimentalTypeScript.counts,
          sha256: experimentalTypeScript.sha256,
        },
      },
    }],
  ]);

  if (checkOnly && version !== reviewedVersion) {
    await checkFutureProtocolSurface({
      installedVersion: baseline,
      reviewedVersion,
      clientRequests: experimentalTypeScript.clientRequests,
      serverRequests: experimentalTypeScript.serverRequests,
      clientNotifications: experimentalTypeScript.clientNotifications,
      serverNotifications: experimentalTypeScript.serverNotifications,
    });
    console.log(
      `Codex protocol surface is capability-compatible with ${CODEX_PROTOCOL_BASELINE}; installed ${baseline}`,
    );
  } else {
    for (const [name, value] of fixtures) {
      const target = path.join(fixtureDirectory, name);
      const content = `${JSON.stringify(value, null, 2)}\n`;
      if (!checkOnly) {
        await fs.writeFile(target, content);
        continue;
      }
      const current = await fs.readFile(target, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current !== content) {
        throw new Error(
          `Codex protocol fixture drift detected for ${name}; run npm run protocol:generate`,
        );
      }
    }
    console.log(
      checkOnly
        ? `Codex protocol fixtures match ${baseline}`
        : `Generated Codex protocol fixtures for ${baseline}`,
    );
  }
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

async function checkFutureProtocolSurface({
  installedVersion,
  reviewedVersion,
  clientRequests,
  serverRequests,
  clientNotifications,
  serverNotifications,
}) {
  const [client, server, notifications, manifest] = await Promise.all([
    readJson(path.join(fixtureDirectory, `codex-app-server-${reviewedVersion}-client-methods.json`)),
    readJson(path.join(fixtureDirectory, `codex-app-server-${reviewedVersion}-server-methods.json`)),
    readJson(path.join(fixtureDirectory, `codex-app-server-${reviewedVersion}-notifications.json`)),
    readJson(path.join(fixtureDirectory, `codex-app-server-${reviewedVersion}-schema-manifest.json`)),
  ]);
  const snapshot = buildCodexProtocolCompatibility({
    installedVersion,
    reviewedSurface: {
      clientRequests: client.methods,
      serverRequests: server.methods,
      clientNotifications: notifications.experimental?.client,
      serverNotifications: notifications.experimental?.server,
    },
    detectedSurface: {
      clientRequests,
      serverRequests,
      clientNotifications,
      serverNotifications,
    },
    generatedAt: manifest.generatedAt,
  });
  if (!snapshot.activationAllowed) {
    const detail = snapshot.criticalIssues
      .slice(0, 8)
      .map((item) => `${item.feature}: ${item.method}`)
      .join("; ");
    throw new Error(`Codex protocol core capability check failed for ${installedVersion}: ${detail}`);
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function existingGeneratedAt(file) {
  const current = await fs.readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!current) {
    throw new Error("Codex protocol schema manifest is missing; run npm run protocol:generate");
  }
  const value = JSON.parse(current).generatedAt;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Codex protocol schema manifest generation time is missing; run npm run protocol:generate");
  }
  return new Date(value).toISOString();
}

async function typeScriptSurface(directory) {
  const [clientRequests, serverRequests, clientNotifications, serverNotifications] = await Promise.all([
    methodsFromTypeScript(directory, "ClientRequest.ts"),
    methodsFromTypeScript(directory, "ServerRequest.ts"),
    methodsFromTypeScript(directory, "ClientNotification.ts"),
    methodsFromTypeScript(directory, "ServerNotification.ts"),
  ]);
  return {
    counts: {
      clientRequests: clientRequests.length,
      serverRequests: serverRequests.length,
      clientNotifications: clientNotifications.length,
      serverNotifications: serverNotifications.length,
    },
    sha256: Object.fromEntries(await Promise.all(
      ["ClientRequest.ts", "ServerRequest.ts", "ClientNotification.ts", "ServerNotification.ts"]
        .map(async (name) => [
          name,
          crypto.createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex"),
        ]),
    )),
    clientRequests,
    serverRequests,
    clientNotifications,
    serverNotifications,
  };
}

async function methodsFromTypeScript(directory, name) {
  const source = await fs.readFile(path.join(directory, name), "utf8");
  const methods = [...source.matchAll(/"method": "([^"]+)"/g)].map((match) => match[1]);
  if (!methods.length) throw new Error(`${name} contains no protocol methods`);
  const unique = [...new Set(methods)].sort((left, right) => left.localeCompare(right, "en"));
  if (unique.length !== methods.length) throw new Error(`${name} contains duplicate protocol methods`);
  return unique;
}

async function protocolSurface(directory) {
  const [
    clientRequests,
    serverRequests,
    clientNotifications,
    serverNotifications,
  ] = await Promise.all([
    methodsFromSchema(directory, "ClientRequest.json"),
    methodsFromSchema(directory, "ServerRequest.json"),
    methodsFromSchema(directory, "ClientNotification.json"),
    methodsFromSchema(directory, "ServerNotification.json"),
  ]);
  const hashNames = [
    "ClientRequest.json",
    "ServerRequest.json",
    "ClientNotification.json",
    "ServerNotification.json",
    "codex_app_server_protocol.schemas.json",
    "codex_app_server_protocol.v2.schemas.json",
  ];
  const hashes = await Promise.all(hashNames.map(async (name) => [
    name,
    crypto.createHash("sha256")
      .update(canonicalJson(JSON.parse(await fs.readFile(path.join(directory, name), "utf8"))))
      .digest("hex"),
  ]));
  return {
    clientRequests,
    serverRequests,
    clientNotifications,
    serverNotifications,
    sha256: Object.fromEntries(hashes),
  };
}

async function methodsFromSchema(directory, name) {
  const schema = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
  const methods = schema.oneOf?.flatMap((entry) => entry?.properties?.method?.enum || []) || [];
  if (!methods.length) throw new Error(`${name} contains no protocol methods`);
  const unique = [...new Set(methods)].sort((left, right) => left.localeCompare(right, "en"));
  if (unique.length !== methods.length) throw new Error(`${name} contains duplicate protocol methods`);
  return unique;
}

function surfaceCounts(surface) {
  return {
    clientRequests: surface.clientRequests.length,
    serverRequests: surface.serverRequests.length,
    clientNotifications: surface.clientNotifications.length,
    serverNotifications: surface.serverNotifications.length,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: projectDirectory,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let standardError = "";
    child.stderr.on("data", (chunk) => { standardError += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(standardError.trim() || `${command} exited with status ${code}`));
    });
  });
}

function capture(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: projectDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let standardOutput = "";
    let standardError = "";
    child.stdout.on("data", (chunk) => { standardOutput += chunk; });
    child.stderr.on("data", (chunk) => { standardError += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(standardOutput);
      else reject(new Error(standardError.trim() || `${command} exited with status ${code}`));
    });
  });
}
