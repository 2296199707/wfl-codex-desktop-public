# DeepSeek Harness 官方子代理替换实施计划

状态：官方 `SubagentRuntime` Host Bridge 已接线；旧的自建循环和 one-shot 主路径已移除；当前工作树的定向回归已完成，供应商切换保护已补齐，尚未重新部署；当前主站基线为 `0.43.61-beta`。

调查日期：2026-08-16（UTC）

## 当前实施状态（2026-08-16）

本次按稳定、低风险、精简架构执行官方完整运行时路线：Codex 继续是外部父会话，
每用户 Host Bridge 为官方 Harness 提供可验证的直接父 Agent；子代理的身份、持久化、
后台继续执行、中断、列表和 settlement 由官方 `SubagentRuntime` 管理。前台调用仍可
显式选择 one-shot，但不把它当成后台子代理的默认架构。WFL 不增加 Token、回合、工具
次数、费用或任务预算，也不增加角色和自定义 continuation 状态。

已完成的接线：

- 旧第三方子代理实现已单独归档到
  `/srv/wfl-codex-desktop-backups/third-party-subagents-pre-deepseek-official-20260816T065055Z.tar.gz`，当前源码、测试和 UI 不再引用旧 MCP 名称或旧预算、角色、continuation 字段；
- MCP 暴露官方语义所需的 `subagent`、`send_message`、`interrupt_agent` 和 `list_agents`；
  `subagent` 参数为 `description`、`prompt` 和可选 `run_in_background`，控制工具只接收
  官方 child id 与消息/范围；
- 使用显式锁定的 `@deepseek-ai/dsh-*-0.1.0-rc.6` 包集合；`@deepseek-ai/dsh-subagent` 虽没有应用层直接 import，但仍是 `dsh-sdk-protocol` 和 `dsh-sdk-jsonrpc-server` 的官方 peer dependency，不能删除；
- 供应商页面只增加一个最小设置：从已经配置且具有模型与 API Key 的供应商中选择一个，并明确选择 `OpenAI Responses` 或 `OpenAI Chat Completions`；不按供应商名称、模型名或 URL 猜协议；
- 子进程使用目标用户的 `HOME`、`TMPDIR` 与父任务工作区；WFL 网页主路径按父任务当前工程配置继承 `read-only`、`workspace-write`、`danger-full-access`，但跨进程审批目前只接受明确为 `never` 的 child；`ask` 因官方 SDK 尚未实现 server-request/approval mux 而 fail closed，无法唯一确定父任务时也拒绝运行，取消时关闭官方 Harness；
- `build-essential`、`make`、`g++` 已存在，`node-pty@1.1.0` 原生绑定已成功加载；这是 `dsh-subprocess-local` 在新服务器安装时的前置条件；
- 凭据只通过 Harness 子进程环境注入，不进入 `cordis.yml`、MCP 参数、浏览器响应或公开供应商快照；MCP 认证令牌使用每个实例独立的 `0600` 文件，仅把文件路径放入该 MCP 的配置环境；
- 当前 `deepseek-harness-subagent` 定向回归已通过 30/30，覆盖 fake DeepSeek Chat
  Completions、fake GPT/OpenAI Responses、官方 coding tool 写文件、继承只读沙箱拒绝写入、
  并发、失败隔离、断连取消、非 `completed` stop reason、空结果拒绝、MCP
  `notifications/cancelled`、输入大小边界、错误脱敏、令牌文件权限、官方 continuable
  settlement、冷恢复和供应商切换保护。

本 Goal 的追加修复只修改了当前工作树源码，尚未重新部署到主站；重新部署时仍须使用新版本和既有蓝绿路径，且不得触碰冻结的 rescue `4321`。

### 追加语义修复（2026-08-17）

- `description` 只作为官方子代理的显示标签保留；发送给 Harness 的模型输入现在严格是
  `prompt` 原文，不再把两者拼成额外的 `Task description`／`Task instructions` 提示词，
  避免改变官方语义和无意义的上下文重复。
