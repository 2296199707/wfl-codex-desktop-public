# DeepSeek Harness 第三方子代理：官方设计验证与完整集成方案

状态：调查和方案阶段；本文件新增于 2026-08-16，尚未按本方案改造生产架构，也没有在本轮部署。

本文回答三个问题：中间层是否会造成明显延迟、当前 WFL 子代理为什么没有完整官方能力、以及如何在不重新实现一套 WFL 调度器的前提下接入 DeepSeek Harness 的真实 continuable 子代理。

## 结论先行

结论不是“继续给当前 one-shot 外面加几个接口”。经源码、发布包、官方测试和本地桥接验证后，推荐的完整方向是：

```text
Codex app-server
  -> WFL MCP / Host Bridge（只做宿主适配、身份、权限、传输和事件投递）
  -> 每用户长驻的官方 DSH Context
  -> 官方 SubagentRuntime
  -> 官方 spawn-in-process 子代理
  -> 官方 session persistence、sandbox、approval 和 LLM adapter
```

核心判断如下：

1. 中间层本身不是性能瓶颈。当前 fake Harness 基准中，桥接层中位数约 `0.87 ms`、P95 约 `2.21 ms`；主要耗时来自 Harness 冷启动和模型请求，而不是 MCP/Unix socket。
2. 当前 WFL 已经是官方 DeepSeek Harness SDK 的 **one-shot** 路径，不是官方标准 Agent 的完整 continuable 路径。它可以执行一次独立 coding child，但没有官方的 `startContinuable`、`followup`、`interrupt`、`listChildren`、持久化冷恢复和 settlement notice 链路。
3. 完整功能可以通过中间层实现，但中间层必须是 **官方 DSH Runtime 的宿主适配器**，不能自己再做任务队列、预算、角色、tombstone、continuation 状态机或 `spawn/wait/stop/close` 生命周期。
4. 纯 MCP 无法天然把稍后到达的 child settlement 注入 Codex parent model；但当前 Codex
   源码已经验证 MCP 工具请求会携带 `x-codex-turn-metadata`（含 `thread_id`、`turn_id`）
   和 `threadId`。因此 one-shot 可以做精确父会话绑定；缺少或不一致时必须拒绝，不能用
   “猜唯一 active task”或把 `parentThreadId` 暴露成模型工具参数糊过去。
5. 第一阶段只接官方 fresh `spawn` 和 continuable 子代理，不接 `subagent_fork`。官方公开配置对 fork 的 background 行为仍有冲突，继续扩大范围会增加不必要风险。
6. 不增加 WFL 预算、角色、任务时长、工具次数、continuation 状态、用户可见生命周期控制或自定义编排策略。官方 `maxDepth` 若需要，保留为部署级递归深度保护，不把它包装成用户任务预算。

因此，当前可立即确认的是“方案可行，桥接延迟可接受，官方 child runtime 已被验证”；当前不能诚实宣称的是“现有 WFL MCP 已经具备完整官方 continuable 能力”。

## 1. 调查范围和证据来源

### 1.1 官方仓库和发布版本

调查使用的官方仓库：

- 仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 调查时 HEAD：`47f943859bef60e4160492346772ded9b24f765a`
- HEAD 时间：`2026-08-13T19:38:46+08:00`
- 关键源码目录：
  - [`packages/subagent/subagent/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/index.ts)
  - [`packages/subagent/subagent/src/continuation.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/continuation.ts)
  - [`packages/subagent/subagent-spawn-in-process/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent-spawn-in-process/src/index.ts)
  - [`packages/subagent/tool-subagent/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent/src/index.ts)
  - [`packages/subagent/tool-subagent-control/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent-control/src/index.ts)
  - [`packages/llm/llm-pi-ai/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm-pi-ai/README.md)

npm 调查结果：

- `latest = 0.0.1-rc.1` 或更早的组件标签并不统一；很多组件的 `next` 才是 `0.1.0-rc.6`。
- 本方案不能使用不带版本的 `latest`。所有接入包必须显式固定 `0.1.0-rc.6`，并由 lockfile 固定 integrity。
- `0.1.0-rc.6` 是目前公开可安装的包载体，不能把它描述成一个新产生 continuable 行为的源码提交。
- 关键包已查询到的 integrity：

