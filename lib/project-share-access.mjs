import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const SETFACL = "/usr/bin/setfacl";
const FIND = "/usr/bin/find";

export async function applyProjectShareAccess({ projectPath, sourceUser, targetUser, access }, {
  testMode = process.env.CODEX_DESKTOP_MULTI_USER_TEST_MODE === "1",
  runner = run,
  setfacl = SETFACL,
  find = FIND,
} = {}) {
  validateShareUsers(sourceUser, targetUser);
  if (testMode || targetUser.legacy) return { mode: testMode ? "test" : "owner" };
  await fs.access(setfacl).catch(() => {
    throw new Error("服务器缺少 acl 工具，请安装 acl 后再共享工程");
  });
  const principal = `u:${targetUser.systemUsername}`;
  const filePermissions = access === "write" ? "rw-" : "r--";
  const directoryPermissions = access === "write" ? "rwx" : "r-x";

  try {
    for (const ancestor of shareAncestors(projectPath, sourceUser)) {
      await runner(setfacl, ["--modify", `${principal}:--x`, ancestor]);
    }
    await runner(setfacl, ["--physical", "--recursive", "--modify", `${principal}:${filePermissions}`, projectPath]);
    await runner(find, [
      "-P", projectPath, "(", "-type", "d", "-o", "-perm", "/111", ")",
      "-exec", setfacl, "--modify", `${principal}:${directoryPermissions}`, "{}", "+",
    ]);
    await runner(find, [
      "-P", projectPath, "-type", "d", "-exec", setfacl,
      "--modify", `d:${principal}:${directoryPermissions}`, "{}", "+",
    ]);
    if (access === "write" && !sourceUser.legacy) {
      validateSystemUsername(sourceUser.systemUsername);
      await runner(find, [
        "-P", projectPath, "-type", "d", "-exec", setfacl,
        "--modify", `d:u:${sourceUser.systemUsername}:rwx`, "{}", "+",
      ]);
    }
    return { mode: "acl" };
  } catch (error) {
    await revokeProjectShareAccess({ projectPath, sourceUser, targetUser, access }, {
      testMode, runner, setfacl, find,
    }).catch(() => {});
    throw new Error(`无法应用共享工程权限：${error.message}`);
  }
}

export async function revokeProjectShareAccess({ projectPath, sourceUser, targetUser, access }, {
  testMode = process.env.CODEX_DESKTOP_MULTI_USER_TEST_MODE === "1",
  runner = run,
  setfacl = SETFACL,
  find = FIND,
  chown = "/usr/bin/chown",
} = {}) {
  if (testMode || targetUser?.legacy) return;
  validateSystemUsername(targetUser?.systemUsername);
  const principal = `u:${targetUser.systemUsername}`;
  if (access === "write") {
    const sourceOwner = sourceUser?.legacy
      ? String(sourceUser.uid)
      : String(sourceUser?.systemUsername || "");
    if (sourceUser?.legacy) {
      if (!Number.isInteger(sourceUser.uid) || sourceUser.uid < 0) throw new Error("共享工程所有者 UID 不正确");
    } else {
      validateSystemUsername(sourceOwner);
    }
    await runner(find, [
      "-P", projectPath, "-user", targetUser.systemUsername,
      "-exec", chown, sourceOwner, "{}", "+",
    ]);
  }
  await runner(setfacl, ["--physical", "--recursive", "--remove", principal, projectPath]);
  await runner(find, [
    "-P", projectPath, "-type", "d", "-exec", setfacl,
    "--remove", `d:${principal}`, "{}", "+",
  ]);
}

function shareAncestors(projectPath, sourceUser) {
  const candidates = [sourceUser.home, sourceUser.projectRoot];
  return candidates.filter((candidate, index) => {
    if (!candidate || candidates.indexOf(candidate) !== index) return false;
    const relative = projectPath.startsWith(`${candidate}/`) || projectPath === candidate;
    return relative;
  });
}

function validateShareUsers(sourceUser, targetUser) {
  if (!sourceUser?.id || !targetUser?.id || sourceUser.id === targetUser.id) {
    throw new Error("共享工程用户不正确");
  }
  if (!targetUser.legacy) validateSystemUsername(targetUser.systemUsername);
}

function validateSystemUsername(value) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(String(value || ""))) {
    throw new Error("共享工程目标系统账号不正确");
  }
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
