# 第三方子代理官方对齐实施计划

> 历史归档：本文件记录的 OpenAI agent-thread / WFL 自建线程方案已被路线 B 替换，
> 不得据此恢复旧预算、角色或 `wfl_programming_*` 接线。当前实施状态以
> [DeepSeek Harness 官方子代理替换实施计划](./deepseek-harness-subagent-replacement-plan.zh-CN.md)为准。

> 原状态：预算误导修复已完成，官方对齐继续推进；源码尚未部署
> 决策日期：2026-08-16
> 工作目录：`/srv/wfl-codex-desktop-v0.43.55-beta`

## 1. 已确认的产品约束

官方依据：[OpenAI Docs：Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

所有者已经确认：

- 第三方供应商额度充足，不使用 WFL 自定义的任务回合、工具次数、任务时长或费用预算。
- 预算字段会误导用户和主代理，必须从工具 schema、运行时结果、文档和测试中删除。
- 子代理按官方 agent-thread 的角色、生命周期、权限继承和摘要回传语义对齐。
- 官方文档之外的新增参数、状态或编排策略，实施前必须先询问所有者。
- 主站子代理更新不得影响管理员对话访问，不触碰冻结的 rescue/4321 组件。

## 2. 官方基线

官方公开的内置角色是：

- `default`
- `explorer`
- `worker`

官方公开的全局配置包括启用状态、会话并发线程数、默认子代理模型、默认推理强度和中断消息。官方文档没有 `maxTurns`、`maxTotalTurns`、`maxToolCalls`、`maxDurationMs`、`maxQueueDurationMs`，也没有预算耗尽后的 `needs_continuation` 状态。

目标生命周期：

```text
spawn → queued/running → completed | failed | blocked | cancelled
                    ↘ wait / steer / stop / close
```

`wait` 收集线程结果；已完成线程可以接收后续指令；`stop` 停止工作；`close` 释放已结束线程资源。

## 3. 已完成修复

- 删除 MCP 编程任务中的全部预算字段。
- 删除服务端预算字段归一化、结果字段和默认角色预算。
- 删除总回合、工具次数、累计时长、接力次数和 follow-up 次数硬上限。
- 删除 `needs_continuation`、`programming_continue` 和自动接力路径。
- 模型持续使用同一线程上下文执行，直到返回最终文本、供应商失败、父任务停止或触发重复工具循环保护。
- 最终 assistant 消息写回线程上下文，保证后续指令能看到此前结论。
- 内置角色收敛为官方 `default`、`explorer`、`worker`，删除 WFL 硬编码的 `reviewer` 别名。
- MCP 展示文本不再出现“内部安全预算”“剩余预算”或“可继续”等误导。
- 新增回归：explorer 连续完成 9 次工具调用、在第 10 个模型回合总结，仍返回 `completed`，且结果中没有预算字段。

## 4. 保留的执行边界

以下边界不是额度预算：

- 单次供应商 HTTP 请求超时；
- 父任务显式取消和 `stop`；
- 完全相同工具调用的重复循环检测；
- 工程路径、密钥过滤、父线程权限、补丁哈希和命令白名单；
- 供应商并发线程数与排队；
- 工具结果、图片和上下文的协议安全处理。

这些边界只处理连接故障、权限和确定的执行循环，不会因为已经消耗的 Token 达到本地阈值而截断任务。

## 5. 下一阶段

### P0：官方生命周期完整性

- 保证 spawn、wait、steer、list、stop、close 的状态和父线程隔离一致。
- 保证 Chat Completions 与 Responses 的工具调用和结果始终成对。
- 保证所有完成线程向主代理返回实际模型摘要和文件/检查信息。
- 修复供应商用量按真实协议聚合的问题。
- 关闭线程时保留可审查结果，不保留密钥、图片或完整工具历史。

### P1：主界面可观测性

- 展示 Active/Done 子代理线程及模型返回的摘要。
- 展示 Token 用量、请求数和耗时作为只读事实，不将它们命名为预算，也不据此自动停止线程。
- 允许查看、停止和关闭自己父对话中的线程。

### 需要所有者先确认的项目

- 运行中 `steer` 是等待当前模型/工具边界后送达，还是立即中断当前请求后送达。
- 是否移除无工程上下文的 `wfl_delegate_subtasks` 和启动并等待兼容入口 `wfl_programming_subagents`，只保留官方线程工具面。
- 是否以及如何把工具箱角色编辑器连接到官方 custom agent 配置文件。
- 是否采用供应商专属的服务端会话 ID 或 Responses `previous_response_id` 来降低历史重复发送；不能默认假设所有第三方兼容。

在这些项目得到确认前，不自行引入自定义状态、自动接力、预算、供应商切换或摘要协议。

## 6. 定向验证

必须覆盖：

1. 工具 schema 只接受 `id`、`title`、`role`、`prompt`。
2. 旧预算参数被拒绝，不被静默解释。
3. 超过旧角色回合上限的有限任务仍能完成。
4. `wait` 不返回预算暂停或要求 `continue`。
5. `stop` 能中止模型请求和工程工具。
6. 重复工具循环返回明确阻断原因。
7. 最终 assistant 文本保留在后续指令上下文。
8. 图片 Base64 不进入后续历史或最终结果。
9. 不同父线程不能操作彼此的子代理。
10. `default`/`worker` 不绕过父对话权限和审批。

当前已复核 146 项定向测试通过（MCP/工具服务/用量/工作区 27 项、执行器 24 项、主界面 95 项）；未运行完整仓库测试、浏览器 smoke、压力测试或发布流程。

## 7. 发布边界

- 本计划不授权正式发布或服务重启。
- 主站部署必须使用新版本和既有 blue-green 路径。
- 默认采用所有者指定的立即强制切换，同时保留候选验证、watchdog、readiness、writer fencing 和恢复链。
- 不修改、启动、停止、切换或升级 rescue/4321。

## 8. 2026-08-16 高额 Token 事故与 DeepSeek 官方 Harness 调研

### 8.1 事故记录

本次四个子代理审查任务的供应商返回用量如下。这里的“轮数”是线程尝试的模型回合，不是用户发送的任务数；“工具调用”是子代理实际执行的工程工具次数。

| 任务 | 模型轮数 | 工具调用 | 输入 Token | 输出 Token | 总 Token |
| --- | ---: | ---: | ---: | ---: | ---: |
| executor 审查 | 67 | 103 | 2,938,724 | 30,974 | 2,969,698 |
| MCP 审查 | 102 | 151 | 4,647,940 | 48,236 | 4,696,176 |
| UI 审查 | 166 | 272 | 7,054,348 | 39,547 | 7,093,895 |
| 测试/部署审查 | 60 | 123 | 2,689,898 | 36,017 | 2,725,915 |
| 合计 | 395 | 649 | 17,330,910 | 154,774 | 17,485,684 |

输入占总量约 99.1%，因此“消耗很多 Token 但最终结果很少”是真实问题，不是把同一个响应重复记账。WFL 当前在每次第三方响应后累加供应商 `usage`；最终账单仍须以供应商后台为准，因为失败、超时和缓存 Token 的计费方式可能与 WFL 收到的字段不同。

已确认的根因：

- `lib/subagent-executor.mjs` 的 `runThread()` 在模型返回工具调用后继续进入下一轮；只有模型返回无工具调用的文本才正常结束。
- Responses 和 Chat Completions 请求都把累计的 `conversation` 作为下一次请求的完整输入；工具结果越多，后续每轮输入越大。
- 当前 256KB 上下文处理是原始消息裁剪，不是保留事实、文件、错误和待办事项的语义摘要；单个工具结果超过 24KB 时也可能只保留损坏或不完整的字符串。
- 循环保护只对完全相同的工具名和参数做重复识别，轮换关键词、文件窗口或命令参数时仍可能持续探索。
- 四个任务都是大范围审查，线程之间不共享探索结果，同一工程文件和测试输出可能被重复读取。
- 单次 `max_output_tokens` 只约束一次供应商请求，不约束整个线程；删除 WFL 自定义预算是正确的，但不能把“无限继续直到模型自行结束”当成完整的收敛机制。

事故影响：四个任务共 395 次模型回合和 649 次工具调用，其中至少两个任务在长时间运行后没有拿到可靠的最终摘要，而是因传输/等待超时结束。当前实现修复前，不应把同价位高成本模型直接接入生产；这不是新增任务预算的授权，处理方向必须是官方式的任务边界、上下文压缩、循环收敛和结果交付。

### 8.2 调研对象与身份核验

本次查到的 DeepSeek 官方开源项目是 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)，不是名为 Hermes 的项目。仓库归属于 `deepseek-ai` 官方组织，仓库许可证为 MIT，项目说明为 “DeepSeek Harness: Everything is a Plugin”。