| 包 | 版本 | integrity |
| --- | --- | --- |
| `@deepseek-ai/dsh-subagent` | `0.1.0-rc.6` | `sha512-vROmBDAlaFAzzSlTBOlvg/7fO55zxhUztnLtB3lKmN5RevrNQBjTsbeIMDQ8ow5ZplxEOnLU+sikFoA5JaoH8A==` |
| `@deepseek-ai/dsh-subagent-spawn-in-process` | `0.1.0-rc.6` | `sha512-62mtUEr5megxVy6CwQCdZVq5MCSt+kMw74ns5m7PK0PlZTWcxQVBQHNdfkE9sX4Cageu7YTvciUJuH8amm6bsQ==` |
| `@deepseek-ai/dsh-subagent-in-process-driver` | `0.1.0-rc.6` | `sha512-KK8Ep4PeSyrM3YQdcZhetXsiBd+bliKu6NWWKyTh60LobKtVNREfPBlqRfzc0mU0ZIKD4VEC7RfuJaqvz4UlPw==` |
| `@deepseek-ai/dsh-tool-subagent` | `0.1.0-rc.6` | `sha512-yK+ETLxDZhtwc19uqv5yAVzq3x/i2hjV9p67Or1a+s9Eqs+eu+ZJJk5hQ/2JeRiJet2otOC4zzOkYb/UVSBFyA==` |
| `@deepseek-ai/dsh-tool-subagent-control` | `0.1.0-rc.6` | `sha512-zoVt+uV8yyg1dAuIMydtz/AfARZPkjFOXQLd90a3Bj8GdxpE3tdaR6ZIv3xD39Grxe2vRz4gOZEJ9qth3O+s9g==` |
| `@deepseek-ai/dsh-tool-subagent-report` | `0.1.0-rc.6` | `sha512-DqnJ6yJ0wO35jdcpCSuogbx/PC4xE8wrcVxXPvSw9I59p/8nROsfwB9UXuJoilp/wenREUoTi0X8+5ZOVSRLqw==` |
| `@deepseek-ai/dsh-session-projection` | `0.1.0-rc.6` | `sha512-DYLALBPdEI1LZjJ4B6rdGdGY4gy+iR2+5Xh2xJoAGa/pTyN5Z55TNfvuMJrmeRBjAuDXNUQpmURbvos5rJ4veg==` |
| `@deepseek-ai/dsh-llm-pi-ai` | `0.1.0-rc.6` | `sha512-5RvzkpVCYLg9A3IGdm04px7XOaF/xikuMLe2toBY4A0qtJraXiZtUN1QBOL9i6u7DTOLG9oHP/USsbWRpyI+1Q==` |
| `@deepseek-ai/dsh-agent-loop` | `0.1.0-rc.6` | `sha512-yShuKIMW360H14L4y13j3gz3Ix1s/3lwEEpfJW4hnFAE09h9Z4yJA7UfTQmQdzMRMnuj4uWFPw0e0BbapnkFuw==` |
| `@deepseek-ai/dsh-user-approval` | `0.1.0-rc.6` | `sha512-9rnkSDGOpu2XUeGwbPeTzVUTFWTND1PMPM5L/ZQPptV5yyZlQiNxM2rCC6OdL+ZVerwxEqrRhZIQn/KVtQfKag==` |

### 1.2 “到底哪个更新”形成了当前官方子代理行为

不能只看 rc.6 版号。源码和发布物交叉检查后的准确结论是：

- 最后一次形成当前生命周期语义的合并提交是 `564a853a04f4cd8b69f9ff10657b563ac1192b5e`，标题为 `background-first-continuable-subagents`。
- 其中关键行为提交包括：
  - `8344d64363412c1b65b96596c1f0401eb513eacb`：continuable 委派在省略 `run_in_background` 时默认后台运行；
  - `c778b5b0db18c0b647101de716d02a6f6a0d2f51`：对应评审修正和提示词收口；
  - `c172faed370bb62a0b0ef2a04b76bdc87f5f63c6`：报告、settlement notice、唤醒父级和冷子代理状态链路；
  - `c76570a3b83e112f507e34331d0387639b1f5dbf`：同一模型消息中的同级委派可以并发。
- 这条行为链首次一起进入 npm 发布物是在 `0.0.1-rc.2`；`0.1.0-rc.6` 是公开包和依赖范围同步后的可安装载体。
- 后续 `a2d0f7f4...` 主要是命名契约重构，例如 one-shot 后台收集从 `task_*` 改成 `job_*`，不是 continuable 生命周期重写。

所以实施基线应写成：**使用 rc.6 的公开包，行为基线是 rc.2 首次发布的 background-first continuable 更新链**。

## 2. 官方设计到底提供了什么

### 2.1 官方 `SubagentRuntime` 的真实能力

官方 `SubagentRuntime` 暴露的核心能力包括：

```text
startContinuable
followup
interrupt
reportFrom
registerContinuableSetup
drainContinuableDescendants
listChildren
listDescendants
start
```

`spawn-in-process` 的关键事实：

- child 在同一个 DSH `Context` 中创建，但有自己的独立 `Session`；
- child 不复制父会话全文；
- child 使用官方 continuation manager 管理 Activation、inbox、父子所有权和后续唤醒；
- `prepareContinuable()` 为官方持久化/冷恢复链提供能力；
- session persistence 和 projection 负责在进程重启后发现可继续的 child；
- parent 的身份必须是真实 DSH `Agent`，不能只拿一个外部字符串 thread id 冒充。

官方模型可见工具的语义是：

| 工具 | 官方语义 |
| --- | --- |
| `subagent` | 创建 fresh child；continuable 模式下省略 `run_in_background` 默认后台运行，显式 `false` 才等待一次性结果 |
| `send_message` | 将消息排入指定 continuable child 的下一回合；工具确认“已排队”，不返回 child 最终结果 |
| `interrupt_agent` | 只中断当前回合，保留 child、未领取消息和后续继续能力 |
| `list_agents` | 从实时或持久化 projection 发现/恢复 child，不是轮询任务结果 |
| `report` | child 向直接 parent 显式报告；报告不会结束 child turn |

child 完成时，官方 runtime 还会向 parent inbox 发送 settlement notice，包含最终 assistant 内容。parent 空闲时会被唤醒，parent 忙时使用 steer；这由 DSH runtime 完成，不需要上层轮询。

