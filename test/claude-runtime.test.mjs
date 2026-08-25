import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeExtensionStore } from "../lib/claude-extensions.mjs";
import { ClaudeOfficialAccountStore } from "../lib/claude-official-accounts.mjs";
import { ClaudeRuntime, classifyClaudeFailure } from "../lib/claude-runtime.mjs";
import { ClaudeStore } from "../lib/claude-store.mjs";

test("Claude ignores unreviewed events, denies unreviewed controls, and never logs their raw payload", async () => {
  const runtime = new ClaudeRuntime({
    user: {
      stateDirectory: path.join(os.tmpdir(), "wfl-claude-protocol-state"),
      home: path.join(os.tmpdir(), "wfl-claude-protocol-home"),
      projectRoot: os.tmpdir(),
      legacy: true,
    },
    store: { snapshot: () => ({ activeId: null, profiles: [] }) },
    appVersion: "test",
    command: "false",
  });
  const events = [];
  const logs = [];
  const writes = [];
  runtime.on("event", (event) => events.push(event));
  runtime.on("log", (event) => logs.push(event));
  const session = { id: "session-fixture" };
  runtime.consumeEvent(session, {}, JSON.stringify({
    type: "sk-ant-secret-event",
    subtype: "private@example.test",
    apiKey: "should-not-leak",
  }));
  runtime.consumeEvent(session, {}, "not-json sk-ant-invalid");
  runtime.registerControlRequest(session, {
    process: {
      stdin: {
        writable: true,
        write(value, callback) {
          writes.push(value);
          callback();
        },
      },
    },
  }, {
    type: "control_request",
    request_id: "request-fixture",
    request: { subtype: "authorization-secret-code" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "protocol/unreviewed-event");
  assert.match(events[0].event.type, /^unreviewed-[a-f0-9]{12}$/);
  assert.match(events[0].event.subtype, /^unreviewed-[a-f0-9]{12}$/);
  assert.equal(writes.length, 1);
  const response = JSON.parse(writes[0]);
  assert.equal(response.response.subtype, "error");
  assert.match(response.response.error, /unreviewed-[a-f0-9]{12}/);
  const diagnostics = JSON.stringify({ events, logs, writes });
  assert.doesNotMatch(diagnostics, /sk-ant|private@example|should-not-leak|authorization-secret-code/);
  assert.equal(runtime.environment().DISABLE_AUTOUPDATER, "1");
  await runtime.destroy();
});

test("Claude providers encrypt keys and expose only public connection metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-store-"));
  try {
    const store = await new ClaudeStore(root).initialize();
    const profile = await store.create({
      name: "Anthropic test",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      apiKey: "secret-claude-key",
    });
    const snapshot = store.snapshot();
    assert.equal(snapshot.activeId, profile.id);
    assert.equal(snapshot.profiles[0].configured, true);
    assert.equal(Object.hasOwn(snapshot.profiles[0], "apiKey"), false);
    assert.equal((await fs.readFile(path.join(root, "profiles.enc.json"), "utf8")).includes("secret-claude-key"), false);
    assert.equal(store.getActiveProfile().apiKey, "secret-claude-key");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude retry classification and task settings stay bounded and secret-safe", async () => {
  assert.deepEqual(classifyClaudeFailure({ code: "ECONNRESET" }), {
    class: "network",
    retryable: true,
    safeToRetry: true,
  });
  assert.deepEqual(
    [
      classifyClaudeFailure({ message: "401 Unauthorized: account token expired" }),
      classifyClaudeFailure({ message: "429 rate limit", retryAfterMs: 8_000 }),
      classifyClaudeFailure({ message: "402 quota exhausted" }),
      classifyClaudeFailure({ message: "407 Proxy Authentication Required" }),
      classifyClaudeFailure({ message: "proxy tunnel socket disconnected" }),
    ].map(({ class: failureClass, retryable, safeToRetry }) => ({
      failureClass,
      retryable,
      safeToRetry,
    })),
    [
      { failureClass: "auth", retryable: false, safeToRetry: false },
      { failureClass: "rate-limit", retryable: true, safeToRetry: true },
      { failureClass: "quota", retryable: false, safeToRetry: false },
      { failureClass: "auth", retryable: false, safeToRetry: false },
      { failureClass: "network", retryable: true, safeToRetry: true },
    ],
  );

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-task-settings-"));
  try {
    const store = await new ClaudeStore(path.join(root, "store")).initialize();
    const runtime = await new ClaudeRuntime({
      user: { stateDirectory: root, home: root, projectRoot: root, legacy: true },
      store,
      appVersion: "test",
      command: "false",
    }).initialize();
    assert.deepEqual(runtime.taskSettingsSnapshot(), {
      unlimitedRetry: false,
      retryFrequency: "balanced",
      maxRetries: 5,
    });
    const updated = await runtime.updateTaskSettings({
      unlimitedRetry: true,
      retryFrequency: "patient",
      maxRetries: 7,
    });
    assert.deepEqual(updated, { unlimitedRetry: true, retryFrequency: "patient", maxRetries: 7 });
    await runtime.destroy();
    const restored = await new ClaudeRuntime({
      user: { stateDirectory: root, home: root, projectRoot: root, legacy: true },
      store,
      appVersion: "test",
      command: "false",
    }).initialize();
    assert.deepEqual(restored.taskSettingsSnapshot(), updated);
    assert.doesNotMatch(await fs.readFile(path.join(root, "claude", "task-settings.json"), "utf8"), /api|secret|token/i);
    await restored.destroy();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude personal skills and agents are bounded, atomic, and preserve advanced frontmatter", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-extensions-"));
  try {
    const configDirectory = path.join(root, "config");
    await fs.mkdir(configDirectory);
    const store = new ClaudeExtensionStore({
      configDirectory,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
    });
    const skill = await store.saveSkill({
      name: "release-check",
      description: "Checks a release before deployment",
      allowedTools: ["Read", "Bash(git status *)"],
      disableModelInvocation: true,
      userInvocable: true,
      body: "Inspect the release and report blockers.",
    });
    assert.deepEqual(skill.allowedTools, ["Read", "Bash(git status *)"]);
    const skillPath = path.join(configDirectory, "skills", "release-check", "SKILL.md");
    assert.equal((await fs.stat(skillPath)).mode & 0o777, 0o600);
    const original = await fs.readFile(skillPath, "utf8");
    await fs.writeFile(skillPath, original.replace("description:", "context: fork\ndescription:"), { mode: 0o600 });
    await store.saveSkill({ ...skill, description: "Updated release checks", body: "Run focused verification." }, { existingName: skill.name });
    assert.match(await fs.readFile(skillPath, "utf8"), /context: fork/);

    const agent = await store.saveAgent({
      name: "reviewer",
      description: "Reviews changes without editing",
      tools: ["Read", "Grep", "Glob"],
      disallowedTools: ["Edit"],
      model: "sonnet",
      permissionMode: "plan",
      effort: "high",
      worktree: true,
      body: "Review the current changes and return prioritized findings.",
    });
    assert.equal(agent.worktree, true);
    assert.equal(agent.permissionMode, "plan");
    assert.deepEqual((await store.listAgents())[0].tools, ["Read", "Grep", "Glob"]);

    const outside = path.join(root, "outside.md");
    await fs.writeFile(outside, "unsafe");
    await fs.symlink(outside, path.join(configDirectory, "agents", "linked.md"));
    assert.equal((await store.listAgents()).some((entry) => entry.name === "linked"), false);
    await assert.rejects(store.saveAgent({
      name: "linked",
      description: "Should fail",
      body: "Do not follow links.",
    }), /不安全/);

    await store.removeSkill(skill.name);
    await store.removeAgent(agent.name);
    assert.deepEqual(await store.listSkills(), []);
    assert.deepEqual(await store.listAgents(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude MCP configuration stays native, atomic, isolated, and secret-safe", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-mcp-"));
  let runtime = null;
  try {
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const command = path.join(root, "fake-claude-mcp.mjs");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    await fs.writeFile(command, `#!/usr/bin/env node
if (process.argv[2] === "mcp" && process.argv[3] === "get") {
  process.stdout.write(process.argv[4] === "fixture-oauth"
    ? "401 Unauthorized: OAuth required\\n"
    : process.argv[4] === "fixture-pending"
      ? "fixture-pending: ⏸ Pending approval\\n"
      : process.argv[4] + ": ✓ Connected\\nTools:\\n  - read_file — Read fixture files\\nResources:\\n  - fixture://docs\\n");
  process.exit(0);
}
if (process.argv[2] === "mcp" && process.argv[3] === "logout") {
  process.stdout.write("Logged out\\n");
  process.exit(0);
}
if (process.argv[2] === "mcp" && process.argv[3] === "reset-project-choices") {
  process.stdout.write("Project choices reset\\n");
  process.exit(0);
}
process.exit(1);
`, { mode: 0o700 });
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    runtime = await new ClaudeRuntime({
      user: {
        stateDirectory,
        home,
        projectRoot: project,
        systemUsername: "fixture",
        legacy: false,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
      },
      store,
      appVersion: "test",
      command,
    }).initialize();
    await runtime.saveSkill({
      name: "fixture-command",
      description: "Runs the fixture command",
      userInvocable: true,
      body: "Inspect the fixture.",
    });
    await runtime.saveSkill({
      name: "hidden-command",
      description: "Internal fixture skill",
      userInvocable: false,
      body: "Do not expose this command.",
    });
    assert.deepEqual(await runtime.commandSnapshot(), {
      commands: [
        {
          kind: "builtin",
          name: "doctor",
          action: "doctor",
          description: "检查 Claude CLI 兼容性与连接状态",
        },
        {
          kind: "builtin",
          name: "permissions",
          action: "permissions",
          description: "查看当前会话的 Claude 权限模式",
        },
        {
          kind: "builtin",
          name: "context",
          action: "context",
          description: "查看当前 Claude 会话的上下文与用量",
        },
        {
          kind: "skill",
          name: "fixture-command",
          description: "Runs the fixture command",
        },
      ],
    });
    assert.equal((await runtime.commandSnapshot({ includeSkills: false })).commands.length, 3);
    const created = await runtime.saveMcpServer({
      name: "fixture-tools",
      type: "stdio",
      command: "node",
      args: ["server.mjs"],
      sensitiveMode: "replace",
      environment: { API_KEY: "mcp-secret" },
    });
    assert.equal(created.scope, "user");
    assert.deepEqual(created.environmentKeys, ["API_KEY"]);
    assert.equal(Object.hasOwn(created, "environment"), false);
    assert.equal(Object.hasOwn(created, "env"), false);
    const configPath = path.join(home, ".wfl-claude", ".claude.json");
    let configuration = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(configuration.mcpServers["fixture-tools"].env.API_KEY, "mcp-secret");
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);

    const updated = await runtime.saveMcpServer({
      name: "fixture-tools",
      type: "stdio",
      command: "node",
      args: ["updated.mjs"],
      sensitiveMode: "preserve",
    }, { existingName: "fixture-tools" });
    assert.deepEqual(updated.args, ["updated.mjs"]);
    configuration = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(configuration.mcpServers["fixture-tools"].env.API_KEY, "mcp-secret");
    assert.equal((await runtime.checkMcpServer("fixture-tools")).status, "connected");
    const connectedHealth = await runtime.checkMcpServer("fixture-tools", project);
    assert.deepEqual(connectedHealth.tools, ["read_file"]);
    assert.deepEqual(connectedHealth.resources, ["fixture://docs"]);
    assert.equal(connectedHealth.error, null);

    const projectScoped = await runtime.saveMcpServer({
      name: "fixture-pending",
      scope: "project",
      cwd: project,
      type: "http",
      url: "https://mcp.example.test/project",
    });
    assert.equal(projectScoped.scope, "project");
    const localScoped = await runtime.saveMcpServer({
      name: "fixture-local",
      scope: "local",
      cwd: project,
      type: "stdio",
      command: "node",
      args: ["local.mjs"],
    });
    assert.equal(localScoped.scope, "local");
    const scopedServers = await runtime.listMcpServers(project);
    assert.equal(scopedServers.some((server) => server.name === "fixture-pending" && server.scope === "project"), true);
    assert.equal(scopedServers.some((server) => server.name === "fixture-local" && server.scope === "local"), true);
    const projectMcp = JSON.parse(await fs.readFile(path.join(project, ".mcp.json"), "utf8"));
    assert.equal(projectMcp.mcpServers["fixture-pending"].url, "https://mcp.example.test/project");
    assert.equal((await fs.stat(path.join(project, ".mcp.json"))).mode & 0o777, 0o600);
    const nativeConfiguration = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(nativeConfiguration.projects[project].mcpServers["fixture-local"].command, "node");
    const pendingHealth = await runtime.checkMcpServer("fixture-pending", project);
    assert.equal(pendingHealth.status, "pendingApproval");
    assert.equal(pendingHealth.approval, "pending");

    await assert.rejects(
      runtime.saveMcpServer({ name: "bad name", type: "http", url: "file:///tmp/mcp" }),
      /MCP 名称无效/,
    );
    await runtime.saveMcpServer({ name: "fixture-oauth", type: "http", url: "https://mcp.example.test/service" });
    const oauthHealth = await runtime.checkMcpServer("fixture-oauth");
    assert.equal(oauthHealth.name, "fixture-oauth");
    assert.equal(oauthHealth.status, "authRequired");
    assert.equal(oauthHealth.authRequired, true);
    assert.equal(Number.isSafeInteger(oauthHealth.checkedAt), true);
    assert.deepEqual(await runtime.logoutMcpServer("fixture-oauth"), {
      ok: true,
      name: "fixture-oauth",
      loggedOut: true,
    });
    await assert.rejects(runtime.resetMcpProjectChoices(project, "wrong"), /确认不匹配/);
    assert.deepEqual(await runtime.resetMcpProjectChoices(project, "重置 MCP 项目选择"), {
      ok: true,
      cwd: project,
      reset: true,
    });
    await runtime.removeMcpServer("fixture-tools");
    await runtime.removeMcpServer("fixture-oauth");
    await runtime.removeMcpServer("fixture-pending", { scope: "project", cwd: project });
    await runtime.removeMcpServer("fixture-local", { scope: "local", cwd: project });
    await runtime.removeSkill("fixture-command");
    await runtime.removeSkill("hidden-command");
    assert.deepEqual(await runtime.listMcpServers(), []);
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude Auto Mode reads large grouped rules, critiques safely, and resets only after confirmation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-auto-mode-"));
  let runtime = null;
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const stateDirectory = path.join(root, "state");
    const command = path.join(root, "fake-claude-auto-mode.mjs");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    const largeRules = Array.from({ length: 4 }, (_, index) => `Soft rule ${index}: ${"x".repeat(10_000)}`);
    const defaults = {
      allow: ["Default allow"],
      soft_deny: largeRules,
      hard_deny: ["Default hard deny"],
      environment: ["Default environment"],
    };
    const effective = {
      ...defaults,
      allow: ["Custom allow"],
    };
    await fs.writeFile(command, `#!/usr/bin/env node
import fs from "node:fs/promises";
const defaults = ${JSON.stringify(defaults)};
const effective = ${JSON.stringify(effective)};
if (process.argv[2] === "auto-mode" && process.argv[3] === "config") {
  process.stdout.write(JSON.stringify(effective));
  process.exit(0);
}
if (process.argv[2] === "auto-mode" && process.argv[3] === "defaults") {
  process.stdout.write(JSON.stringify(defaults));
  process.exit(0);
}
if (process.argv[2] === "auto-mode" && process.argv[3] === "critique") {
  process.stdout.write("Rules look focused. API_KEY=auto-mode-secret");
  process.exit(0);
}
if (process.argv[2] === "auto-mode" && process.argv[3] === "reset") {
  await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/auto-mode-args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
  process.stdout.write("Reset complete");
  process.exit(0);
}
process.exit(1);
`, { mode: 0o700 });
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot: project, legacy: true },
      store,
      appVersion: "test",
      command,
    }).initialize();

    const summary = await runtime.autoModeSnapshot();
    assert.equal(summary.hasCustomRules, true);
    assert.equal(summary.groups.find((group) => group.name === "allow").customized, true);
    assert.equal(Object.hasOwn(summary, "effective"), false);
    const softRules = await runtime.autoModeSnapshot("soft_deny");
    assert.equal(softRules.effective.length, 4);
    assert.equal(softRules.effective[3].length > 10_000, true);
    assert.equal(softRules.groups.find((group) => group.name === "soft_deny").customized, false);
    await assert.rejects(runtime.autoModeSnapshot("unknown"), /分组无效/);

    const critique = await runtime.critiqueAutoMode("sonnet");
    assert.match(critique.critique, /Rules look focused/);
    assert.doesNotMatch(critique.critique, /auto-mode-secret/);
    await assert.rejects(runtime.critiqueAutoMode("bad model"), /模型无效/);
    await assert.rejects(runtime.resetAutoMode("wrong"), /确认不匹配/);
    assert.deepEqual(await runtime.resetAutoMode("重置 Auto Mode 规则"), { ok: true, reset: true });
    const resetArgs = JSON.parse((await fs.readFile(
      path.join(home, ".wfl-claude", "auto-mode-args.jsonl"),
      "utf8",
    )).trim());
    assert.deepEqual(resetArgs, ["auto-mode", "reset", "--yes"]);
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude project purge requires a fresh preview and preserves a private bounded backup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-project-purge-"));
  let runtime = null;
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const stateDirectory = path.join(root, "state");
    const command = path.join(root, "fake-claude-project.mjs");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    await fs.writeFile(command, `#!/usr/bin/env node
import fs from "node:fs/promises";
if (process.argv[2] === "project" && process.argv[3] === "purge") {
  if (process.argv.includes("--dry-run")) {
    process.stdout.write("Purge plan: transcript, tasks, file history, config entry\\nDry run: 4 items\\n");
  } else {
    await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/purge-args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
    process.stdout.write("Project state purged\\n");
  }
  process.exit(0);
}
process.exit(1);
`, { mode: 0o700 });
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot: project, legacy: true },
      store,
      appVersion: "test",
      command,
    }).initialize();
    const configDirectory = path.join(home, ".wfl-claude");
    const nativeProjectDirectory = path.join(configDirectory, "projects", project.replace(/[^A-Za-z0-9]/g, "-"));
    await fs.mkdir(nativeProjectDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(nativeProjectDirectory, "fixture.jsonl"), '{"type":"user","message":"keep me"}\n', { mode: 0o600 });
    await fs.writeFile(path.join(configDirectory, ".claude.json"), `${JSON.stringify({
      projects: { [project]: { hasTrustDialogAccepted: true, mcpServers: {} } },
    })}\n`, { mode: 0o600 });

    const preview = await runtime.previewProjectPurge(project);
    assert.equal(preview.exists, true);
    assert.match(preview.plan, /Dry run: 4 items/);
    assert.equal(preview.estimate.nativeFiles, 1);
    assert.equal(preview.estimate.projectConfiguration, 1);
    await assert.rejects(runtime.purgeProject({
      cwd: project,
      previewToken: preview.previewToken,
      confirmation: "wrong",
    }), /确认不匹配/);
    const purged = await runtime.purgeProject({
      cwd: project,
      previewToken: preview.previewToken,
      confirmation: "清理 Claude 工程状态",
    });
    assert.equal(purged.purged, true);
    assert.equal(purged.backup.files, 1);
    const backupDirectory = path.join(stateDirectory, "claude", "project-purge-backups", purged.backup.id);
    assert.equal((await fs.stat(backupDirectory)).mode & 0o777, 0o700);
    assert.equal(
      await fs.readFile(path.join(backupDirectory, "native", "projects", project.replace(/[^A-Za-z0-9]/g, "-"), "fixture.jsonl"), "utf8"),
      '{"type":"user","message":"keep me"}\n',
    );
    const manifest = JSON.parse(await fs.readFile(path.join(backupDirectory, "manifest.json"), "utf8"));
    assert.equal(manifest.projectConfiguration.hasTrustDialogAccepted, true);
    assert.equal((await fs.stat(path.join(backupDirectory, "manifest.json"))).mode & 0o777, 0o600);
    const purgeArgs = JSON.parse((await fs.readFile(path.join(configDirectory, "purge-args.jsonl"), "utf8")).trim());
    assert.deepEqual(purgeArgs.slice(0, 3), ["project", "purge", "--yes"]);
    await assert.rejects(runtime.purgeProject({
      cwd: project,
      previewToken: preview.previewToken,
      confirmation: "清理 Claude 工程状态",
    }), /预览已失效/);
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude Ultra Review is server-owned, bounded, persistent, and cancellable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-ultrareview-"));
  let runtime = null;
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const stateDirectory = path.join(root, "state");
    const command = path.join(root, "fake-claude-ultrareview.mjs");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    await fs.writeFile(command, `#!/usr/bin/env node
import fs from "node:fs/promises";
if (process.argv[2] === "ultrareview") {
  await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/ultrareview-args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
  if (process.argv.at(-1) === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    process.stdout.write('{"bugs":[]}\\n');
  } else {
    await new Promise((resolve) => setTimeout(resolve, 40));
    process.stdout.write('{"bugs":[{"title":"Fixture finding"}],"API_KEY":"ultra-secret"}\\n');
  }
  process.exit(0);
}
process.exit(1);
`, { mode: 0o700 });
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot: project, legacy: true },
      store,
      appVersion: "test",
      command,
    }).initialize();
    await assert.rejects(runtime.startUltraReview({ cwd: project, target: "../main" }), /目标/);
    await assert.rejects(runtime.startUltraReview({ cwd: project, timeoutMinutes: 121 }), /超时/);
    const started = await runtime.startUltraReview({ cwd: project, target: "123", timeoutMinutes: 10 });
    assert.equal(started.status, "running");
    await waitForCondition(() => runtime.listUltraReviews(project)[0]?.status === "completed");
    const completed = runtime.listUltraReviews(project)[0];
    assert.equal(completed.status, "completed");
    assert.match(completed.output, /Fixture finding/);
    assert.doesNotMatch(completed.output, /ultra-secret/);
    assert.equal((await fs.stat(path.join(stateDirectory, "claude", "ultra-reviews.json"))).mode & 0o777, 0o600);
    const args = JSON.parse((await fs.readFile(path.join(home, ".wfl-claude", "ultrareview-args.jsonl"), "utf8"))
      .trim().split("\n")[0]);
    assert.deepEqual(args, ["ultrareview", "--json", "--timeout", "10", "123"]);

    const slow = await runtime.startUltraReview({ cwd: project, target: "slow", timeoutMinutes: 10 });
    assert.equal((await runtime.cancelUltraReview(slow.id)).status, "cancelling");
    await waitForCondition(() => runtime.listUltraReviews(project).find((review) => review.id === slow.id)?.status === "cancelled");
    await runtime.destroy();
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot: project, legacy: true },
      store,
      appVersion: "test",
      command,
    }).initialize();
    assert.equal(runtime.listUltraReviews(project).some((review) => review.status === "completed"), true);
    assert.equal(runtime.listUltraReviews(project).some((review) => review.status === "cancelled"), true);
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude runtime keeps native sessions separate and normalizes stream-json output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-runtime-"));
  const command = path.join(root, "fake-claude.mjs");
  let runtime = null;
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from "node:fs/promises";
import readline from "node:readline";
if (process.argv[2] === "plugin") {
  if (process.argv[3] === "marketplace" && process.argv[4] === "list") {
    process.stdout.write(JSON.stringify([{ name: "fixture-market", source: "https://example.test/fixture-market.git", sourceType: "git", trusted: true }]) + "\\n");
  } else if (process.argv[3] === "list" && process.argv.includes("--available")) {
    process.stdout.write(JSON.stringify({
      installed: [{ id: "review-kit@fixture-market", name: "review-kit", marketplace: "fixture-market", version: "1.2.3", scope: "user", enabled: true }],
      available: [{
        id: "review-kit@fixture-market",
        name: "review-kit",
        marketplace: "fixture-market",
        version: "1.2.3",
        description: "Reviews changes",
        permissions: ["Read", "Bash(git diff *)"]
      }]
    }) + "\\n");
  } else if (process.argv[3] === "list") {
    process.stdout.write(JSON.stringify([{ id: "review-kit@fixture-market", name: "review-kit", marketplace: "fixture-market", version: "1.2.3", scope: "user", enabled: true }]) + "\\n");
  } else if (process.argv[3] === "details") {
    await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/plugin-args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
    if (process.argv[4] === "broken@fixture-market") {
      process.stderr.write("EACCES /srv/private/account/plugin.json API_KEY=plugin-error-secret\\n");
      process.exit(1);
    }
    process.stdout.write("review-kit components: 2; projected tokens: 420; API_KEY=plugin-secret\\n");
  } else if (process.argv[3] === "validate") {
    await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/plugin-args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
    process.stdout.write("Plugin validation passed\\n");
  } else if (process.argv[3] === "prune") {
    await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/plugin-args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
    process.stdout.write(process.argv.includes("--dry-run") ? "Would remove 1 dependency\\n" : "Removed 1 dependency\\n");
  } else if (process.argv[3] === "eval") {
    await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/plugin-args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
    process.stdout.write('{"score":1,"API_KEY":"eval-secret"}\\n');
  } else if (process.argv[3] === "init") {
    await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/plugin-args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
    process.stdout.write("Plugin scaffold created\\n");
  } else if (process.argv[3] === "tag") {
    await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/plugin-args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
    process.stdout.write("Would create fixture-session-plugin--v1.0.0\\n");
  } else {
    await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/plugin-args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
  }
  process.exit(0);
}
if (process.argv.includes("auth") && process.argv.includes("status")) {
  let loggedIn = false;
  try {
    await fs.access(process.env.CLAUDE_CONFIG_DIR + "/submitted-code.txt");
    loggedIn = true;
  } catch {}
  process.stdout.write(JSON.stringify({
    loggedIn,
    authMethod: loggedIn ? "claude.ai" : "none",
    email: loggedIn ? "fixture@example.test" : null,
    subscriptionType: loggedIn ? "max" : null
  }) + "\\n");
  process.exit(0);
}
if (process.argv.includes("auth") && process.argv.includes("login")) {
  process.stdout.write("If the browser didn't open, visit: https://claude.com/oauth/authorize?fixture=1\\n");
  process.stdout.write("Paste code here if prompted > ");
  const input = readline.createInterface({ input: process.stdin });
  input.once("line", async (code) => {
    await fs.writeFile(process.env.CLAUDE_CONFIG_DIR + "/submitted-code.txt", code);
    process.exit(0);
  });
} else {
  await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
  const sessionIndex = process.argv.indexOf("--session-id");
  const resumeIndex = process.argv.indexOf("--resume");
  const fromPrIndex = process.argv.indexOf("--from-pr");
  const sessionId = process.argv.includes("--fork-session")
    ? "22222222-2222-4222-8222-222222222222"
    : sessionIndex !== -1
      ? process.argv[sessionIndex + 1]
      : resumeIndex !== -1
        ? process.argv[resumeIndex + 1]
        : fromPrIndex !== -1
          ? "33333333-3333-4333-8333-333333333333"
          : null;
  const input = readline.createInterface({ input: process.stdin });
  let turn = 0;
  input.on("line", async (line) => {
    const incoming = JSON.parse(line);
    if (incoming.type === "control_request" && incoming.request?.subtype === "initialize") {
      process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: incoming.request_id, response: {} } }) + "\\n");
      return;
    }
    if (incoming.type !== "user") return;
    await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/inputs.jsonl", JSON.stringify(incoming) + "\\n");
    turn += 1;
    const suffix = process.pid + "-" + turn;
    const permissionMode = process.argv[process.argv.indexOf("--permission-mode") + 1];
    const model = process.argv[process.argv.indexOf("--model") + 1];
    const toolId = "tool-" + suffix;
    const toolMessageId = "tool-message-" + suffix;
    const textMessageId = "text-message-" + suffix;
    const write = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
    write({ type: "system", subtype: "init", session_id: sessionId, uid: process.getuid?.(), permissionMode, model });
    write({ type: "hook_started", hook_id: "hook-" + suffix, hook_event_name: "PreToolUse", hook_name: "Bash validation", status: "started" });
    write({ type: "hook_response", hook_id: "hook-" + suffix, hook_event_name: "PreToolUse", hook_name: "Bash validation", outcome: "success" });
    const taskId = "agent-task-" + suffix;
    const taskStartedAt = Date.now() - 1250;
    write({
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      tool_use_id: "task-tool-" + suffix,
      description: "Review the fixture project",
      subagent_type: "Explore",
      task_type: "local_agent",
      workflow_name: "fixture-review",
      started_at: taskStartedAt,
    });
    write({
      type: "system",
      subtype: "task_progress",
      task_id: taskId,
      summary: "Inspecting the focused files",
      last_tool_name: "Read",
      usage: { total_tokens: 180, tool_uses: 2, duration_ms: 700 },
      updated_at: taskStartedAt + 700,
    });
    write({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      status: "completed",
      summary: "Fixture review complete",
      usage: { total_tokens: 240, tool_uses: 3, duration_ms: 1250 },
      completed_at: taskStartedAt + 1250,
    });
    write({
      type: "system",
      subtype: "task_notification",
      task_id: "stopped-task-" + suffix,
      description: "Stopped fixture task",
      status: "stopped",
    });
    write({
      type: "system",
      subtype: "task_started",
      task_id: "hidden-task-" + suffix,
      description: "Hidden fixture task",
      skip_transcript: true,
    });
    write({ type: "stream_event", session_id: sessionId, event: { type: "message_start", message: { id: toolMessageId } } });
    write({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    write({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspecting fixture" } } });
    write({ type: "stream_event", session_id: sessionId, event: { type: "content_block_stop", index: 0 } });
    write({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: toolId, name: "Bash", input: {} } } });
    write({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\\\"command\\\":\\\"pwd\\\"}" } } });
    write({ type: "stream_event", session_id: sessionId, event: { type: "content_block_stop", index: 1 } });
    write({ type: "assistant", session_id: sessionId, message: { id: toolMessageId, content: [
      { type: "thinking", thinking: "Inspecting fixture" },
      { type: "tool_use", id: toolId, name: "Bash", input: { command: "pwd" } },
    ] } });
    write({ type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: toolId, content: process.cwd(), is_error: false }] }, tool_use_result: { stdout: process.cwd() } });
    write({ type: "stream_event", session_id: sessionId, event: { type: "message_start", message: { id: textMessageId } } });
    write({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    write({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture response" } } });
    write({ type: "stream_event", session_id: sessionId, event: { type: "content_block_stop", index: 0 } });
    write({ type: "assistant", session_id: sessionId, message: { id: textMessageId, content: [{ type: "text", text: "fixture response" }] } });
    if (String(incoming.message?.content || "").includes("/compact")) {
      write({ type: "system", subtype: "compact_boundary", session_id: sessionId, compact_metadata: { trigger: "manual" } });
    }
    write({ type: "prompt_suggestion", session_id: sessionId, suggestion: "Run the focused tests" });
    write({ type: "result", uuid: "result-" + suffix, session_id: sessionId, result: "fixture response", structured_output: { verdict: "pass", count: 2 }, duration_ms: 1250, duration_api_ms: 900, num_turns: 2, total_cost_usd: 0.0123, usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 40 }, modelUsage: { [model]: { input_tokens: 120, output_tokens: 30, costUSD: 0.0123 } } });
  });
}
`, { mode: 0o700 });

  try {
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    const extraProject = path.join(project, "shared");
    await fs.mkdir(extraProject);
    const sessionPlugin = path.join(project, "fixture-plugin");
    await fs.mkdir(path.join(sessionPlugin, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(sessionPlugin, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "fixture-session-plugin", version: "1.0.0" })}\n`,
    );
    const downloadedPluginZip = storedZip({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "fixture-url-plugin", version: "1.0.0" }),
    });
    const attachmentPath = path.join(project, "fixture-note.txt");
    await fs.writeFile(attachmentPath, "fixture attachment");
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    await store.create({ name: "fixture", baseUrl: "http://127.0.0.1:9999", model: "fixture-model", apiKey: "fixture-key" });
    const runtimeOptions = {
      user: {
        stateDirectory,
        home,
        projectRoot: project,
        systemUsername: "fixture",
        legacy: false,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
      },
      store,
      appVersion: "test",
      command,
      pluginUrlDownloader: async (url) => {
        assert.equal(url, "https://plugins.example.test/reviewer.zip");
        return downloadedPluginZip;
      },
    };
    runtime = await new ClaudeRuntime(runtimeOptions).initialize();
    await runtime.saveAgent({
      name: "reviewer",
      description: "Reviews the fixture release",
      tools: ["Read", "Grep"],
      model: "sonnet",
      body: "Review the current changes and report release blockers.",
    });
    const savedMemory = await runtime.saveMemory(project, "Use the fixture project conventions.\nNever expose test credentials.");
    assert.deepEqual(savedMemory, {
      cwd: project,
      text: "Use the fixture project conventions.\nNever expose test credentials.",
      configured: true,
      length: 67,
    });
    assert.equal((await fs.stat(runtime.memoryPath(project))).mode & 0o777, 0o600);
    assert.deepEqual(await runtime.readMemory(project), savedMemory);
    await assert.rejects(runtime.saveMemory(root, "outside"), /超出账号范围/);
    await assert.rejects(runtime.saveMemory(project, "x".repeat(32_001)), /不能超过 32,000/);
    const savedHooks = await runtime.saveHooks(project, [{
      event: "PreToolUse",
      matcher: "Bash",
      command: "npm test",
      timeout: 20,
    }, {
      event: "SessionEnd",
      matcher: "",
      command: "node scripts/cleanup.mjs",
      timeout: 5,
    }]);
    assert.equal(savedHooks.configured, true);
    assert.equal(savedHooks.count, 2);
    assert.deepEqual(savedHooks.native.PreToolUse, [{
      matcher: "Bash",
      hooks: [{ type: "command", command: "npm test", timeout: 20 }],
    }]);
    const hooksPath = runtime.hooksPath(project);
    const hooksStat = await fs.stat(hooksPath);
    assert.equal(hooksStat.mode & 0o777, 0o600);
    await fs.chmod(hooksPath, 0o640);
    await assert.rejects(runtime.readHooks(project), /配置文件不安全/);
    await fs.chmod(hooksPath, 0o600);
    const originalUser = runtime.user;
    runtime.user = { ...originalUser, uid: hooksStat.uid + 1 };
    await assert.rejects(runtime.readHooks(project), /配置文件不安全/);
    runtime.user = originalUser;
    const hooksBackup = `${hooksPath}.real`;
    await fs.rename(hooksPath, hooksBackup);
    await fs.symlink(hooksBackup, hooksPath);
    await assert.rejects(runtime.readHooks(project), /配置文件不安全/);
    await fs.rm(hooksPath);
    await fs.rename(hooksBackup, hooksPath);
    await assert.rejects(runtime.saveHooks(project, [{ event: "Unknown", command: "true" }]), /配置无效/);
    await runtime.saveMcpServer({
      name: "session-tools",
      type: "stdio",
      command: "node",
      args: ["fixture-mcp.mjs"],
      environment: { SESSION_SECRET: "session-mcp-secret" },
      sensitiveMode: "replace",
    });
    const session = await runtime.startSession({
      cwd: project,
      fallbackModel: "haiku,sonnet",
      maxBudgetUsd: 1.25,
      autocompact: 1_000_000,
      allowedTools: ["Read", "Bash(git status *)"],
      disallowedTools: ["Write"],
      agent: "reviewer",
      systemPrompt: "You are the fixture release reviewer.",
      excludeDynamicSystemPromptSections: true,
      settingSources: ["user", "project"],
      strictMcpConfig: true,
      mcpServerNames: ["session-tools"],
      jsonSchema: JSON.stringify({
        type: "object",
        properties: { verdict: { type: "string" }, count: { type: "integer" } },
        required: ["verdict", "count"],
      }),
      inlineAgentNames: ["reviewer"],
      brief: true,
      remoteFiles: [{ fileId: "file_fixture123", relativePath: "references/release.pdf" }],
      pluginDirectories: ["fixture-plugin"],
      pluginUrls: ["https://plugins.example.test/reviewer.zip"],
      betaHeaders: ["files-api-2025-04-14"],
    });
    assert.equal(session.permissionMode, "acceptEdits");
    assert.equal(session.fallbackModel, "haiku,sonnet");
    assert.equal(session.maxBudgetUsd, 1.25);
    assert.equal(session.autocompact, 1_000_000);
    assert.deepEqual(session.allowedTools, ["Read", "Bash(git status *)"]);
    assert.deepEqual(session.disallowedTools, ["Write"]);
    assert.equal(session.agent, "reviewer");
    assert.equal(session.systemPrompt, "You are the fixture release reviewer.");
    assert.equal(session.excludeDynamicSystemPromptSections, true);
    assert.deepEqual(session.settingSources, ["user", "project"]);
    assert.equal(session.strictMcpConfig, true);
    assert.deepEqual(session.mcpServerNames, ["session-tools"]);
    assert.equal(JSON.parse(session.jsonSchema).type, "object");
    assert.deepEqual(session.inlineAgentNames, ["reviewer"]);
    assert.equal(session.brief, true);
    assert.deepEqual(session.remoteFiles, [{
      fileId: "file_fixture123",
      relativePath: "references/release.pdf",
    }]);
    assert.deepEqual(session.pluginDirectories, [sessionPlugin]);
    assert.deepEqual(session.pluginUrls, ["https://plugins.example.test/reviewer.zip"]);
    assert.deepEqual(session.betaHeaders, ["files-api-2025-04-14"]);
    await assert.rejects(runtime.startSession({ cwd: project, maxBudgetUsd: 10_001 }), /预算必须/);
    await assert.rejects(runtime.startSession({ cwd: project, autocompact: 99_999 }), /自动压缩窗口必须/);
    await assert.rejects(runtime.startSession({ cwd: project, agent: "--dangerous" }), /Agent 名称无效/);
    await assert.rejects(runtime.startSession({
      cwd: project,
      remoteFiles: ["file_fixture123:../outside.pdf"],
    }), /越界目录|安全的工程内相对路径/);
    await assert.rejects(runtime.startSession({
      cwd: project,
      pluginUrls: ["https://127.0.0.1/private.zip"],
    }), /公开 HTTPS|本地|私有/);
    const initialized = new Promise((resolve) => {
      runtime.on("event", (event) => {
        if (event.event?.type === "system" && event.sessionId === session.id) resolve(event.event);
      });
    });
    const completed = new Promise((resolve) => {
      runtime.on("event", (event) => {
        if (event.type === "result" && event.sessionId === session.id) resolve(event);
      });
    });
    await runtime.sendMessage(session.id, "Inspect this project", [{
      name: "fixture-note.txt",
      path: attachmentPath,
      mediaType: "text/plain",
      size: 18,
    }]);
    const initEvent = await initialized;
    assert.equal(initEvent.permissionMode, "acceptEdits");
    assert.equal(initEvent.uid, process.getuid?.());
    await completed;
    const restored = runtime.readSession(session.id);
    assert.equal(restored.name, "Inspect this project");
    assert.equal(restored.messages.find((item) => item.role === "user")?.attachments?.[0]?.path, attachmentPath);
    const nativeInputs = (await fs.readFile(path.join(home, ".wfl-claude", "inputs.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const invocationsBeforeRestart = (await fs.readFile(path.join(home, ".wfl-claude", "args.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--fallback-model") + 1], "haiku,sonnet");
    assert.equal(invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--max-budget-usd") + 1], "1.25");
    assert.equal(invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--autocompact") + 1], "1000000");
    assert.equal(invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--allowed-tools") + 1], "Read,Bash(git status *)");
    assert.equal(invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--disallowed-tools") + 1], "Write");
    assert.equal(invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--agent") + 1], "reviewer");
    assert.equal(invocationsBeforeRestart[0].includes("--brief"), true);
    const inlineAgents = JSON.parse(
      invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--agents") + 1],
    );
    assert.deepEqual(inlineAgents.reviewer, {
      description: "Reviews the fixture release",
      prompt: "Review the current changes and report release blockers.",
      tools: ["Read", "Grep"],
      model: "sonnet",
    });
    assert.equal(
      invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--file") + 1],
      "file_fixture123:references/release.pdf",
    );
    const pluginArguments = invocationsBeforeRestart[0]
      .flatMap((entry, index, values) => entry === "--plugin-dir" ? [values[index + 1]] : []);
    assert.equal(pluginArguments[0], sessionPlugin);
    assert.equal(pluginArguments.length, 2);
    assert.equal(pluginArguments[1].startsWith(runtime.sessionPluginDirectory(session.id)), true);
    assert.equal((await fs.stat(pluginArguments[1])).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(invocationsBeforeRestart[0]), /plugins\.example\.test/);
    assert.equal(
      invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--betas") + 1],
      "files-api-2025-04-14",
    );
    assert.equal(
      invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--system-prompt") + 1],
      "You are the fixture release reviewer.",
    );
    assert.equal(invocationsBeforeRestart[0].includes("--exclude-dynamic-system-prompt-sections"), false);
    assert.equal(
      invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--setting-sources") + 1],
      "user,project",
    );
    assert.equal(invocationsBeforeRestart[0].includes("--strict-mcp-config"), true);
    const sessionMcpPath = invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--mcp-config") + 1];
    assert.equal(sessionMcpPath, runtime.sessionMcpConfigPath(session.id));
    assert.equal((await fs.stat(sessionMcpPath)).mode & 0o777, 0o600);
    const sessionMcp = JSON.parse(await fs.readFile(sessionMcpPath, "utf8"));
    assert.deepEqual(Object.keys(sessionMcp.mcpServers), ["session-tools"]);
    assert.equal(sessionMcp.mcpServers["session-tools"].env.SESSION_SECRET, "session-mcp-secret");
    assert.doesNotMatch(JSON.stringify(invocationsBeforeRestart[0]), /session-mcp-secret/);
    assert.deepEqual(
      JSON.parse(invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--json-schema") + 1]).required,
      ["verdict", "count"],
    );
    assert.equal(
      invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--append-system-prompt") + 1],
      [
        "Project Memory (server-managed, read-only context):",
        "Use the fixture project conventions.",
        "Never expose test credentials.",
      ].join("\n"),
    );
    assert.equal(invocationsBeforeRestart[0][invocationsBeforeRestart[0].indexOf("--settings") + 1], runtime.hooksPath(project));
    assert.equal(invocationsBeforeRestart[0].includes("--include-hook-events"), true);
    const nativeHooks = JSON.parse(await fs.readFile(runtime.hooksPath(project), "utf8"));
    assert.deepEqual(nativeHooks.hooks, savedHooks.native);
    assert.match(nativeInputs[0].message.content, /Use the Read tool/);
    assert.match(nativeInputs[0].message.content, /fixture-note\.txt/);
    assert.deepEqual(restored.messages.filter((item) => item.type === "message").map((message) => [message.role, message.content]), [
      ["user", "Inspect this project"],
      ["assistant", "fixture response"],
    ]);
    assert.equal(restored.messages.find((item) => item.type === "thinking")?.content, "Inspecting fixture");
    const hookEvents = restored.messages.filter((item) => item.type === "system" && item.subtype?.startsWith("hook_"));
    assert.deepEqual(hookEvents.map((item) => [item.subtype, item.status]), [
      ["hook_started", "inProgress"],
      ["hook_response", "completed"],
    ]);
    assert.match(hookEvents[0].content, /PreToolUse · Bash validation · started/);
    const agentTask = restored.messages.find((item) => item.type === "task" && item.title === "Review the fixture project");
    assert.equal(agentTask.status, "completed");
    assert.equal(agentTask.subtype, "task_notification");
    assert.equal(agentTask.subagentType, "Explore");
    assert.equal(agentTask.taskType, "local_agent");
    assert.equal(agentTask.workflowName, "fixture-review");
    assert.equal(agentTask.lastToolName, "Read");
    assert.equal(agentTask.content, "Fixture review complete");
    assert.deepEqual(agentTask.usage, { totalTokens: 240, toolUses: 3, durationMs: 1250 });
    assert.equal(agentTask.finishedAt - agentTask.startedAt, 1250);
    assert.equal(restored.messages.find((item) => item.type === "task" && item.title === "Stopped fixture task")?.status, "interrupted");
    assert.equal(restored.messages.some((item) => item.type === "task" && item.title === "Hidden fixture task"), false);
    const bash = restored.messages.find((item) => item.type === "tool" && item.name === "Bash");
    assert.equal(bash.input.command, "pwd");
    assert.equal(bash.output, project);
    assert.equal(bash.status, "completed");
    const resultItem = restored.messages.find((item) => item.type === "result");
    assert.equal(resultItem.durationMs, 1250);
    assert.equal(resultItem.costUsd, 0.0123);
    assert.equal(resultItem.usage.input_tokens, 120);
    assert.deepEqual(resultItem.structuredOutput, { verdict: "pass", count: 2 });
    assert.equal(restored.resolvedModel, "fixture-model");
    assert.equal(restored.suggestion, "Run the focused tests");
    assert.equal(restored.usageSummary.contextUsedTokens, 160);
    assert.equal(restored.usageSummary.totalTokens, 190);
    assert.equal(restored.usageSummary.costUsd, 0.0123);

    await runtime.destroy();
    runtime = await new ClaudeRuntime(runtimeOptions).initialize();
    assert.deepEqual(
      runtime.readSession(session.id).messages
        .filter((item) => item.type === "system" && item.subtype?.startsWith("hook_"))
        .map((item) => item.subtype),
      ["hook_started", "hook_response"],
    );
    const restoredAgentTask = runtime.readSession(session.id).messages
      .find((item) => item.type === "task" && item.title === "Review the fixture project");
    assert.equal(restoredAgentTask.status, "completed");
    assert.deepEqual(restoredAgentTask.usage, { totalTokens: 240, toolUses: 3, durationMs: 1250 });
    const resumed = new Promise((resolve) => {
      runtime.on("event", (event) => {
        if (event.type === "result" && event.sessionId === session.id) resolve(event);
      });
    });
    await runtime.sendMessage(session.id, "Continue after restart");
    await resumed;
    let invocations = (await fs.readFile(path.join(home, ".wfl-claude", "args.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations[0].includes("--session-id"), true);
    assert.equal(invocations[0].includes("--resume"), false);
    assert.equal(invocations[1].includes("--resume"), true);
    assert.equal(invocations[1].includes("--session-id"), false);

    const configured = await runtime.configureSession(session.id, {
      model: "fixture-opus",
      effort: "high",
      permissionMode: "plan",
      fallbackModel: "haiku",
      maxBudgetUsd: 2,
      autocompact: 200_000,
      allowedTools: ["Read"],
      disallowedTools: ["Bash(rm *)"],
      agent: "security-review",
    });
    assert.equal(configured.effort, "high");
    assert.equal(configured.fallbackModel, "haiku");
    assert.equal(configured.maxBudgetUsd, 2);
    assert.equal(configured.autocompact, 200_000);
    assert.deepEqual(configured.allowedTools, ["Read"]);
    assert.deepEqual(configured.disallowedTools, ["Bash(rm *)"]);
    assert.equal(configured.agent, "security-review");
    const configuredTurn = new Promise((resolve) => {
      runtime.on("event", (event) => {
        if (event.type === "result" && event.sessionId === session.id) resolve(event);
      });
    });
    await runtime.sendMessage(session.id, "Use updated settings");
    await configuredTurn;
    invocations = (await fs.readFile(path.join(home, ".wfl-claude", "args.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations[2][invocations[2].indexOf("--model") + 1], "fixture-opus");
    assert.equal(invocations[2][invocations[2].indexOf("--effort") + 1], "high");
    assert.equal(invocations[2][invocations[2].indexOf("--permission-mode") + 1], "plan");
    assert.equal(invocations[2][invocations[2].indexOf("--fallback-model") + 1], "haiku");
    assert.equal(invocations[2][invocations[2].indexOf("--max-budget-usd") + 1], "2");
    assert.equal(invocations[2][invocations[2].indexOf("--autocompact") + 1], "200000");
    assert.equal(invocations[2][invocations[2].indexOf("--allowed-tools") + 1], "Read");
    assert.equal(invocations[2][invocations[2].indexOf("--disallowed-tools") + 1], "Bash(rm *)");
    assert.equal(invocations[2][invocations[2].indexOf("--agent") + 1], "security-review");
    assert.equal(invocations[2].includes("--resume"), true);

    const renamed = await runtime.renameSession(session.id, "Fixture conversation");
    assert.equal(renamed.name, "Fixture conversation");
    const fork = await runtime.startSession({ cwd: project, forkedFrom: session.id });
    assert.deepEqual(fork.messages, runtime.readSession(session.id).messages);
    const forkCompleted = new Promise((resolve) => {
      runtime.on("event", (event) => {
        if (event.type === "result" && event.sessionId === fork.id) resolve(event);
      });
    });
    await runtime.sendMessage(fork.id, "Continue on a fork");
    await forkCompleted;
    invocations = (await fs.readFile(path.join(home, ".wfl-claude", "args.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations[3].includes("--fork-session"), true);
    assert.equal(invocations[3].includes("--resume"), true);
    await runtime.archiveSession(fork.id, true);
    assert.equal(runtime.listSessions({ cwd: project }).some((entry) => entry.id === fork.id), false);
    assert.equal(runtime.listSessions({ cwd: project, archived: true }).some((entry) => entry.id === fork.id), true);
    await runtime.removeSession(fork.id);
    assert.equal(runtime.listSessions({ cwd: project, archived: true }).some((entry) => entry.id === fork.id), false);

    const isolated = await runtime.startSession({
      cwd: project,
      workspaceMode: "worktree",
      worktreeName: "review-task",
      additionalDirectories: [extraProject],
    });
    const isolatedCompleted = new Promise((resolve) => {
      runtime.on("event", (event) => {
        if (event.type === "result" && event.sessionId === isolated.id) resolve(event);
      });
    });
    await runtime.sendMessage(isolated.id, "Work in isolation");
    await isolatedCompleted;
    invocations = (await fs.readFile(path.join(home, ".wfl-claude", "args.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations[4][invocations[4].indexOf("--worktree") + 1], "review-task");
    assert.equal(invocations[4][invocations[4].indexOf("--add-dir") + 1], extraProject);
    await runtime.closeSession(isolated.id);
    const isolatedResumed = new Promise((resolve) => {
      runtime.on("event", (event) => {
        if (event.type === "result" && event.sessionId === isolated.id) resolve(event);
      });
    });
    await runtime.sendMessage(isolated.id, "Resume isolation");
    await isolatedResumed;
    invocations = (await fs.readFile(path.join(home, ".wfl-claude", "args.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations[5].includes("--resume"), true);
    assert.equal(invocations[5].includes("--worktree"), false);
    assert.equal(invocations[5][invocations[5].indexOf("--add-dir") + 1], extraProject);
    await runtime.removeSession(isolated.id);
    await assert.rejects(runtime.startSession({
      cwd: project,
      additionalDirectories: [root],
    }), /超出账号工程范围/);
    const outsideDirectory = path.join(root, "outside-extra");
    const linkedOutsideDirectory = path.join(project, "linked-outside");
    await fs.mkdir(outsideDirectory);
    await fs.symlink(outsideDirectory, linkedOutsideDirectory);
    await assert.rejects(runtime.startSession({
      cwd: project,
      additionalDirectories: [linkedOutsideDirectory],
    }), /超出账号工程范围/);
    await assert.rejects(runtime.startSession({
      cwd: project,
      additionalDirectories: [path.join(project, "missing-extra")],
    }), /不存在或不可访问/);

    assert.deepEqual((await runtime.listPlugins())[0], {
      identifier: "review-kit@fixture-market",
      name: "review-kit",
      marketplace: "fixture-market",
      version: "1.2.3",
      description: null,
      scope: "user",
      enabled: true,
      editable: true,
    });
    const pluginMarket = await runtime.pluginMarketplaceSnapshot();
    assert.deepEqual(pluginMarket.marketplaces, [{
      name: "fixture-market",
      source: "https://example.test/fixture-market.git",
      sourceType: "git",
      installLocation: null,
      lastUpdated: null,
      trusted: true,
    }]);
    assert.deepEqual(pluginMarket.available[0].permissions, ["Read", "Bash(git diff *)"]);
    assert.equal(pluginMarket.available[0].installed, true);
    await runtime.addPluginMarketplace("fixture-owner/fixture-market");
    await runtime.updatePluginMarketplace("fixture-market");
    await runtime.removePluginMarketplace("fixture-market");
    await assert.rejects(runtime.addPluginMarketplace("https://localhost/private.git"), /不能指向本地或私有网络/);
    await runtime.installPlugin("review-kit@fixture-market");
    await runtime.setPluginEnabled("review-kit@fixture-market", false);
    await runtime.removePlugin("review-kit@fixture-market");
    const pluginDetails = await runtime.pluginDetails("review-kit@fixture-market");
    assert.match(pluginDetails.details, /projected tokens: 420/);
    assert.doesNotMatch(pluginDetails.details, /plugin-secret/);
    await runtime.updatePlugin("review-kit@fixture-market");
    const pluginValidation = await runtime.validatePlugin(project, "fixture-plugin");
    assert.equal(pluginValidation.valid, true);
    assert.equal(pluginValidation.path, "fixture-plugin");
    assert.match(pluginValidation.diagnostics, /validation passed/);
    const prunePreview = await runtime.prunePlugins({ dryRun: true });
    assert.match(prunePreview.diagnostics, /Would remove/);
    await assert.rejects(runtime.prunePlugins({ dryRun: false }), /确认不匹配/);
    const pruned = await runtime.prunePlugins({
      dryRun: false,
      confirmation: "清理未使用插件",
    });
    assert.match(pruned.diagnostics, /Removed 1/);
    const pluginInvocations = (await fs.readFile(path.join(home, ".wfl-claude", "plugin-args.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(pluginInvocations.map((args) => args.slice(0, 3)), [
      ["plugin", "marketplace", "add"],
      ["plugin", "marketplace", "update"],
      ["plugin", "marketplace", "remove"],
      ["plugin", "install", "review-kit@fixture-market"],
      ["plugin", "disable", "review-kit@fixture-market"],
      ["plugin", "uninstall", "review-kit@fixture-market"],
      ["plugin", "details", "review-kit@fixture-market"],
      ["plugin", "update", "review-kit@fixture-market"],
      ["plugin", "validate", "--strict"],
      ["plugin", "prune", "--scope"],
      ["plugin", "prune", "--scope"],
    ]);
    assert.equal(pluginInvocations.slice(3, 6).every((args) => args.includes("user")), true);
    assert.equal(pluginInvocations[7].includes("user"), true);
    assert.equal(pluginInvocations[8].at(-1), sessionPlugin);
    assert.equal(pluginInvocations[9].includes("--dry-run"), true);
    assert.equal(pluginInvocations[10].includes("--yes"), true);

    const initializedPlugin = await runtime.initializePlugin({
      name: "fixture-admin-plugin",
      description: "Fixture admin plugin",
      components: ["skills", "agents"],
    });
    assert.deepEqual(initializedPlugin.components, ["skills", "agents"]);
    const evaluatedPlugin = await runtime.evaluatePlugin(project, {
      target: "./fixture-plugin",
      maxCostUsd: 2,
      runs: 2,
      threshold: 0.8,
    });
    assert.equal(evaluatedPlugin.thresholdPassed, true);
    assert.doesNotMatch(evaluatedPlugin.diagnostics, /eval-secret/);
    await assert.rejects(runtime.evaluatePlugin(project, {
      target: "./fixture-plugin",
      maxCostUsd: 101,
    }), /成本上限/);
    const tagPreview = await runtime.previewPluginTag(project, "fixture-plugin");
    assert.match(tagPreview.plan, /fixture-session-plugin--v1\.0\.0/);
    await assert.rejects(runtime.createPluginTag({
      cwd: project,
      path: "fixture-plugin",
      previewToken: tagPreview.previewToken,
      confirmation: "wrong",
    }), /确认不匹配/);
    const tagCreated = await runtime.createPluginTag({
      cwd: project,
      path: "fixture-plugin",
      previewToken: tagPreview.previewToken,
      confirmation: "创建 Claude 插件标签",
    });
    assert.equal(tagCreated.created, true);
    const adminPluginInvocations = (await fs.readFile(path.join(home, ".wfl-claude", "plugin-args.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line)).slice(11);
    assert.deepEqual(adminPluginInvocations.map((args) => args.slice(0, 3)), [
      ["plugin", "init", "fixture-admin-plugin"],
      ["plugin", "eval", sessionPlugin],
      ["plugin", "tag", "--dry-run"],
      ["plugin", "tag", "--dry-run"],
      ["plugin", "tag", sessionPlugin],
    ]);
    assert.equal(adminPluginInvocations[0].includes("--with"), true);
    assert.equal(adminPluginInvocations[1].includes("--no-scaffold"), true);
    assert.equal(adminPluginInvocations[1].includes("--max-cost-usd"), true);
    assert.equal(adminPluginInvocations[4].includes("--push"), false);
    assert.equal(adminPluginInvocations[4].includes("--force"), false);
    await assert.rejects(
      runtime.pluginDetails("broken@fixture-market"),
      (error) => (
        /原始诊断已隐藏/.test(error.message)
        && !/\/srv\/private|plugin-error-secret|API_KEY/.test(error.message)
      ),
    );

    const safeConfigured = await runtime.configureSession(session.id, {
      systemPrompt: null,
      excludeDynamicSystemPromptSections: true,
      safeMode: true,
      strictMcpConfig: true,
      mcpServerNames: ["session-tools"],
    });
    assert.equal(safeConfigured.systemPrompt, null);
    assert.equal(safeConfigured.safeMode, true);
    const safeCompleted = new Promise((resolve) => {
      runtime.on("event", (event) => {
        if (event.type === "result" && event.sessionId === session.id) resolve(event);
      });
    });
    await runtime.sendMessage(session.id, "Run in safe mode");
    await safeCompleted;
    let launchInvocations = (await fs.readFile(path.join(home, ".wfl-claude", "args.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const safeArgs = launchInvocations.at(-1);
    assert.equal(safeArgs.includes("--safe-mode"), true);
    assert.equal(safeArgs.includes("--exclude-dynamic-system-prompt-sections"), true);
    assert.equal(safeArgs.includes("--append-system-prompt"), false);
    assert.equal(safeArgs.includes("--settings"), false);
    assert.equal(safeArgs.includes("--strict-mcp-config"), false);
    assert.equal(safeArgs.includes("--mcp-config"), false);
    assert.equal(safeArgs.includes("--agents"), false);
    assert.equal(safeArgs.includes("--plugin-dir"), false);

    const ephemeral = await runtime.startSession({
      cwd: project,
      noSessionPersistence: true,
      jsonSchema: '{"type":"object"}',
    });
    assert.equal(ephemeral.noSessionPersistence, true);
    const ephemeralCompleted = new Promise((resolve) => {
      runtime.on("event", (event) => {
        if (event.type === "result" && event.sessionId === ephemeral.id) resolve(event);
      });
    });
    await runtime.sendMessage(ephemeral.id, "Run without persistence");
    await ephemeralCompleted;
    launchInvocations = (await fs.readFile(path.join(home, ".wfl-claude", "args.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(launchInvocations.at(-1).includes("--no-session-persistence"), true);
    const persistedSessions = JSON.parse(await fs.readFile(runtime.sessionsPath, "utf8"));
    assert.equal(persistedSessions.sessions.some((entry) => entry.id === ephemeral.id), false);
    await assert.rejects(
      runtime.configureSession(ephemeral.id, { noSessionPersistence: false }),
      /只能在 Claude 首次启动前修改/,
    );
    await runtime.closeSession(ephemeral.id);
    await assert.rejects(
      runtime.sendMessage(ephemeral.id, "Cannot resume this process"),
      /临时 Claude 对话的原生进程已结束/,
    );
    await runtime.removeSession(ephemeral.id);
    await assert.rejects(
      runtime.startSession({ cwd: project, jsonSchema: '{"type":' }),
      /不是有效 JSON/,
    );

    const fromPrSession = await runtime.startSession({
      cwd: project,
      fromPr: "https://github.com/example/repository/pull/321",
    });
    const fromPrCompleted = new Promise((resolve) => {
      runtime.on("event", (event) => {
        if (event.type === "result" && event.sessionId === fromPrSession.id) resolve(event);
      });
    });
    await runtime.sendMessage(fromPrSession.id, "Continue the pull request");
    await fromPrCompleted;
    launchInvocations = (await fs.readFile(path.join(home, ".wfl-claude", "args.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const fromPrArgs = launchInvocations.at(-1);
    assert.equal(fromPrArgs[fromPrArgs.indexOf("--from-pr") + 1], "https://github.com/example/repository/pull/321");
    assert.equal(fromPrArgs.includes("--session-id"), false);
    assert.equal(fromPrArgs.includes("--file"), false);
    await runtime.removeSession(fromPrSession.id);

    const loginEvents = [];
    const loginReady = new Promise((resolve) => {
      runtime.on("status", (status) => {
        if (status.officialLogin?.requiresCode) resolve(status.officialLogin);
      });
    });
    const loginCompleted = new Promise((resolve) => {
      runtime.on("event", (event) => {
        loginEvents.push(event);
        if (event.type === "auth/login-completed") resolve(event);
      });
    });
    const startedLogin = await runtime.startOfficialLogin();
    const login = await loginReady;
    assert.match(startedLogin.loginId, /^[0-9a-f-]{36}$/i);
    assert.equal(startedLogin.authorizationUrl, "https://claude.com/oauth/authorize?fixture=1");
    assert.equal(Number.isSafeInteger(startedLogin.expiresAt), true);
    assert.equal(login.requiresCode, true);
    assert.equal(Object.hasOwn(login, "authorizationUrl"), false);
    assert.equal(Object.hasOwn(login, "loginId"), false);
    assert.doesNotMatch(JSON.stringify(loginEvents), /fixture=1|paste code/i);
    await runtime.submitOfficialLogin("fixture-oauth-code");
    assert.equal((await loginCompleted).success, true);
    assert.equal(await fs.readFile(path.join(home, ".wfl-claude", "submitted-code.txt"), "utf8"), "fixture-oauth-code");
    await runtime.destroy();
    runtime = null;
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude runtime discovers native JSONL sessions without changing the source transcript", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-native-"));
  let runtime = null;
  try {
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot: project, systemUsername: "fixture", legacy: true },
      store,
      appVersion: "test",
      command: process.execPath,
    }).initialize();
    const nativeSessionId = "77777777-7777-4777-8777-777777777777";
    const nativeDirectory = path.join(home, ".wfl-claude", "projects", "fixture-project");
    const nativePath = path.join(nativeDirectory, `${nativeSessionId}.jsonl`);
    await fs.mkdir(nativeDirectory, { recursive: true });
    const nativeTranscript = [
      { type: "user", uuid: "native-user", sessionId: nativeSessionId, cwd: project, timestamp: "2026-07-27T08:00:00.000Z", message: { role: "user", content: "Continue the native task" } },
      { type: "assistant", uuid: "native-agent", sessionId: nativeSessionId, cwd: project, timestamp: "2026-07-27T08:00:01.000Z", message: { id: "native-message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "Native response" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await fs.writeFile(nativePath, nativeTranscript);

    assert.deepEqual(await runtime.discoverNativeSessions({ cwd: project }), { discovered: 1 });
    assert.deepEqual(await runtime.discoverNativeSessions({ cwd: project }), { discovered: 0 });
    const discovered = runtime.readSession(nativeSessionId);
    assert.equal(discovered.nativeSource, true);
    assert.equal(discovered.name, "Continue the native task");
    assert.deepEqual(discovered.messages.filter((item) => item.type === "message").map((item) => item.content), [
      "Continue the native task",
      "Native response",
    ]);
    assert.equal(await fs.readFile(nativePath, "utf8"), nativeTranscript);
    await runtime.removeSession(nativeSessionId);
    assert.deepEqual(await runtime.discoverNativeSessions({ cwd: project }), { discovered: 0 });
    assert.throws(() => runtime.readSession(nativeSessionId), /Claude 对话不存在/);
    const persisted = JSON.parse(await fs.readFile(path.join(stateDirectory, "claude", "sessions.json"), "utf8"));
    assert.deepEqual(persisted.deletedNativeSessionIds, [nativeSessionId]);
    await runtime.destroy();
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot: project, systemUsername: "fixture", legacy: true },
      store,
      appVersion: "test",
      command: process.execPath,
    }).initialize();
    assert.deepEqual(await runtime.discoverNativeSessions({ cwd: project }), { discovered: 0 });
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude runtime makes provider changes safe and turn submission idempotent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-safety-"));
  let runtime = null;
  try {
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot: project, systemUsername: "fixture", legacy: true },
      store,
      appVersion: "test",
      command: process.execPath,
    }).initialize();
    const session = await runtime.startSession({ cwd: project });
    const writes = [];
    let killed = false;
    const child = {
      turnActive: false,
      process: {
        stdin: {
          writable: true,
          write(payload, callback) {
            writes.push(JSON.parse(payload));
            callback?.();
            return true;
          },
        },
        kill() {
          killed = true;
        },
      },
    };
    let childStarts = 0;
    runtime.startChild = async () => {
      childStarts += 1;
      await new Promise((resolve) => setImmediate(resolve));
      runtime.children.set(session.id, child);
      return child;
    };
    const initialized = await Promise.all([
      runtime.ensureChild(runtime.sessions.get(session.id)),
      runtime.ensureChild(runtime.sessions.get(session.id)),
    ]);
    assert.equal(childStarts, 1);
    assert.equal(initialized[0], initialized[1]);

    const simultaneous = await Promise.allSettled([
      runtime.sendMessage(session.id, "Retry-safe task", [], { clientMessageId: "client-1" }),
      runtime.sendMessage(session.id, "another task", [], { clientMessageId: "client-2" }),
    ]);
    assert.equal(simultaneous.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(simultaneous.filter((entry) => entry.status === "rejected").length, 1);
    assert.match(simultaneous.find((entry) => entry.status === "rejected").reason.message, /正在执行任务/);
    const first = simultaneous.find((entry) => entry.status === "fulfilled").value;
    const duplicate = await runtime.sendMessage(session.id, "Retry-safe task", [], { clientMessageId: "client-1" });
    assert.equal(first.messageId, duplicate.messageId);
    assert.equal(duplicate.duplicate, true);
    assert.equal(writes.filter((entry) => entry.type === "user").length, 1);
    await assert.rejects(
      runtime.sendMessage(session.id, "another task", [], { clientMessageId: "client-2" }),
      /正在执行任务/,
    );
    assert.equal(runtime.readSession(session.id).messages.filter((item) => item.role === "user").length, 1);

    await assert.rejects(runtime.prepareProviderChange(), (error) => error.status === 409);
    assert.equal(runtime.children.has(session.id), true);
    child.turnActive = false;
    await runtime.prepareProviderChange();
    assert.equal(killed, true);
    assert.equal(runtime.children.has(session.id), false);
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude runtime keeps three project turns independent and exposes authoritative ordered snapshots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-concurrency-"));
  let runtime = null;
  try {
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const projectRoot = path.join(root, "projects");
    const projects = ["alpha", "bravo", "charlie"].map((name) => path.join(projectRoot, name));
    await Promise.all([
      fs.mkdir(home),
      fs.mkdir(stateDirectory),
      ...projects.map((project) => fs.mkdir(project, { recursive: true })),
    ]);
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    const events = [];
    const statuses = [];
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot, systemUsername: "fixture", legacy: true },
      store,
      appVersion: "test",
      command: process.execPath,
    }).initialize();
    runtime.on("event", (event) => events.push(event));
    runtime.on("status", (status) => statuses.push(status));

    const sessions = await Promise.all(projects.map((cwd) => runtime.startSession({ cwd })));
    const writes = new Map();
    sessions.forEach((session) => {
      const sessionWrites = [];
      writes.set(session.id, sessionWrites);
      runtime.children.set(session.id, {
        connected: true,
        turnActive: false,
        runId: null,
        safeToRetry: true,
        failureClass: null,
        streamBlocks: new Map(),
        process: {
          stdin: {
            writable: true,
            write(payload, callback) {
              sessionWrites.push(JSON.parse(payload));
              callback?.();
              return true;
            },
          },
          kill() {},
        },
      });
    });

    const started = await Promise.all(sessions.map((session, index) =>
      runtime.sendMessage(
        session.id,
        `Run project task ${index + 1}`,
        [],
        { clientMessageId: `project-client-${index + 1}` },
      )));
    assert.equal(new Set(started.map((turn) => turn.runId)).size, 3);
    assert.equal(runtime.status().runningTurns, 3);
    assert.deepEqual(
      sessions.map((session) => runtime.readSession(session.id).status),
      ["inProgress", "inProgress", "inProgress"],
    );
    assert.deepEqual(
      sessions.map((session) => writes.get(session.id).filter((entry) => entry.type === "user").length),
      [1, 1, 1],
    );

    const snapshot = runtime.sessionSnapshot();
    assert.match(snapshot.runtimeEpoch, /^[a-f0-9-]{36}$/);
    assert.equal(snapshot.data.length, 3);
    assert.equal(snapshot.data.every((session) => session.status === "inProgress"), true);
    assert.equal(snapshot.eventSequence, events.at(-1).eventSequence);
    assert.equal(events.every((event) => event.runtimeEpoch === snapshot.runtimeEpoch), true);
    assert.equal(events.every((event, index) =>
      index === 0 || event.eventSequence > events[index - 1].eventSequence), true);

    const firstSession = runtime.sessions.get(sessions[0].id);
    const firstChild = runtime.children.get(sessions[0].id);
    await runtime.consumeEvent(firstSession, firstChild, JSON.stringify({
      type: "assistant",
      message: {
        id: "project-tools-alpha",
        content: [
          { type: "tool_use", id: "tool-alpha-read", name: "Read", input: { file_path: "alpha.txt" } },
          { type: "text", text: "Checking both files." },
          { type: "tool_use", id: "tool-alpha-write", name: "Write", input: { file_path: "result.txt" } },
        ],
      },
    }));
    await runtime.consumeEvent(firstSession, firstChild, JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-alpha-write", content: "write-result" },
          { type: "tool_result", tool_use_id: "tool-alpha-read", content: "read-result" },
        ],
      },
    }));
    // A duplicated Tool Use can be replayed while native JSONL and live events
    // converge. It must not erase or re-open the already paired Tool Result.
    await runtime.consumeEvent(firstSession, firstChild, JSON.stringify({
      type: "assistant",
      message: {
        id: "project-tools-alpha-replay",
        content: [
          { type: "tool_use", id: "tool-alpha-read", name: "Read", input: { file_path: "alpha.txt" } },
        ],
      },
    }));
    const pairedTools = runtime.readSession(sessions[0].id).messages
      .filter((item) => item.type === "tool" && item.toolUseId.startsWith("tool-alpha-"));
    assert.deepEqual(
      pairedTools.map(({ toolUseId, output, status }) => ({ toolUseId, output, status })),
      [
        { toolUseId: "tool-alpha-read", output: "read-result", status: "completed" },
        { toolUseId: "tool-alpha-write", output: "write-result", status: "completed" },
      ],
    );
    await runtime.consumeEvent(firstSession, firstChild, JSON.stringify({
      type: "result",
      uuid: "project-result-alpha",
      result: "alpha complete",
      duration_ms: 25,
      num_turns: 1,
    }));
    assert.equal(runtime.readSession(sessions[0].id).status, "idle");
    assert.equal(runtime.readSession(sessions[1].id).status, "inProgress");
    assert.equal(runtime.readSession(sessions[2].id).status, "inProgress");
    const resultEvent = events.find((event) =>
      event.type === "result" && event.sessionId === sessions[0].id);
    assert.equal(resultEvent.session.status, "idle");
    assert.equal(statuses.at(-1).runningTurns, 2);

    const duplicate = await runtime.sendMessage(
      sessions[0].id,
      "Run project task 1",
      [],
      { clientMessageId: "project-client-1" },
    );
    assert.equal(duplicate.duplicate, true);
    assert.equal(writes.get(sessions[0].id).filter((entry) => entry.type === "user").length, 1);

    for (const session of sessions.slice(1)) {
      await runtime.consumeEvent(
        runtime.sessions.get(session.id),
        runtime.children.get(session.id),
        JSON.stringify({
          type: "result",
          uuid: `project-result-${session.id}`,
          result: "complete",
          duration_ms: 25,
          num_turns: 1,
        }),
      );
    }
    assert.equal(runtime.status().runningTurns, 0);
    assert.equal(runtime.sessionSnapshot().data.every((session) => session.status === "idle"), true);
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("three concurrent Claude projects retain independent API, official account, and proxy bindings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-routing-"));
  let runtime = null;
  try {
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const projectRoot = path.join(root, "projects");
    const projects = ["official-a", "official-b", "api"].map((name) => path.join(projectRoot, name));
    await Promise.all([
      fs.mkdir(home),
      ...projects.map((project) => fs.mkdir(project, { recursive: true })),
    ]);
    const officialAccounts = await new ClaudeOfficialAccountStore(
      path.join(stateDirectory, "claude"),
      { legacyConfigDirectory: path.join(home, ".wfl-claude") },
    ).initialize();
    const accountA = await officialAccounts.create({ label: "Official A" });
    await officialAccounts.recordStatus(accountA.id, {
      loggedIn: true,
      email: "official-a@example.test",
      subscriptionType: "max",
    });
    await officialAccounts.setProxy(accountA.id, {
      protocol: "http",
      host: "127.0.0.1",
      port: 19081,
      username: "account-a",
      password: "proxy-a-secret",
    });
    const accountB = await officialAccounts.create({ label: "Official B" });
    await officialAccounts.recordStatus(accountB.id, {
      loggedIn: true,
      email: "official-b@example.test",
      subscriptionType: "pro",
    });
    await officialAccounts.setProxy(accountB.id, {
      protocol: "socks5",
      host: "127.0.0.1",
      port: 19082,
      username: "account-b",
      password: "proxy-b-secret",
    });
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot, systemUsername: "fixture", legacy: true },
      store,
      officialAccounts,
      allowPrivateOfficialProxy: true,
      appVersion: "test",
      command: process.execPath,
    }).initialize();

    await officialAccounts.activate(accountA.id);
    const sessionA = await runtime.startSession({ cwd: projects[0] });
    await officialAccounts.activate(accountB.id);
    const sessionB = await runtime.startSession({ cwd: projects[1] });
    const apiProfile = await store.create({
      name: "Independent API",
      baseUrl: "https://api.example.test",
      model: "claude-api-fixture",
      apiKey: "api-fixture-secret",
    });
    const sessionApi = await runtime.startSession({ cwd: projects[2] });

    assert.equal(sessionA.officialAccountId, accountA.id);
    assert.equal(sessionA.provider.name, "Official A");
    assert.equal(sessionB.officialAccountId, accountB.id);
    assert.equal(sessionB.provider.name, "Official B");
    assert.equal(sessionApi.providerId, apiProfile.id);
    assert.equal(sessionApi.provider.name, "Independent API");
    const deletePreview = runtime.officialAccountDeletePreview(accountA.id);
    assert.equal(deletePreview.sessionCount, 1);
    assert.equal(deletePreview.deletable, false);
    assert.equal(deletePreview.sessions[0].id, sessionA.id);
    await assert.rejects(
      runtime.deleteOfficialAccount(accountA.id),
      /仍有 Claude 会话绑定此账号/,
    );
    const environmentA = runtime.environment(null, { officialAccountId: accountA.id });
    const environmentB = runtime.environment(null, { officialAccountId: accountB.id });
    const environmentApi = runtime.environment(store.getProfile(apiProfile.id));
    assert.notEqual(environmentA.CLAUDE_CONFIG_DIR, environmentB.CLAUDE_CONFIG_DIR);
    assert.match(environmentA.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(environmentB.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(environmentA.HTTPS_PROXY, environmentB.HTTPS_PROXY);
    assert.equal(environmentApi.ANTHROPIC_API_KEY, "api-fixture-secret");
    assert.equal(environmentApi.ANTHROPIC_BASE_URL, "https://api.example.test");
    assert.notEqual(environmentApi.HTTPS_PROXY, environmentA.HTTPS_PROXY);
    assert.notEqual(environmentApi.HTTPS_PROXY, environmentB.HTTPS_PROXY);

    const sessions = [sessionA, sessionB, sessionApi];
    const writes = new Map();
    for (const session of sessions) {
      const values = [];
      writes.set(session.id, values);
      runtime.children.set(session.id, {
        connected: true,
        turnActive: false,
        runId: null,
        safeToRetry: true,
        process: {
          stdin: {
            writable: true,
            write(payload, callback) {
              values.push(JSON.parse(payload));
              callback?.();
              return true;
            },
          },
          kill() {},
        },
      });
    }
    await runtime.consumeEvent(
      runtime.sessions.get(sessionA.id),
      runtime.children.get(sessionA.id),
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 0.72,
          resetsAt: Math.round(Date.now() / 1_000) + 3_600,
        },
      }),
    );
    assert.equal(officialAccounts.get(accountA.id).quota.windows[0].type, "five_hour");
    assert.equal(officialAccounts.get(accountA.id).quota.windows[0].utilization, 0.72);
    assert.equal(officialAccounts.get(accountB.id).quotaAvailable, false);
    await Promise.all(sessions.map((session, index) =>
      runtime.sendMessage(
        session.id,
        `Bound route ${index + 1}`,
        [],
        { clientMessageId: `bound-route-${index + 1}` },
      )));
    assert.equal(runtime.status().runningTurns, 3);
    assert.deepEqual(
      sessions.map((session) => writes.get(session.id).filter((entry) => entry.type === "user").length),
      [1, 1, 1],
    );
    assert.deepEqual(
      sessions.map((session) => runtime.readSession(session.id).provider.name),
      ["Official A", "Official B", "Independent API"],
    );
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude official account proxies refresh health at a bounded cadence and retain safe failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-proxy-health-"));
  let runtime = null;
  try {
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    const officialAccounts = await new ClaudeOfficialAccountStore(
      path.join(stateDirectory, "claude"),
      { legacyConfigDirectory: path.join(home, ".wfl-claude") },
    ).initialize();
    const account = await officialAccounts.create({ label: "Proxy health" });
    await officialAccounts.setProxy(account.id, {
      protocol: "http",
      host: "127.0.0.1",
      port: 19091,
      username: "proxy-user",
      password: "proxy-secret",
    });
    let shouldFail = false;
    let checks = 0;
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot: project, legacy: true },
      store,
      officialAccounts,
      allowPrivateOfficialProxy: true,
      officialProxyHealthInitialDelayMs: 60_000,
      officialProxyHealthCheck: async (proxy) => {
        checks += 1;
        assert.equal(proxy.password, "proxy-secret");
        if (shouldFail) {
          const error = new Error("upstream body and proxy-secret must stay private");
          error.proxyCode = "authentication";
          throw error;
        }
        return {
          status: "ready",
          checkedAt: Date.now(),
          latencyMs: 31,
          exitIp: "203.0.113.21",
          code: null,
        };
      },
      appVersion: "test",
      command: "false",
    }).initialize();
    const events = [];
    runtime.on("event", (event) => events.push(event));

    await runtime.refreshOfficialProxyHealth({ accountId: account.id, force: true });
    let health = officialAccounts.get(account.id).proxy.health;
    assert.equal(health.status, "ready");
    assert.equal(health.exitIp, "203.0.113.21");
    assert.equal(health.latencyMs, 31);

    shouldFail = true;
    await runtime.refreshOfficialProxyHealth({ accountId: account.id, force: true });
    health = officialAccounts.get(account.id).proxy.health;
    assert.equal(health.status, "failed");
    assert.equal(health.code, "authentication");
    assert.equal(Number.isFinite(health.checkedAt), true);
    assert.equal(checks, 2);
    assert.equal(events.filter((event) => event.type === "official/proxy-health-updated").length, 2);
    assert.doesNotMatch(JSON.stringify(events), /proxy-secret|upstream body/);
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude stdout events and process exit are serialized per session", async () => {
  const runtime = new ClaudeRuntime({
    user: {
      stateDirectory: path.join(os.tmpdir(), "wfl-claude-event-queue-state"),
      home: path.join(os.tmpdir(), "wfl-claude-event-queue-home"),
      projectRoot: os.tmpdir(),
      legacy: true,
    },
    store: { snapshot: () => ({ activeId: null, profiles: [] }) },
    appVersion: "test",
    command: "false",
  });
  const order = [];
  runtime.consumeEvent = async (_session, _state, line) => {
    if (line === "first") await new Promise((resolve) => setTimeout(resolve, 20));
    order.push(line);
  };
  runtime.childExit = async () => {
    order.push("exit");
  };
  const state = { buffer: "", eventQueue: Promise.resolve() };
  runtime.consumeOutput({ id: "fixture" }, state, "first\nsecond\n");
  await runtime.queueChildExit({ id: "fixture" }, state, {});
  assert.deepEqual(order, ["first", "second", "exit"]);
  await runtime.destroy();
});

test("Claude persists interrupted turns, requires recovery confirmation, and resumes with the native session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-recovery-"));
  const command = path.join(root, "fake-claude-recovery.mjs");
  let runtime = null;
  let restoredRuntime = null;
  try {
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    await fs.writeFile(command, `#!/usr/bin/env node
import fs from "node:fs/promises";
import readline from "node:readline";
await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
const input = readline.createInterface({ input: process.stdin });
const sessionId = process.argv[process.argv.indexOf("--resume") + 1];
const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
input.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request?.subtype === "initialize") {
    write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    return;
  }
  if (message.type !== "user") return;
  write({ type: "system", subtype: "init", session_id: sessionId, permissionMode: "acceptEdits", model: "fixture-model" });
  write({ type: "assistant", message: { id: "recovery-assistant", content: [{ type: "text", text: "recovered" }] } });
  write({ type: "result", uuid: "recovery-result", result: "recovered", duration_ms: 20, num_turns: 1 });
});
`, { mode: 0o700 });
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot: project, systemUsername: "fixture", legacy: true },
      store,
      appVersion: "test",
      command,
    }).initialize();
    const session = await runtime.startSession({ cwd: project });
    const internal = runtime.sessions.get(session.id);
    internal.nativeStarted = true;
    internal.nativeSessionId = "11111111-1111-4111-8111-111111111111";
    internal.pendingTurn = {
      runId: "22222222-2222-4222-8222-222222222222",
      messageId: "old-message",
      clientMessageId: "old-client",
      startedAt: Date.now() - 10_000,
      lastActivityAt: Date.now() - 2_000,
      status: "inProgress",
    };
    internal.pendingApprovals = [{
      id: "approval-old",
      kind: "permission",
      toolName: "Bash",
      requestedAt: Date.now() - 500,
      expiresAt: Date.now() + 5_000,
      status: "waiting",
    }];
    await runtime.persistSessions();
    await runtime.destroy();
    runtime = null;

    restoredRuntime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot: project, systemUsername: "fixture", legacy: true },
      store,
      appVersion: "test",
      command,
    }).initialize();
    const recovered = restoredRuntime.readSession(session.id);
    assert.equal(recovered.status, "recoveryPending");
    assert.equal(recovered.recovery.requiresConfirmation, true);
    assert.equal(recovered.recovery.reason, "runtime-restarted");
    assert.equal(recovered.pendingApprovals[0].status, "expired");
    await assert.rejects(
      restoredRuntime.sendMessage(session.id, "Do not silently replay", [], { clientMessageId: "new-client" }),
      /等待恢复处理/,
    );
    const dismissed = await restoredRuntime.recoverTurn(session.id, { action: "dismiss" });
    assert.equal(dismissed.session.status, "idle");

    const resumable = await restoredRuntime.startSession({ cwd: project });
    const resumableInternal = restoredRuntime.sessions.get(resumable.id);
    resumableInternal.nativeStarted = true;
    resumableInternal.nativeSessionId = "33333333-3333-4333-8333-333333333333";
    resumableInternal.pendingTurn = {
      runId: "44444444-4444-4444-8444-444444444444",
      messageId: "resume-old-message",
      clientMessageId: "resume-old-client",
      startedAt: Date.now() - 5_000,
      lastActivityAt: Date.now() - 1_000,
      status: "recoveryPending",
      recoveryReason: "process-exit",
      recoveryAt: Date.now() - 500,
      requiresConfirmation: true,
      error: "Claude 进程已退出（退出码 1）",
    };
    const completed = new Promise((resolve) => {
      restoredRuntime.on("event", (event) => {
        if (event.type === "result" && event.sessionId === resumable.id) resolve(event);
      });
    });
    const resumed = await restoredRuntime.recoverTurn(resumable.id, {
      action: "resume",
      confirmation: "继续未完成任务",
    });
    assert.equal(resumed.recoveredFromRunId, "44444444-4444-4444-8444-444444444444");
    await completed;
    const args = JSON.parse((await fs.readFile(path.join(home, ".wfl-claude", "args.jsonl"), "utf8")).trim().split("\n").at(-1));
    assert.equal(args.includes("--resume"), true);
    assert.equal(args.includes("--session-id"), false);
    assert.equal(restoredRuntime.readSession(resumable.id).status, "idle");
  } finally {
    await runtime?.destroy();
    await restoredRuntime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude pause/continue preserves one user message and supports account or provider switching", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-pause-"));
  let runtime = null;
  try {
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    const first = await store.create({
      name: "first",
      baseUrl: "https://api.anthropic.com",
      model: "fixture",
      apiKey: "first-secret",
    });
    const second = await store.create({
      name: "second",
      baseUrl: "https://api.anthropic.com",
      model: "fixture",
      apiKey: "second-secret",
    });
    const officialAccounts = await new ClaudeOfficialAccountStore(
      path.join(stateDirectory, "official"),
      { legacyConfigDirectory: path.join(home, ".wfl-claude") },
    ).initialize();
    const official = await officialAccounts.create({ label: "Official switch" });
    await officialAccounts.recordStatus(official.id, {
      loggedIn: true,
      email: "switch@example.test",
      subscriptionType: "max",
    });
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot: project, legacy: true },
      store,
      officialAccounts,
      appVersion: "test",
      command: "false",
    }).initialize();
    const started = await runtime.startSession({ cwd: project });
    const writes = [];
    const child = {
      turnActive: false,
      process: {
        stdin: {
          writable: true,
          write(payload, callback) {
            writes.push(JSON.parse(payload));
            callback?.();
            return true;
          },
        },
        kill() {},
      },
    };
    runtime.children.set(started.id, child);
    await runtime.sendMessage(started.id, "inspect once", [], { clientMessageId: "pause-client" });
    const pause = await runtime.pauseTurn(started.id, { mode: "after-turn" });
    assert.equal(pause.status, "pausing");
    await runtime.consumeEvent(
      runtime.sessions.get(started.id),
      child,
      JSON.stringify({
        type: "result",
        uuid: "pause-result",
        is_error: false,
        subtype: "success",
        duration_ms: 1,
        num_turns: 1,
      }),
    );
    const paused = runtime.readSession(started.id);
    assert.equal(paused.status, "paused");
    assert.equal(paused.pause.status, "paused");
    assert.equal(paused.messages.filter((item) => item.role === "user").length, 1);
    const switched = await runtime.switchProvider(started.id, second.id);
    assert.equal(switched.session.providerId, second.id);
    assert.equal(switched.session.provider.name, "second");
    const switchedOfficial = await runtime.switchProvider(started.id, null, official.id);
    assert.equal(switchedOfficial.session.providerId, null);
    assert.equal(switchedOfficial.session.officialAccountId, official.id);
    assert.equal(switchedOfficial.session.provider.name, "Official switch");
    runtime.children.set(started.id, child);
    const continued = await runtime.continueTurn(started.id);
    assert.equal(continued.continued, true);
    assert.equal(runtime.readSession(started.id).status, "inProgress");
    assert.equal(writes.filter((entry) => entry.type === "user").length, 2);
    assert.equal(writes.at(-1).message.content.includes("不要重复"), true);
    assert.equal(runtime.readSession(started.id).messages.filter((item) => item.role === "user").length, 1);
    assert.equal(runtime.sessions.get(started.id).providerId, null);
    assert.equal(runtime.sessions.get(started.id).officialAccountId, official.id);
    await runtime.consumeEvent(
      runtime.sessions.get(started.id),
      child,
      JSON.stringify({
        type: "system",
        subtype: "task_started",
        task_id: "interrupted-agent",
        description: "Long-running Agent",
      }),
    );
    assert.equal(
      runtime.readSession(started.id).messages.find((item) => item.taskId === "interrupted-agent").status,
      "inProgress",
    );
    const interrupt = await runtime.interrupt(started.id);
    assert.equal(interrupt.interrupted, true);
    assert.equal(runtime.readSession(started.id).status, "stopping");
    await runtime.consumeEvent(
      runtime.sessions.get(started.id),
      child,
      JSON.stringify({
        type: "result",
        uuid: "interrupted-result",
        is_error: false,
        subtype: "success",
        duration_ms: 1,
        num_turns: 1,
      }),
    );
    const interrupted = runtime.readSession(started.id);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(
      interrupted.messages.find((item) => item.taskId === "interrupted-agent").status,
      "interrupted",
    );
    assert.notEqual(first.id, second.id);
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude retries only safe transient failures and never retries credentials or side-effect turns", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-retry-"));
  let runtime = null;
  try {
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    runtime = await new ClaudeRuntime({
      user: { stateDirectory, home, projectRoot: project, legacy: true },
      store,
      appVersion: "test",
      command: "false",
    }).initialize();
    await runtime.updateTaskSettings({ unlimitedRetry: true, retryFrequency: "fast" });
    const session = await runtime.startSession({ cwd: project });
    const child = {
      turnActive: true,
      safeToRetry: true,
      process: {
        stdin: { writable: true, write(_payload, callback) { callback?.(); return true; } },
        kill() {},
      },
      runId: crypto.randomUUID(),
    };
    runtime.children.set(session.id, child);
    const internal = runtime.sessions.get(session.id);
    internal.pendingTurn = {
      runId: child.runId,
      messageId: "retry-message",
      clientMessageId: "retry-client",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "inProgress",
    };
    const scheduled = await runtime.handleRetryableFailure(
      internal,
      child,
      classifyClaudeFailure({ code: "ECONNRESET" }),
      "test",
    );
    child.turnActive = false;
    assert.equal(scheduled, true);
    assert.equal(runtime.readSession(session.id).status, "retryWaiting");
    runtime.clearRetryTimer(session.id);
    child.safeToRetry = false;
    internal.pendingTurn.status = "inProgress";
    const stopped = await runtime.handleRetryableFailure(
      internal,
      child,
      classifyClaudeFailure({ code: "ECONNRESET" }),
      "test",
    );
    assert.equal(stopped, false);
    assert.equal(runtime.readSession(session.id).status, "recoveryPending");
    internal.pendingTurn = {
      ...internal.pendingTurn,
      status: "inProgress",
      requiresConfirmation: false,
    };
    child.safeToRetry = true;
    const authStopped = await runtime.handleRetryableFailure(
      internal,
      child,
      classifyClaudeFailure({ message: "401 Unauthorized" }),
      "test",
    );
    assert.equal(authStopped, false);
    assert.equal(runtime.readSession(session.id).recovery.reason, "process-exit");
    assert.match(runtime.readSession(session.id).recovery.error, /凭据/);
    await runtime.updateTaskSettings({ unlimitedRetry: false, maxRetries: 1 });
    assert.equal(runtime.retryAllowed(1), true);
    assert.equal(runtime.retryAllowed(2), false);

    internal.pendingTurn = {
      runId: crypto.randomUUID(),
      messageId: "auth-result-message",
      clientMessageId: "auth-result-client",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "inProgress",
    };
    child.turnActive = true;
    child.safeToRetry = true;
    child.runId = internal.pendingTurn.runId;
    await runtime.consumeEvent(
      internal,
      child,
      JSON.stringify({
        type: "result",
        uuid: "auth-result",
        is_error: true,
        subtype: "error",
        error: "401 Unauthorized",
      }),
    );
    assert.equal(runtime.readSession(session.id).status, "recoveryPending");
    assert.equal(runtime.readSession(session.id).recovery.reason, "process-exit");

    internal.pendingTurn = {
      ...internal.pendingTurn,
      status: "retryWaiting",
      retryAttempts: 1,
      nextRetryAt: Date.now() + 60_000,
    };
    const interrupted = await runtime.interrupt(session.id);
    assert.equal(interrupted.interrupted, true);
    assert.equal(runtime.readSession(session.id).status, "idle");

    internal.jsonSchema = { type: "object", required: ["result"] };
    internal.pendingTurn = {
      runId: crypto.randomUUID(),
      messageId: "structured-revoked-message",
      clientMessageId: "structured-revoked-client",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "retryWaiting",
      retryAttempts: 1,
      nextRetryAt: Date.now() + 60_000,
    };
    child.turnActive = false;
    runtime.children.set(session.id, child);
    runtime.scheduleRetry(internal, internal.pendingTurn);
    await runtime.enforcePermissions({
      runtimeAllowed: true,
      backgroundAllowed: true,
      structuredOutputAllowed: false,
    });
    assert.equal(runtime.retryTimers.has(session.id), false);
    assert.equal(runtime.readSession(session.id).status, "paused");
    assert.equal(runtime.readSession(session.id).pause?.mode, "permission-revoked");
    assert.match(runtime.sessions.get(session.id)?.pendingTurn?.error || "", /结构化输出权限已撤销/);
    internal.jsonSchema = null;

    internal.pendingTurn = {
      runId: crypto.randomUUID(),
      messageId: "active-revoked-message",
      clientMessageId: "active-revoked-client",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "inProgress",
    };
    child.turnActive = true;
    child.runId = internal.pendingTurn.runId;
    runtime.children.set(session.id, child);
    runtime.runtimeAllowed = true;
    await runtime.enforcePermissions({ runtimeAllowed: false, backgroundAllowed: true });
    assert.equal(runtime.readSession(session.id).status, "stopping");
    assert.equal(runtime.sessions.get(session.id)?.pendingTurn?.status, "pausing");
    assert.equal(child.pauseRequested, true);

    internal.pendingTurn = {
      runId: crypto.randomUUID(),
      messageId: "revoked-retry-message",
      clientMessageId: "revoked-retry-client",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "retryWaiting",
      retryAttempts: 1,
      nextRetryAt: Date.now() + 60_000,
    };
    child.turnActive = false;
    runtime.runtimeAllowed = true;
    runtime.scheduleRetry(internal, internal.pendingTurn);
    assert.equal(runtime.retryTimers.has(session.id), true);
    await runtime.enforcePermissions({ runtimeAllowed: false, backgroundAllowed: false });
    assert.equal(runtime.retryTimers.has(session.id), false);
    assert.equal(runtime.readSession(session.id).status, "paused");
    assert.equal(runtime.readSession(session.id).pause?.status, "paused");
    assert.match(runtime.sessions.get(session.id)?.pendingTurn?.error || "", /权限已撤销/);
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude runtime routes permissions, questions, and user dialogs over the control channel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-control-"));
  const command = path.join(root, "fake-claude-control.mjs");
  let runtime = null;
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from "node:fs/promises";
import readline from "node:readline";
await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
const write = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request?.subtype === "initialize") {
    await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/initialize.jsonl", JSON.stringify(message.request) + "\\n");
    write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    return;
  }
  if (message.type === "user") {
    write({ type: "system", subtype: "init", session_id: "55555555-5555-4555-8555-555555555555", permissionMode: "manual", model: "fixture-model" });
    const permission = {
      type: "control_request",
      request_id: "permission-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "npm test" },
        tool_use_id: "tool-permission-1",
        title: "Run tests",
        decision_reason: "\\u001b[31mNeeds shell access\\u001b[0m",
        permission_suggestions: [{
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "npm test" }],
          behavior: "allow",
          destination: "session"
        }]
      }
    };
    write(permission);
    write(permission);
    return;
  }
  if (message.type !== "control_response") return;
  await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + "/responses.jsonl", JSON.stringify(message) + "\\n");
  if (message.response.request_id === "permission-1") {
    write({
      type: "control_request",
      request_id: "question-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        display_name: "AskUserQuestion",
        tool_use_id: "tool-question-1",
        requires_user_interaction: true,
        input: { questions: [{
          question: "Which interface?",
          header: "Interface",
          options: [
            { label: "Compact", description: "Use a compact layout" },
            { label: "Detailed", description: "Show more controls" }
          ],
          multiSelect: false
        }] }
      }
    });
    return;
  }
  if (message.response.request_id === "question-1") {
    write({ type: "control_request", request_id: "dialog-1", request: {
      subtype: "request_user_dialog",
      dialog_kind: "refusal_fallback_prompt",
      tool_use_id: "tool-dialog-1",
      payload: {
        originalModel: "claude-opus-test",
        fallbackModel: "claude-sonnet-test",
        apiRefusalCategory: "cyber",
        guidanceText: "\\u001b[31mReview the fallback choice\\u001b[0m",
        retractedMessageUuids: ["message-1"]
      }
    } });
    return;
  }
  if (message.response.request_id === "dialog-1") {
    write({ type: "control_request", request_id: "elicitation-url-1", request: {
      subtype: "elicitation",
      mcp_server_name: "fixture-oauth",
      mode: "url",
      message: "Authorize the fixture MCP server",
      url: "https://example.test/mcp/authorize?state=fixture",
      elicitation_id: "fixture-url-1",
      title: "Connect fixture MCP"
    } });
    return;
  }
  if (message.response.request_id === "elicitation-url-1") {
    write({ type: "control_request", request_id: "elicitation-form-1", request: {
      subtype: "elicitation",
      mcp_server_name: "fixture-config",
      mode: "form",
      message: "Configure the fixture deployment",
      requested_schema: {
        type: "object",
        properties: {
          environment: { type: "string", title: "Environment", enum: ["staging", "production"], default: "staging" },
          retries: { type: "integer", title: "Retries", minimum: 1, maximum: 5, default: 2 },
          notify: { type: "boolean", title: "Send notification", default: true }
        },
        required: ["environment", "retries"]
      }
    } });
    return;
  }
  if (message.response.request_id === "elicitation-form-1") {
    write({ type: "control_request", request_id: "invalid-elicitation-1", request: {
      subtype: "elicitation",
      mcp_server_name: "fixture-invalid",
      mode: "form",
      message: "Render an unsafe schema",
      requested_schema: {
        type: "object",
        properties: { nested: { type: "object", properties: {} } }
      }
    } });
    return;
  }
  if (message.response.request_id === "invalid-elicitation-1") {
    write({ type: "control_request", request_id: "unknown-dialog-1", request: {
      subtype: "request_user_dialog",
      dialog_kind: "future_dialog_kind",
      payload: { arbitrary: true }
    } });
    return;
  }
  if (message.response.request_id === "unknown-dialog-1") {
    write({ type: "control_request", request_id: "cancelled-1", request: {
      subtype: "elicitation",
      mcp_server_name: "fixture-cancelled",
      mode: "form",
      message: "This request will be cancelled",
      requested_schema: {
        type: "object",
        properties: { value: { type: "string" } }
      }
    } });
    write({ type: "control_cancel_request", request_id: "cancelled-1" });
    write({ type: "result", uuid: "control-result", session_id: "55555555-5555-4555-8555-555555555555", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 });
  }
});
`, { mode: 0o700 });

  try {
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    await store.create({ name: "fixture", baseUrl: "http://127.0.0.1:9999", model: "fixture-model", apiKey: "fixture-key" });
    runtime = await new ClaudeRuntime({
      user: {
        stateDirectory,
        home,
        projectRoot: project,
        systemUsername: "fixture",
        legacy: false,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
      },
      store,
      appVersion: "test",
      command,
    }).initialize();
    const session = await runtime.startSession({ cwd: project, permissionMode: "manual" });
    const permissionPending = onceRuntimeEvent(runtime, (event) =>
      event.type === "control/request" && event.request?.kind === "permission");
    const questionPending = onceRuntimeEvent(runtime, (event) =>
      event.type === "control/request" && event.request?.kind === "question");
    const dialogPending = onceRuntimeEvent(runtime, (event) =>
      event.type === "control/request" && event.request?.kind === "dialog");
    const urlPending = onceRuntimeEvent(runtime, (event) =>
      event.type === "control/request"
      && event.request?.kind === "elicitation"
      && event.request?.serverName === "fixture-oauth");
    const formPending = onceRuntimeEvent(runtime, (event) =>
      event.type === "control/request"
      && event.request?.kind === "elicitation"
      && event.request?.serverName === "fixture-config");
    const cancelledPending = onceRuntimeEvent(runtime, (event) =>
      event.type === "control/request"
      && event.request?.kind === "elicitation"
      && event.request?.serverName === "fixture-cancelled");
    const cancelledResolved = onceRuntimeEvent(runtime, (event) =>
      event.type === "control/resolved"
      && event.sessionId === session.id
      && event.outcome === "cancelled");
    const completed = onceRuntimeEvent(runtime, (event) => event.type === "result" && event.sessionId === session.id);

    await runtime.sendMessage(session.id, "Exercise control requests");
    const permission = (await permissionPending).request;
    assert.equal(permission.kind, "permission");
    assert.equal(permission.canRemember, true);
    assert.equal(permission.rememberLabel, "本会话允许");
    assert.equal(permission.decisionReason, "Needs shell access");
    await runtime.resolveControlRequest(session.id, permission.id, { decision: "allowAlways" });

    const question = (await questionPending).request;
    assert.equal(question.kind, "question");
    assert.equal(question.requiresUserInteraction, true);
    assert.equal(question.questions[0].options.length, 2);
    await runtime.resolveControlRequest(session.id, question.id, {
      decision: "answer",
      answers: { "Which interface?": "Compact" },
    });

    const dialog = (await dialogPending).request;
    assert.equal(dialog.kind, "dialog");
    assert.equal(dialog.dialogKind, "refusal_fallback_prompt");
    assert.equal(dialog.originalModel, "claude-opus-test");
    assert.equal(dialog.fallbackModel, "claude-sonnet-test");
    assert.equal(dialog.apiRefusalCategory, "cyber");
    assert.equal(dialog.guidanceText, "Review the fallback choice");
    assert.equal(dialog.toolUseId, "tool-dialog-1");
    await assert.rejects(
      runtime.resolveControlRequest(session.id, dialog.id, { decision: "unknown" }),
      /Claude 对话选择无效/,
    );
    await runtime.resolveControlRequest(session.id, dialog.id, { decision: "retryFallback" });

    const url = (await urlPending).request;
    assert.equal(url.kind, "elicitation");
    assert.equal(url.mode, "url");
    assert.equal(url.serverName, "fixture-oauth");
    assert.equal(url.url, "https://example.test/mcp/authorize?state=fixture");
    assert.equal(url.elicitationId, "fixture-url-1");
    await runtime.resolveControlRequest(session.id, url.id, { decision: "accept" });

    const form = (await formPending).request;
    assert.equal(form.kind, "elicitation");
    assert.equal(form.mode, "form");
    assert.deepEqual(form.fields.map((field) => [field.name, field.type, field.required]), [
      ["environment", "string", true],
      ["retries", "integer", true],
      ["notify", "boolean", false],
    ]);
    await assert.rejects(
      runtime.resolveControlRequest(session.id, form.id, {
        decision: "accept",
        content: { environment: "staging", retries: 9 },
      }),
      /Retries.*无效/,
    );
    await runtime.resolveControlRequest(session.id, form.id, {
      decision: "accept",
      content: { environment: "production", retries: 3, notify: false },
    });
    assert.equal((await cancelledPending).request.kind, "elicitation");
    assert.equal((await cancelledResolved).outcome, "cancelled");
    await completed;

    const responses = (await fs.readFile(path.join(home, ".wfl-claude", "responses.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(responses.length, 7);
    assert.equal(responses[0].response.response.behavior, "allow");
    assert.equal(responses[0].response.response.toolUseID, "tool-permission-1");
    assert.equal(responses[0].response.response.updatedPermissions[0].destination, "session");
    assert.equal(responses[1].response.response.updatedInput.answers["Which interface?"], "Compact");
    assert.equal(responses[1].response.response.toolUseID, "tool-question-1");
    assert.deepEqual(responses[2].response.response, { behavior: "completed", result: "retry_fallback" });
    assert.deepEqual(responses[3].response.response, { action: "accept" });
    assert.deepEqual(responses[4].response.response, {
      action: "accept",
      content: { environment: "production", retries: 3, notify: false },
    });
    assert.deepEqual(responses[5].response.response, { action: "cancel" });
    assert.deepEqual(responses[6].response.response, { behavior: "cancelled" });
    const initialize = JSON.parse((await fs.readFile(path.join(home, ".wfl-claude", "initialize.jsonl"), "utf8")).trim());
    assert.deepEqual(initialize.supportedDialogKinds, ["refusal_fallback_prompt"]);
    const args = JSON.parse((await fs.readFile(path.join(home, ".wfl-claude", "args.jsonl"), "utf8")).trim());
    assert.deepEqual(args.slice(args.indexOf("--permission-prompt-tool"), args.indexOf("--permission-prompt-tool") + 2), ["--permission-prompt-tool", "stdio"]);
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude Rewind previews native checkpoints and requires confirmation before restoring files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-rewind-"));
  const command = path.join(root, "fake-claude-control.mjs");
  let runtime = null;
  try {
    await fs.copyFile(path.resolve("test/fixtures/fake-claude-control.mjs"), command);
    await fs.chmod(command, 0o700);
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await Promise.all([
      fs.mkdir(home),
      fs.mkdir(path.join(project, "src"), { recursive: true }),
    ]);
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    await store.create({
      name: "fixture",
      baseUrl: "http://127.0.0.1:9999",
      model: "fixture-model",
      apiKey: "fixture-key",
    });
    runtime = await new ClaudeRuntime({
      user: {
        stateDirectory,
        home,
        projectRoot: project,
        systemUsername: "fixture",
        legacy: false,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
      },
      store,
      appVersion: "test",
      command,
    }).initialize();
    const session = await runtime.startSession({ cwd: project, permissionMode: "manual" });
    const completed = onceRuntimeEvent(
      runtime,
      (event) => event.type === "result" && event.sessionId === session.id,
    );
    await runtime.sendMessage(session.id, "/compact");
    await completed;

    const readable = runtime.readSession(session.id);
    const target = readable.rewindTargets.at(-1);
    assert.equal(target.available, true);
    assert.equal(JSON.stringify(readable).includes("11111111-1111-4111-8111"), false);

    const preview = await runtime.rewindFiles(session.id, {
      messageId: target.id,
      dryRun: true,
    });
    assert.deepEqual(preview.filesChanged, ["src/fixture.js", "README.md"]);
    assert.equal(preview.insertions, 7);
    assert.equal(preview.deletions, 3);
    assert.equal(preview.canRewind, true);

    await assert.rejects(
      runtime.rewindFiles(session.id, { messageId: target.id, dryRun: false }),
      /明确确认/,
    );
    const restored = await runtime.rewindFiles(session.id, {
      messageId: target.id,
      dryRun: false,
      confirm: true,
    });
    assert.equal(restored.canRewind, true);
    assert.equal(restored.skippedLinks, 1);
    assert.match(
      runtime.readSession(session.id).messages.at(-1).content,
      /已恢复 Claude 文件检查点/,
    );
  } finally {
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude native background agents are isolated, recoverable, and secret-safe", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-background-"));
  const command = path.join(root, "fake-claude-background.mjs");
  let runtime = null;
  let isolatedRuntime = null;
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const config = process.env.CLAUDE_CONFIG_DIR;
const jobs = path.join(config, "jobs");
const project = process.cwd();
const sessionId = "33333333-3333-4333-8333-333333333333";
const shortId = "ab12cd34";
const statePath = path.join(jobs, shortId, "state.json");
const transcriptPath = path.join(config, "projects", "-fixture", sessionId + ".jsonl");
await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
await fs.mkdir(path.dirname(transcriptPath), { recursive: true, mode: 0o700 });

async function readState() {
  try { return JSON.parse(await fs.readFile(statePath, "utf8")); } catch { return null; }
}
async function writeState(state) {
  await fs.writeFile(statePath, JSON.stringify(state) + "\\n", { mode: 0o600 });
  await fs.chmod(statePath, 0o600);
}

if (process.argv[2] === "--bg") {
  const nameIndex = process.argv.indexOf("--name");
  const name = nameIndex >= 0 ? process.argv[nameIndex + 1] : "fixture";
  const mcpIndex = process.argv.indexOf("--mcp-config");
  const settingsIndex = process.argv.indexOf("--settings");
  const mcpPath = mcpIndex >= 0 ? process.argv[mcpIndex + 1] : null;
  const settingsPath = settingsIndex >= 0 ? process.argv[settingsIndex + 1] : null;
  const mcp = mcpPath ? JSON.parse(await fs.readFile(mcpPath, "utf8")) : null;
  const [mcpStat, settingsStat] = await Promise.all([
    mcpPath ? fs.stat(mcpPath) : null,
    settingsPath ? fs.stat(settingsPath) : null,
  ]);
  await fs.writeFile(config + "/background-dispatch.json", JSON.stringify({
    args: process.argv.slice(2),
    mcpPath,
    mcpMode: mcpStat ? mcpStat.mode & 0o777 : null,
    mcpServers: Object.keys(mcp?.mcpServers || {}),
    settingsMode: settingsStat ? settingsStat.mode & 0o777 : null,
  }) + "\\n", { mode: 0o600 });
  const now = Date.now();
  await writeState({
    daemonShort: shortId,
    sessionId,
    cwd: project,
    state: "working",
    status: "busy",
    tempo: "active",
    detail: "fixture started",
    needs: "",
    providerEnv: { ANTHROPIC_API_KEY: "sk-ant-secret-fixture" },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    startedAt: new Date(now).toISOString(),
    linkScanPath: transcriptPath,
  });
  await fs.writeFile(transcriptPath, JSON.stringify({
    type: "user",
    message: { content: "inspect fixture" },
    env: { ANTHROPIC_API_KEY: "sk-ant-secret-fixture" },
  }) + "\\n" + JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "background fixture complete" }] },
    providerEnv: { API_KEY: "should-not-leak" },
  }) + "\\n", { mode: 0o600 });
  await fs.chmod(transcriptPath, 0o600);
  process.stdout.write("backgrounded · " + shortId + " · " + name + "\\n");
  process.exit(0);
}
if (process.argv[2] === "agents") {
  const state = await readState();
  const requested = process.argv[process.argv.indexOf("--cwd") + 1];
  process.stdout.write(JSON.stringify(state && (!requested || state.cwd === requested) ? [{
    id: shortId,
    cwd: state.cwd,
    kind: "background",
    startedAt: Date.parse(state.startedAt),
    sessionId: state.sessionId,
    name: "fixture-agent",
    state: state.state,
    status: state.status,
  }] : []) + "\\n");
  process.exit(0);
}
if (process.argv[2] === "stop") {
  const state = await readState();
  if (!state || process.argv[3] !== shortId) process.exit(1);
  state.state = "stopped";
  state.status = "idle";
  state.tempo = "idle";
  state.detail = "stopped";
  state.updatedAt = new Date().toISOString();
  await writeState(state);
  process.stdout.write("stopped " + shortId + "\\n");
  process.exit(0);
}
process.exit(1);
`, { mode: 0o700 });

  try {
    const stateDirectory = path.join(root, "state");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
    const store = await new ClaudeStore(path.join(stateDirectory, "store")).initialize();
    runtime = await new ClaudeRuntime({
      user: {
        stateDirectory,
        home,
        projectRoot: project,
        systemUsername: "fixture",
        legacy: false,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
      },
      store,
      appVersion: "test",
      command,
    }).initialize();
    const pluginDirectory = path.join(project, "fixture-plugin");
    const additionalDirectory = path.join(project, "fixture-reference");
    await fs.mkdir(path.join(pluginDirectory, ".claude-plugin"), { recursive: true });
    await fs.mkdir(additionalDirectory);
    await fs.writeFile(
      path.join(pluginDirectory, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "fixture-background-plugin", version: "1.0.0" })}\n`,
    );
    await runtime.saveMcpServer({
      name: "fixture-dispatch",
      type: "stdio",
      command: "node",
      args: ["fixture-mcp.mjs"],
      sensitiveMode: "replace",
      environment: { API_KEY: "dispatch-secret" },
    });
    await runtime.saveHooks(project, [{
      event: "PreToolUse",
      matcher: "Bash",
      command: "npm test",
      timeout: 20,
    }]);

    const started = await runtime.startBackgroundAgent({
      cwd: project,
      name: "fixture-agent",
      prompt: "inspect fixture",
      model: "sonnet",
      permissionMode: "acceptEdits",
      settingSources: ["user", "project"],
      strictMcpConfig: true,
      mcpServerNames: ["fixture-dispatch"],
      pluginDirectories: ["fixture-plugin"],
      additionalDirectories: [additionalDirectory],
      includeHooks: true,
    });
    assert.equal(started.shortId, "ab12cd34");
    assert.equal(started.kind, "background");
    assert.equal(started.state, "working");
    assert.equal(started.cwd, project);
    assert.equal(started.model, "sonnet");
    assert.equal(started.providerId, null);
    assert.equal(started.providerName, "Claude 官方账号");
    assert.deepEqual(started.settingSources, ["user", "project"]);
    assert.deepEqual(started.mcpServerNames, ["fixture-dispatch"]);
    assert.equal(started.pluginCount, 1);
    assert.equal(started.additionalDirectoryCount, 1);
    assert.equal(started.hooksEnabled, true);
    assert.equal(Object.hasOwn(started, "providerEnv"), false);
    assert.equal(JSON.stringify(started).includes("sk-ant-secret"), false);
    const dispatch = JSON.parse(await fs.readFile(
      path.join(home, ".wfl-claude", "background-dispatch.json"),
      "utf8",
    ));
    assert.equal(dispatch.args[0], "--bg");
    assert.equal(dispatch.args[dispatch.args.indexOf("--setting-sources") + 1], "user,project");
    assert.equal(dispatch.args[dispatch.args.indexOf("--plugin-dir") + 1], pluginDirectory);
    assert.equal(dispatch.args[dispatch.args.indexOf("--add-dir") + 1], additionalDirectory);
    assert.equal(dispatch.args.includes("--strict-mcp-config"), true);
    assert.equal(dispatch.args.includes("--include-hook-events"), true);
    assert.deepEqual(dispatch.mcpServers, ["fixture-dispatch"]);
    assert.equal(dispatch.mcpMode, 0o600);
    assert.equal(dispatch.settingsMode, 0o600);
    await assert.rejects(fs.access(dispatch.mcpPath), /ENOENT/);

    const taskSnapshot = await runtime.taskCenterBackgroundAgents();
    assert.equal(taskSnapshot.length, 1);
    assert.equal(taskSnapshot[0].model, "sonnet");
    assert.equal(taskSnapshot[0].providerName, "Claude 官方账号");
    assert.equal(Object.hasOwn(taskSnapshot[0], "providerEnv"), false);

    const listed = await runtime.listBackgroundAgents({ cwd: project });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sessionId, "33333333-3333-4333-8333-333333333333");
    assert.equal(listed[0].transcriptAvailable, true);

    const detailed = await runtime.readBackgroundAgent("ab12cd34");
    assert.equal(detailed.transcript.length, 2);
    assert.equal(JSON.stringify(detailed).includes("should-not-leak"), false);
    assert.equal(JSON.stringify(detailed).includes("sk-ant-secret"), false);

    const statePath = path.join(home, ".wfl-claude", "jobs", "ab12cd34", "state.json");
    const transcriptPath = path.join(home, ".wfl-claude", "projects", "-fixture", "33333333-3333-4333-8333-333333333333.jsonl");
    assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(transcriptPath)).mode & 0o777, 0o600);
    await fs.chmod(statePath, 0o640);
    await assert.rejects(runtime.readBackgroundAgent("ab12cd34"), /不安全|0600/);
    await fs.chmod(statePath, 0o600);
    const stateBackup = `${statePath}.real`;
    await fs.rename(statePath, stateBackup);
    await fs.symlink(stateBackup, statePath);
    await assert.rejects(runtime.readBackgroundAgent("ab12cd34"), /不安全/);
    await fs.rm(statePath);
    await fs.rename(stateBackup, statePath);

    const stopped = await runtime.stopBackgroundAgent("ab12cd34");
    assert.equal(stopped.shortId, "ab12cd34");
    assert.equal(stopped.state, "stopped");
    await assert.rejects(runtime.startBackgroundAgent({ cwd: root, prompt: "outside" }), /超出账号工程范围|工程目录不存在|工程目录超出账号范围/);
    await assert.rejects(runtime.readBackgroundAgent("../bad"), /ID 无效/);

    const isolatedStateDirectory = path.join(root, "isolated-state");
    const isolatedHome = path.join(root, "isolated-home");
    const isolatedProject = path.join(root, "isolated-project");
    await Promise.all([fs.mkdir(isolatedHome), fs.mkdir(isolatedProject)]);
    const isolatedStore = await new ClaudeStore(path.join(isolatedStateDirectory, "store")).initialize();
    isolatedRuntime = await new ClaudeRuntime({
      user: {
        stateDirectory: isolatedStateDirectory,
        home: isolatedHome,
        projectRoot: isolatedProject,
        systemUsername: "isolated",
        legacy: false,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
      },
      store: isolatedStore,
      appVersion: "test",
      command,
    }).initialize();
    assert.deepEqual(await isolatedRuntime.listBackgroundAgents(), []);
  } finally {
    await isolatedRuntime?.destroy();
    await runtime?.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function waitForCondition(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Claude fixture condition");
}

function onceRuntimeEvent(runtime, predicate) {
  return new Promise((resolve) => {
    const listener = (event) => {
      if (!predicate(event)) return;
      runtime.off("event", listener);
      resolve(event);
    };
    runtime.on("event", listener);
  });
}

function storedZip(files) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const [name, rawContent] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const content = Buffer.from(rawContent);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, nameBuffer);
    localOffset += local.length + nameBuffer.length + content.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}