版本基线必须跟随最新版本，不能把本次调研的旧快照直接当成接入版本。2026-08-16 核对结果为：官方 `master` 当前 HEAD 是 `47f943859bef60e4160492346772ded9b24f765a`，源码包版本标为 `0.1.0-rc.5`；官方 npm `0.1.0-rc.6` 包集合已经发布，主包 `@deepseek-ai/dsh` 的 `latest` 和 `next` 都指向 `0.1.0-rc.6`，部分子包的 `latest` 标签仍停留在旧版而 `next` 指向 `rc.6`。因此实施前必须显式锁定并验证完整的 `0.1.0-rc.6` 包集合；如果从 GitHub 源码构建，则锁定同一个最新 commit 全量构建。禁止依赖模糊的 dist-tag，禁止混用 `rc.5` 源码、`rc.6` 依赖和旧 `latest` 子包。

官方仓库中没有 `Hermes` 代码或插件名称。独立的 [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) 是另一个 MIT 开源项目，不属于 `deepseek-ai`；搜索结果中的 `oh-my-deepseek-harness` 等项目也属于第三方扩展，不能作为 DeepSeek 官方实现依据。

### 8.3 DeepSeek Harness 已有的子代理与压缩能力

DeepSeek Harness 不是只有一个简单的委派函数，而是完整的插件能力家族：

