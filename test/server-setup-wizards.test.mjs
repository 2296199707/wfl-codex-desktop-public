import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const passwordWizard = await fs.readFile(
  new URL("../scripts/reset-web-password.sh", import.meta.url),
  "utf8",
);
const updateWizard = await fs.readFile(
  new URL("../scripts/configure-update-source.sh", import.meta.url),
  "utf8",
);
const setPassword = await fs.readFile(
  new URL("../scripts/set-password.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));

test("package exposes dedicated post-install setup commands", () => {
  assert.equal(packageJson.scripts["server:password"], "bash scripts/reset-web-password.sh");
  assert.equal(packageJson.scripts["server:updates"], "bash scripts/configure-update-source.sh");
  assert.equal(packageJson.scripts["server:access"], "bash scripts/configure-access.sh");
});

test("password reset hides submitted passwords and refuses a split multi-user credential", () => {
  assert.match(passwordWizard, /requires an interactive terminal/);
  assert.match(passwordWizard, /multi-user\.json/);
  assert.match(passwordWizard, /ownerId/);
  assert.match(passwordWizard, /will not rewrite only the legacy password/);
  assert.match(passwordWizard, /CODEX_DESKTOP_NEW_PASSWORD="\$password"/);
  assert.match(passwordWizard, /CODEX_DESKTOP_HIDE_PASSWORD=1/);
  assert.doesNotMatch(passwordWizard, /set-password\.mjs[^\n]*"\$password"/);
  assert.match(passwordWizard, /wfl-codex-desktop-backend@\$\{active_port\}\.service/);
  assert.doesNotMatch(passwordWizard, /wfl-codex-desktop-gateway\.service/);
});

test("set-password can suppress a caller-provided secret", () => {
  assert.match(setPassword, /CODEX_DESKTOP_HIDE_PASSWORD === "1"/);
  assert.match(setPassword, /hidePassword \? "updated" : password/);
  assert.match(setPassword, /createAuthRecord\(username, password\)/);
});

test("update-source wizard keeps the Deploy Key private and verifies access before Git setup", () => {
  assert.match(updateWizard, /requires an interactive terminal/);
  assert.match(updateWizard, /wfl-codex-desktop-deploy/);
  assert.match(updateWizard, /Allow write access/);
  assert.match(updateWizard, /chmod 600 "\$KEY_FILE"/);
  assert.match(updateWizard, /GIT_SSH_COMMAND="\$ssh_command" git ls-remote/);
  assert.match(updateWizard, /bootstrap-package-git\.mjs/);
  assert.ok(
    updateWizard.indexOf("git ls-remote --exit-code \"$remote\"")
      < updateWizard.indexOf("bootstrap-package-git.mjs"),
  );
  assert.doesNotMatch(updateWizard, /Allow write access[^\n]*(?:enable|开启)/i);
  assert.doesNotMatch(updateWizard, /cat "\$KEY_FILE"/);
});
