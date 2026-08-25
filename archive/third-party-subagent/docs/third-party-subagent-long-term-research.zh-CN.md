# 第三方子代理长期研究日志

状态：进行中

Goal：`01a00683-419d-7791-9469-158b4a4c8a25`

目标是用官方源码、锁定发布物和可复现实验解决 WFL 第三方子代理的实际缺口。本文
只记录已经核对的事实和实验，不把设计猜想写成结论。实现仍须遵守仓库规则：不增加
WFL 自定义预算、角色或生命周期；需要超出官方语义的方案必须单独确认。

## 2026-08-16：基线核验

### 当前工作树

- 当前源码包版本为 `0.43.61-beta`，但工作树包含大量先前任务的未提交改动，不能用
  `git diff` 直接推断本次子代理改动的完整范围。
- 当前第三方接线位于 `lib/deepseek-harness-subagent.mjs`、
  `scripts/deepseek-harness-mcp.mjs`、`lib/third-party-subagent-policy.mjs` 和
  `server.mjs`。
- 针对 Harness、策略和 TaskStatus 的回归测试本轮为 **47/47 通过**；此前记录的
  fake DeepSeek/GPT-compatible、工具写入、只读沙箱、并发、断连取消和 MCP schema
  测试也通过。
- 本轮权限上下文追加修复尚未重新部署；不得把工作树测试结果当作主站已上线结果。

### 官方 DeepSeek 发布物

已核对本地安装包和 npm registry：

- 官方仓库：`https://github.com/deepseek-ai/deepseek-harness`
- `master` HEAD：`47f943859bef60e4160492346772ded9b24f765a`
- 相关 npm 包：`0.1.0-rc.6`
- `@deepseek-ai/dsh-subagent-dsh-sdk@0.1.0-rc.6` 的 integrity：
  `sha512-LIEx1A/9SoTwgJFPII2YLQEjI8oUX/vG6P05k4ruhmv4sb4FftVW/TNe3XxLjP6JtLiko0ms+6R21B1ZF8km5A==`
- `@deepseek-ai/dsh-subagent-dsh-sdk` 的源码目录：
  `packages/subagent/subagent-dsh-sdk`

### 已确认的 API 边界

本地 `@deepseek-ai/dsh-sdk-client@0.1.0-rc.6` 的导出和实例方法为：

- `DeepSeekHarness`: `start`、`session`、`run`、`close`
- `HarnessClient`: `start`、`initialize`、`prompt`、`request`、`subscribe`、
  `subscribeSessionTree`、`close`
- 没有跨进程 `startContinuable`、`followup`、`interrupt_agent`、`list_agents` 或
  `report` 请求。

本地 `@deepseek-ai/dsh-subagent@0.1.0-rc.6` 则导出了完整的进程内运行时：

- `SubagentRuntime.startContinuable`
- `SubagentRuntime.followup`
- `SubagentRuntime.interrupt`
- `SubagentRuntime.reportFrom`
- `SubagentRuntime.listChildren`
- `SubagentRuntime.listDescendants`
- `SubagentRuntime.prepareContinuable`

这两个包属于不同层级。前者是驱动独立 Harness 进程的 SDK，后者要求真实 DSH
`Context`、`Agent`、session persistence 和 provider seam。不能仅因为同一版本号就把
它们视为同一种运行时。

### 官方 SDK provider 的源码事实

从 npm tarball 解出的 `@deepseek-ai/dsh-subagent-dsh-sdk` 明确写明：

- 每个 child 是独立的完整 Harness 进程；
- 每次执行由 SDK 驱动 one-shot run，并在结束时回收；
- `capabilities` 使用 `NO_START_CAPABILITIES`；
- 只读取父会话的 workspace cwd，不继承父 DSH Context；
- 取消的实现是关闭独立 Harness，而不是官方 continuable child 的
  `interrupt`（保留 inbox 和 child 身份）。

因此，当前 WFL 的 one-shot 路线是官方支持的 provider 形态，但不是官方标准 Agent
的 background-first continuable 形态。

### 官方 OpenAI/Codex 文档基线

已读取官方页面：
`https://developers.openai.com/codex/subagents.md`