| 官方模块 | 能力 | 对 WFL 的意义 |
| --- | --- | --- |
| [`packages/subagent`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent) | `ctx.subagents` 提供方注册、子代理运行结果和生命周期 | 可作为正式的子代理抽象参考 |
| `subagent-spawn-in-process` / `subagent-fork-in-process` | 新上下文子代理、从父级已完成轮次创建的 fork 子代理 | 明确区分独立上下文与继承上下文 |
| `subagent-acp` / `subagent-dsh-sdk` | 通过 ACP 或官方 TypeScript SDK 运行独立子进程 | `subagent-dsh-sdk` 是接入官方 DeepSeek Harness 运行时的候选路径 |
| `subagent-codex` / `subagent-claude-code` | 对接官方 Codex app-server 和 Claude Agent SDK | 说明提供方是可插拔的，不应在 WFL 中重写每个供应商的执行循环 |
| `tool-subagent` / `tool-subagent-control` / `tool-subagent-report` | 模型委派、子代理控制和子代理向父代理报告 | 有明确的父子结果边界，父代理不接收全部中间工具流量 |
| [`packages/compaction`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/compaction) | 基于 token 压力和上下文窗口的自动压缩、工具结果剪枝和语义摘要 | 直接对应本次事故中的上下文重复问题 |
| [`packages/llm/llm-deepseek`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-deepseek) | DeepSeek 原生流式适配、thinking/reasoning 参数、工具调用回传和 usage | 比把 DeepSeek 当作通用 OpenAI-compatible 端点更适配其协议细节 |

关键实现事实：

- 官方 in-process 子代理通过 `parent.ctx.agents.create()` 创建真正的子 Agent，子 Agent 有独立 session 和 Agent loop；不是在宿主里手工维护一个字符串数组再用 `while (true)` 反复 POST。
- 一个 one-shot 子代理会提交一次独立 prompt，等待 child agent 空闲，读取其最终 assistant 输出，然后执行幂等 dispose；异常会映射为明确的 stop reason，部分结果不会伪装成成功。
- 官方 agent loop 将每个模型步骤、工具调用、工具结果和 turn 结束原因写入 session；工具调用按协议成对保存，并支持并行工具的有界调度。
- `dsh-compaction-basic` 会根据实际模型上下文容量计量压力，优先进行不依赖模型的工具结果剪枝，必要时用一次语义摘要替换旧的完整历史，并校验压缩后确实降低了上下文压力。
- DeepSeek 适配器按其接口传回工具调用轮次的 `reasoning_content`，始终以流式方式请求 usage，并明确拒绝不支持的图片内容；这比当前 WFL 通用解析器更适合 DeepSeek thinking/tool-call 组合。

### 8.4 结论与接入边界

结论：DeepSeek 官方确实有可复用的子代理插件和完整运行时，且对 DeepSeek 模型的上下文压缩、thinking、工具调用和 usage 处理明显比当前 WFL 的通用 HTTP 循环更成熟。最值得评估的不是复制某个第三方 Hermes 插件，而是以最新同批次的 `dsh-subagent` seam、`dsh-subagent-dsh-sdk` 和 `dsh-compaction-basic` 为参考或可选后端。接入验证必须以锁定的最新版本为准，不能继续使用旧调研快照作为运行时依赖。

