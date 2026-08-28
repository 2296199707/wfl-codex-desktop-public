# Codex 线程并发与会话恢复研究

状态：研究完成，已按本文方案实施最小恢复边界修改

日期：2026-08-27

本文是主站会话恢复后续修改的固定依据。后续实现以 `0.44.56-beta` 的提交
`32f7eb1` 为代码基线，不以 `0.44.57-beta` 或 `0.44.58-beta` 为基线。

## 1. 版本基线

| 版本 | 提交 | 结论 |
| --- | --- | --- |
| `0.44.55` | `7faedb8` | 上一稳定提交 |
| `0.44.56-beta` | `32f7eb1` | 后续修改的基线；主要是超时和渐进显示调整 |
| `0.44.57-beta` | `9f63ebd` | 增加活动任务完整读取、任务 shell 和延迟恢复，问题版本 |
| `0.44.58-beta` | `512add7` | 只额外调整部署 handoff 等待，不能作为会话恢复基线 |

当前实现分支从 `32f7eb1`（`0.44.56-beta`）开始，工作树版本仍为
`0.44.56-beta`，尚未发布新的候选版本。后续发布时应递增为新的 beta 版本，
不复用已发布版本。

救援窗口是独立冻结组件。本研究和后续主站方案不修改救援端口、槽位、资产、版本
或服务状态。

## 2. 官方 Codex 的实际模型

源码副本：`/www/mobile-agent-tooling/openai-codex-research.oZMeyF`

源码快照：`f5420174dafba153913a3e697f89002c338dfd7e`

该副本工作树包含大量删除，但 Git 对象完整。复查时使用
`git -C /www/mobile-agent-tooling/openai-codex-research.oZMeyF show <快照>:<路径>`
读取文件，不对副本执行 `checkout`、`restore` 或工作树恢复。

### 2.1 一个 Thread 一个运行句柄

官方 `ThreadManager` 使用
`Arc<RwLock<HashMap<ThreadId, Arc<CodexThread>>>>` 保存运行中的线程，见
`codex-rs/core/src/thread_manager.rs:339-357`。读取线程只按 `ThreadId` 查找并返回
同一个 `Arc`，见 `:1467-1474`。

因此：

- 不同 `ThreadId` 可以同时运行，不能用一个全局恢复锁把它们串起来。
- 一个界面可以只有一个当前可见 Thread，但后台任务状态必须带 `threadId`。
- “恢复”不是重新创建第二个同 ID 线程。

### 2.2 请求按资源键序列化，不是全局串行

官方协议定义了 `Global`、`GlobalSharedRead`、`Thread` 和进程等资源范围，见
`codex-rs/app-server-protocol/src/protocol/common.rs:128-174`。

`thread/resume` 和 `thread/read` 按 Thread 键序列化；`thread/turns/list` 和
`thread/items/list` 明确标记为不需要该序列化范围，见同文件
`:520-524`、`:786-801`。App Server 在
`codex-rs/app-server/src/message_processor.rs:912-945` 根据范围进入对应队列；
队列实现见 `codex-rs/app-server/src/request_serialization.rs:215-287`。

官方测试 `request_serialization.rs:538-639` 证明共享读取可以并行加入，
`:641-710`、`:833-900` 证明写入排在同一资源的读取之后，后来的读取不能越过写入。

这说明 WFL 不需要新增一个“所有对话共用的恢复锁”。真正需要的是让每个异步操作
携带并校验自己的 `threadId`，完成时不能覆盖另一个当前界面的状态。

### 2.3 运行中 resume 复用原有 Thread

`ThreadManager` 在恢复时发现同一 `conversation_id` 已有运行线程，会直接返回原有
线程和 `session_configured`，不会新建第二个线程，见
`codex-rs/core/src/thread_manager.rs:1890-1908`。