### 2.2 one-shot Provider 和完整 Runtime 的区别

| 能力 | 当前 WFL 使用的官方 SDK one-shot | 官方 in-process continuable |
| --- | --- | --- |
| 启动方式 | 每次调用启动一个 Harness 子进程 | 一个 DSH Context 中创建真实 child Agent |
| 调用流程 | `start -> run -> close` | `startContinuable -> child Activation -> settlement` |
| 父会话 | 外部 Codex 只等待最终文本 | DSH parent Agent 是官方所有权和 inbox 权威 |
| 后续消息 | 无官方 `followup` | `followup` 进入 child inbox，支持 FIFO 和冷恢复 |
| 中断 | 主要是关闭 one-shot Harness | `interrupt` 只取消当前回合，child 继续存在 |
| 发现/恢复 | 无 `list_agents`/持久化 child 目录 | `listChildren`/`listDescendants` 和 session projection |
| 完成通知 | MCP 工具返回一次文本 | settlement notice 自动进入 DSH parent inbox |
| 进程开销 | 每次冷启动 | Runtime 长驻，child 可冷恢复 |

结论：当前 SDK 接线不是错误，也不是“官方 continuable 的简化实现”；它准确地实现了官方 one-shot Provider 的边界，但不能继续包装成完整官方子代理。

### 2.3 官方没有哪些 WFL 自定义概念

官方设计没有要求模型或用户填写：

- 任务 Token 预算、回合预算、工具调用预算、费用预算；
- `role`、WFL 自定义角色编辑器或自定义 worker/explorer 生命周期；
- `needs_continuation`、tombstone、WFL 任务状态机；
- `spawn/wait/steer/list/stop/close` 这一组自定义生命周期工具。

供应商额度、网络超时、父级显式中断和部署级递归深度是连接/部署安全事实，不能被改名为用户任务预算。已经发出的模型请求不能因为 WFL 本地预算耗尽而被截断。

## 3. 当前 WFL 的真实实现和缺口

### 3.1 当前链路

```text
Codex app-server
  -> scripts/deepseek-harness-mcp.mjs（外层 MCP stdio）
  -> WFL Unix socket
  -> lib/deepseek-harness-subagent.mjs
  -> @deepseek-ai/dsh-sdk-client
  -> @deepseek-ai/dsh-sdk-jsonrpc-demo
  -> Cordis coding tools
```

每一次当前调用都会：

```text
new DeepSeekHarness
  -> start()
  -> run()
  -> close()
```

当前 MCP 对外只暴露：

```text
subagent(description, prompt)
```

当前 `config/deepseek-harness/cordis.yml` 已使用官方 `dsh-llm-pi-ai`，并明确从环境变量读取 API、base URL、模型和 API key 引用；当前 `package.json` 已锁定 rc.6 的 one-shot Harness 相关包和通用 LLM 适配器，但没有把完整 continuable 所需的 spawn、tool-control、report 组合成运行时。

### 3.2 已经实际验证的能力

当前实现已经通过以下能力验证：

- 官方 Harness start/run/close 只执行一次；
- fake DeepSeek OpenAI Chat Completions；
- fake OpenAI Responses；
- 官方 coding tool 写入工作区；
- 继承 `cwd`、sandbox 和 approval policy；
- `read-only` 沙箱拒绝写入；
- API key 只进入 Harness 子进程环境，不进入 MCP 参数或公开结果；
- Unix socket 创建、权限、清理和路径长度保护；
- MCP 工具 schema 只包含 `description` 和 `prompt`；
- MCP 连接断开会关闭正在运行的 Harness；
- 无效或歧义的父会话上下文会 fail closed，而不是猜测目录和权限。

### 3.3 当前不是完整功能的部分

当前缺少或不完整的能力：

1. 每次调用冷启动，不能复用长驻 DSH Context。
2. 没有 `run_in_background`、`send_message`、`interrupt_agent`、`list_agents` 和 child-scoped `report`。
3. 没有 `startContinuable`、settlement notice、inbox 顺序、Activation 所有权和 cold resume。
4. MCP adapter 先忽略所有无 `id` 的消息，因此当前 `notifications/initialized` 的处理分支实际上不可达。
5. MCP 级 `notifications/cancelled` 已由当前 one-shot 外层接入；它会关闭对应请求 socket
   并触发 Harness close。该能力仍不等同于官方 continuable 的 `interrupt_agent`。
6. MCP adapter 现在要求精确的父线程和父轮次元数据；缺失时在连接 Harness 之前拒绝，已
   删除 active task 数量猜测和配置回退路径。
7. 未选择第三方供应商时不启动该用户的 Harness socket，也不把第三方 MCP 工具注入主 Codex。
8. DSH 的 `ask` approval 请求尚未跨进程接入现有 Codex approval mux；不能把 `ask` 静默降级成 `never`。
9. Codex MCP 调用完成后，单纯 MCP server 没有标准机制把未来 child settlement 直接变成 Codex parent model 的新消息。

这些是功能边界，不是继续增加本地预算或重试次数可以解决的问题。

## 4. 官方资料和实际测试结果

### 4.1 官方源码测试

