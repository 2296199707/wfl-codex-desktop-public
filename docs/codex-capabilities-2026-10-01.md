# Codex 0.159.3 能力适配记录

## 当前任务与基线

用户要求「帮更新新版 codex 能力」。以稳定版能力适配为范围，优先最小修改，保留已有发送、追加、停止、并行对话和历史恢复行为。

- 已安装并由所有者确认保留：`codex-cli 0.159.3`。npm latest 同为 `0.159.3`，不安装 alpha，不重复执行 CLI 更新。
- 主站已部署版本：`0.45.4`。此次审查开始时活动后端 `4318`，Codex 就绪；代码中的协议审查基线仍为 `0.153.4`。
- 备用窗口独立冻结：`4321 / 1.1.16`，槽位解析到 `.codex-runtime/releases/v0.44.55-7cee544ef285`，PID `2735898`。本任务不改备用窗口组件、服务、槽位或选择文件。
- 保留工作区中既有网页 SSH、模型目录和其他改动，不提交或推送用户未要求的变更。不同代码上线须新版本及既有蓝绿、watchdog、候选检查、writer fencing 和恢复路径。

## 已确认的官方依据

已使用 `openai-docs` 技能读取官方更新说明：<https://developers.openai.com/codex/changelog/>。官方 app-server 文档访问曾超时；实际接口和字段以本机稳定版生成的 TypeScript / JSON Schema 为准。

- `0.159.1` 将 `gpt-6.1-sol` 加入内置默认模型目录。网站应读取实际目录，不替换用户已选择的模型或供应商。
- `0.159.0` 提供按 item anchor 分页历史和可选 `instant_interrupt`。后者是 opt-in，不能默认改变现有追加消息语义。
- `0.158.0` 涉及命令完成/启动失败事件、数字推理强度、线程设置直接回复、运行中环境选择及图片能力。
- 部分新增能力只属于 CLI/TUI 或上游实验接口，不直接等同于网站功能。逐项以协议差异和现有网站入口决定接入方式。

## 审查进度

- [x] 确认运行时已是最新稳定版，前一网页 SSH `0.45.4` 发布已完成。
- [x] 阅读已有协议生成、兼容检查、能力探测和历史读取实现。
- [x] 生成 `0.159.3` experimental TypeScript 与 JSON Schema 到 `/tmp/wfl-codex-0159-review-Blm7F8/`，与保留的 `0.153.4` schema 对比。
- [x] 审查方法和字段变化，记录网站实际缺口与接入决策。
- [x] 完成必要实现，更新协议 fixtures、coverage、安装推荐。
- [x] 运行有限针对验证，记录结果及实际上线状态。

旧生成目录 `/tmp/wfl-codex-0153-review-IKOkDn/new` 仍存在，可以直接比较，不必重新查旧版源码或下载旧运行时。既有 `test/codex-current-conversation.test.mjs` 可用于真实安装版本与本地 Fake Responses 的有界兼容验证；不访问付费供应商，不跑完整仓库或压力套件。

## 实现和验证结果

- 方法差异：client requests `158 → 170`（新增 13，删除已弃用的 `thread/rollback`）；server notifications `83 → 85`。核心发送、停止和恢复接口无移除，相关参数无新增必填项。
- 历史：接受官方 `{ type: "item", itemId }` 游标；浏览器继续读取旧页时使用已经加载的最早原生 item ID。初次读取、旧版运行时和迁移快照保留原游标路径，继续沿用现有选择代数、加载取消和终态 fencing。
- 字段探测：基于当前二进制生成的 TS 判断 item anchor、MCP `serverName`、resource `target`，不按版本字符串猜测能力。消息分页保留原生开始/完成时间。
- MCP：检查器按单服务查询并使用当前对话的 MCP 连接；支持显式 connector/link resource target，显示 `toolsError`；继续使用原有账号隔离和权限。
- 记忆：已有 Memories API 增加原生 `memory/status` 结果，页面展示 v2Ready 与 v2ConsolidatedThreads。旧版不请求此方法，状态读取失败不让已有记忆文件和设置不可用。
- 推理：官方协作预设和子代理设置接受协议中的数字/自定义字符串，移除旧强度枚举限制；子代理输入保留建议选项并允许填写。修复保存函数对已删除 `COLLABORATION_STRATEGIES/strategy` 的残留引用。Ultra 只标记推理强度，不新增 WFL 子代理策略。
- 未启用 `instant_interrupt`，未替换用户模型或供应商，未变更现有任务入场、重试、恢复和停止策略。
- 新 typed JSON thread attachments、native user verification、explicit gateway OAuth 和 rollout/compress 已逐项审查并记录 deferred 原因；不把 metadata attachments 当作发送文件，未把原始账号令牌或宿主验证接口直接开放给网页。

针对检查命令：`node --test --test-concurrency=1 test/codex-protocol-coverage.test.mjs test/codex-compatibility.test.mjs test/codex-runtime-capabilities.test.mjs test/codex-policy.test.mjs test/codex-0159-capabilities.test.mjs test/codex-0153-ui.test.mjs test/codex-thread-history.test.mjs`，46 项通过，1 项跳过（可选旧版 0.146 二进制未配置）。

真实安装版本隔离检查：`node --test test/codex-current-conversation.test.mjs`，约 7 秒通过。本地 Fake Responses 使用 `gpt-6.1-sol`：执行无害 printf，完成工具结果回传、命令终态/退出码、item anchor、Memories 状态、独立线程创建/读取、追加 steer、interrupt 和 resume；数字强度 `"42"` 确认由官方 Codex 发为 JSON number `42`。没有调用真实付费供应商，没有跑完整仓库、浏览器或压力套件。

