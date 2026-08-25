import assert from "node:assert/strict";
import test from "node:test";
import {
  codexAppInstallUrlFromRead,
  normalizeCodexAppId,
  normalizeCodexAppInstallUrl,
  publicCodexAppsConfig,
  updateCodexAppSettings,
  userCodexAppsConfig,
} from "../lib/codex-apps.mjs";

test("accepts bounded app ids and only official ChatGPT app install URLs", () => {
  assert.equal(normalizeCodexAppId("google_drive"), "google_drive");
  assert.throws(() => normalizeCodexAppId("apps.bad"), /App ID/);
  assert.equal(
    normalizeCodexAppInstallUrl("https://chatgpt.com/apps/google/google-drive#details"),
    "https://chatgpt.com/apps/google/google-drive",
  );
  for (const value of [
    "http://chatgpt.com/apps/example",
    "https://evil.example/apps/example",
    "https://chatgpt.com/auth/login",
    "https://user:secret@chatgpt.com/apps/example",
  ]) assert.throws(() => normalizeCodexAppInstallUrl(value), /安装地址/);
});

test("extracts install URLs without exposing unrelated app rows", () => {
  const result = codexAppInstallUrlFromRead({
    apps: [{
      id: "google_drive",
      name: "Google Drive",
      installUrl: "https://chatgpt.com/apps/google/google-drive",
    }],
  }, "google_drive");
  assert.equal(result.app.name, "Google Drive");
  assert.equal(result.installUrl, "https://chatgpt.com/apps/google/google-drive");
  assert.throws(
    () => codexAppInstallUrlFromRead({ apps: [] }, "google_drive"),
    /不存在/,
  );
});

test("reads only the user app config layer and returns public settings", () => {
  const read = {
    layers: [{
      name: { type: "system", file: "/etc/codex/config.toml", profile: null },
      version: "system-1",
      config: { apps: { secret_app: { enabled: true } } },
    }, {
      name: { type: "user", file: "/home/user/.codex/config.toml", profile: null },
      version: "user-2",
      config: {
        apps: {
          _default: { enabled: true, destructive_enabled: false },
          google_drive: {
            enabled: false,
            open_world_enabled: true,
            approvals_reviewer: "user",
            default_tools_approval_mode: "prompt",
            tools: { "files/delete": { enabled: false } },
          },
        },
      },
    }],
  };
  assert.equal(userCodexAppsConfig(read).version, "user-2");
  assert.deepEqual(publicCodexAppsConfig(read), {
    version: "user-2",
    defaults: {
      enabled: true,
      destructiveEnabled: false,
      openWorldEnabled: null,
      approvalsReviewer: null,
      defaultToolsApprovalMode: null,
    },
    apps: {
      google_drive: {
        enabled: false,
        destructiveEnabled: null,
        openWorldEnabled: true,
        approvalsReviewer: "user",
        defaultToolsApprovalMode: "prompt",
      },
    },
  });
});

test("updates one app while preserving unknown and per-tool native settings", () => {
  const next = updateCodexAppSettings({
    _default: { enabled: true },
    google_drive: {
      enabled: true,
      tools: { "files/delete": { enabled: false } },
      future_setting: "keep",
    },
  }, "google_drive", {
    enabled: false,
    destructiveEnabled: false,
    openWorldEnabled: true,
    approvalsReviewer: "auto_review",
    defaultToolsApprovalMode: "writes",
  });
  assert.deepEqual(next.google_drive, {
    tools: { "files/delete": { enabled: false } },
    future_setting: "keep",
    enabled: false,
    destructive_enabled: false,
    open_world_enabled: true,
    approvals_reviewer: "auto_review",
    default_tools_approval_mode: "writes",
  });
  assert.deepEqual(next._default, { enabled: true });
  assert.throws(
    () => updateCodexAppSettings({}, "google_drive", { token: "secret" }),
    /未知字段/,
  );
});