在隔离的官方源码仓库中，已安装 lockfile 依赖并运行过以下有界测试：

```bash
corepack pnpm install --frozen-lockfile --ignore-scripts

corepack pnpm exec vitest run \
  packages/subagent/subagent/tests/continuation.spec.ts \
  packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts \
  packages/subagent/tool-subagent-control/tests/list-agents.spec.ts \
  --reporter=dot
```

结果：3 个文件通过，`123 tests passed`。

```bash
corepack pnpm exec vitest run \
  packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts \
  packages/subagent/subagent-in-process-driver/tests/structured.spec.ts \
  packages/subagent/subagent-in-process-driver/tests/inheritance.spec.ts \
  --reporter=dot
```

结果：3 个文件通过，`53 tests passed`。

```bash
corepack pnpm exec vitest run packages/subagent/tool-subagent/tests
```

结果：2 个文件通过，`68 tests passed`。

为了验证 DeepSeek/GPT-compatible 供应商配置入口，本轮又运行：

```bash
corepack pnpm exec vitest run \
  packages/llm/llm-pi-ai/tests/adapter.spec.ts \
  packages/llm/llm-pi-ai/tests/dynamic-config.spec.ts \
  --reporter=dot
```

结果：2 个文件通过，`52 tests passed`。测试覆盖了 OpenAI-compatible route、`apiKeyEnv`、动态 credentials、base URL、模型配置和请求失败边界。

### 4.2 外部 Host Bridge 证明

官方临时验证脚本位于隔离仓库：

```text
/tmp/dsh-harness-research.eeshvd/repo/scripts/validate-external-host-bridge.ts
```

脚本建立一个真实 DSH host Agent 作为外部 Codex thread 的 authority anchor，然后验证：

1. `startContinuable` 创建 durable child；
2. child 完成后 settlement notice 进入 host Agent inbox；
3. `listChildren` 从持久化状态发现 child；
4. 对相同 child 调用 `followup`；
5. follow-up 结果仍写入相同 child session；
6. 初始调用和 follow-up 一共只产生两次 fake model request，没有轮询或额外重试。

核心输出为：

```json
{
  "childId": "<uuid>",
  "firstNotice": true,
  "listedMode": "continuable",
  "followupPersisted": [
    "first child result",
    "follow-up child result"
  ],
  "modelRequests": 2
}
```

该临时脚本还输出了 `firstChildPersisted: false`。这是验证脚本把 `Session` 对象当成有顶层 `id` 字段的错误断言，不是持久化失败；后续 `followupPersisted` 和 `listChildren` 已经证明持久化和冷续接链路。这个字段不能作为验收指标。

官方 snapshot 测试曾遇到：

```text
Unhandled SyntaxError: Unexpected token '�' ... convert-source-map
```

因此 snapshot 测试不计入通过，也不作为本方案的验收证据。它只能说明该隔离环境的 fixture/source-map harness 有问题。

### 4.3 当前 WFL 定向测试

本轮在当前工作目录重新运行：

```bash
node --test test/deepseek-harness-subagent.test.mjs
```

结果：`13 tests passed, 0 failed`，耗时约 `4.73s`。

这证明当前 one-shot 实现本身的已声明边界是稳定的，但不证明它已经拥有 continuable 子代理。

## 5. 延迟、模型请求和“中间层是不是很慢”

### 5.1 已测数据

之前在本地 fake Harness + fake 模型上完成的基准如下：

| 路径 | 样本数 | 最小 | 中位数 | P95 | 最大 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 仅桥接层 fake Harness | 100 | `0.71 ms` | `0.87 ms` | `2.21 ms` | `6.71 ms` |
| 官方 Harness 冷启动 + 本地 fake model | 3 | `1046.72 ms` | `1081.54 ms` | `1081.54 ms` | `1114.67 ms` |
| 完整 Unix socket + 本地 fake model | 2 | `1022.46 ms` | `1022.46 ms` | `1022.46 ms` | `1052.47 ms` |

样本量对冷启动部分较小，不能当生产 SLA；但足以回答架构问题：

- MCP + Unix socket 额外开销是毫秒级；
- 完整 Unix socket 路径没有出现明显的额外秒级延迟；
- 长驻 DSH Runtime 可以消除每次 child 的 Harness 冷启动；
- 中间层不会自动增加模型请求，除非错误地实现轮询或自动重试。

### 5.2 后台唤醒为什么可能多一次模型请求

官方 continuable 的 child 完成后，如果 parent 仍在运行，runtime 使用 steer；如果 parent 空闲，runtime 唤醒 parent。parent 被唤醒后再产生一次正常 parent model turn，这是官方 settlement 设计的结果，不是中间层轮询。

监控时必须分别统计：

- child 的模型请求；
- parent 的正常请求；
- settlement 唤醒导致的 parent 请求；
- 真正的重试。

不能把它们粗暴相加后再用 WFL 本地预算截断。每个已接受的请求都应有可解释的来源和持久化事件。

## 6. 推荐的完整架构

### 6.1 组件职责

推荐在每个用户运行时内启动一个长驻官方 DSH Context，并让它持有一个或多个真实 host Agent：

