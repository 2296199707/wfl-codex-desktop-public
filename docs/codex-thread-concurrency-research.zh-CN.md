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

## 10. 并行发送失败审查（2026-08-30）

### 10.1 官方协议依据

官方 App Server 仍使用 `Thread → Turn → Item` 的层次：同一 Thread 内一次只运行一个
Turn，追加内容使用 `turn/steer` 并携带该 Thread 当前 Turn 的 `expectedTurnId`；不同
Thread 可以并行运行。App Server 的入口队列有界时会返回过载错误，客户端应使用有界的
指数退避和随机抖动重试，不能把一次过载直接显示为永久发送失败。

官方源码副本和快照保持不变：

```text
/www/mobile-agent-tooling/openai-codex-research.oZMeyF
f5420174dafba153913a3e697f89002c338dfd7e
```

源码中的 `request_serialization.rs` 按资源键串行化，同一 Thread 的写操作保持 FIFO，
共享读取可以并行；`connection_rpc_gate.rs` 只在单个连接内管理 RPC gate。它没有要求
客户端把不同 Thread 的发送放进全局锁。

### 10.2 WFL 根因

当前 `public/app.js` 的以下状态虽然被命名为全局字段，实际却属于某个 Thread：

```text
pendingTurnRequest
pendingSteerRequest
turnPreparationPending
turnStartRequestPending
steerRequestPending
interruptRequestPending
activeTurnId / codexActiveTurnId
pendingUserMessage
```

切换 Thread、创建新对话、发送和重试都直接读取这些单槽位字段。因此会出现：

```text
A 正在等待 turn/start 或 turn/steer 响应
  -> 全局 pending 被占用
  -> B 的新消息被前端直接 return，或 B 无法切换

A 的 activeTurnId 残留在全局字段
  -> 切换到 B 后 B 的消息错误走 turn/steer
  -> expectedTurnId 不属于 B，服务端按协议拒绝追加
```

服务端 `turn/steer` 会再次按目标 Thread 核对运行状态和 `expectedTurnId`；这部分是
必要的防串线校验，不应删除。`withCodexTaskAdmission`、`TaskStatusTracker`、写租约和
`TurnStartDeduplicator` 也都使用 Thread 或 `threadId + clientSubmissionId`，目前没有
证据表明它们是本次跨对话失败的根因。服务器任务并发上限仍然是有效的资源配置，不能把
“排队/达到上限”伪装成已经发送成功。

### 10.3 本次最小修复边界

1. 在浏览器端为 Codex 的发送、准备、恢复和当前 Turn 指针建立按 `threadId` 的内存槽位；
   旧字段保留为当前可见 Thread 的投影，尽量不改动现有 UI 渲染代码。
2. 切换或新建对话时只阻止目标 Thread 自己仍在确认的请求；A 的 pending 不再阻止 B
   加载、发送或继续运行。
3. 所有 `turn/steer` 请求从目标 Thread 槽位读取 Turn ID，并在异步响应、错误和重连时
   按目标 Thread 清理；迟到的 A 响应不能清掉 B 的 composer 或 Turn 指针。
4. 同一 Thread 仍只允许一个待确认 steer，保持官方的 Turn 内 FIFO；不同 Thread 的
   请求可以并行。新对话尚未拿到 Thread ID 时仍保留单独的草稿准备边界，避免创建过程
   被切换破坏。
5. 对明确的 App Server 入口过载错误只做少量、幂等的退避重试；传输超时仍保持
   delivery-unknown 语义，不盲目重复执行可能已经被接受的 Turn。

### 10.4 验收记录

本次改动只执行有界检查：两个 Thread 的 pending 状态互不阻塞、A/B 的 Turn ID 不互串、
同一 Thread 的追加仍使用 `turn/steer`，以及过载重试不改变 client message ID。不会在普通
用户服务器运行完整仓库测试、压力测试或完整浏览器 smoke。

### 10.5 实施与验证记录（2026-08-30）

已完成的代码边界：

- 浏览器端将发送、追加、恢复、停止、待确认消息和当前 Turn 指针按 `threadId` 保存；
  旧的 `state.*` 字段只作为当前可见 Thread 的兼容投影。
- A Thread 的发送准备、恢复或 RPC 响应不会再占用 B Thread 的发送槽位；后台 Thread 的
  迟到事件只更新自己的缓存，不能清空当前页面的 composer 或 Turn 指针。
- `turn/steer` 从目标 Thread 槽位取最新 Turn；只有本地任务状态不匹配时才走服务端原生
  核验，正常追加不再先做重复的完整 `thread/read`。