App Server 的 `thread/resume` 先检查运行线程，见
`codex-rs/app-server/src/request_processors/thread_processor.rs:3552-3613` 和
`:4066-4115`。运行线程的恢复结果通过原有 listener 的
`SendThreadResumeResponse` 命令发送，见同文件 `:4227-4347` 以及
`thread_lifecycle.rs:619-849`。

所以切换或重连时的正确动作是重新订阅并 resume 同一个 Thread，不是读取完整历史
后合成一个临时 shell。

### 2.4 轻量恢复和完整历史是两种操作

官方把 `excludeTurns` 转换为 `include_turns = !exclude_turns`，见
`thread_processor.rs:3615-3635`。运行线程恢复在没有要求完整历史或初始分页时，
不会读取完整历史，见 `:4194-4205`。源码还明确说明 `excludeTurns` 是轻量路径，
见 `:3995-4008`。

相反，`thread/read(includeTurns=true)` 会加载并重建完整 turns；运行线程路径会调用
`load_history`，见 `thread_processor.rs:2771-3001`。分页接口是另一条路径：
`thread/turns/list` 从 `:3006` 开始，`thread/items/list` 在 `:884-890` 注册。
对于旧的非分页 rollout，官方也注明 turns/list 可能每次重放完整 rollout，见
`:3052-3060`，因此只能把它放在异步历史补全中，不能作为任务状态心跳。

### 2.5 中断绑定精确的 Thread 和 Turn

官方 `turn/interrupt` 从请求中同时取出 `thread_id` 和 `turn_id`，校验当前 active
turn 后提交 `Op::Interrupt`，见
`codex-rs/app-server/src/request_processors/turn_processor.rs:1540-1601`。

中断按钮在点击瞬间必须保存目标二元组。后续切换对话、状态刷新或恢复完成，都不能
把中断请求改投到新的当前 Thread。

## 3. WFL 56、57、58 的对照

### 3.1 56 中应保留的部分

56 的 `resumeThread` 已经发送：

```text
thread/resume {
  threadId,
  excludeTurns: true,
  initialTurnsPage: { limit, sortDirection: "desc", itemsView: "full" }
}
```

对应代码是 `32f7eb1:public/app.js:18774-18796`。收到结果后先显示有限的初始页，
再异步执行 item 补全，见 `:18833-18888`。这与官方的轻量恢复加分页历史模型一致，
应保留。

56 的重连也让任务状态查询和 Thread resume 同时开始，见
`32f7eb1:public/app.js:9623-9648`。这个并行关系不能被恢复逻辑重新改成串行依赖。

56 的大约十倍历史 RPC 超时和列表渐进显示可以保留，但超时不是并发模型的修复。

### 3.2 57 引入的高风险链路

57 增加了 `scheduleCodexActiveTaskThreadRead`，在活动任务期间直接调用
`thread/read` 并设置 `includeTurns: true`，见
`9f63ebd:public/app.js:9625-9755`。随后又把任务标记为需要恢复，增加 deferred
resume、任务 shell 和重复恢复判断。

57 还把重连流程改成先等待 `loadTaskStatus()` 再决定 resume，见
`9f63ebd:public/app.js:9930-9945`；发送前的恢复又等待一次任务状态，见
`:19344-19373`。

这会形成以下等待链：

```text
重连或切换
  -> 任务状态查询
  -> 原生任务核验
  -> 可能的 thread/read(includeTurns=true)
  -> 合成活动任务 shell
  -> 标记 needsResume
  -> 发送前再次 resume
```

它把“显示当前任务状态”和“让 Thread 可继续使用”错误地合并了。长任务的完整历史
读取还会与同一 Thread 的恢复、历史补全和发送互相等待。

### 3.3 56 中仍需注意的服务端 fallback

56 的 `/api/task/status` 在本地任务状态缺少有效 Turn 身份时，会调用
`reconcileNativeTaskStatus`，见 `32f7eb1:server.mjs:12141-12157`。