```text
用户运行时
  ├─ Codex app-server（当前对话和 thread）
  ├─ WFL Host Bridge
  │    ├─ thread binding / socket auth
  │    ├─ encrypted provider -> DSH credentials 映射
  │    ├─ cwd / sandbox / approval 快照
  │    └─ DSH settlement -> Codex app-server 事件适配
  └─ 官方 DSH Context（长驻）
       ├─ host Agent（每个 Codex thread 一个稳定 anchor）
       ├─ SubagentRuntime
       ├─ spawn-in-process
       ├─ tool-subagent / control / report
       ├─ session persistence / projection
       ├─ official sandbox / approval
       └─ dsh-llm-pi-ai
```

host Agent 不是第二套 WFL 任务状态机。它是 DSH 官方 Runtime 需要的真实 parent authority；child 的所有权、inbox、Activation、settlement、持久化和冷恢复仍由 DSH 管理。

### 6.2 外层工具面

MCP facade 应该只做协议适配，模型可见表面按官方语义提供：

```text
subagent(description, prompt, run_in_background?)
send_message(...)
interrupt_agent(...)
list_agents(...)
```

`report` 只在 continuable child scope 内按官方插件语义提供，不由 WFL 设计一套新的父子报告格式。

第一阶段配置组合应等价于官方 fresh spawn 示例：

```yaml
- id: subagent
  name: '@deepseek-ai/dsh-subagent'

- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
  config:
    providerName: spawn

- id: tool-subagent-control
  name: '@deepseek-ai/dsh-tool-subagent-control'

- id: tool-subagent-report
  name: '@deepseek-ai/dsh-tool-subagent-report'

- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
    backgroundMode: continuable
```

这段只是官方组合的目标形态，不代表当前仓库已经完成这些接线。

### 6.3 DSH 和 WFL 的边界

| 事情 | 负责方 |
| --- | --- |
| child id、父子 ownership、Activation、inbox 顺序 | DSH `SubagentRuntime` |
| `startContinuable`、`followup`、`interrupt`、`listChildren` | DSH 官方 runtime |
| settlement notice、parent wake/steer | DSH runtime 在其 host Agent 内完成；WFL 只做外部事件投递 |
| session persistence、projection、cold resume | DSH 官方插件 |
| coding tools、sandbox、approval 规则 | DSH 官方插件，权限由 WFL 在调用边界提供 |
| WFL 用户身份、加密供应商选择、API key 解析 | WFL |
| Codex thread 与 DSH host Agent 的绑定 | WFL Host Bridge 的传输适配 |
| Unix socket、认证 token、进程回收、启动恢复 | WFL Host Bridge |
| Codex app-server 的 steer/start 事件投递 | WFL Host Bridge，使用当前已支持的 app-server 边界 |
| 本地任务预算、角色、WFL continuation 状态 | 不实现 |

## 7. DeepSeek、GPT 和 OpenAI-compatible 供应商接入

### 7.1 官方依据

官方 `@deepseek-ai/dsh-llm-pi-ai` 不是只支持 DeepSeek 的硬编码适配器。它是基于 pi-ai 的通用多供应商适配器：

- 一个 `providers` route 可以指向 DeepSeek、OpenAI 或 OpenAI-compatible 网关；
- route 可以明确 `api: openai-completions` 或 `api: openai-responses`；
- 可以配置 `baseURL`、模型列表、上下文窗口和 reasoning 能力；
- `apiKeyEnv` 是凭据引用，不是明文密钥；
- `ctx.credentials` 可以在每次请求时解析凭据，配置变化对下一次请求生效；
- 对无法完整描述的 OAuth、Bedrock、Vertex 等协议，官方适配器会拒绝或交给其原生 catalog，不应在 WFL 中猜测兼容性。

因此“子代理只能设置 DeepSeek 模型”不是官方 Runtime 的必要限制；当前 WFL UI/供应商映射才是需要补齐的边界。

### 7.2 推荐的 WFL 映射

用户继续在 WFL 供应商页面选择一个已经配置好的供应商。没有新增“预算、角色、任务时长”等设置，只保存必要的选择：

```text
selectedProviderId
selectedModel（可选，空值表示该供应商主模型）
wireApi（明确为 openai-responses 或 openai-completions）
```

实际接入时：

1. WFL 从自己的加密供应商存储读取 profile；
2. WFL 把 endpoint、模型和协议映射成官方 DSH LLM route；
3. WFL 通过 DSH credentials seam 提供一次请求可解析的密钥引用；
4. 密钥不进入 `cordis.yml`、MCP 工具参数、浏览器响应、session 文本、日志或 socket 命令行；
5. 供应商切换只影响新建立或下一次请求的 route，不修改正在进行的模型请求；
6. 未明确支持的协议直接报配置错误，不按供应商名字、模型名字或 URL 猜协议。

当前 one-shot 已用环境变量完成了密钥隔离；长驻 Runtime 应将同一原则迁移到官方 `ctx.credentials` seam，而不是把密钥写入长驻配置文件。

### 7.3 不应加入的兼容层功能

不要在 WFL 中另造：

- DeepSeek 专属提示词拼接器；
- GPT 专属的自定义 reasoning 参数猜测；
- 按模型名自动选择 Responses/Chat Completions；
- 自动降级到另一模型；
- 失败后无条件重放完整 child turn；
- 以“重试预算”形式截断供应商额度充足的任务。

