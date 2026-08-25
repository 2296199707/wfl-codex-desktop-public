# Claude Code 安装与更新问题记录

记录时间：2026-08-16

这份记录用于保留新服务器安装和 Claude Code 组件更新中的可复现问题、修复边界和验证结果。Claude 是独立可选组件；这些问题不应阻断 Codex 主站或管理员对话。

判定口径：`Doctor` 返回 0 且没有 `fatalIssues` 只代表核心兼容性检查通过；如果仍有 warning，或完整能力审查尚未完成，只能记为“警告但通过/未完成”，不能直接记为可正式发布。只有版本、协议、能力基线和所需回归均完成，才可记为“发布候选通过”。

## 已确认问题

### 1. 新服务器误装 Claude

根因是主项目把 `@anthropic-ai/claude-code` 放在 `optionalDependencies`，而安装器执行普通 `npm ci`。在 Linux x64 上 npm 会自动选择并下载该 optional package，因此“可选安装”实际上变成了默认安装。

修复：

- 从主项目 `package.json` 和 `package-lock.json` 移除 Claude 包及其平台包。
- 保留其他 optional 依赖（尤其 Sharp 的平台运行时），不使用全局 `npm ci --omit=optional`。
- 安装器在 `npm ci` 前调用 `scripts/migrate-claude-component.mjs`。
- 新服务器没有 bundled Claude 时不创建组件；已有 bundled Claude 时先原子复制到 `.codex-runtime/claude/current`，再允许 npm 清理应用依赖。

### 2. Claude 2.1.233 更新被 Doctor 警告阻断

失败单元：`wfl-claude-install-1786846264377-2c7b0bd8`。失败阶段是兼容性验证，错误为：`Claude Doctor reported an unhealthy installation`。

2.1.233 的 `doctor` 能正常启动并返回 0，但会报告两个普通 warning：native 安装配置未知，以及 `/root/.local/bin/claude` 缺失或损坏。旧检查器只接受精确文本 `No installation issues found.`，把 warning 错判为 `installationHealthy=false`。

修复：

- `sanitizeClaudeDoctor()` 现在分别输出 `warnings`、`fatalIssues` 和 `installationHealthy`。
- warning 摘要仍会展示，但不会阻断候选组件；路径会被安全脱敏。
- 明确的 installation issue、fatal/error/critical 结果仍然阻断激活。
- 版本、commit、核心参数、协议探测和语义基线检查仍保持阻断能力。

### 3. 2.1.233 的验证边界与回滚

2.1.233 已完成下载、启动和轻量 Doctor/协议探测：Doctor 返回 0，保留 2 条普通 warning，`fatalIssues=[]`。这表示核心兼容性检查通过，但不表示新增参数和 `import` 命令已经完成完整能力审查。

随后按安全策略回滚到 2.1.220，原因是 2.1.233 尚未完成完整能力审查，不是 Doctor 报告了 fatal 错误。记录如下：

- 更新单元：`wfl-claude-install-1786848339759-eff9ea82`；结果为核心检查通过、warning 保留、候选进入待管理员决定状态。
- 回滚单元：`wfl-claude-install-1786848414219-3023b149`。
- 当前状态：2.1.220、来源 `bundled`、`pendingDecision=null`；当前主站继续使用回滚后的稳定组件。
- 当前审查基线仍为 2.1.220；2.1.233 不得在没有新增能力矩阵和管理员决定的情况下重新激活。

## 回归验证

- `node --test test/claude-migration.test.mjs`
- `node --test test/claude-compatibility.test.mjs`
- `node --check scripts/migrate-claude-component.mjs`
- `bash -n scripts/install-server.sh`
- 实际重试单元 `wfl-claude-install-1786848339759-eff9ea82` 成功，2.1.233 已进入
  `.codex-runtime/claude/current`；Doctor 保留 2 条 warning，`fatalIssues=[]`，状态为
  `ready + pendingDecision`，随后已通过 `wfl-claude-install-1786848414219-3023b149`
  回滚到 2.1.220。
- 回滚后再次确认当前状态为 2.1.220、`bundled`、无待决定状态；主站 4319 的未授权健康请求仍返回
  `401`，说明网关认证边界保持正常。

尚未在普通服务器运行完整仓库测试、浏览器冒烟或压力测试；正式发布前应在主开发/候选服务器完成完整验证。救援窗口及其 4321 端口不属于本修复范围。

## 第三方子代理复核观察

本次按要求优先使用第三方子代理做只读复核。第二轮 4 个审查线程因达到各自的累计工具回合预算而只留下进度文本，没有可靠最终摘要，随后已关闭：

- `sa-msv79yby-7`：迁移补丁安全性；
- `sa-msv79ybz-8`：Doctor 判定；
- `sa-msv79ybz-9`：回归测试覆盖；
- `sa-msv79ybz-a`：更新失败恢复路径。

这些线程的 `incomplete` 只记录为当时子代理硬预算缺陷的事故证据，不能被当作 Claude 产品验证结论。2026-08-16 已从子代理 schema 和运行时删除该预算/接力设计；另行执行的三个有界只读文档复核已返回摘要，结论与本记录一致：必须区分 Doctor 通过、完整能力审查和正式发布授权。

## 后续观察项

- 在一台全新临时服务器验证 `npm ci` 后 `node_modules` 不含 Claude，Codex 仍可启动。
- 在一台旧服务器验证迁移后再执行依赖更新，确认迁移脚本重复执行、部分中断和恢复均不会破坏已有组件。
- 明确安装器的退出码、Doctor warning/fatal 决策、低权限/非交互环境和网络失败行为。
- 继续为 2.1.233 建立能力矩阵；管理员确认前保持“未完全审查”标记，不能重新激活。
