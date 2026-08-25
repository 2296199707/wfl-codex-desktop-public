import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  renderServiceUnit,
  SERVICE_UNIT_NAMES,
  serviceUnitVariables,
} from "../lib/service-units.mjs";

const templates = Object.fromEntries(await Promise.all(SERVICE_UNIT_NAMES.map(async (name) => [
  name,
  await fs.readFile(new URL(`../systemd/${name}.template`, import.meta.url), "utf8"),
])));

test("portable service templates render an alternate server directory without unresolved values", () => {
  const variables = serviceUnitVariables({
    sourceDirectory: "/opt/wfl-codex-desktop",
    projectRoot: "/workspaces",
    defaultProject: "/workspaces/first-project",
    stateDirectory: "/var/lib/wfl-codex-desktop/state",
    runtimeDirectory: "/var/lib/wfl-codex-desktop/runtime",
    nodeBinary: "/usr/local/bin/node",
    serviceHome: "/root",
    candidateReleasesEnabled: true,
  });
  const backend = renderServiceUnit(templates["wfl-codex-desktop-backend@.service"], variables);
  const gateway = renderServiceUnit(templates["wfl-codex-desktop-gateway.service"], variables);
  const rescue = renderServiceUnit(templates["wfl-codex-desktop-rescue@.service"], variables);
  const recovery = renderServiceUnit(
    templates["wfl-codex-desktop-restore-recovery.service"],
    variables,
  );

  assert.match(backend, /WorkingDirectory=\/opt\/wfl-codex-desktop/);
  assert.match(backend, /CODEX_DESKTOP_PROJECT_ROOT=\/workspaces/);
  assert.match(backend, /CODEX_DESKTOP_PROJECT_ROOTS=\/workspaces/);
  assert.match(backend, /CODEX_DESKTOP_STATE_DIR=\/var\/lib\/wfl-codex-desktop\/state/);
  assert.match(backend, /CODEX_DESKTOP_CANDIDATE_RELEASES_ENABLED=1/);
  assert.match(backend, /PLAYWRIGHT_BROWSERS_PATH=\/root\/\.cache\/ms-playwright/);
  assert.match(backend, /CODEX_DESKTOP_BACKEND_SOURCE_DIR=\/var\/lib\/wfl-codex-desktop\/runtime\/slots\/%i/);
  assert.match(backend, /ExecStart=\/usr\/local\/bin\/node \/opt\/wfl-codex-desktop\/scripts\/backend-entry\.mjs/);
  assert.match(gateway, /Environment=HOST=127\.0\.0\.1/);
  assert.match(gateway, /Environment=PORT=4317/);
  assert.match(gateway, /CODEX_DESKTOP_ACTIVE_PORT_FILE=\/var\/lib\/wfl-codex-desktop\/runtime\/active-port/);
  assert.match(gateway, /CODEX_DESKTOP_RESCUE_PORT=4321/);
  assert.doesNotMatch(gateway, /CODEX_DESKTOP_RESCUE_PORTS|RESCUE_ACTIVE_PORT_FILE/);
  assert.doesNotMatch(gateway, /Wants=.*wfl-codex-desktop-rescue/);
  assert.match(rescue, /Environment=PORT=%i/);
  assert.match(rescue, /Environment=CODEX_DESKTOP_RESCUE_MODE=1/);
  assert.match(rescue, /Environment=CODEX_DESKTOP_RELEASE_DISABLED=1/);
  assert.match(rescue, /Environment=CODEX_DESKTOP_CODEX_UPDATE_DISABLED=1/);
  assert.match(rescue, /Environment=CODEX_DESKTOP_AUTH_FILE=\/var\/lib\/wfl-codex-desktop\/runtime\/rescue-auth\/%i\/auth\.json/);
  assert.match(rescue, /Environment=CODEX_DESKTOP_RESCUE_CREDENTIAL_MIRROR=\/var\/lib\/wfl-codex-desktop\/runtime\/rescue-credentials\/current\.json/);
  assert.match(rescue, /Environment=CODEX_DESKTOP_RESCUE_SESSION_DIR=\/var\/lib\/wfl-codex-desktop\/runtime\/rescue-sessions\/%i/);
  assert.match(rescue, /Environment=CODEX_DESKTOP_RESCUE_CODEX_HOME=\/var\/lib\/wfl-codex-desktop\/runtime\/rescue-codex-homes\/%i/);
  assert.match(rescue, /StartLimitIntervalSec=120s/);
  assert.match(rescue, /StartLimitBurst=5/);
  assert.match(rescue, /Restart=on-failure/);
  assert.doesNotMatch(rescue, /Restart=always|StartLimitIntervalSec=0/);
  assert.match(rescue, /WorkingDirectory=\/var\/lib\/wfl-codex-desktop\/runtime\/rescue-slots\/%i/);
  assert.match(rescue, /ExecStart=\/usr\/local\/bin\/node \/var\/lib\/wfl-codex-desktop\/runtime\/rescue-slots\/%i\/server\.mjs/);
  assert.match(
    backend,
    /^Requires=wfl-codex-desktop-restore-recovery\.service$/m,
  );
  assert.match(backend, /^Wants=network-online\.target wfl-codex-desktop-codex-recovery\.service$/m);
  assert.match(
    backend,
    /After=network-online\.target wfl-codex-desktop-restore-recovery\.service wfl-codex-desktop-codex-recovery\.service/,
  );
  assert.doesNotMatch(gateway, /Requires=wfl-codex-desktop-restore-recovery\.service/);
  assert.match(recovery, /ExecStart=\/usr\/local\/bin\/node \/opt\/wfl-codex-desktop\/scripts\/recover-data-restore\.mjs/);
  assert.match(recovery, /CODEX_DESKTOP_MULTI_USER_ROOT=\/srv\/wfl-users/);
  assert.match(recovery, /Before=wfl-codex-desktop-backend@4318\.service wfl-codex-desktop-backend@4319\.service/);
  assert.match(recovery, /StartLimitIntervalSec=120s/);
  assert.match(recovery, /StartLimitBurst=45/);
  assert.match(recovery, /TimeoutStartSec=90s/);
  assert.doesNotMatch(recovery, /^Restart=/m);
  assert.match(recovery, /\[Install\][\s\S]*WantedBy=multi-user\.target/);
  assert.doesNotMatch(`${backend}${gateway}${rescue}${recovery}`, /\{\{/);
});

test("service unit rendering rejects paths that could alter unit syntax", () => {
  assert.throws(
    () => serviceUnitVariables({ sourceDirectory: "/srv/project with spaces" }),
    /without spaces or control characters/,
  );
  assert.throws(
    () => serviceUnitVariables({ sourceDirectory: "/srv/project\nEnvironment=HOST=0.0.0.0" }),
    /without spaces or control characters/,
  );
});

test("service unit defaults keep the source separate from the first workspace", () => {
  const variables = serviceUnitVariables({ sourceDirectory: "/srv/wfl-rpg" });
  assert.equal(variables.PROJECT_ROOT, "/srv");
  assert.equal(variables.DEFAULT_PROJECT, "/srv/workspace");
});

test("service units preserve multiple project storage roots", () => {
  const variables = serviceUnitVariables({
    sourceDirectory: "/srv/wfl-codex-desktop",
    projectRoots: ["/srv", "/www"],
    defaultProject: "/srv/workspace",
  });
  assert.equal(variables.PROJECT_ROOT, "/srv");
  assert.equal(variables.PROJECT_ROOTS, "/srv:/www");
});

test("main-only service preparation leaves the active rescue component untouched", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-main-only-unit-");
  try {
    const runtimeDirectory = path.join(directory, "runtime");
    const outputDirectory = path.join(directory, "units");
    const sourceDirectory = path.join(directory, "source");
    const rescueDirectory = path.join(directory, "frozen-rescue");
    const projectRoot = path.join(directory, "projects");
    const defaultProject = path.join(projectRoot, "workspace");
    await Promise.all([
      fs.mkdir(path.join(runtimeDirectory, "rescue-slots"), { recursive: true }),
      fs.mkdir(sourceDirectory, { recursive: true }),
      fs.mkdir(rescueDirectory, { recursive: true }),
    ]);
    await fs.symlink(rescueDirectory, path.join(runtimeDirectory, "rescue-slots", "4321"), "dir");

    await runInstallServiceUnits({
      runtimeDirectory,
      outputDirectory,
      sourceDirectory,
      projectRoot,
      defaultProject,
      mainOnly: true,
    });

    assert.equal(await fs.realpath(path.join(runtimeDirectory, "rescue-slots", "4321")), rescueDirectory);
    await assert.rejects(
      fs.lstat(path.join(runtimeDirectory, "rescue")),
      { code: "ENOENT" },
    );
    await assert.rejects(fs.access(path.join(outputDirectory, "wfl-codex-desktop-rescue@.service")));
    assert.equal(await fs.readFile(path.join(outputDirectory, "wfl-codex-desktop-backend@.service"), "utf8").then(Boolean), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("fresh rescue preparation uses one fixed 4321 service and snapshots the verified active release", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-fresh-rescue-unit-");
  try {
    const runtimeDirectory = path.join(directory, "runtime");
    const outputDirectory = path.join(directory, "units");
    const sourceDirectory = path.join(directory, "source");
    const activeRelease = path.join(runtimeDirectory, "releases", "v1.0.0");
    const projectRoot = path.join(directory, "projects");
    const defaultProject = path.join(projectRoot, "workspace");
    await Promise.all([
      seedRescueSource(sourceDirectory),
      seedRescueSource(activeRelease),
      fs.mkdir(path.join(runtimeDirectory, "slots"), { recursive: true }),
    ]);
    await fs.writeFile(path.join(runtimeDirectory, "active-port"), "4319\n");
    await fs.symlink(activeRelease, path.join(runtimeDirectory, "slots", "4319"), "dir");

    await runInstallServiceUnits({
      runtimeDirectory,
      outputDirectory,
      sourceDirectory,
      projectRoot,
      defaultProject,
      includeRescue: true,
    });

    assert.equal(await fs.realpath(path.join(runtimeDirectory, "rescue-slots", "4321")), activeRelease);
    assert.match(await fs.readFile(path.join(outputDirectory, "wfl-codex-desktop-rescue@.service"), "utf8"), /PORT=%i/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("service installation migrates a legacy rescue slot into the fixed rescue service", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-rescue-unit-");
  try {
    const runtimeDirectory = path.join(directory, "runtime");
    const outputDirectory = path.join(directory, "units");
    const sourceDirectory = path.join(directory, "source");
    const legacyRelease = path.join(directory, "legacy-v0.37.6");
    const projectRoot = path.join(directory, "projects");
    const defaultProject = path.join(projectRoot, "workspace");
    await Promise.all([
      seedRescueSource(sourceDirectory),
      fs.mkdir(path.join(legacyRelease, "node_modules"), { recursive: true }),
      fs.mkdir(path.join(runtimeDirectory, "slots"), { recursive: true }),
    ]);
    await fs.writeFile(path.join(legacyRelease, "server.mjs"), "// legacy server\n");
    await fs.writeFile(path.join(runtimeDirectory, "active-port"), "4318\n");
    await fs.symlink(legacyRelease, path.join(runtimeDirectory, "slots", "4318"), "dir");
    await fs.symlink(legacyRelease, path.join(runtimeDirectory, "rescue-slot"), "dir");

    await runInstallServiceUnits({
      runtimeDirectory,
      outputDirectory,
      sourceDirectory,
      projectRoot,
      defaultProject,
      includeRescue: true,
      rescueInstallApproved: true,
    });

    assert.equal(await fs.realpath(path.join(runtimeDirectory, "rescue-slots", "4321")), sourceDirectory);
    const rescueUnit = await fs.readFile(
      path.join(outputDirectory, "wfl-codex-desktop-rescue@.service"),
      "utf8",
    );
    assert.match(rescueUnit, /Environment=CODEX_DESKTOP_RESCUE_MODE=1/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("service installation preserves a capable legacy rescue release as the rollback copy", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-rescue-legacy-unit-");
  try {
    const runtimeDirectory = path.join(directory, "runtime");
    const outputDirectory = path.join(directory, "units");
    const sourceDirectory = path.join(directory, "source");
    const legacyRelease = path.join(directory, "legacy-v0.37.6");
    const projectRoot = path.join(directory, "projects");
    const defaultProject = path.join(projectRoot, "workspace");
    await Promise.all([
      seedRescueSource(sourceDirectory),
      seedRescueSource(legacyRelease, { legacyUnit: true }),
      fs.mkdir(path.join(runtimeDirectory, "slots"), { recursive: true }),
    ]);
    await fs.writeFile(path.join(runtimeDirectory, "active-port"), "4318\n");
    await fs.symlink(legacyRelease, path.join(runtimeDirectory, "slots", "4318"), "dir");
    await fs.symlink(legacyRelease, path.join(runtimeDirectory, "rescue-slot"), "dir");

    await runInstallServiceUnits({
      runtimeDirectory,
      outputDirectory,
      sourceDirectory,
      projectRoot,
      defaultProject,
      includeRescue: true,
      rescueInstallApproved: true,
    });

    assert.equal(await fs.realpath(path.join(runtimeDirectory, "rescue-slots", "4321")), legacyRelease);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function seedRescueSource(directory, { legacyUnit = false } = {}) {
  await Promise.all([
    fs.mkdir(path.join(directory, "node_modules"), { recursive: true }),
    fs.mkdir(path.join(directory, "public"), { recursive: true }),
    fs.mkdir(path.join(directory, "systemd"), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(directory, "server.mjs"), "// rescue server\n"),
    fs.writeFile(path.join(directory, "public", "rescue.html"), "<!doctype html>\n"),
    fs.writeFile(path.join(directory, "public", "rescue.js"), "// rescue client\n"),
    fs.writeFile(path.join(directory, "public", "rescue.css"), "/* rescue styles */\n"),
    fs.writeFile(
      path.join(
        directory,
        "systemd",
        legacyUnit ? "wfl-codex-desktop-rescue.service.template" : "wfl-codex-desktop-rescue@.service.template",
      ),
      "# rescue unit capability\n",
    ),
  ]);
}

function runInstallServiceUnits({
  runtimeDirectory,
  outputDirectory,
  sourceDirectory,
  projectRoot,
  defaultProject,
  mainOnly = false,
  includeRescue = false,
  rescueInstallApproved = false,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      new URL("../scripts/install-service-units.mjs", import.meta.url).pathname,
      "--output-dir",
      outputDirectory,
      ...(mainOnly ? ["--main-only"] : []),
      ...(includeRescue ? ["--include-rescue"] : []),
    ], {
      env: {
        ...process.env,
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
        CODEX_DESKTOP_SOURCE_DIR: sourceDirectory,
        CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
        CODEX_DESKTOP_DEFAULT_PROJECT: defaultProject,
        CODEX_DESKTOP_STATE_DIR: path.join(path.dirname(projectRoot), "state"),
        ...(rescueInstallApproved ? { CODEX_DESKTOP_RESCUE_INSTALL_APPROVED: "1" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`install-service-units exited with ${code}: ${output}`));
    });
  });
}