- 最终 `error` 通知现在按目标 `threadId + expectedTurnId` 收口 `turn/steer`：当前
  对话立即恢复输入，后台对话把失败草稿放回自己的槽位；迟到的 RPC 回包不能再次清理
  其他对话。`willRetry: true` 不会提前清理请求，最终错误到达时才释放追加锁。
- 最终错误缺少显式 Thread ID 时，使用已经推断出的 Thread/Turn 指针；已确认的终态会
  立即释放对应发送锁，不再等待最长 RPC 超时才能继续操作。
- 新对话的 `thread/start` 使用稳定的客户端请求 ID；传输超时或断线被标为
  `deliveryUnknown`，恢复时按同一 ID 核对，避免把“已执行但响应丢失”重复当成失败重跑。
- 停止操作在点击瞬间保存目标 `{ threadId, turnId }`，切换对话后仍向原目标发送
  `turn/interrupt`。

本地有界验证结果：

```text
node --check server.mjs                         通过
node --check public/app.js                      通过
node --check lib/task-status.mjs                通过
node --test test/turn-start-deduplicator.test.mjs test/task-status.test.mjs
  34 passed, 0 failed
node --test --test-name-pattern='Codex recovery and interruption stay bound|parallel Codex sends|normal appends skip duplicate|turn starts reuse only' test/ui.test.mjs
  4 passed, 0 failed
node --test --test-name-pattern='Codex recovery and interruption stay bound|parallel Codex sends|normal appends skip duplicate|turn starts reuse only|sparse terminal Turn events|final Codex errors settle steer' test/ui.test.mjs
  6 passed, 0 failed
```

前一轮完整 `test/ui.test.mjs` 为 `112 passed, 3 failed`（共 115 项）。剩余失败项是工作树
此前已经存在的权限默认值和图片供应商静态契约问题；本轮新增保护后完整 UI 套件为
`113 passed, 3 failed`（共 116 项），并发相关新增和更新断言均已通过，不能把这次并发修复
报告为完整 UI 套件全绿。服务端并行用例若单独使用名称筛选，会跳过
该文件要求的前置登录测试并因 `Cookie: undefined` 失败；这不是业务断言结果。任务状态
和去重测试仍为 `34 passed, 0 failed`。多用户/完整浏览器测试还依赖前置登录、供应商、
额度和临时工程环境，未将其作为本次普通服务器验收条件，也未在普通用户服务器执行。

本次新增回归边界：

- 当前 Thread 的最终追加错误不再遗留 `pendingSteerRequest` 或 `steerRequestPending`。
- 后台 Thread 的追加错误不会恢复到当前可见对话；切回目标 Thread 时仅恢复该 Thread
  自己的失败草稿。
- `willRetry: true` 仍保留原追加请求，最终错误才清理；不同 Turn 的迟到错误不能清掉
  新 Turn 的追加请求。

### 10.6 恢复后原生 active 复核（2026-08-30 继续）

复查 `turn/start` 发送前路径时发现一个恢复边界：本地任务表可能已经是 idle，但第一次
`thread/turns/list` 或 `thread/read` 因连接切换、Thread 尚未重新装载或索引重建而只能
返回不确定结果。此时 `thread/resume` 可能明确返回 `thread.status.type = active`。如果
继续直接执行 `turn/start`，就可能把原生仍在运行的 Turn 当成空闲对话，导致追加失败或
重复创建 Turn。

已做的最小修复：

- `ensureNativeThreadLoadedForTurn` 在已装载 Thread 的轻量 `thread/read` 返回 idle/active
  时保留该快照；`thread/resume` 的返回值也作为发送前准备结果保留。
- 发送前只在准备结果明确为 `active` 时再调用一次有界的
  `reconcileNativeTaskStatus`，然后重新执行 `assertThreadTaskCanStart`。
- 二次核验发现活动 Turn 时沿用现有 Thread 准入错误；若原生仍报告 active 但暂时无法
  取到 Turn 明细，则返回 409 并停止本次新建，绝不继续 `turn/start`。
- 该逻辑只覆盖恢复明确报告 active 的异常路径，不增加全局恢复锁，不触发完整历史读取，
  不改变不同 Thread 的并行发送，也不影响同一 client submission 的不确定投递核验。

本轮验证：