`findNativeActiveTurn` 先调用 `thread/turns/list`，没有结果时再调用
`thread/read(includeTurns=true)`，见 `32f7eb1:server.mjs:3974-4024`。这个 fallback
不是 57 新增的完整恢复链，但会让重连后的状态轮询变重。它不能继续作为普通状态轮询
的同步前置条件。

## 4. 以 56 为主线的最小稳定方案

### 4.1 基线处理

1. 从 `32f7eb1` 新建主站候选分支；不从 57 或 58 拣选恢复代码。
2. 保留 56 的历史超时、列表渐进渲染、有限初始 turns page 和异步 item 补全。
3. 仅将后续发布版本递增为新的 beta 版本，例如 `0.44.59-beta`；不覆盖 56 已发布
   版本，也不修改救援组件。

### 4.2 只改恢复边界

1. 不引入 57 的活动任务完整 `thread/read`、任务 shell、deferred resume 状态机。
2. 重连、切换和发送前恢复统一只调用 56 已有的
   `thread/resume(excludeTurns=true, initialTurnsPage=...)`。
3. `thread/read(includeTurns=true)` 只允许明确的完整历史操作使用，不能由任务状态、
   重连或发送前准备隐式触发。
4. 历史补全继续使用 turns/items 分页并异步执行；页面先显示已拿到的有效内容，不能
   因补全失败清空当前对话。
5. `/api/task/status` 普通轮询只返回 WFL 已有的按 `threadId` 状态；不能同步等待
   原生完整历史读取。原生核验保留给明确的中断或身份缺失场景，并使用有界请求。
6. `prepareActiveThreadForSend` 在 resume 成功后不再等待第二次任务状态核验才能发送；
   状态刷新放到后台，Thread resume 返回的身份和 Turn 事件作为发送依据。

### 4.3 最小的按 Thread 隔离

不重写整个前端状态模型，只增加一个按 Thread 保存恢复信息的 Map，例如：

```text
threadRecovery[threadId] = {
  needsResume,
  turnId,
  generation
}
```

`activeThread` 仍然只是当前可见视图；`activeTurnId` 仍然可以作为 UI 投影，但所有
后台回调必须先检查捕获的 `threadId`、选择版本和连接代次，再投影到当前界面。

这样可以同时满足：

- A Thread 长任务运行时可以切换到 B Thread。
- B Thread 的恢复完成不会清掉 A Thread 的状态。
- 回到 A Thread 时复用原生运行 Thread 和准确 Turn。
- 旧连接或旧选择的迟到响应不能覆盖新选择。

### 4.4 中断路径

中断按钮点击时立即保存 `{ threadId, turnId }`，发送请求始终使用该快照。原生
`turn/interrupt` 是延迟敏感操作，Goal 收口、任务状态刷新和历史补全只能并行或在
后台执行，不能阻塞中断请求。

## 5. 明确不做的修改

- 不再用更长超时掩盖完整历史读取和错误的等待依赖。
- 不新增全局 conversation/recovery 锁，不把不同 Thread 串行化。
- 不新增任务预算、续接状态、角色或 WFL 自定义子代理生命周期控制。
- 不重写 Codex App Server 的线程管理器，不复制官方 Thread 句柄。
- 不用普通任务状态接口证明完整历史已加载。
- 不修改救援窗口 `4321` 及其独立版本。

## 6. 最小验收范围

只做与本次改动直接相关的有界测试，不在普通用户服务器运行完整仓库测试或压力测试。

1. 两个 Thread：A 正在长任务，切换 B；B 能显示并发送，A 继续运行，A 的状态不会
   覆盖 B。
2. 重连恢复：恢复请求先返回有限 turns page；延迟的状态查询不能阻止页面恢复、发送
   或切换。
3. 运行中重复 resume：同一 `threadId` 不产生第二个 native Thread，listener 不重复
   丢失，回到原对话后仍能继续发送。
4. 中断目标：切换前点击停止后，始终对点击瞬间的 `threadId + turnId` 发送
   `turn/interrupt`。