- Harness 返回 `error`、`max-tokens` 或 `aborted` 等非 `completed` 结束原因时，MCP 仍以
  `isError: true` 告知父代理，绝不把它算作成功；如果运行时已有最终/部分 assistant 文本，
  同时通过错误内容和 `structuredContent.partialOutput` 保留该文本及 `stopReason`，不再因
  错误包装直接丢失可用结果。
- WFL 没有向 `DeepSeekHarness` 传递 `maxTokens`，也没有第三方任务 Token、回合、工具或费用
  预算。官方 JSON-RPC server 的 `maxTokensAsSuccess` 只是结束状态映射开关，不是预算或
  截断参数；WFL 不显式设置它，使用官方默认值，也不会主动停止模型请求。
- 当前 `approval=ask` 仍是能力边界而不是已实现功能：官方 SDK 文档确认 server→client
  requests 尚未实现，WFL 也尚未把 DSH `approval/request` 接到 Codex approval mux；因此
  现在明确拒绝 `ask`，避免把没有审批通道的 child 误当成已继承权限。要支持它必须先完成
  真实的请求、决定、取消和断线 settlement 桥接，并通过独立测试验证。
- 已根据当前 Codex 源码验证 MCP 工具请求的官方元数据形状：`_meta` 中包含
  `x-codex-turn-metadata.thread_id`、`x-codex-turn-metadata.turn_id`，并带有 `threadId`。
  WFL 现在要求父线程和父轮次同时存在且一致；缺少元数据直接 fail closed，不再从唯一活动
  任务猜测父会话，也不再从项目配置回退推断权限。
- DeepSeek Harness MCP socket 现在随用户运行时稳定注册一次，但供应商设置只在工具调用时
  动态解析。未选择第三方供应商时，调用会在创建 Harness 前以“尚未配置供应商”失败，
  不会产生模型请求；启用、停用、换模型或修改 API Key 不需要重启 Codex app-server，
  不会留下旧 MCP 配置，也不会中断主会话。这样既保持 MCP 目录稳定，也避免运行中的设置
  与实际服务脱节。
- 当前没有第三方子代理 Token、轮次、工具次数或费用预算。`cordis.yml` 中官方
  `workspaceContext.maxBytes` 是加载 `AGENTS.md`/`CLAUDE.md` 的官方字节边界，不是模型
  输出 Token 上限；`tool_timeout_sec`、请求大小和 Bash 超时是传输/安全边界，也不会按额度
  截断已发出的模型请求。

## 真实完整任务验收与修复记录（2026-08-16）

`0.43.61-beta` 部署后使用已配置的真实供应商 `opencodego`、模型
`deepseek-v4-flash`、OpenAI Chat Completions 协议，向子代理发送了一次完整的只读工程
验收任务。子代理实际阅读代码、执行有界测试并返回结构化报告；生产路径的 socket 为
104 字节，运行中的 socket 存在且为 `0600`，没有高或中严重度问题。

子代理报告的低严重度问题已按低风险范围处理：

1. `start()` 在 `listen` 成功后现在立即校验 socket 文件类型；Linux 下路径过长会在构造
   服务时明确失败，而不是延迟到 `chmod`。
2. 启动时只扫描当前用户的 `dsh-*.sock`，并仅删除确认没有活动监听者的残留 socket；活动
   socket、普通文件和无法确认状态的路径均保留并拒绝覆盖。
3. `notifications/initialized` 仍按 MCP 通知规范忽略；MCP 级 `notifications/cancelled`
   已接入，会关闭对应的请求 socket 并触发 Harness close，不再只依赖进程断开。
4. socket 实例标识从 16 位缩短为 12 位十六进制，且构造时检查 Linux Unix socket 上限，
   为较深的 runtime 根目录保留更多余量。
5. 官方 `turn/end.reason` 现在必须是 `completed` 才能成功返回；`error`、`blocked`、
   `max-tokens`、`aborted` 和缺失结束状态会返回明确错误，空最终文本也不会伪装成功。
6. 前台 one-shot 使用临时官方 session id；后台 child 保留官方 durable session，由官方
   runtime 负责 settlement、后续消息、中断和冷恢复；两条路径都不清理并发兄弟任务。
