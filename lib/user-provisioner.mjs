import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export async function provisionManagedUser(user, {
  usersRoot = "/srv/wfl-users",
  controlStateRoot = "/var/lib/wfl-codex-desktop/users",
  testMode = process.env.CODEX_DESKTOP_MULTI_USER_TEST_MODE === "1",
  commandRunner = run,
  quotaConfigurator = configureManagedUserQuota,
} = {}) {
  const root = path.resolve(usersRoot);
  const stateRoot = path.resolve(controlStateRoot);
  const home = path.join(root, user.id);
  const systemUsername = `wflc-${user.id.slice(2, 14)}`;
  const stateDirectory = path.join(stateRoot, user.id);
  if (!/^u-[a-f0-9]{16}$/.test(user.id)) throw new Error("Invalid managed user ID");

  await fs.mkdir(root, { recursive: true, mode: 0o711 });
  await fs.chmod(root, 0o711);
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(stateRoot, 0o700);

  let accountCreated = false;
  let quotaMode = "application";
  try {
    if (!testMode) {
      if (typeof process.getuid !== "function" || process.getuid() !== 0) {
        throw new Error("Managed user provisioning requires the backend service to run as root");
      }
      await commandRunner("/usr/sbin/useradd", [
        "--system",
        "--user-group",
        "--create-home",
        "--home-dir",
        home,
        "--shell",
        "/usr/sbin/nologin",
        systemUsername,
      ]);
    } else {
      await fs.mkdir(home, { recursive: false, mode: 0o700 });
    }
    accountCreated = true;

    const homeStat = await fs.stat(home);
    const uid = testMode && typeof process.getuid === "function" ? process.getuid() : homeStat.uid;
    const gid = testMode && typeof process.getgid === "function" ? process.getgid() : homeStat.gid;
    const codexHome = path.join(home, ".codex");
    const projectRoot = path.join(home, "projects");
    const defaultProject = path.join(projectRoot, "workspace");
    const privateTemp = path.join(home, "tmp");
    await Promise.all([
      fs.mkdir(codexHome, { recursive: true, mode: 0o700 }),
      fs.mkdir(projectRoot, { recursive: true, mode: 0o700 }),
      fs.mkdir(defaultProject, { recursive: true, mode: 0o700 }),
      fs.mkdir(privateTemp, { recursive: true, mode: 0o700 }),
      fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
    ]);
    for (const directory of [home, codexHome, projectRoot, defaultProject, privateTemp]) {
      await fs.chmod(directory, 0o700);
      if (!testMode) await fs.chown(directory, uid, gid);
    }
    await fs.chmod(stateDirectory, 0o700);
    quotaMode = await quotaConfigurator(
      { systemUsername, home },
      user.quotaBytes,
      { testMode },
    );
    const cleanup = once(() => rollbackManagedUser({
      accountCreated,
      commandRunner,
      home,
      quotaMode,
      stateDirectory,
      systemUsername,
      testMode,
    }));
    return {
      systemUsername,
      uid,
      gid,
      home,
      codexHome,
      projectRoot,
      defaultProject,
      stateDirectory,
      quotaMode,
      cleanup,
    };
  } catch (error) {
    if (accountCreated) {
      try {
        await rollbackManagedUser({
          accountCreated,
          commandRunner,
          home,
          quotaMode,
          stateDirectory,
          systemUsername,
          testMode,
        });
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  }
}

export async function configureManagedUserQuota(user, quotaBytes, {
  testMode = process.env.CODEX_DESKTOP_MULTI_USER_TEST_MODE === "1",
} = {}) {
  return configureFilesystemQuota({
    systemUsername: user.systemUsername,
    home: user.home,
    quotaBytes,
    testMode,
  });
}

async function configureFilesystemQuota({ systemUsername, home, quotaBytes, testMode }) {
  if (testMode || !Number.isSafeInteger(quotaBytes)) return "application";
  try {
    const mount = await capture("/usr/bin/findmnt", [
      "--noheadings",
      "--output",
      "TARGET,OPTIONS",
      "--target",
      home,
    ]);
    const [target, ...optionParts] = mount.trim().split(/\s+/);
    const options = optionParts.join(",");
    if (!target || !/(?:^|,)(?:usrquota|uquota)(?:,|$)/.test(options)) return "application";
    await run("/usr/sbin/setquota", [
      "-u",
      systemUsername,
      "0",
      String(Math.ceil(quotaBytes / 1024)),
      "0",
      "0",
      target,
    ]);
    return "filesystem";
  } catch {
    return "application";
  }
}

async function rollbackManagedUser({
  accountCreated,
  commandRunner,
  home,
  quotaMode,
  stateDirectory,
  systemUsername,
  testMode,
}) {
  if (!accountCreated) return;
  const failures = [];
  if (!testMode && quotaMode === "filesystem") {
    await configureFilesystemQuota({ systemUsername, home, quotaBytes: 0, testMode: false }).catch((error) => failures.push(error));
  }
  if (testMode) {
    await fs.rm(home, { recursive: true, force: true }).catch((error) => failures.push(error));
  } else {
    await commandRunner("/usr/sbin/userdel", ["--remove", systemUsername]).catch((error) => failures.push(error));
  }
  await fs.rm(stateDirectory, { recursive: true, force: true }).catch((error) => failures.push(error));
  if (failures.length) throw new AggregateError(failures, "Unable to fully roll back managed user provisioning");
}

function once(operation) {
  let task = null;
  return () => {
    task ||= operation();
    return task;
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-4000)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout = `${stdout}${chunk}`.slice(-4000)));
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-4000)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}