页面确认：

- 官方 Codex 子代理继承父会话的 sandbox/approval 权限；
- 官方内置角色是 `default`、`worker`、`explorer`；
- 多个同级子代理适合并行；
- `max_concurrent_threads_per_session` 是并发线程设置，不是任务 token 预算；
- 自定义 agent 文件主要定义 `name`、`description`、`developer_instructions`，其余
  会话设置在未覆盖时从父级继承。

这构成 WFL 的宿主语义基线，但不能证明 Codex app-server 会把 MCP 工具调用的父
thread/turn 元数据自动传给任意 MCP server；这一点必须做真实 app-server 实验。

## 当前待验证实验

1. 用真实 Codex 0.147 app-server 启动 MCP server，让主模型实际调用 `subagent`，
   捕获 MCP stdin 原始 JSON，确认 `_meta` 是否包含稳定的 thread/turn 身份。
2. 在父线程并发、重连、`thread/resume` 和后端重启后重复实验，确认权限快照是否仍可
   精确绑定；没有可验证元数据时必须继续 fail closed。
3. 用 DSH `ask` approval 触发真实写工具，确认 SDK 文档所说的“双方 server request
   未实现”是否导致挂起、拒绝或其他明确失败，并记录完整事件链。
4. 逐事件统计 DSH `assistant/chunk` / `usage`、`turn/end` 和工具调用，确认当前
   WFL 只返回 `finalResponse` 是否丢失可用的 token 观测。
5. 在隔离的官方 DSH Context 中运行 `SubagentRuntime` 的最小 continuable fixture，
   验证 `startContinuable → followup → interrupt → listChildren → cold resume` 的
   实际依赖和宿主所有权要求。
6. 评估是否存在不新增 WFL 生命周期、又能让 Codex 父会话接收 settlement 的官方
   app-server 通道；若不存在，分别记录“保留 one-shot”与“DSH 成为一等父运行时”
   的真实代价。

## 暂不作出的结论

- 不因为 MCP 可以增加几个工具名，就声称已经实现官方 continuable。
- 不把 DSH `maxDepth`、网络超时或并发上限包装成 WFL 任务预算。
- 不把外部 Codex thread id 伪装成 DSH Agent id。
- 不在没有真实 approval/settlement 证据前开放后台持久子代理。

## 2026-08-17：本轮验证与修复记录

- 本轮没有调用真实 DeepSeek/GPT 供应商，只使用 fake Harness、fake SSE 和 fake
  Codex app-server。
- 发现空闲父会话 settlement 的 `turn/start` 分支缺少自己的写租约保留变量；这会在
  Codex 返回运行中的 Turn 时抛出 `ReferenceError`，已补上并保留“Turn 活跃时由原生
  terminal notification 释放租约”的路径。
- 发现 settlement 队列的 Codex 通知唤醒使用了原生 thread id，而队列键使用公开 thread
  id；已统一经过 `publicThreadIdForNative()`，避免导入线程完成后队列不再重试。
- 发现跨进程 Harness 没有 `approval/request` 往返，但 WFL 仍会接受父级 `ask`，而
  `cordis.yml` 的官方 approval 插件固定为 `never`。这属于权限扩大风险，不是可接受的
  语义映射；现已在服务和父上下文解析两层 fail closed，返回
  `SUBAGENT_APPROVAL_UNSUPPORTED`。只有父级明确为 `never` 才能启动第三方子代理。
- 这次没有增加 token、回合、工具次数、费用、任务预算或自定义生命周期；Goal 的
  `tokensUsed` 只是平台累计遥测，`remainingTokens=null` 表示没有完成预算上限。

### 2026-08-17：并发 settlement 竞态与恢复验证

- 新增并通过了活跃错误 Host 的父子归属测试：即使错误的父会话 Host 已经在内存中，
  `send_message`/`interrupt_agent` 仍先读取 child 持久化 `parentSession`，不会因为复用
  Host 而越权。