但 DeepSeek Harness 的 `continuable` 子代理、深度策略、report 通道和插件组合是它自己的产品设计；它们不能未经确认直接加入当前“按 OpenAI Codex 子代理语义对齐”的 WFL 公共接口。当前文档只记录调研结论，不授权替换执行器、引入 DeepSeek 专属生命周期、增加供应商预算或部署新版本。

后续若要实施，必须先完成以下有界评估并单独确认接入方案：

1. 在无真实高价模型的回放测试中，对比当前执行器和官方 DSH SDK 子进程的模型请求数、输入/输出/缓存 Token、工具调用数和最终结果完整性。
2. 确认官方 DSH SDK 运行时的安装、进程隔离、凭据传递、工程目录映射和管理员父线程权限能否符合 WFL 约束。
3. 只在官方 DeepSeek 模型配置下验证其 native adapter；不能因为 OpenAI-compatible 端点可用就推断协议、thinking 或 usage 完全兼容。
4. 评估采用官方运行时作为可选 DeepSeek 后端，还是只移植其 session/compaction 设计；两者都会改变现有子代理实现边界，实施前需由所有者确认。

### 8.5 最新官方实现对 WFL 接入方式的进一步核对

基于最新 `master` 源码以及 `0.1.0-rc.6` 发布包的接口和测试，官方子代理的真实结构如下：

- 一次性子代理走 `SubagentProvider.start(request)`，成功后返回一个拥有者负责的 `SubagentRun`：等待 `run.result`，再无条件调用幂等的 `run.dispose()`。模型/传输失败通过 `stopReason` 返回，不把部分结果伪装成成功；发布前失败才由 `start()` 拒绝。
- 连续子代理不是 provider 自己维护线程状态，而是 `SubagentRuntime` 的 continuation manager 负责 `startContinuable()`、FIFO `followup()`、`interrupt()`、持久化 session、冷恢复、父子权限和 child-first 释放。provider 只可通过可选的 `prepareContinuable()` 提供创建时的 seed；不能拥有 Agent、AgentHandle、turn 或 teardown。
- 官方模型工具是 `dsh-tool-subagent`，参数是任务描述、完整 prompt 和可选的 `run_in_background`。one-shot 后台任务使用官方 jobs；continuable 后台任务返回 durable child id，后续由 `send_message`、`interrupt_agent`、`list_agents` 和 child-scoped `report` 完成。官方没有 `default/explorer/worker` 角色，也没有 WFL 的 `programming_subtasks`、`programming_continue`、线程 tombstone 或自定义任务预算。
- 最新 `subagent-dsh-sdk` 是进程外 one-shot provider：`capabilities` 的四项均为 false、`inheritsParentContext` 为 false，并且没有 `prepareContinuable()`。它只启动一个完整 DSH 子进程，接收自己的 Cordis 配置、session、模型和工具，父端只通过 `initialize`、`session/prompt`、`shutdown` 驱动；SDK 协议没有取消请求或 session-close 方法，取消的官方语义是关闭子进程并等待其退出。
- 因此，`subagent-dsh-sdk` 可以作为 WFL 的官方 DeepSeek one-shot 后端，但不能承载 WFL 当前的连续 `steer` 语义。若要使用官方 continuable 设计，必须让真实的 DSH `Context/Agent/Session` 和 continuation manager 成为所有者；把它们在 WFL 中重新仿写一遍会变成额外的 WFL 编排设计。
- DSH 的编程能力来自子进程自己的 Cordis 组合，例如官方 filesystem、search、bash/terminal、sandbox、compaction 和 token-meter 插件；SDK 后端不会自动继承 WFL 的 `SubagentWorkspace`、敏感文件过滤或 `apply_patch` 校验。直接把 WFL 工程根目录交给官方 coding preset 会形成新的写入和凭据边界，不能未经确认启用。

严格按官方设计的最小接入边界应当是：先只实现 WFL 到最新 `subagent-dsh-sdk` 的 one-shot provider 映射，保留官方的 `start → result → dispose` 语义；不新增角色、批量编排、预算、续接、报告、线程关闭状态或自定义循环。官方 continuable、官方控制工具以及写入工具组合，只有在确认 WFL 是否要成为 DSH runtime 所有者、以及工程写入边界之后才能讨论，当前不授权实现。