7. MCP 请求有 512 KiB 字节上限，供应商错误中的常见 Bearer/API key 形式会脱敏。

### 协议边界记录

- WFL 外层的 `scripts/deepseek-harness-mcp.mjs` 是给 Codex app-server 加载的 MCP
  JSON-RPC server，负责把四个官方语义工具转发到每用户 Unix socket。
- DeepSeek 官方 Harness 内层不是 MCP：WFL runtime 进程直接组合官方 Cordis 插件和
  `SubagentRuntime`，通过受控 stdio 行协议接收 Host Bridge 请求；模型工具循环、child
  session、inbox、settlement 和恢复仍由官方 Harness 代码负责。
- 因此当前结构是“Codex ↔ MCP 外层适配器 ↔ WFL Unix socket ↔ 官方 DSH
  `SubagentRuntime`”，不能把 WFL 的 MCP 外壳称为 DeepSeek 官方 MCP 协议。

本 Goal 原始实施范围不包含发布；本次已按所有者明确要求完成主站 `0.43.61-beta` 部署。
后续只有在所有者明确要求部署时，才提升主站新版本并走既有蓝绿候选路径；不得触碰冻结的
rescue `4321`。完整仓库测试仍只能在开发/候选发布服务器
执行，普通生产服务器不得因部署而运行完整套件。

当前有意不增加一套“单次 Turn 上下文注册表”。WFL 网页发送的权限来自当前工程配置，
因此主产品路径与上述继承结果一致；若未来要让外部客户端在同一工程上提交临时、仅单次
Turn 的权限覆盖，并要求第三方 child 精确继承该覆盖，需要另行批准一个最小运行时上下文
跟踪改动。现阶段未知或无法证明的权限一律降为只读，不猜测放行。

## 1. 结论先行

先前把“最新 DeepSeek Harness 子代理”归纳为 `dsh-subagent-dsh-sdk` 的 one-shot
流程是不完整的。该包只是官方提供的一个进程外 Provider，并不是 DeepSeek 当前标准
Agent 使用的完整子代理架构。

真正形成当前行为的是 **background-first continuable delegation** 更新链：

- 最后一项行为更新是合并提交
  `564a853a04f4cd8b69f9ff10657b563ac1192b5e`，Git 历史标题为
  `Merge pull request #2277 ... background-first-continuable-subagents`。
- 其中核心提交为：
  - `8344d64363412c1b65b96596c1f0401eb513eacb`：continuable 委派在省略
    `run_in_background` 时默认后台运行；
  - `c778b5b0db18c0b647101de716d02a6f6a0d2f51`：完成该行为的评审修正与提示词收口。
- 这不是孤立改动。同一批可安装代码还依赖：
  - `c172faed370bb62a0b0ef2a04b76bdc87f5f63c6`（Git 历史中的 PR #1836）：
    子代理必须报告、`report` 默认唤醒父级、运行时无条件发送 settlement notice、
    冷子代理状态改称 `ready`；
  - `c76570a3b83e112f507e34331d0387639b1f5dbf`（Git 历史中的 PR #2138）：
    同一模型消息中的多个同级委派可并发执行。
- 上述行为首次一起进入 npm 包的是 **`0.0.1-rc.2`**，release 提交为
  `5ca7be5dcb310aad1ce83e673d2b4326a7329ac9`。
- npm `0.1.0-rc.6` 没有新增子代理行为；它是公开发布、包版本和依赖范围同步。

因此，实施基线不能写成“rc.6 新增官方子代理功能”。准确表述应是：

> 使用 rc.6 的公开包和新包名安装，但行为基线来自 rc.2 首次发布的
> background-first continuable 更新链。

这里必须把三种容易混在一起的“更新”分开：

- **最后一次子代理生命周期更新**：PR #2277，合并提交 `564a853a...`；它把
  continuable 委派改成 background-first，并配套模型提示和显式前台例外。
- **之后最后一次造成子代理模型可见名称变化的源码更新**：`a2d0f7f4...`；它是全仓库
  命名契约重构，把 one-shot 后台收集从 `task_*` 改称 `job_*`，并重命名若干包、类型
  和目录，没有改变 continuable 的生命周期；再后的相关源码改动只有注释措辞。