```text
node --check server.mjs public/app.js lib/task-status.mjs lib/turn-start-deduplicator.mjs  通过
git diff --check                                                                    通过
node --test test/turn-start-deduplicator.test.mjs test/task-status.test.mjs          34 passed
node --test --test-name-pattern='turn starts recheck a native active Thread|normal appends skip duplicate history reads|turn starts reuse only a subscribed idle Thread' test/ui.test.mjs
  3 passed
```

新增的 UI 契约测试确认二次核验发生在本地 `taskStatus.start` 之前；它是源码级回归保护，
不是对真实付费供应商的兼容性认证。当前工作树仍未提交、未推送、未部署，救援窗口
`4321` 未修改。

## 11. 发送被错误租约拦截修复（2026-08-31）

### 11.1 现象和根因

一次 turn/start 请求会先取得 Thread 写租约，再在真正提交用户消息前执行原生
任务核验。若 thread/turns/list 在这段可选核验中超时，Codex RPC 的通用超时错误
带有 deliveryUnknown 标记。旧的外层处理把它误当成用户的 turn/start 已经
投递但响应丢失，于是保留了本次其实尚未发送消息的租约。刷新页面后新窗口继续看到
这个有效租约，表现为发送被“当前对话正在由另一个窗口执行”拦截。

同样的原生核验还位于 /api/task/status 的刷新路径。它是辅助状态读取，不是用户
消息提交；读取超时却直接变成 HTTP 错误，会让刷新同时显示任务状态读取失败。

### 11.2 修复边界

- turn/start 只有真正的 turn/start RPC（包括定向恢复重试）发生
  deliveryUnknown 时才保留写租约。
- 发送前的 thread/read、thread/resume、额度/准入检查和原生任务核验失败，
  都释放本次新取得的租约，不把未发送的消息标记为已投递。
- 如果本地确实有同一条不确定提交及其旧租约，则继续复用并保留该旧租约；旧租约已经
  丢失时新建的租约不继承这个保留标记。
- 租约冲突只在本地任务空闲、原生 Thread 明确确认无活动 Turn 且核验成功时自动回收。
  回收使用冲突时捕获的不可枚举租约指纹，并在文件锁内再次比对；租约期间发生续租或
  新增同主人的子租约时不会误删。
- /api/task/status 的可选原生核验超时或连接不确定会返回 HTTP 200 的
  status: "uncertain"、canSend: false，前端显示“确认任务状态”并继续轮询；
  在权威状态恢复前不会发送新消息，避免与仍在运行的 Turn 重叠。

### 11.3 回归验证

本次新增了租约原子回收、指纹变化拒绝回收、发送前租约保留边界和刷新不确定状态的
定向测试：

node --check server.mjs public/app.js lib/thread-write-lease.mjs       通过
node --test test/thread-write-lease.test.mjs                            5 passed
node --test test/turn-start-deduplicator.test.mjs test/task-status.test.mjs
  34 passed
node --test --test-name-pattern='lease retention|optional native verification|terminal native lifecycle|automatic stale lease|composer stays closed|turn starts recheck|normal appends skip duplicate|turn starts reuse' test/ui.test.mjs
  8 passed
git diff --check                                                        通过

当前修改仍未提交、未部署、未推送；冻结的救援窗口 4321 未修改。

### 11.4 后续边界修复

截图中出现“任务已完成”但发送仍提示主窗口占用，说明原生服务有时只发送
`thread/status/changed: idle`、`notLoaded` 或 `thread/closed`，没有发送对应的
`turn/completed`。服务端现在也把这些终态事件纳入租约释放，但只有任务表已经确认
非活动时才释放，延迟的空闲事件不会清除仍在运行的 Turn。

对尚未产生首条消息的空 Worktree Thread，原生上不可能存在活动 Turn；发送前遇到
残留租约时可在指纹再次核对后回收，不必等待 30 分钟租约过期。其他 Thread 仍要求
`thread/turns/list` 和 `thread/read` 的原生非活动证据，两者任一失败都不自动回收。

任务状态接口的原生核验是辅助信息。任何核验失败都返回 HTTP 200 的
`status: "uncertain"` 和 `canSend: false`，前端继续轮询，不再把刷新显示成任务状态
HTTP 错误；在状态确认前仍禁止发送，以避免把真实运行中的 Turn 当成空闲。

本轮增量验证还通过了：

- `node --test --test-name-pattern='lease|task status|turn/start|turn start|recovery|concurr|delivery|thread status|notification' test/server.test.mjs`：11/11；
- `node --check server.mjs public/app.js lib/thread-write-lease.mjs`；
- `git diff --check`。
