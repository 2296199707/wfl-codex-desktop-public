import assert from "node:assert/strict";
import test from "node:test";
import { applyProjectShareAccess, revokeProjectShareAccess } from "../lib/project-share-access.mjs";

const sourceUser = {
  id: "u-1111111111111111",
  legacy: false,
  systemUsername: "wflc-111111111111",
  home: "/srv/wfl-users/u-1111111111111111",
  projectRoot: "/srv/wfl-users/u-1111111111111111/projects",
};
const targetUser = {
  id: "u-2222222222222222",
  legacy: false,
  systemUsername: "wflc-222222222222",
};
const projectPath = `${sourceUser.projectRoot}/shared`;

test("read-only project shares apply traversal, access, and inherited ACLs", async () => {
  const calls = [];
  const runner = async (command, args) => calls.push({ command, args });
  await applyProjectShareAccess({ projectPath, sourceUser, targetUser, access: "read" }, {
    testMode: false,
    runner,
    setfacl: "/bin/true",
    find: "/bin/true",
  });
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0].args, ["--modify", `u:${targetUser.systemUsername}:--x`, sourceUser.home]);
  assert.match(calls[2].args.join(" "), /u:wflc-222222222222:r--/);
  assert.match(calls[3].args.join(" "), /u:wflc-222222222222:r-x/);
  assert.match(calls[4].args.join(" "), /d:u:wflc-222222222222:r-x/);
});

test("writable shares preserve source access for target-owned quota files", async () => {
  const calls = [];
  await applyProjectShareAccess({ projectPath, sourceUser, targetUser, access: "write" }, {
    testMode: false,
    runner: async (command, args) => calls.push({ command, args }),
    setfacl: "/bin/true",
    find: "/bin/true",
  });
  assert.equal(calls.length, 6);
  assert.match(calls[2].args.join(" "), /u:wflc-222222222222:rw-/);
  assert.match(calls[4].args.join(" "), /d:u:wflc-222222222222:rwx/);
  assert.match(calls[5].args.join(" "), /d:u:wflc-111111111111:rwx/);
});

test("project share revocation removes access and inherited ACL entries", async () => {
  const calls = [];
  await revokeProjectShareAccess({ projectPath, targetUser }, {
    testMode: false,
    runner: async (command, args) => calls.push({ command, args }),
    setfacl: "/bin/true",
    find: "/bin/true",
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].args.join(" "), /--remove u:wflc-222222222222/);
  assert.match(calls[1].args.join(" "), /--remove d:u:wflc-222222222222/);
});

test("writable share revocation transfers target-owned files back before removing ACLs", async () => {
  const calls = [];
  await revokeProjectShareAccess({ projectPath, sourceUser, targetUser, access: "write" }, {
    testMode: false,
    runner: async (command, args) => calls.push({ command, args }),
    setfacl: "/bin/true",
    find: "/bin/true",
    chown: "/bin/true",
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].args.join(" "), /-user wflc-222222222222 -exec \/bin\/true wflc-111111111111/);
  assert.match(calls[1].args.join(" "), /--remove u:wflc-222222222222/);
});