- **当前公开 npm 载体**：`0.1.0-rc.6`；关键子代理包的运行代码与
  `0.1.0-rc.3` 逐字节相同，变化限于包版本、公开访问和依赖版本同步。

所以若问题是“到底哪个更新形成了当前官方子代理行为”，答案是 **PR #2277 加上它
依赖的 PR #1836、PR #2138 行为链**；rc.6 只是目前可安装的承载物。

## 2. 调查证据

### 2.1 官方源码身份

- 仓库：`https://github.com/deepseek-ai/deepseek-harness`
- 唯一公开分支：`master`
- 调查时 HEAD：`47f943859bef60e4160492346772ded9b24f765a`
- 无 Git tag、无 GitHub Release。
- HEAD 合并的实际发布改动是将 DSH 包族从 `restricted` 改为 `public`，并把仓库清单
  提升到 `0.1.0-rc.5`；从 rc.3 release merge 到 HEAD 没有子代理运行源码变化。
- npm 登记的公开版本却是 `0.1.0-rc.6`，公开 Git 历史中不存在把这些清单提升到
  rc.6 的提交。不能把 rc.6 伪装成一个可定位的源码功能提交，也不能仅凭其版号推断
  新行为。

### 2.2 npm 包内容反证

已逐文件比较 rc.1、rc.2、rc.3、rc.5 和 rc.6 的关键包。

`0.0.1-rc.1 -> 0.0.1-rc.2` 的编译物存在真实运行代码变化：

- `dsh-tool-subagent` 出现
  `request.run_in_background ?? options.continuable`；
- `dsh-subagent` 出现独立来源类型 `subagent-settled` 和父级 settlement 投递；
- `dsh-tool-subagent-report` 的 `reportDelivery` 默认值从 `quiet` 改为 `wakeup`；
- `dsh-tool-subagent` 声明同级委派 `isConcurrencySafe`；
- `list_agents` 不再把可恢复的冷子代理误称为完成结果。

`0.1.0-rc.3 -> 0.1.0-rc.6` 的关键包中：

- `dsh-tool-subagent`、`dsh-subagent`、control、`list-agents` 和 report 的关键运行
  文件逐字节相同；
- `lib/`、类型声明和 README 相同；
- 只有 `package.json` 的版本、公开访问和依赖版本范围发生变化。

npm 包没有 `gitHead`、`_gitHead` 或 provenance source commit。因此源码提交与 npm
包的对应关系可由 release 提交、发布时间和编译物语义交叉证明，但不能伪称为 npm
提供的加密源码证明。正式接入必须同时锁定包版本、lockfile 和 tarball integrity。

### 2.3 dist-tag 陷阱

调查时：

- `@deepseek-ai/dsh` 的 `latest` 与 `next` 都是 `0.1.0-rc.6`；
- `@deepseek-ai/dsh-subagent`、`dsh-tool-subagent`、control、report、SDK client 等
  组件包的 `latest` 仍指向早期 rc.1，`next` 才是 rc.6；
- spawn/fork in-process 组件的 `latest` 仍指向早期 rc.3。

所以禁止使用不带版本的组件安装命令。候选实现必须显式固定
`0.1.0-rc.6`，并由 `package-lock.json` 固定实际 tarball integrity。

## 3. 当前官方设计边界

DeepSeek 标准 Agent 的主要路径不是 SDK one-shot，而是同一 DSH 进程中的完整
continuable 运行时：

1. `SubagentRuntime` 持有 Provider、持久化子会话、Activation 和父子所有权；
2. 标准 `subagent` 使用 `spawn-in-process`，新子代理不继承父对话内容；
3. 模型可见的 `subagent` 参数只有：
   - `description`（必填）；
   - `prompt`（必填）；
   - `run_in_background`（启用 continuable 时可选，省略默认 `true`）；
4. 后台调用立即返回 durable child id，不等待结果；
5. `send_message` 把消息排入该子代理下一回合，不返回任务结果；
6. `interrupt_agent` 只中断当前回合，保留未领取消息和已启动后代；
7. `list_agents` 用于找回可继续的子代理，不是轮询结果；
8. child-scoped `report` 是子到父的显式报告通道；无论是否报告，运行时都在
   Activation 结束时向父级发送 settlement notice；