补充有限回归：历史 item 合并的 5 项现有用例通过，UI 元素/版本/官方协作的 4 项静态用例通过。主站 `0.45.5` 版本和资源缓存标识同步，离线 `quick-update-check`、版本元数据与语法/diff 检查通过；MCP 检查器新增对话切换后忽略旧响应的针对验证。

## 上线状态

截至 2026-10-07：`0.45.5` 已完成本地部署，活动主站 `4319 / Codex 0.159.3`；以下为候选准备时的历史记录，最终结果见末尾部署完成记录。

适配代码完成，准备新主站版本 `0.45.5`。当前线上仍为 `0.45.4 / 4318 / Codex 0.159.3`；现有主站、网关、备用窗口健康，网页 SSH 分享页返回 200。

部署前发现主站 PID `3123392` 到 `82.158.88.71:15162` 有活动 SSH 连接。用户之前明确要求保留已在使用的连接；「运行」「允许」仅授权上一次 `0.45.4` 切换中断，不能复用为此次允许。先完成候选包，未开始主站切换、重启或改冻结备用窗口。

### 0.45.5 候选包已准备

- 快照 `eeb208b10cac5340ee3d76d215d09641eb259690`，tree `80aaee18bc13ce2145dc4e08a3cf1b4149cad7a1`。
- 包 `backups/wfl-codex-desktop-v0.45.5-eeb208b10cac.tar.gz`，SHA-256 `558568a2eb9e063436cbe13c85788c9bb63d005f169f271fa8a0e21c6ec5cf08`；在 backups 目录执行 `sha256sum -c` 校验成功，新增适配模块、文档、针对测试和全部 0.159.3 fixtures 已包含。
- 有限验证共 57 个独立用例通过，另 1 个可选旧版本检查跳过。未进行完整仓库/浏览器测试。
- 主分支 HEAD 仍为 `a060f6beff1a2c5f5edf67345b5cb7ddff879b77`，未提交主分支或推送。打包快照是临时 index / commit-tree 生成的不可变候选。
- 最终复查 SSH 连接仍在使用（PID `3123392`，FD `36`）。主站/备用窗口服务未重启，备用 PID `2735898`、槽位、包和 HTML/JS/CSS 校验和与冻结基线相同。
- 未启动此次 release worker；后续若获本次切换许可，使用上述已校验的候选及既有 `release.mjs --package-source` 蓝绿流程，不能换成别的未校验源码或触碰备用窗口。

## 2026-10-07 本地部署

所有者回复「部署」，授权执行上次已明确告知会中断旧 SSH 的 `0.45.5` 主站切换。使用原不可变候选 `eeb208b10cac5340ee3d76d215d09641eb259690`，不重新打包不同代码，不提交或推送。

- 部署前：主站 `0.45.4 / 4318 / Codex 0.159.3` 就绪，`4319` inactive；网关 policy 8 与候选代码相同。
- 原候选 SHA-256 再次校验成功，离线快速兼容检查通过；不重复运行完整仓库、浏览器或压力套件。
- 采用已有 local-candidate/package-source release worker、强制蓝绿切换、独立 watchdog、候选就绪检查、writer fencing 和恢复流程。
- 备用窗口基线：`4321 / 1.1.16 / Codex 0.153.4`，PID `2735898`，槽位 `v0.44.55-7cee544ef285`；服务单元、package 与 HTML/JS/CSS 校验和与原冻结记录一致，`rescue-active-port` 文件不存在且不创建。
- 当前开始发布，最终完成状态与上线验证结果待记录。

### 部署完成和上线验证

- 后台发布单元 `wfl-codex-release-v0-45-5-1791374693101-480b910b` 已完成，status/phase 均为 `completed`，error 为 null，完成时间戳 `1791374755546`。用户中断对话期间 worker 持续运行；恢复后仅核对原任务，没有重复发起发布。
- 已按候选就绪 → watchdog 与强制 writer fencing 切换 → 网关验证 → 停止旧后端的既有流程完成 `4318 → 4319`。活动槽位解析到 `.codex-runtime/releases/v0.45.5-eeb208b10cac`；版本和全部页面缓存标识核验为 `0.45.5`。
- 主站 PID `3199417`，旧 `4318` 服务 inactive/PID 0。新后端 `codexReady/threadListReady/runtimeBundleReady/codeModeHostReady: true`，`codexRecovery.state: ready` 且无待恢复 thread；运行时保持 `0.159.3`。
- 非离线 `quick-update-check.mjs` 全部通过：Codex 兼容状态 compatible、新字段能力已探测、网关上游 `4319`、主站就绪、登录页 200、未认证 WebSocket 返回正常 401。没有执行仓库测试、浏览器测试或真实供应商推理请求。
- 经稳定网关的登录页与 SSH 分享页均返回 200，资源版本为 `0.45.5`；公网 `https://mofen.fun/login.html` 确认登录表单和 `0.45.5` 缓存标识。未认证 `/api/health` 仍返回 401，认证没有绕过。
- 备用窗口仍为 `4321 / 1.1.16 / Codex 0.153.4`，PID `2735898`、NRestarts 0、原槽位和服务单元/包/HTML/JS/CSS 校验和全部不变；`rescue-active-port` 仍不存在。
- 本地部署完成，未提交主分支或推送。切换停止旧后端，旧网页 SSH 会话须重新登录，不能跨此后端重启恢复原 PTY。