这些行为会让 DeepSeek 官方 adapter 和 WFL 的实际计费/上下文不一致。协议和 reasoning 能力应由官方 LLM adapter 的 route/model descriptor 明确决定。

## 8. 必须解决的宿主边界

这是当前方案能否真正可用的关键部分。

### 8.1 父会话绑定：使用 Codex 官方 MCP turn metadata

当前 Codex 源码的 `build_mcp_tool_call_request_meta()` 已确认：每个 MCP 工具调用会把
`x-codex-turn-metadata` 对象放入 `_meta`，其中包含 `thread_id` 和 `turn_id`，随后再由
`with_mcp_tool_call_thread_id_meta()` 加入 `threadId`。这不是模型参数，而是宿主向 MCP
server 传递的调用上下文。

不能这样解决：

```text
subagent({ description, prompt, parentThreadId })
```

这会改变官方工具 schema，让模型承担本来属于宿主的身份参数，而且仍不能证明调用者有权使用该 id。

当前 one-shot 的实际绑定方案：

1. MCP facade 只接受 Codex `_meta` 中的 `threadId` 和 `x-codex-turn-metadata.turn_id`；
2. WFL 使用这两个值在当前用户的 active task 中做精确匹配，并校验保存的 cwd、sandbox、
   approval 快照和 app-server 状态；
3. thread/turn 元数据缺失、不一致、不是当前运行中的父轮次，或没有可验证权限快照时，
   在创建 Harness 前拒绝；
4. 不从模型工具参数读取父 ID，不从 active task 数量猜测，不从项目配置回退推断；
5. 这只解决 one-shot 的父会话绑定，不自动产生官方 DSH continuable ownership、inbox
   或 settlement。

这里的 binding 是传输和权限适配，不是新的模型可见任务状态机；两个并行 MCP 调用的负向
元数据测试已经通过。它仍不能被描述成 DSH 官方 continuable parent binding。

### 8.2 Settlement 投递：MCP 本身没有异步 parent push

官方 DSH 的 settlement 是写入 DSH parent Agent inbox，并由 DSH parent Agent 自己 wake/steer。外部 Codex parent 不在这个 DSH Context 中，单纯 MCP server 没有标准的“稍后调用一次工具并把结果塞给模型”的接口。

因此 Host Bridge 必须：

1. 监听 host Agent inbox 中的 `subagent-report` 和 `subagent-settled` 事件；
2. 根据已验证的 thread binding，把官方 settlement 内容关联到对应 Codex thread；
3. parent turn 仍运行时，使用当前 Codex app-server 支持的 steer 入口；
4. parent 空闲时，使用同一 thread 的 turn start/wakeup 入口；
5. 不启动轮询，不读取 child 状态后反复发请求，不自行重试 settlement；
6. 保留 child id、消息 id、DSH session id 和 Codex thread id 的可审计映射，但不把它们暴露成 WFL 生命周期工具。

这里有一个不能掩盖的协议事实：如果当前 Codex app-server 只允许把这类外部内容伪装成普通 user text，而没有合适的 agent/system event 入口，那么 child 生命周期仍可由 DSH 正确管理，但 parent 展示语义会是宿主适配，而不是 DSH 原生 parent。这个决定必须在真实 app-server 原型测试后确认，不能在文档里假定不存在语义差异。

### 8.3 Approval：不能静默降级

官方 DSH approval 在同一个 Context 中通过 `approval/request` waterfall 工作，并记录 asked/decided 事件。跨进程集成需要：

- 把 DSH approval request 传给 WFL 现有 approval mux；
- 使用当前 Codex UI 的用户确认面；
- 将 `allowed-once`、`rejected`、`cancelled`、`unavailable` 原样映射回 DSH；
- host 重启、thread 关闭、客户端断开时 settle 所有未完成请求；
- 不能把 `ask` 改成 `never`，也不能把悬挂的 approval 当成成功。

在这条桥接完成前，`approval_policy=ask` 不能宣称完整支持；只允许执行已明确为 `never` 的 child，或者继续使用当前 one-shot 的已验证边界。

## 9. 生命周期、恢复和安全设计

### 9.1 每用户 Harness

建议每个 WFL 用户运行时拥有一个长驻 DSH Context：

- 首次使用时启动，stdout 保留给协议，诊断只写 stderr/受控日志；
- host Agent 按 Codex thread 建立稳定映射；
- DSH session root 位于该用户专属、`0700` 的运行目录；
- DSH Runtime 负责 child session、projection 和 cold resume；
- 用户运行时重启时，先加载 persistence，再由 `listChildren/listDescendants` 发现可继续 child；
- WFL 只在用户运行时退出、账号切换或部署恢复时回收 Context，不提供模型可见的自定义 child close API；
- 不因一次 child 完成就销毁整个 Context，也不创建每次请求的冷启动 Harness。

### 9.2 socket 和 token

建议保持当前已验证的 Unix socket 安全方向，并扩展到 host bridge：