9. 同级委派可并发，父级结果仍按模型工具调用顺序提交；
10. 官方没有 WFL 的角色、任务预算、continuation 状态、tombstone 线程或
    `spawn/wait/steer/list/stop/close` 生命周期。

官方 `maxDepth` 是部署级递归深度上限（默认 3），不是用户任务 Token/请求预算，
也不是模型参数。若采用完整官方配置，应保留其官方默认，但不在 WFL 设置界面新增
“预算”概念。

## 4. one-shot SDK Provider 的准确定位

`@deepseek-ai/dsh-subagent-dsh-sdk` 仍是官方包，但它被有意限定为 one-shot：

- 每次调用启动一个完整 DSH 子进程；
- `start() -> result -> dispose()`；
- 四项 start capability 全为 false；
- 不继承父对话；
- 没有 `prepareContinuable()`；
- 取消通过关闭子进程完成。

SDK JSON-RPC wire 只有：

- `initialize`；
- `session/prompt`；
- `shutdown`。

它会发送 `session.event`、`session.status`、`subagent.started` 和
`subagent.finished` 通知，但没有跨进程 `startContinuable`、`send_message`、
`list_agents` 或 `interrupt_agent` 请求。

官方 Web API Proxy 对已经存在的 DSH 子代理提供 list/history/prompt/interrupt，
但没有“替外部非 DSH 父会话创建 continuable 子代理”的接口。

## 5. 与 WFL 当前架构的真实冲突

WFL 主会话当前由 Codex app-server 持有。DeepSeek 完整 continuable 运行时要求
父级是同一 DSH Context 中的真实 `Agent`，因为以下事实都以该对象为权威：

- 父子会话和权限；
- inbox 消息顺序；
- Activation 所有权；
- settlement wake/steer；
- 冷恢复和持久化；
- 祖先中断授权。

因此不能用一个薄 MCP 转发器把 Codex thread id 当成 DSH Agent id。这样做需要新建
“影子父代理”、双向同步两个会话、重新实现 wake/settlement/ownership，实质上又会
造出一套 WFL 生命周期，违背“严格官方设计”和“额外设计先确认”。

这也是为什么此前的 one-shot 方案虽然容易落地，却不能称为“完整对齐最新官方设计”。

## 6. 上游仍存在的歧义

同一公开 HEAD 中，官方组合配置对 `subagent_fork` 不一致：

- `dsh-base` bundle 和对应 Agent Note 明确设置 `backgroundMode: one-shot`，理由是
  continuable child 的 `report` 提示会破坏 fork 复用父级请求前缀；
- Web 的 standard/code/cordis Agent Preset 仍设置
  `backgroundMode: continuable`，该行可追溯到更早提交，未随 one-shot 决策同步。

这说明“官方最新版”本身不是一份完全无歧义的配置。第一阶段不得擅自复制
`subagent_fork`；若只接入官方主工具，应以 fresh `spawn` 的 `subagent` 为范围。
是否额外开放 fork，必须等待上游修正或由所有者单独确认。

## 7. 当前集成决策：官方 Runtime + 薄 Host Bridge

当前采用的是官方完整 `SubagentRuntime`，不是 `dsh-subagent-dsh-sdk` 的 one-shot
Provider，也不把 Codex thread id 伪装成 DSH Agent id。

- 每用户启动一个隔离的官方 DSH runtime 进程；它组合真实的 DSH `Context`、Host Agent、
  `SubagentRuntime`、session persistence 和 provider。
- Host Agent 只承担官方 runtime 要求的直接父级和 settlement inbox，不执行额外模型回合；
  child 的身份、inbox、Activation、继续执行、中断、列表、持久化和冷恢复仍由官方代码
  持有。
- WFL 只负责 MCP/Unix socket 传输、加密供应商读取、父线程元数据验证、cwd/sandbox
  交接、用户隔离和 settlement 送回 Codex。