- 新增并通过了两个同父 child 并发完成的测试。第一次运行发现真实竞态：第一个官方
  settlement 使 Host 进入无模型 `pre-step reject`，第二个 settlement 通过 `steer` 进入
  Host 的 `next-step`，但 DeepSeek Agent loop 在 blocked pre-step 后不会自动再次唤醒，
  所以第二条会留在 inbox 而不触发 WFL settlement。
- 修复方式是 Host Bridge 的适配逻辑：监听官方 settlement inbox 插入；若 Host 正在
  reject 当前无模型 turn，则等 Host idle 后，一次只把一个待处理 settlement 从
  `next-step` 重新放入官方 `next-turn` FIFO，继续让官方 inbox/claimed 路径处理。没有
  新增 WFL 任务队列、预算、角色或终态机。
- 新增并通过绑定文件安全测试：`host-bindings.json` 权限为 `0600`，仅包含父线程、Host、
  cwd 和 sandbox，不包含供应商 API key、socket token 或 Bearer 字符串。
- 新增并通过 runtime 重启 cold-resume 测试：关闭第一个 runtime 后，第二个 runtime
  可以从官方持久化 session 恢复 Host，列出原 child，并通过官方 `followup` 冷恢复同一
  child；child ID 和 settlement 均保持一致。
- 本轮定向结果：`deepseek-harness-subagent` **27/27**、settlement queue **3/3**、
  Codex settlement **1/1** 通过；仍未调用真实第三方供应商，未部署。

### 2026-08-17：供应商切换回归修复

- 复现了真实缺陷：旧 provider 的 durable child 正在运行时，下一次请求解析到新 provider，
  原实现立即关闭旧 runtime，导致模型请求被中断且没有 settlement。
- 修复为：控制已有 child 的 `send_message`、`interrupt_agent`、`list_agents` 在旧 runtime
  仍存活时继续使用旧 runtime；新任务要求切换时，先调用官方 `listDescendants` 检查所有
  已保存父 Host 的 `activity`，发现 `running`、未完成 runtime 请求、diagnostic 或无法读取
  状态时 fail closed，保留旧 runtime。
- 只有所有持久 child 都是官方 `inactive` 且请求已收敛时才停止旧 runtime并启动新 provider。
  新增 fake-provider regression，验证旧 child 正常 settlement，切换后新任务实际使用新模型；
  当前 `deepseek-harness-subagent` 测试结果为 **30/30**。
- 本轮没有调用真实 DeepSeek/GPT 供应商，没有部署，也没有增加 WFL 任务预算、Token/回合/工具
  次数限制或自定义生命周期。

### 2026-08-17：并发 runtime 所有权与冷恢复 provider 修复

- 复现了并发首次启动竞态：两个 child 在 provider 冷恢复检查的异步间隙同时创建 runtime，后
  创建的实例会覆盖服务里的 runtime 引用，关闭时无法回收前一个实例，留下孤儿 runtime 进程。
- 修复为把 provider 决策、冷恢复检查和 runtime 启动放入同一个 `officialRuntimeStarting`
  transition；provider 解析后再次检查锁，确保并发请求共享一个 runtime，不引入并发任务上限。
- 生产 resolver 现在保留并转发 `providerId`。runtime 重启且当前选中 provider 已变更时，先按
  持久化的旧 `providerId` 恢复旧 runtime；旧 child 全部 `inactive` 后，新任务才切换到当前选中
  provider。旧 provider 不存在或指纹无法验证时继续 fail closed。
- 新增冷恢复 provider 所有权回归：验证 A child 在配置切到 B 后仍由 A 恢复并完成，随后新任务
  才使用 B；并发 runtime、父隔离、供应商切换和冷恢复定向测试均正常退出，无孤儿 runtime。
- 本轮仍没有调用真实 DeepSeek/GPT 供应商，没有部署；Goal 未设置 completion budget，平台的
  `tokensUsed` 仅为累计遥测。

仍未解决且需要后续证据的边界：

1. 外部 Codex 的 `ask/on-request` approval 尚未有跨进程 request/decision 往返；当前
   继续 fail closed，不把它静默降级为 `never`。
2. 真实 Codex app-server 对 MCP `_meta` 父 thread/turn 元数据、重连和后端重启的行为，
   仍需单独实测；fake app-server 结果不能替代该证据。