5. 迟到响应：旧选择、旧连接和旧 generation 的响应只能被丢弃，不能清空当前对话。

建议只补 `test/ui.test.mjs` 的关键交互和必要的 RPC mock；候选服务器执行语法检查、
定向测试和 readiness 检查后再按现有蓝绿流程发布新版本。

## 7. 实施文件边界

预期只涉及：

- `public/app.js`：恢复、切换、任务状态和中断目标快照；
- `server.mjs`：任务状态轮询与显式原生核验边界；
- `test/ui.test.mjs`：上述最小场景；
- 本文档及版本变更记录。

在验证发现 56 本身已有的服务端 fallback 不影响正常状态轮询前，不修改其他页面、
数据库、部署控制器或救援组件。

## 8. 当前实施结果

- `public/app.js` 已按 `threadId` 保存恢复标记，并让所有同一 Thread 的恢复入口共享
  在途 Promise；恢复开始会占用新代次，旧 Thread、旧选择或旧连接的迟到响应不能清掉
  当前 Thread 的恢复标记。不同 Thread 仍可同时恢复。
- `prepareActiveThreadForSend` 只等待目标 Thread 的 `thread/resume`，任务状态刷新在
  后台进行，不再把第二次状态核验放在发送前关键路径。
- `server.mjs` 的 `/api/task/status` 只有在客户端明确提供 `activeTurnId` 且身份不一致
  时才执行原生任务核验；普通状态轮询不再隐式触发完整历史读取。
- 主窗口停止按钮在点击瞬间保存 `threadId + turnId`，响应返回时只更新仍然对应的当前
  Thread，避免切换对话后的迟到响应清掉新任务。
- 本次已完成语法检查、UI/会话状态/任务状态定向测试；提交和本地部署结果由发布记录确认，
  未触碰救援窗口 `4321`。

## 9. `0.44.60-beta` 重复同步事故复盘

2026-08-28 的 `0.44.60-beta` 运行日志确认，问题不是 Codex 创建了多个同 ID Thread，
而是浏览器重复发起了同一个 Thread 的历史读取。06:28:34 至 06:29:40 期间，
`thread/turns/list` 请求连续堆积，单次耗时从约 24 秒升至约 58 秒；06:30:57 有 20
多个请求同时失败，耗时约 64 至 131 秒，并触发后端 OOM 重启。

触发链有两条叠加：

1. 后端每次 handoff 状态变化同时发送 `codex/recovery-status` 和 `bridge/status`。
   前端两个入口都调用 `scheduleCodexConnectionRecovery`，调度器只合并“进行中”
   请求，却把后续状态无条件排队。状态消息的 `observedAt` 每次都不同，即使恢复
   内容没有变化，也会在前一轮结束后再次执行恢复。
2. `scheduleRecentTurnsRefresh` 只去重尚未触发的定时器。定时器触发后，前一个
   `thread/turns/list` 尚未结束时，`thread/status/changed`、缺失 Turn/Item 的
   delta、终止和错误事件仍会各自创建新的历史读取。

当前约束：

- 恢复请求按运行状态、运行时 epoch 和 handoff 内容生成稳定键，忽略
  `observedAt` 与 `eventSequence`；同一 Socket 代次和同一键只运行一次，真实状态
  变化仍可排队一次。`eventSequence` 只用于新 Socket 的漏事件判断，不能作为同一
  Socket 恢复任务的唯一变化依据。
- `thread/loaded/list` 和历史读取都按 Thread/连接代次复用在途 Promise；在途期间的
  `notLoaded`、`closed` 或缺失 Item 事件只设置一次补查标记，完成后最多再查一次。
  不同 Thread 仍可并行，停止命令仍按精确的 `threadId + turnId` 发送。
- 这些约束只抑制重复读取，不缩短既有历史读取超时，也不把不同 Thread 串成全局队列；
  真实历史请求仍由现有版本和连接代次校验决定是否可以写回页面。