- 不开放官方源码仍有歧义的 `fork`，不增加角色、任务预算、Token/回合/工具次数阈值、
  自定义队列或自定义终态机。

这是一层宿主适配，不宣称 Codex app-server 与 DSH 已成为同一个原生父会话。当前仍保留
两项明确能力边界：父级 `ask/on-request` 审批没有跨进程往返时 fail closed；真实 Codex
app-server 的重连和后端重启仍需独立验证。

### 供应商切换规则

运行中的官方 runtime 是其 child 的 provider 所有者。配置变更不会立即停止它：控制已有
child 的 `send_message`、`interrupt_agent` 和 `list_agents` 继续进入旧 runtime。新任务只有
在官方 `list` 确认所有持久 child 都是 `inactive`、且没有未完成 runtime 请求时才切换；
状态读取失败、诊断项或状态不明都拒绝切换并保留旧 runtime。这个规则是宿主安全边界，
不是用户任务预算或生命周期设置。

## 8. 已执行和待执行阶段

### 阶段 0：证据与依赖固定

- 锁定 `0.1.0-rc.6` 包集合、lockfile integrity 和上游行为 fixture；
- 逐字核对 `SubagentRuntime`、`listChildren/listDescendants`、settlement 和 persistence
  API；
- 保持 rescue `4321` 完全冻结。

### 阶段 1：官方 runtime 接线

- 已删除旧 WFL 模型循环、角色、预算、任务截断和旧 MCP 工具面；
- 已接入每用户 Host Bridge、凭据隔离、父线程归属、cwd/sandbox 继承、并发、取消、
  settlement、冷恢复和 provider switch fail-closed；
- `ask/on-request` 仍明确拒绝，未静默降级为 `never`。

### 阶段 2：MCP 与父会话适配

- 外层只暴露 `subagent`、`send_message`、`interrupt_agent` 和 `list_agents`；
- MCP schema 不包含 WFL budget、role、thread ownership 或 provider credential；
- settlement 通过 Codex 原生 thread/turn 传输适配回父会话，并保持重复防护。

### 阶段 3：有界回归

- 当前 `deepseek-harness-subagent` 定向测试为 30/30；覆盖 fake DeepSeek/GPT 兼容接口、
  工具写入、只读沙箱、并发、取消、settlement、冷恢复和供应商切换；
- 不调用真实供应商作为普通开发步骤；只有明确的真实功能测试才允许调用；
- 完整测试只在开发/候选发布服务器运行，普通服务器只做有界兼容和健康检查。

### 阶段 4：发布

- 需要发布时提升主站新版本，沿既有 blue-green 路径启动候选、readiness 验证、默认
  强制切流、验证流量、再停旧后端；
- 使用 deployment watchdog、writer fencing 和既有恢复链；
- 不更改 rescue-active-port、rescue slot、服务状态、资源或组件版本。

## 9. 验收标准

- 旧 WFL 自建模型循环、角色、预算和任务截断不再可达；
- MCP schema 与官方四个工具语义一致，不出现 WFL 自定义预算字段；
- 多个 child 可以并发运行；后台 child 可 settlement、后续消息、中断、列表和冷恢复；
- 供应商切换不会杀掉运行中的旧 child，状态不明时 fail closed；
- 子进程取消和服务关闭后无孤儿进程；
- 管理员主对话始终可继续或恢复；
- rescue `4321` 未发生任何变化；
- approval 和真实 Codex app-server 重连边界必须如实标注，不能以 fake 测试冒充已解决。

## 10. 现有冻结归档

- 归档：
  `/srv/wfl-codex-desktop-backups/third-party-subagents-pre-deepseek-official-20260816T065055Z.tar.gz`
- SHA-256：
  `3a608736e32872ee13a6eb9b08c87ebef144d8c70c02517b7affbd39f46af8a0`
- 校验文件：同路径追加 `.sha256`
- 包含 54 个文件、`MANIFEST.md`、逐文件 `SHA256SUMS` 和 `snapshot/`。

归档已通过 gzip、tar 列表和哈希校验。恢复时只能解压到临时目录并逐文件提取，
不得覆盖当前脏工作树。