- socket 位于用户专属运行目录，权限 `0600`；
- socket 文件名使用随机实例 id，不复用旧路径；
- 每个 runtime 使用随机高熵认证 token，token 不进入工具参数和日志；
- socket 地址可以作为受控启动参数，token 通过子进程受保护环境或安全 IPC 传递；
- 服务端用 constant-time compare 校验 token；
- 关闭、崩溃恢复和 runtime 重启时只清理自己明确生成且没有活动监听者的 socket；
- 不能通过递归清理用户目录来处理残留文件；
- API key 与 socket token 分开，不能混用；
- thread binding 再绑定一个 capability，防止同一用户下的错误 Codex thread 交叉调用。

### 9.3 cwd、sandbox、approval 继承

创建 child 时只捕获官方允许的执行上下文：

```text
cwd: 规范化后的绝对路径
sandbox: read-only / workspace-write / danger-full-access
approval: ask / never（由父会话策略明确决定）
```

不把 Codex parent 全文复制给 child。无法唯一确定 cwd 或权限时 fail closed；不能用默认项目目录、`danger-full-access` 或 `never` 猜测补齐。

## 10. 分阶段实施计划

以下顺序以稳定、低风险和可回滚为优先，不包含用户可见的 WFL 自定义子代理机制。

### 阶段 0：保持当前 one-shot 可用并完成验证（已完成）

- 保留当前官方 SDK one-shot 作为已验证路径；
- 记录当前功能边界，不把它宣传为 continuable；
- 锁定 rc.6 版本和 lockfile；
- 完成当前 WFL 13 项定向测试；
- 完成官方 continuation、in-process、tool-control、LLM adapter 测试；
- 不在普通生产服务器运行完整仓库测试，不触碰 rescue `4321`。

### 阶段 1：官方 Runtime 隔离原型

目标是先在临时目录，不改生产路径，证明官方链路：

- 创建长驻 DSH Context；
- 挂载 `SubagentRuntime`、`spawn-in-process`、session persistence、projection；
- 挂载官方 `tool-subagent`、control、report；
- 创建一个 host Agent；
- 验证后台创建、settlement、follow-up、interrupt、list、进程重启后的 cold resume；
- 使用 fake LLM adapter，并记录每个 child/parent 的模型请求数；
- 修正临时验证脚本的 `firstChildPersisted` 断言，不能再用错误字段判断持久化。

阶段 1 通过后，才能进入 WFL 代码接入。

### 阶段 2：接入 WFL 供应商和权限上下文

- 将 WFL 加密供应商映射成官方 `dsh-llm-pi-ai` route；
- 明确支持 DeepSeek、OpenAI 和 OpenAI-compatible Responses/Chat Completions；
- 通过 credentials seam 按请求解析 API key；
- 添加真实的 cwd/sandbox/approval snapshot；
- 让 provider/model 切换只作用于新请求；
- 对缺少密钥、未知模型、未支持协议和不完整 profile fail loud；
- 增加 key 不出现在 session、MCP、日志和异常文本中的测试。

### 阶段 3：解决 thread binding

- 用当前实际 Codex app-server 做两个并行 thread 的 MCP 请求实验；
- 记录 MCP initialize、tools/call、connection 生命周期是否包含可用 thread context；
- 若有官方 context，使用它并验证签名/权限边界；
- 若没有，验证 thread-scoped facade/Unix socket/capability 方案；
- 测试错误 thread、过期 token、同用户跨 thread、app-server 重启和重复调用；
- 在 binding 未通过前，保留 one-shot，禁止 continuable 开关进入普通用户路径。

### 阶段 4：Settlement 和 approval 适配

- 将 DSH host inbox 的 settlement 事件投递到准确 Codex thread；
- parent busy 使用 steer，parent idle 使用 wakeup；
- 验证 parent 看到的是一次正常 settlement，不是轮询产生的重复消息；
- 接通 `approval/request` 和现有 UI/mux 的完整允许、拒绝、取消、断线回收；
- 验证 child report 与 runtime settlement 不重复计数；
- 测试一个 child 失败、一个 child 中断和一个 child 正常完成同时存在的情况。

### 阶段 5：真实供应商验收

每个已支持协议至少执行：

- DeepSeek 模型：一个后台 child、一次 follow-up、一次 coding tool；
- GPT/OpenAI-compatible 模型：同样的三类测试；
- 两个同级 child 并发；
- parent 忙/闲两种 settlement；
- `send_message`、`interrupt_agent`、`list_agents`；
- 重启 DSH host 后 cold resume；
- `read-only`、`workspace-write` 和 `ask` approval；
- 请求数、重试数、token/usage 归因和错误来源审计；
- 完整检查密钥、token 和 parent 对话全文没有越界。

真实供应商测试必须在开发或候选发布服务器执行。普通用户服务器部署只运行 bounded compatibility/readiness checks，不运行完整测试、压力测试或浏览器 smoke suite。

### 阶段 6：候选发布和回滚

- 为主站生成新版本，不能在原版本上覆盖；
- 使用现有 blue-green 流程：启动候选、readiness、协议检查、切换、再次验证、停止旧 backend；
- 默认按现有部署偏好立即 forced switch，但仍保留 watchdog、writer fencing 和 recovery；
- rescue `4321` 作为冻结组件，不启动、停止、切换、改版本或改资源；
- 若 continuable 完整验收失败，回退到已验证 one-shot 路径，不把半成品暴露成“后台子代理”；
- 回滚只能回滚主站候选，不改变 rescue 组件。

## 11. 验收标准

完整方案只有满足以下条件才可以称为“可用”：

