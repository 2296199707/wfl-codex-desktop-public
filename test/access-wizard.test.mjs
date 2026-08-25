import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const accessScript = path.join(projectDir, "scripts", "configure-access.sh");
const accessSource = await fs.readFile(accessScript, "utf8");

test("local access changes no network services and records only non-secret metadata", async () => {
  const fixture = await createFixture();
  const result = await runAccess(fixture, ["--mode", "local", "--non-interactive"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /127\.0\.0\.1:4317/);
  assert.equal(await fs.readFile(fixture.commandLog, "utf8"), "");
  const state = await readState(fixture.stateFile);
  assert.deepEqual(
    { mode: state.mode, hostname: state.hostname, managedBy: state.managedBy },
    { mode: "local", hostname: null, managedBy: "none" },
  );
  assert.equal((await fs.stat(fixture.stateFile)).mode & 0o777, 0o600);
});

test("managed domain mode writes an isolated WebSocket proxy and validates before reload", async () => {
  const fixture = await createFixture();
  await addStub(fixture, "nginx", 'printf "nginx %s\\n" "$*" >>"$WFL_STUB_LOG"\n');
  await addStub(fixture, "certbot", 'printf "certbot %s\\n" "$*" >>"$WFL_STUB_LOG"\n');
  await addStub(fixture, "systemctl", 'printf "systemctl %s\\n" "$*" >>"$WFL_STUB_LOG"\n');

  const result = await runAccess(fixture, [
    "--mode", "existing-domain",
    "--hostname", "codex.example.com",
    "--reverse-proxy", "nginx",
    "--email", "admin@example.com",
    "--non-interactive",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const nginx = await fs.readFile(
    path.join(fixture.etcDir, "nginx", "sites-available", "wfl-codex-desktop.conf"),
    "utf8",
  );
  assert.match(nginx, /server_name codex\.example\.com;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:4317;/);
  assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade;/);
  const commands = await fs.readFile(fixture.commandLog, "utf8");
  assert.ok(commands.indexOf("nginx -t") < commands.indexOf("systemctl reload nginx"));
  assert.match(commands, /certbot .*--redirect.*-d codex\.example\.com/);
  const state = await readState(fixture.stateFile);
  assert.equal(state.managedBy, "nginx-certbot");
});

test("preview origin pool is opt-in and included in the same Nginx certificate", async () => {
  const fixture = await createFixture();
  await addStub(fixture, "nginx", 'printf "nginx %s\\n" "$*" >>"$WFL_STUB_LOG"\n');
  await addStub(fixture, "certbot", 'printf "certbot %s\\n" "$*" >>"$WFL_STUB_LOG"\n');
  await addStub(fixture, "systemctl", 'printf "systemctl %s\\n" "$*" >>"$WFL_STUB_LOG"\n');
  const result = await runAccess(fixture, [
    "--mode", "existing-domain",
    "--hostname", "codex.example.com",
    "--reverse-proxy", "nginx",
    "--email", "admin@example.com",
    "--preview-base-domain", "codex.example.com",
    "--preview-slots", "2",
    "--non-interactive",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const nginx = await fs.readFile(
    path.join(fixture.etcDir, "nginx", "sites-available", "wfl-codex-desktop.conf"),
    "utf8",
  );
  assert.match(nginx, /server_name codex\.example\.com preview-1\.codex\.example\.com preview-2\.codex\.example\.com;/);
  const commands = await fs.readFile(fixture.commandLog, "utf8");
  assert.match(commands, /certbot .* -d codex\.example\.com -d preview-1\.codex\.example\.com -d preview-2\.codex\.example\.com/);
  const state = await readState(fixture.stateFile);
  assert.equal(state.previewBaseDomain, "codex.example.com");
  assert.equal(state.previewSlotCount, 2);
});

test("managed domain mode refuses a same-name Nginx link owned by another site", async () => {
  const fixture = await createFixture();
  await addStub(fixture, "nginx", 'printf "nginx %s\\n" "$*" >>"$WFL_STUB_LOG"\n');
  await addStub(fixture, "certbot", 'printf "certbot %s\\n" "$*" >>"$WFL_STUB_LOG"\n');
  const available = path.join(fixture.etcDir, "nginx", "sites-available");
  const enabled = path.join(fixture.etcDir, "nginx", "sites-enabled");
  const foreign = path.join(available, "foreign.conf");
  await Promise.all([
    fs.mkdir(available, { recursive: true }),
    fs.mkdir(enabled, { recursive: true }),
  ]);
  await fs.writeFile(foreign, "server {}\n");
  await fs.symlink(foreign, path.join(enabled, "wfl-codex-desktop.conf"));

  const result = await runAccess(fixture, [
    "--mode", "existing-domain",
    "--hostname", "codex.example.com",
    "--reverse-proxy", "nginx",
    "--email", "admin@example.com",
    "--non-interactive",
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /拒绝覆盖/);
  assert.equal(await fs.readFile(foreign, "utf8"), "server {}\n");
  assert.equal(await fs.readFile(fixture.commandLog, "utf8"), "");
});

test("managed domain mode preserves an HTTPS site on repeated runs", async () => {
  const fixture = await createFixture();
  await addStub(fixture, "nginx", 'printf "nginx %s\\n" "$*" >>"$WFL_STUB_LOG"\n');
  await addStub(fixture, "certbot", 'printf "certbot %s\\n" "$*" >>"$WFL_STUB_LOG"\n');
  await addStub(fixture, "systemctl", 'printf "systemctl %s\\n" "$*" >>"$WFL_STUB_LOG"\n');
  const available = path.join(fixture.etcDir, "nginx", "sites-available");
  const site = path.join(available, "wfl-codex-desktop.conf");
  const existing = [
    "# Managed by WFL Codex Desktop access wizard.",
    "server {",
    "    listen 443 ssl; # managed by Certbot",
    "    server_name codex.example.com;",
    "}",
    "",
  ].join("\n");
  await fs.mkdir(available, { recursive: true });
  await fs.writeFile(site, existing);

  const result = await runAccess(fixture, [
    "--mode", "existing-domain",
    "--hostname", "codex.example.com",
    "--reverse-proxy", "nginx",
    "--non-interactive",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已经配置 HTTPS/);
  assert.equal(await fs.readFile(site, "utf8"), existing);
  assert.doesNotMatch(await fs.readFile(fixture.commandLog, "utf8"), /certbot/);
});

test("Cloudflare mode starts a connector without persisting or printing its token", async () => {
  const fixture = await createFixture();
  const token = "test-token-abcdefghijklmnopqrstuvwxyz-0123456789-SECRET";
  await addStub(fixture, "systemctl", `
if [ "$1" = "is-active" ]; then
  [ -f "$WFL_STUB_ACTIVE" ]
  exit $?
fi
if [ "$1" = "cat" ]; then exit 1; fi
printf "systemctl %s\\n" "$*" >>"$WFL_STUB_LOG"
if [ "$1" = "enable" ]; then : >"$WFL_STUB_ACTIVE"; fi
`);
  await addStub(fixture, "cloudflared", `
if [ "$1" != "--no-autoupdate" ] || [ "$2" != "tunnel" ] || [ "$3" != "run" ] || [ "$4" != "--token-file" ] || [ -z "$5" ]; then exit 2; fi
printf "cloudflared tunnel run --token-file %s\\n" "$5" >>"$WFL_STUB_LOG"
`);

  const result = await runAccess(fixture, [
    "--mode", "cloudflare",
    "--hostname", "codex.example.com",
    "--non-interactive",
  ], { WFL_CLOUDFLARE_TUNNEL_TOKEN: token });
  assert.equal(result.code, 0, result.stderr);
  const stateText = await fs.readFile(fixture.stateFile, "utf8");
  const commands = await fs.readFile(fixture.commandLog, "utf8");
  const tokenFile = path.join(fixture.etcDir, "cloudflared", "token");
  const unit = await fs.readFile(path.join(fixture.etcDir, "systemd", "system", "cloudflared.service"), "utf8");
  assert.doesNotMatch(`${result.stdout}${result.stderr}${stateText}${commands}`, new RegExp(token));
  assert.match(unit, /tunnel run --token-file/);
  assert.doesNotMatch(unit, new RegExp(token));
  assert.equal(await fs.readFile(tokenFile, "utf8"), token);
  assert.equal((await fs.stat(tokenFile)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(stateText).managedBy, "cloudflared-token-file");
});

test("access wizard keeps all application ports on loopback and accepts no token argument", () => {
  assert.match(accessSource, /http:\/\/127\.0\.0\.1:4317/);
  assert.doesNotMatch(accessSource, /listen 431[789]/);
  assert.doesNotMatch(accessSource, /--tunnel-token/);
  assert.match(accessSource, /WFL_CLOUDFLARE_TUNNEL_TOKEN/);
  assert.match(accessSource, /--token-file \$token_file/);
  assert.match(accessSource, /chmodSync\(file, 0o600\)/);
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-access-test-"));
  const binDir = path.join(root, "bin");
  const etcDir = path.join(root, "etc");
  const stateFile = path.join(root, "runtime", "access.json");
  const commandLog = path.join(root, "commands.log");
  const activeFile = path.join(root, "cloudflared.active");
  await Promise.all([
    fs.mkdir(binDir, { recursive: true }),
    fs.mkdir(etcDir, { recursive: true }),
    fs.writeFile(commandLog, ""),
  ]);
  const fixture = { root, binDir, etcDir, stateFile, commandLog, activeFile };
  await addStub(fixture, "curl", 'printf "401"\n');
  return fixture;
}

async function addStub(fixture, name, body) {
  const destination = path.join(fixture.binDir, name);
  await fs.writeFile(destination, `#!/bin/sh\n${body}`, { mode: 0o755 });
}

async function runAccess(fixture, args, extraEnv = {}) {
  return run("bash", [accessScript, ...args], {
    ...process.env,
    ...extraEnv,
    PATH: `${fixture.binDir}:${process.env.PATH}`,
    WFL_ACCESS_ETC_DIR: fixture.etcDir,
    WFL_ACCESS_STATE_FILE: fixture.stateFile,
    WFL_ACCESS_SKIP_PUBLIC_CHECK: "1",
    WFL_ACCESS_TEST_MODE: "1",
    WFL_STUB_LOG: fixture.commandLog,
    WFL_STUB_ACTIVE: fixture.activeFile,
  });
}

async function readState(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