### 官方语义

- 模型可见工具与官方 schema 对齐，至少包含 `subagent`、`send_message`、`interrupt_agent`、`list_agents`；
- `run_in_background` 缺省行为与配置的 `backgroundMode: continuable` 一致；
- `send_message` 只返回排队确认，不把它实现成轮询结果接口；
- `interrupt_agent` 不销毁 child；
- `list_agents` 能发现实时和冷 child；
- child settlement 由 DSH Runtime 产生，不由 WFL 自己合成一套终态机；
- 不出现预算、角色、WFL continuation 状态和自定义 stop/close 工具。

### 父会话和安全

- 两个并行 Codex thread 不能互相获得 child、cwd、approval 或 settlement；
- 没有准确 thread binding 时 fail closed；
- host 重启后 child session、projection 和后续消息顺序可恢复；
- socket、token、API key 分离且不进日志/模型上下文；
- cwd、sandbox、approval 只继承已验证的父快照；
- `ask` 不会静默降级成 `never`，所有悬挂 approval 都会 settle。

### 请求和延迟

- fake 端到端测试证明桥接层不是秒级瓶颈；
- 初始 child、follow-up、parent wakeup 和真正重试可以逐项归因；
- 没有轮询造成的额外模型请求；
- 已接受的请求不因 WFL 自定义预算被截断；
- provider route 切换不影响在途请求。

### 供应商

- DeepSeek、OpenAI 和 OpenAI-compatible 的明确协议均有真实请求验收；
- Chat Completions/Responses 不按名称猜测；
- API key 来自加密供应商配置的受控 credentials seam；
- 未支持协议、未知模型和缺失凭据都 fail loud。

## 12. 不能由中间层自动解决的问题

以下不是“多加一个转发接口”就会消失的限制：

1. **MCP 没有通用的异步 parent model push。** 必须依赖 Codex app-server 宿主事件入口；如果该入口不能承载 settlement，纯 MCP 方案无法原生完成。
2. **只有带有官方 turn metadata 的 MCP 请求才能绑定父会话。** 缺少 metadata 时 one-shot
   会拒绝；不能依靠 active task 数量或模型参数补猜。
3. **DSH 官方 runtime 需要真实 parent Agent。** 只把 Codex thread id 塞进 `startContinuable` 不是官方 ownership，也不能自动获得 inbox 和 persistence。
4. **跨进程 approval 需要 UI/mux 协议。** DSH 同进程 approval 已有能力，但 WFL 还必须完成请求/决定的传输和回收。
5. **官方模型适配器的协议边界仍然存在。** OAuth refresh、Bedrock 签名、Vertex project 等不是一个 OpenAI-compatible URL 可以猜出来的能力；WFL 只能显式支持已验证 route。
6. **`subagent_fork` 的公开配置有冲突。** 在上游配置统一前，不能为了“功能齐全”同时接 fork。

这意味着推荐方案能解决主要功能缺陷，但“完整”包含一段真实的 Codex host adapter 工作；不能承诺只改当前 MCP server 的几十行代码就得到原生体验。

## 13. 需要所有者确认的非官方适配点

以下项目是为了把官方 DSH child 接到外部 Codex parent 所必需的宿主适配，不属于官方 DSH Runtime 本身。在正式编码前应确认：

1. 是否接受 WFL 在 Codex app-server 宿主边界建立 thread-scoped binding；该 binding 不出现在模型工具参数中。
2. Codex MCP turn metadata 已在当前源码中验证；是否接受 WFL 以它作为 one-shot
   父会话绑定输入，而不把该适配误称为 DSH 官方 continuable ownership。
3. 是否接受在 app-server 没有专用 settlement event 时，用已验证的 `turn/steer`/idle `turn/start` 作为宿主投递通道，并在 UI 中明确这类消息的来源。
4. 是否接受把现有 Codex approval surface 接到 DSH `approval/request`；在此完成前不开放 `ask` child。

这些适配点不应被包装成“官方 MCP 原生能力”。如果不接受其中任意一项，唯一诚实的选择是继续使用 one-shot，或者把主会话也迁移到 DSH，使 parent 和 child 真正在同一个官方 Context 中运行；后者是更完整但产品范围更大的路线。

## 14. 最终推荐

稳定低风险的推荐顺序是：

1. 保留并继续验证当前官方 SDK one-shot，作为明确标注的安全 fallback；
2. 在隔离环境先证明官方 in-process continuable runtime；
3. 使用官方 `dsh-llm-pi-ai` 复用现有 WFL 加密供应商，兼容 DeepSeek 和 GPT/OpenAI-compatible route；
4. 用真实宿主 binding 解决多 thread 身份问题；
5. 用 Host Bridge 只做 settlement/approval/权限/传输适配，把 child 生命周期全部交给 DSH；
6. 完成 fake、官方包、真实 DeepSeek、真实 GPT-compatible、重启、并发和 approval 验收后，再走新版本 blue-green 发布；
7. 任何一个宿主边界未验证，都不把当前 one-shot 改名成“完整官方子代理”，也不通过预算或自动重试掩盖问题。

本文件记录的是可执行且可验证的完整方案；本轮没有修改当前子代理架构，没有删除当前 one-shot，没有部署，也没有触碰冻结的 rescue `4321`。
