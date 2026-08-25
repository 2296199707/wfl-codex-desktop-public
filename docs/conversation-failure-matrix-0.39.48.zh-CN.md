# 会话故障矩阵：0.39.48

> 历史调查矩阵，仅保留旧基线证据。当前权威、恢复和隔离不变量见
> [ADR-0002](adr/0002-app-server-conversation-authority.zh-CN.md)。

状态：调查基线，供实现和验收使用<br>
适用范围：主站会话；不包含备用窗口 `1.0 / 4321`

## 1. 录制字段

每个测试输出 NDJSON。每行包含基础身份和时间字段，并在对应层可用时包含：

```json
{
  "schemaVersion": 2,
  "captureId": "short-lived-capture-uuid",
  "traceId": "uuid",
  "browserSocketId": "short-lived-uuid",
  "gatewayConnectionId": "uuid",
  "gatewayUpstreamId": "uuid",
  "backendConnectionId": "uuid",
  "appServerInstanceId": "uuid",
  "clientInstanceIdDigest": "hmac-sha256",
  "windowInstanceIdDigest": "hmac-sha256",
  "checkpointSlotIdDigest": "hmac-sha256",
  "accountIdDigest": "hmac-sha256",
  "layer": "browser|gateway|backend|app-server|snapshot|store|dom",
  "direction": "in|out|local",
  "kind": "socket/open|socket/close|event/transfer|projection/apply",
  "layerSequence": 42,
  "atMonoMs": 123.45,
  "atUnixMs": 1785429186594,
  "runtimeEpochDigest": "hmac-sha256",
  "upstreamEventSequence": 42,
  "eventLogGenerationDigest": "hmac-sha256",
  "eventCursor": 1042,
  "deliveryKind": "full|skip|barrier",
  "rpcIdDigest": "hmac-sha256",
  "method": "item/completed",
  "threadIdDigest": "hmac-sha256",
  "turnIdDigest": "hmac-sha256",
  "itemIdDigest": "hmac-sha256",
  "clientSubmissionIdDigest": "hmac-sha256",
  "payloadBytes": 512,
  "queueMessages": 0,
  "queueBytes": 0,
  "bufferedAmount": 0,
  "closeCode": 1012,
  "closeReasonClass": "backend-switch",
  "connectionLifetimeMs": 25000,
  "digestAlgorithm": "hmac-sha256",
  "digestKeyId": "sha256-prefix-of-ephemeral-key",
  "payloadDigest": "hex-hmac"
}
```

默认不记录提示、回复、API Key、Cookie、Authorization、工具完整输出或 Diff 内容。
短期、随机且只属于本次采集拓扑的 connection ID 可原样保存；账户、浏览器安装、
window/checkpoint、Epoch/generation、RPC 和 Thread/Turn/Item/Submission 等稳定或用户
作用域 ID 一律只导出 HMAC。只记录类型、长度、每次诊断独立密钥的 HMAC 摘要和经白名单
允许的状态字段。需要跨层比较时，各 recorder 使用同一临时 HMAC 密钥；密钥和 trace
同期删除，禁止使用可枚举短文本的裸 SHA-256。临时诊断内容最长保留 24 小时，文件模式
`0600`，报告只引用脱敏聚合。

## 2. 故障注入点

```text
F1 浏览器 WebSocket 收包前
F2 浏览器 Reducer 前
F3 网关 client <-> upstream 两个方向
F4 后端广播队列
F5 Codex Bridge stdout/stdin
F6 App Server 假后端事件源
F7 快照读取结果
F8 DOM 调度器
```

注入器必须支持按 `method`、序号、字节数和第 N 次匹配执行：

- drop：丢一帧或连续 N 帧。
- duplicate：原样重复。
- reorder：交换相邻帧或在窗口内洗牌。
- delay：固定或可重复种子的抖动。
- disconnect：在请求前、写入后、结果前或通知中断开。
- restart：只重启隔离假后端或开发候选后端。
- slow-consumer：限制消费速率并测量队列。

## 3. 功能故障矩阵

| ID | 场景 | 注入/步骤 | 当前结果 | 目标结果 |
| --- | --- | --- | --- | --- |
| M01 | 同 ID `item/completed` 重复 | F2 重复一帧 | 通过：一条 | 一条，终态不变 |
| M02 | completed 后晚到 started | F2 交换顺序 | 失败：通用工具回退 `inProgress` | 终态单调，不回退 |
| M03 | 同用户提交实时/正式消息 | 相同 `clientId`、不同 Item ID | 通过：一条 | 一条 |
| M04 | 两次相同用户文字 | 不同 `clientId` | 通过：两条 | 两条 |
| M05 | 重复来源四分类与实时/快照助手 ID 分叉 | `msg_*`/`item-*`、重复 delta、双提交入口和强制 DOM render；五层 `traceId` 对照 | 统一分类器连续三次证明：同 ID 两条 delta 为 Store 1/正文 2/DOM 1；ID 分叉为原始/广播一致、Store 1→2、DOM 1→2；强制 render 两次保持 DOM 1；双入口先产生两个不同提交 ID。终态 full 只把 ID 分叉暂时变回一条 | 事件、提交、canonical Item 和 DOM key 分别按自身稳定 ID 去重/归一，不用文本猜测 |
| M06 | 同一快照重复 Turn ID | F7 返回两个相同 Turn ID | 失败：两个 Turn | 一个规范 Turn |
| M07 | 晚到 summary | 完整流文本后到短 summary | 通过：不缩短 | 保留完整文本 |
| M08 | 已完成 Turn 晚到运行快照 | terminal 后 `inProgress` | 通过 | 状态单调 |
| M09 | 丢 `turn/completed` | F1 丢单帧 | 偶然由 idle 刷新自愈 | 序号缺口触发重放 |
| M10 | 丢 completed 和 idle | F1 丢连续两帧 | 失败：回复需手动刷新 | ACK 重放后自动恢复 |
| M11 | 重复 `turn/start` 请求 | 同一提交 ID 并发和串行重试 | 统一分类器中两个不同提交 ID 的同 tick 请求由当前同进程后端接受 1/拒绝 1；交付未知探针则证明同一提交 ID 跨 Epoch、历史未可见时 App Server 执行 2 次。当前仅内存 TTL/全历史可见性条件去重；预实现 SQLite 唯一键尚未接入 | 台账直接返回同一 Turn |
| M12 | 交付未知 | App Server 已收请求、结果丢失并断开；同/跨 Epoch | **失败且已连续两次复现**：浏览器均用同一 `clientUserMessageId` 重投；同 Epoch 和跨 Epoch 历史可见时上游各执行 1 次，跨 Epoch 历史尚不可见时执行 2 次并生成两个 Turn；预实现台账的 12 个 `SIGKILL` 点已证明 `sent/unknown/accepted` 与 outbox purge 可原子恢复，但不改变当前失败 | 查询台账/线程后确定状态；无法证明时保持 `unknown`，不重投 |
| M13 | idle 线程同 tick 发送 | click 与 Enter 同时派发 | 通过：一个 `turn/start` | 同一提交只接受一次 |
| M14 | 输入法提交 | composing Enter；`keyCode=229` 且 `isComposing=false` | 前者 0 次；后者失败并发送 1 次 | 组合输入期间不提交；结束后的明确提交仅一次 |
| M15 | Steer 交付未知 | 写入后丢结果；同/跨 Epoch及 reload | **失败且已连续两次复现**：同 Epoch 和跨 Epoch历史可见时浏览器均以同一 ID 重投、App Server 只执行 1 次；跨 Epoch历史不可见时重试被普通 409 拒绝并恢复成普通输入，人工发送变成新 `turn/start`；reload 则丢失 pending Steer 和冻结输入 | 台账保留 `steer` 类型并裁决；`unknown` 不盲目重放、不降级为普通输入 |
| M16 | 运行中快照校准 | 实时 `msg_*` + snapshot `item-*` | 连续两次五层探针均得到 Store 两个助手 Item、DOM 两个节点；用户项凭 `clientId` 保持一条但 key 改变 | 规范映射后单一 Item，用户/助手 DOM key 均稳定 |
| M17 | Epoch 不变且序号跳跃 | 已连接时丢中间通知；或断线期间其他线程产生 6 条通知 | 已连接路径不检测相邻缺口；重连握手只要账户序号推进就扫描当前线程一次 `thread/turns/list`，不重放缺失区间 | 按连续游标请求缺失区间；无关线程事件不触发当前线程 full 快照 |
| M18 | Epoch 改变 | 后端/App Server 重启 | 完整 bootstrap | 先恢复事件/提交，再权威快照 |
| M19 | 断线期间点击发送后继续编辑/切工程 | F1 断线，点击发送，再改文字、删附件或切工程 | **失败且已连续三次复现**：断线点击时没有 RPC；改正文并删除 1 个附件后，重连发送修改后正文和 0 个附件；从工程 A 切到 B 后，重连在 B 新建线程并发送 | 点击时冻结完整载荷和 destination |
| M20 | `turn/start` 交付未知后刷新页面 | F3 写入后丢结果，在自动重投前 reload | **失败且已复现**：App Server 执行 1 次，新 document 不重投，但 pending、交付状态和冻结输入全部未恢复，输入框为空 | 从服务端台账恢复 accepted/unknown 和未终结 outbox |
| M21 | 未发送草稿后刷新 | 输入文字和附件，再 reload | **失败且已连续三次复现**：reload 不触发 `turn/start`，但新 document 的正文和附件均为空 | 按账号/线程恢复有界本地草稿 |
| M22 | 新线程第一步交付未知 | `thread/start` 成功后丢结果；同 Epoch 与跨 Epoch后人工重发 | **失败且已连续两次复现**：同 Epoch 两个同 ID 浏览器请求由内存单航班归为一个线程；跨 Epoch 不自动重试，但原空线程与恢复草稿无关联，人工重发用新 ID 创建第二个线程 | 同进程单航班返回原结果；跨进程保持 `unknown` 和 outbox，禁止把原输入恢复成可直接重发草稿 |
| M23 | 未绑定 pending 与旧文本相同 | 新提交与旧无 `clientId` legacy Item 同文；同 Epoch断线后序号推进 | **失败且已连续三次复现**：重连 `refreshRecentTurns()` 在 App Server 新请求执行 0 次、RPC 仍 pending 时，把 pending Store 从 1 清为 0，DOM 随后从 1 变 0；权威 Item 到达后才重新出现 | 只用提交/投影身份结算；文本只可提示歧义 |
| M24 | 页面收到 RPC error 后连接立即切换 | F3 在已接受结果处替换普通错误并换 Epoch，历史不可见后人工重发 | **失败且已复现**：普通错误清除 pending、恢复输入；人工重发生成新 `clientUserMessageId`，App Server 执行第二次并生成另一 Turn | 网关回执携带 accepted/unknown 语义；`unknown` 不恢复为可直接重发的普通输入 |
| M25 | 需恢复线程同 tick 发送 | `activeThreadNeedsResume=true` 后 click + Enter | 失败：统一分类器连续三次捕获两个不同 `clientUserMessageId` 的 `turn/start`；当前同进程后端接受 1、拒绝 1，首次重复尝试在浏览器提交入口，不是通知、Store 合并或 DOM | 入口同步 guard + 同一 `clientSubmissionId` 台账 |

预实现 canonical Reducer 模型以 4,096 个固定种子处理 167,251 个实时/重放/JSONL/
快照 action。28,758 个随机逻辑 Item 在三类 source 下仍只有 28,758 个 canonical key；
54,542 次 Item 和 81,215 次 Turn 晚到状态没有回退。定向夹具覆盖 M01-M08/M23：
live/snapshot ID 分叉保持一个 key 和原折叠状态，同文不同提交保持两条，unknown
optimistic 项不被无关 full calibration 删除，候选不唯一时保留歧义项；身份映射执行
0 次文本相等比较。该模型不执行当前 `thread-state.js` 或 DOM，不能把上述当前失败改成
生产通过，只冻结未来影子 Reducer 的可执行验收语义。

## 4. 连接和生命周期矩阵

| ID | 场景 | 当前证据 | 目标不变量 |
| --- | --- | --- | --- |
| C01 | 正常前台空闲 | Chromium 同一 socket 经切槽和 3.8 个心跳周期冻结仍保持；生命周期探针三次均完整记录 open/error/close、单调/Unix 时间戳、可见性、online、socket ID/角色和应用连接寿命；生产长测待新遥测 | 不重连，心跳往返可见 |
| C02 | 手机后台 2 分钟 | 桌面文档冻结仍自动 pong；合成无 pong 静默会被 1006 终止；真机协议 F02 已定义但尚未执行，仍为 `P/X` | 回前台后在预算内重放 |
| C03 | 锁屏后恢复 | 真机协议 F03/F04 已定义且 bundle gate 可执行；尚无真实设备结果，仍为 `X` | 不丢提交、不重复 DOM |
| C04 | 浏览器 offline/online | **当前生产失败**：脚本发送禁用的 1001 抛错；旧 socket 仍 OPEN，online 后新旧两条同时 OPEN。当前生命周期探针三次稳定捕获此浏览器异常；同源拒绝路径另真实触发 error 后 `1006 / reason="" / wasClean=false`，网关重启为 `1012 / Gateway restarting / true`。隔离目标原型三次使用合法 4001，10 个 online 入口 single-flight 为 1 个新 socket，旧 generation 帧被拒绝，最终 1 个活动 socket | 关闭 intent 不抛错；只保留一个活动 generation；交付未知请求进入裁决 |
| C05 | Nginx 绕过/经过 | 当前域名直连 Nginx | 相同事件序列和恢复结果 |
| C06 | 网关绕过/经过 | 当前网关 1012 同 document 恢复且序号不变时会话 RPC 为 0；断线期间其他线程 6 条通知却触发当前线程一次 `thread/turns/list`，1.69-1.92 s，仍无业务重放。隔离目标原型三次将断线 3 条事件按 cursor 重放，可保留 gap 只做一次 range replay，`thread/resume/bootstrap/calibration` 均为 0 | 同 Epoch 只恢复传输和重放缺失事件；无关线程不触发 full 快照；已发送 RPC 必须裁决 |
| C07 | 后端槽切换与冷 document 恢复 | 当前 `starting -> ready` 保持 `browser-ws-1`，但 Epoch 改变并完整 bootstrap、`thread/resume` 和 Goal，1,132-1,342 ms；活动快照存在时三次均无恢复 toast。有效 session 快照 reload 同样 resume 1 次/toast 0；新同源 document 初始化 session key 0、持久恢复指针存在时 resume 1 次并仅 toast 1 次，精确证明“已恢复上次对话”是冷 document 恢复分支，不是断线/Epoch 本身。隔离目标原型在 generation/Epoch 变化时启动 calibration，期间再次换代会丢弃旧结果，fence 前后事件缓冲后与 8 个服务端实体一致 | 明确切换 Epoch、document/window 身份和游标；提交/任务先恢复，权威校准按最小差异应用；仅在无活动快照且确实按恢复指针找回时提示恢复 |
| C08 | App Server 崩溃 | 后端换 Epoch | 活跃任务状态可校准 |
| C09 | ping 正常 | 自动 pong 静默和真实 Chromium 冻结均通过 | 静默连接保持 |
| C10 | 无 pong、有业务消息 | 随机端口实验通过 | 业务流量视为活跃 |
| C11 | 无 pong、无消息 | 随机端口客户端稳定 1006；真实 Chromium 拒绝握手路径三次均产生 error 后 `1006 / reason="" / wasClean=false` | 日志记录原因和寿命 |
| C12 | 慢客户端 | 8 MiB 双客户端探针中快端 257-371 ms 完成，但暂停端使直连后端增加 20.8-23.2 MiB RSS，或使网关增加 19.9-21.5 MiB；无发送预算/遥测 | 慢端有消息和字节上限；内存有界且不拖累其他窗口 |
| C13 | App Server stdin 停读 | **失败**：128 个/8 MiB RPC 在 123-134 ms 内全部交给本地传输且无结果，后端增加 33.8-35.3 MiB RSS；readiness 仍全绿 | 1 MiB 后暂停写并等待 `drain`；readiness 降级；已写请求进入 `unknown` |
| C14 | 上游 Epoch 重置与持久 ACK | 纯内存参考模型中 upstream `97,98 -> 1` 对应持久 cursor `1,2,3`，重复源事件仍映射 3；当前生产尚无持久日志/ACK | `eventLogGeneration + eventCursor` 跨 App Server Epoch 单调；上游序号仅作源去重 |
| C15 | 按线程过滤后的账户序号 | 参考模型得到连续 `full,skip,full,skip,barrier,full`；barrier cursor 5 先持久 ACK，校准含 barrier 前两个 B 实体，再投递 cursor 6；当前生产仍全账号广播大 Item | 每个账户 cursor 都投递 full 或 skip envelope；新观察线程先持久 barrier、旧集合 ACK、校准，再激活新集合 |
| C16 | reload 后 ACK 身份 | 参考模型验证服务端 lease；Chromium strict IndexedDB 的 abort/Worker/renderer crash 均无半 checkpoint，reload/重启保留 cursor 42 但 nonce 改变；同账户双 slot 保持 cursor 62/73 且互不覆盖；10,000 种子组合模型命中 52 次旧 generation ACK 拒绝、5 次不兼容 checkpoint 和 2 次重建后空 seed 校准；当前生产尚无 window ACK lease | 新 window/slot 采用兼容 checkpoint 作只读 seed 并建立新 ACK lease；旧 generation ACK 不推进 lease；旧 lease 过期；checkpoint 缺失/驱逐或重建后日志不能证明从零完整时走 resync |
| C17 | 事件日志事务/超大事件 | 参考模型覆盖广播边界；真实 SQLite WAL 探针五处 `SIGKILL` 均保持原子；组合模型 762 次 generation 重建经显式校准收敛；真实浏览器目标原型再验证 stale calibration 丢弃及 fence 前后事件缓冲归零；当前生产尚无该事务层 | 日志/映射/任务状态同事务后广播；重建必须换 generation 并声明保留起点/resync；单条 >64 KiB 不可压缩事件写 barrier 并权威校准 |
| C18 | 跨用户存储队头阻塞 | Worker 时序模型中 A 的 64 个事务使 B 终态在全局 FIFO 等 202.196-205.922 ms；轮转为 4.928-5.860 ms；A 已进入 50 ms 事务时单 Worker 仍阻塞 B 52.023-52.756 ms，独立 executor 为 1.532-2.116 ms。真实双 UID/GID sidecar + SQLite/WAL 的 15 轮中，B 基线终态 1.370-5.826 ms，A 每轮写 64 × 64 KiB 时 B 为 2.378-8.649 ms；A 被 `SIGSTOP`/`SIGKILL` 时 B 为 3.270-4.697/2.157-4.259 ms，A 重启后 cursor 3,072 且 `integrity_check=ok`；带计数执行中每 192 个 A IPC 请求有 177-178 次 `child.send()` 返回 false | 每 UserRuntime 独立 sidecar/数据库和 ingress 水位；一个用户卡死或过载不阻塞其他用户；父进程必须响应 IPC 背压 |

## 5. 多项目、多标签和订阅矩阵

| ID | 场景 | 当前结果 | 目标结果 |
| --- | --- | --- | --- |
| S01 | 两标签看同一线程 | 通过引用计数测试 | 任一标签退出不卸载另一标签 |
| S02 | 最后标签退订空闲线程 | 通过 | 宽限后官方 unsubscribe |
| S03 | 运行中最后标签退出 | 通过 | 任务继续，任务中心可观察 |
| S04 | 10 秒内重连 | 通过 | 取消待退订计时器 |
| S05 | 快速切换 5 线程 | 失败，泄漏 3 个淘汰订阅 | 最终只保留目标及运行线程 |
| S06 | 2 项目并行 | 有集成覆盖 | 切换不影响生命周期 |
| S07 | 4 项目并行 | 有集成覆盖 | 后台完成与审批不丢失 |
| S08 | 3+ 项目快速切换 | Chromium 随机端口验证 3 个不同线程切换后均保持运行；4 项目有集成覆盖 | 任务归服务端、页面仅观察 |
| S09 | 标签可见性变化 | 只影响审批选择，不释放订阅 | 不终止任务；恢复时重放 |
| S10 | 多设备同线程 | 两个隔离 Chromium context 共同观察、单端关闭和最终退订通过；真机协议 F09-F11 已定义但尚无物理跨网络 bundle，仍为 `P/X`；尚无设备级 ACK 游标 | 每客户端独立 ACK 和未读游标 |
| S11 | `window.open` 新标签页 | Chromium 证明复制父页 lease owner ID | 每个 document 生成独立 window ID |
| S12 | 长租约期间同 owner 短写 | 失败：同 token，短写释放后长租约消失 | 可重入引用计数；子租约不能释放父租约 |
| S13 | 多标签观察不同线程 | 浏览器实证非活动客户端收到另一线程 7 条通知，DOM 丢弃未串屏 | 线程事件只发给观察者，任务摘要单独广播 |
| S14 | 两标签观察同一完成 Turn | 每标签各执行一次 recent full 扫描 | 服务端一次规范化并向两客户端重放 |

## 6. 渲染和交互矩阵

| ID | 场景 | 当前结果 | 目标结果 |
| --- | --- | --- | --- |
| R01 | 20,000 行关闭 Diff | 当前 `app.js` 组合场景三次稳定保留 19,999 行、80,047 元素/120,052 全部节点；关闭外层 `<details>` 后数量完全不变，完整场景为 9,489-10,279 ms、最长 Long Task 2,164-2,390 ms。隔离目标原型关闭时正文读取/明细节点为 0，展开首批仅 500 行/558 元素/1,081 全部节点 | 关闭时 0 行节点 |
| R02 | 单个流式 Item 更新 | 当前 4 次 Chromium 首条 delta 可见 89-120 ms，目标缺失时全量 render；隔离目标原型 100 次定向 patch 增加 0 次 full render、单次最大 0.1-0.2 ms | 只创建/patch canonical Item 骨架 |
| R03 | 任意全量 render | 当前所有描述符完整 `JSON.stringify + hash`；隔离目标原型只按 canonical key/revision patch，关闭三类 body 读取为 0 | 只计算脏实体版本 |
| R04 | `msg_*` 恢复为 `item-*` | 当前 DOM/fold key 改变并替换；隔离目标原型 alias 校准保留同一节点、打开状态和 500 行投影 | canonical key 稳定 |
| R05 | 线程缓存持久化 | 主线程同步多次序列化和 `sessionStorage` 写入 | Worker/IndexedDB 有界异步写 |
| R06 | idle 先于 completed | 历史刷新可暂时改写 `activeTurnId`，按钮闪动 | 单一 Turn/提交状态派生按钮 |
| R07 | 超大命令输出保持折叠 | 当前 `app.js` 三次接收完整 2,097,152 字符输出；正文可因显示偏好不挂载/最多投影末尾 80,000 字符，但完整输出仍进入 Store、描述符序列化和签名，并与 20,000 行 Diff 的真实通知序列产生 84.5%-89.6% Long Task 窗口。隔离目标原型 2 MiB 输出关闭读取为 0、展开只挂载 64 KiB、收起卸载且 raw 保留 | 折叠时只保留摘要和内容引用 |
| R08 | 滚动中历史校准 | 当前有 DOM key 锚点但 ID 分叉时失效；隔离目标原型前插 16 Turn 后三次均保留原节点且位移 0 px | canonical key + 虚拟窗口保持锚点 |
| R09 | 22,880 字符 Markdown 风格回复、320 文件引用 | Markdown 语义节点为 0；335 个元素/990 个总节点；文件链接按时序在终态前或后物化 | 原文单一权威；可见时增量解析，流式/终态保持同一节点结构 |

## 7. Provider、Goal 和重试矩阵

| ID | 场景 | 目标结果 | 当前证据 | 结论 |
| --- | --- | --- | --- | :---: |
| G01 | API 瞬时断线 | 有界退避，保持同一提交 ID | 同一 Turn 第 5 次连续可重试错误后停止；进度会重置计数；跨刷新提交台账仍不存在 | P |
| G02 | 额度耗尽 | 明确暂停，不把额度错误当网络无限重试 | 结构化 `usageLimitExceeded` 在独立服务器探针中进入 `provider-unavailable`，开启无限重试后会按连接故障重试 | **失败** |
| G03 | 无限重试开启 | 遵守最小/最大间隔和抖动，不忙循环 | fast/balanced/patient 为有界阶梯并带 ±10% 抖动；但 429/401 也错误取得重试资格 | P |
| G04 | Goal 手动暂停 | 不终止当前 Turn，后续 Turn 不自动启动 | after-Turn 暂停期间任务保持 `running`，受控 1.2 秒 Turn 在暂停请求后约 1.19 秒自然完成，Goal 再落为 `paused` | V |
| G05 | 暂停后切供应商 | 新 Turn 使用新供应商，旧提交不重放 | 空闲切换后 before/after 审计持久化；恢复后的新 Turn 使用第二供应商环境且只启动一次；已完成旧 `clientSubmissionId` 未重放 | V |
| G06 | 交付未知时切供应商 | 先裁决旧提交，禁止跨供应商双执行 | 当前没有持久提交台账，无法裁决写后断线的 `unknown` | D |
| G07 | 账号登录失效 | 保留账号资料，状态失效且不混入管理员 API 额度 | 账号资料/失效状态和官方额度独立存储通过；但结构化 `unauthorized` 在 Turn 重试路径仍被归入连接恢复 | **失败** |
| G08 | 进程重启后 Goal 恢复 | 服务端任务状态恢复，不依赖页面存活 | 临时主服务无浏览器重启后，原 `manualPauseRequestedAt`、原生 Goal `paused` 和控制状态均恢复 | V |

上述 `V` 只证明当前受控边界，不代表未来提交台账、ACK 和故障注入已经实现。证据来自
33 项 Goal/Provider/官方账号隔离单元测试和
`probe-goal-provider-recovery.mjs`；探针使用随机回环端口、假 App Server 与两个本地
模型端点，无生产请求且未访问 `4321`。

## 8. 性能矩阵和预算

以下是实现验收上限，不是当前成绩：

| 指标 | 普通线程目标 | 200+ MB legacy 线程目标 |
| --- | ---: | ---: |
| WebSocket 建连到状态可用 P95 | 1,000 ms | 1,000 ms |
| 打开线程到首屏最近消息 P95 | 800 ms | 1,500 ms |
| `turn/start` 接受回执 P95 | 300 ms | 500 ms |
| 事件进入浏览器到可见文本 P95 | 100 ms | 150 ms |
| 事件日志事务提交 P95（≤16 条且 ≤64 KiB） | 10 ms | 10 ms |
| 事件日志事务提交 P99（≤16 条且 ≤64 KiB） | 25 ms | 25 ms |
| IndexedDB 增量 ACK P95（≤16 事件且 ≤32 KiB） | 10 ms | 10 ms |
| IndexedDB 后台 checkpoint 页面 P95（≤512 KiB） | 30 ms | 30 ms |
| 其他用户存储 backlog 引入的终态排队 P95 | 10 ms | 10 ms |
| 同 Epoch 短线恢复 P95 | 1,500 ms | 2,500 ms |
| 首次增量索引建立 | 后台 | 每 50 MB 不超过 2 s CPU |
| 索引增量更新 P95 | 50 ms | 100 ms |
| 单客户端待发送消息 | 256 条 | 256 条 |
| 单客户端待发送字节 | 4 MiB | 4 MiB |
| App Server stdin 待写字节 | 1 MiB | 1 MiB |
| 默认挂载消息 DOM 节点 | 5,000 | 5,000 |
| 单个关闭 Diff 挂载行数 | 0 | 0 |
| 单个展开 Diff 首批行 | 500 | 500 |
| 页面长任务期间 long task 比例 | < 1% | < 1% |

以上数字统一按
[决策记分卡 §4](conversation-decision-scorecard-0.39.48.zh-CN.md)
的测量契约执行：ordinary warm/cold、legacy warm/cold-index、3/5 项目并发和重连场景
不得混合平均；warm 至少 100 个计入样本，cold/index 至少 30 个，同一候选至少 3 批；
P95 使用 nearest-rank，并同时保留 P50/P99、最大值、失败、超时、崩溃和 outlier。
跨进程延迟只能在记录时钟偏差并同时报告各段时用于诊断，不能冒充精确端到端 P95。

当前受控 Chromium 探针只作为基线，不作为 P95：最近 8 个 Turn 首屏为 210-355 ms，
首条 delta 进入浏览器到可见为 89-120 ms；22,880 字符/320 引用场景的 Long Task
比例为 51%-67%，最长 135-154 ms。假 App Server 发出首条 delta 到浏览器收到还需
240-370 ms，证明浏览器渲染预算和后端事件排队必须分别测量。

开发 ext4 上的 SQLite 3.51.3/WAL/`synchronous=FULL` 探针三次共写 9,888 条、
79.125 MiB 输入：256 B × 16、4 KiB × 16 和 64 KiB × 1 的事务 P95 最大分别为
4.239、5.985 和 3.407 ms；256 KiB × 1 已达 31.013 ms。该结果支持 16 条与 64 KiB
双上限，但不是候选版本 P95；生产必须在独立存储 executor 中复测（managed 多用户
为每 UserRuntime sidecar，legacy 单用户可用 Worker thread），不能使用同步 SQLite
阻塞后端。

临时 Chromium profile 的 strict IndexedDB 探针三次中，32 KiB 增量事务 P95 为
5.5-8.4 ms、P99 为 6.8-9.1 ms；512 KiB 页面 P95 为 22.0-23.4 ms；2 MiB 完整写
P95 为 45.0-49.2 ms。显式 abort、Worker 终止和 renderer crash 均零半 checkpoint；
该浏览器存储未获 persisted，删除后物理使用量也未立即下降，所以 checkpoint 只能是
账户隔离的可丢缓存，缺失时必须权威 resync。

legacy 历史索引预实现探针四次各处理 55,270,771 字节、29,561 行、5,912 个 Turn 和
2,831,371 字节最大单行，首次建立总耗时为 1,144.119-1,285.193 ms，低于每 50 MiB
2 秒预算。2,173 字节残行在补齐换行前不进入索引；增量追加只扫描 safe offset 后的
61,635 字节。截断、inode 替换、头部改写、模式/UID/GID 拒绝和 commit 前后 `SIGKILL`
均有确定性断言。这是 synthetic SQLite 模型，不是生产 sidecar，也不替代真实
200+ MiB 候选验收。

按需渲染参考探针三次使用 80 Turn、20,000 行 Diff、2 MiB 工具输出和 512 KiB 推理
正文。关闭时为 56 个元素/78 个全部节点且正文读取/明细节点为 0；Worker 解析 Diff 为
1.8-2.6 ms，10 行 Diff/8 KiB 文本主线程切片最大 0.5-0.6 ms，首批 500 行后为
558 个元素/1,081 个全部节点，
全程零 Long Task。alias 校准、100 次流式 patch、前插 16 Turn 和收起/重开均保持
canonical 节点、折叠、滚动和 raw 内容。该结果不执行当前主站，不能替代生产、移动或
候选性能验收。

超过队列预算时不得静默丢业务事件。可丢或合并的只有明确声明可压缩的进度类事件，
例如同一 Item 的中间进度快照；终态、审批、提交回执和文本 delta 必须保留或触发
带原因的权威校准。

## 9. 可靠性验收

候选实现必须在固定种子的 10,000 次故障注入运行中满足：

- 合法用户消息重复率：0。
- 助手最终消息重复率：0。
- 终态事件漏失率：0。
- 已接受提交的错误重放率：0；无法裁决时必须显式停在 `unknown`，不能假装失败或成功。
- `unknown` 被错误标记为 `cancelled/rejected` 的次数：0。
- 同 Epoch 可重放断线恢复率：100%。
- 快速切换后的空闲订阅泄漏：0。
- 长任务租约被短写提前释放：0。
- 状态回退：0。
- 慢客户端造成其他客户端延迟超预算：0。
- upstream Epoch 重置后误接受旧 generation cursor：0。
- full/skip 投递区间中的 cursor 空洞：0。
- 日志、任务/提交状态和已广播事件的半提交：0。
- reload 复用旧 `windowInstanceId` 或继承旧 ACK lease：0。
- 一个用户 sidecar 卡死导致其他用户终态超过存储排队预算：0。

### 9.1 预实现组合模型

离线 `probe-conversation-fault-matrix.mjs` 已用 10,000 个固定种子组合 drop、
duplicate、reorder、delay、disconnect 和 restart。累计提交 242,587 条模型事件，
检测 26,419 次 cursor 缺口，幂等忽略 16,149 个重复/晚到帧，并覆盖 5,236 次
App Server 重启、762 次事件日志重建、2,677 次 reload 和 6,000 个未裁决提交。

模型中客户端最终全部经连续范围重放或权威校准收敛；`unknown` 没有跨 Provider
重放，旧 generation ACK 没有推进 lease，reload 没有复用 window。两次完整运行输出
摘要一致。该结果只证明 ADR 的恢复协议在组合故障下内部一致；它不执行生产 Reducer、
SQLite sidecar、IndexedDB、WebSocket 队列、订阅租约或候选代码，不能用来勾选上面的
正式可靠性验收。

独立的 SQLite 提交台账探针又覆盖 12 个真实进程崩溃点：prepare、sent、unknown、
accepted 和 24 小时过期清理在 state、transition history、outbox purge 任一 commit
前崩溃都完整回滚，commit 后同操作重试只读取既有结果。密钥缺失或密文损坏保持 blocked
`unknown`，`sent|unknown` 到期只转为 `unresolved-abandoned`，不会伪装成 rejected 或
cancelled。该探针同样是预实现存储证据，不能把 M11/M12/M20/M22/M24 标记为生产通过。

### 9.2 预实现迁移和回滚模型

`probe-conversation-migration-reference.mjs` 将 ADR §14-16 的七阶段迁移转成纯状态机。
每阶段注入 transaction 前、draft 后 commit 前和 commit 后崩溃：14 个 commit 前故障
全部回滚，7 个 commit 后故障恢复为每阶段恰好提交一次。owner→admin→account 灰度
期间，协议 v1 客户端始终走 legacy broadcast，ACK 被拒绝且不能推进事件日志 retention。

renderer、ACK、submission、index、dedup 五层开关的 120 种回滚顺序共执行 600 次
转换；schema 表和提交台账删除为 0，`unknown` 跨 Provider 重放为 0，ACK 回滚后事件
日志仍继续 append。候选启动、兼容失败、切流前和切流后四个发布故障点均恢复仍在运行
的旧活动后端，管理员对话权限始终保留。JSONL 修改、备用窗口操作和普通服务器完整、
浏览器冒烟、压力测试均为 0。

这是迁移设计的预实现证据，不执行当前发布脚本、真实数据库迁移、旧客户端 bundle 或
服务切流，不能标记任何生产升级/降级或候选发布已经通过。

## 10. 执行边界

完整矩阵仅在开发机或候选发布环境执行。普通用户服务器只运行：

- 协议/数据版本兼容检查。
- 索引文件权限和可恢复性检查。
- 网关、后端和 App Server readiness。
- 一个不调用真实模型的只读 `thread/list`。

正式安装不得运行本矩阵、浏览器冒烟、压力测试或真实模型提示。

## 11. 可复用低负载工具

工具位于 [`scripts/conversation-diagnostics`](../scripts/conversation-diagnostics/README.md)；
不加入 `package.json` 的安装、更新、部署或正式版检查：

| 工具 | 覆盖 | 明确不覆盖 |
| --- | --- | --- |
| `probe-investigation-package-audit.mjs` | 只读核对基线、56 项追踪、矩阵编号/状态、Markdown/链接、诊断隔离与普通安装/更新轻量检查门禁 | 不访问网络/服务、不激活 recorder、不替代真机或所有者 ADR 决策；基线漂移会直接失败 |
| `probe-websocket-lifecycle.mjs` | 有界监听 open/message/ping/pong/close/error，只记录长度、摘要和白名单 ID | 不发送业务 RPC；拒绝 `4321`；不代替真实浏览器可见性/锁屏遥测 |
| `probe-browser-websocket-lifecycle.mjs` | 隔离 Chromium + 随机端口主站夹具，记录真实 open/error/close、关闭码/原因、可见性、online、时间戳、socket ID/角色和寿命，并分类换槽、冻结、离线、重启、序号推进及冷 document 恢复 | 不访问生产；不替代真机后台/锁屏/跨网络或生产发生频率遥测；当前 `targetMet: false` 场景是缺陷证据 |
| `probe-app-server-version-contract.mjs` | 本机 0.146 stable/experimental schema 与 help，验证核心方法/通知、实验历史分页、`clientUserMessageId` 及缺失的 start 幂等键和 ACK/replay | 不启动 App Server、不读生产、不测运行交付/队列容量；schema 不编码 transport 成熟度，升级 Codex 后必须重跑 |
| `analyze-conversation-traces.mjs` | 序号缺口、重复序号、Item 终态回退、跨层缺失聚合 | 没有共同关联 ID 时不能猜测两个事件相同 |
| `inject-conversation-trace.mjs` | 离线 drop/duplicate/delay/reorder、断线/重启 marker 和 slow-consumer 时间变换 | 不断开、不重启、不限速任何真实服务 |
| `probe-browser-render-performance.mjs` | 随机端口测量首屏、流式可见、文件引用物化、DOM 和 Long Task | 不连接生产；不是正式版 P95 或安装检查 |
| `probe-on-demand-render-reference.mjs` | 隔离 Chromium 组合验证 8 Turn 虚拟窗口、关闭零正文/明细、Worker 解析、500 行分批挂载、canonical 节点/折叠/滚动/未读稳定和 100 次定向 patch | 不执行当前 `app.js`；不覆盖 Markdown/选区/搜索/无障碍、Worker 崩溃、内存压力、手机或候选版本 |
| `probe-browser-reconnect-reference.mjs` | 随机回环 WebSocket + 真实 Chromium 验证合法 close、generation guard、online single-flight、连续/gap replay、generation/Epoch calibration、stale 结果丢弃和 fence 缓冲 | 不执行当前 `app.js`；cursor 仅内存；不覆盖 durable ACK、提交/pending RPC、日志淘汰、reload、代理、真机或候选版本 |
| `probe-browser-multi-client-state.mjs` | 两个隔离 context 验证账户广播、DOM 隔离、租约身份、共享订阅和最终退订 | 不替代物理设备、移动网络或 durable ACK |
| `probe-goal-provider-recovery.mjs` | after-Turn 暂停、空闲切换供应商、恢复、新 Turn 与主服务重启；定性 401/429/超时分类 | 不调用真实供应商；G06 `unknown` 裁决及未来台账仍待实现 |
| `probe-websocket-backpressure.mjs` | 两个随机端口客户端、8 MiB 硬上限，比较直连后端和临时网关的快端延迟、慢端排空与 RSS | 不访问生产；不证明未来队列有界；不覆盖 App Server stdin `drain` |
| `probe-app-server-stdin-backpressure.mjs` | SIGSTOP 临时假 App Server 后发送 128 个/8 MiB RPC，记录未决数、主后端 RSS 和 readiness | 不访问生产；不等待真实 RPC 超时；只允许开发机手动运行 |
| `probe-turn-delivery-unknown.mjs` | 随机端口写后丢结果，覆盖同 Epoch、跨 Epoch历史可见/不可见，比较浏览器提交 ID、App Server 调用次数和 Turn ID | 只用假 App Server；证明当前 M12 边界，不代表持久台账已实现或 exactly-once |
| `probe-thread-start-delivery-unknown.mjs` | 写后丢 `thread/start` 结果，比较同 Epoch 单航班与跨 Epoch孤立线程、恢复草稿和人工重发 | 只持久化空线程摘要；证明 M22 当前边界，不提供上游幂等键 |
| `probe-steer-delivery-unknown.mjs` | 随机端口写后丢 Steer 结果，覆盖同 Epoch、跨 Epoch历史可见/不可见、409 后人工发送及 reload | 只持久化脱敏 Turn/Item/client ID；证明 M15 当前边界，不代表 Steer 已有持久裁决 |
| `probe-queued-prompt-reconnect.mjs` | 可控断线后验证排队正文/附件变更、工程切换和未发送草稿 reload | 只输出载荷类别、计数和目标关系；证明 M19/M21 当前边界，不持久化正文或附件 |
| `probe-pending-user-legacy-collision.mjs` | 同 Epoch断线和无关序号推进后，比较 recent 校准前后 pending Store、DOM、RPC 与上游执行数 | 只输出状态布尔值和计数；证明 M23 首错在 Store refresh settlement，不记录正文 |
| `probe-event-log-reference-model.mjs` | 固定种子验证 C14-C17 的双序号、full/skip/barrier、reload lease、事务与广播顺序 | 纯内存模型；不执行生产 Reducer、SQLite 或 IndexedDB |
| `probe-conversation-fault-matrix.mjs` | 10,000 固定种子组合 drop/duplicate/reorder/delay/disconnect/restart，并验证重放、generation resync、reload lease 和 `unknown` 不跨 Provider 重放 | 纯离线参考模型；不执行候选实现、生产 Reducer、数据库、浏览器或真实队列，不能替代 §9 正式验收 |
| `probe-submission-ledger-storage.mjs` | 临时 SQLite WAL/FULL + AES-GCM/HMAC 台账，验证唯一键、状态机、24 小时 outbox、12 个 `SIGKILL` 点及 commit 后幂等恢复 | 不调用生产/App Server/Provider；不证明上游 exactly-once，也不代表生产 sidecar 或台账已实现 |
| `probe-canonical-reducer-reference-model.mjs` | 4,096 固定种子统一处理 live/replay/JSONL/snapshot，验证 source alias、稳定 canonical key、单调状态、歧义保留和 unknown calibration 保护 | 纯内存参考模型；不执行当前 `thread-state.js`、DOM、事件日志或 IndexedDB，不代表影子/生产 Reducer 已实现 |
| `probe-legacy-history-index.mjs` | 私有 55.27 MB synthetic JSONL + SQLite WAL/FULL，验证 safe newline、增量追加、Turn/Item/client 摘要、双向分页、重建判据、UID/GID/mode 拒绝和 commit 前后 `SIGKILL` | 不读取真实正文；依赖 append-only 假设；不代表生产 Worker/UserRuntime sidecar、200+ MiB、格式迁移或饱和磁盘已通过 |
| `probe-event-log-storage.mjs` | 临时 SQLite WAL + AES-GCM 性能、文件模式、密钥缺失回滚和五个真实 `SIGKILL` 原子性点 | 只允许开发机手动运行；Node SQLite API 为 experimental；不代表生产 sidecar/legacy Worker 或 IndexedDB P95 |
| `probe-indexeddb-checkpoint.mjs` | 空白回环页和临时 Chromium profile 测 strict 事务、abort/Worker 终止/renderer crash、账户清理、reload/重启和 checkpoint 延迟 | 不加载主站；不代表移动浏览器、存储压力驱逐或生产 canonical Store |
| `probe-event-log-worker-fairness.mjs` | 真实 Worker thread 时序比较全局 FIFO、账户轮转、独立 runtime executor 和 48/32/64 条水位 | 存储服务时间来自模拟；不执行 SQLite、生产 sidecar 或真实 UID/GID 隔离 |
| `probe-event-log-sidecar-isolation.mjs` | 两个真实非 root UID/GID sidecar、独立 SQLite/WAL、IPC、跨路径拒绝、磁盘竞争、`SIGSTOP`/`SIGKILL` 和 WAL 重开 | root 开发机限定；每轮输入 4 MiB；简化事件表，不代表生产 sidecar、加密台账、Bridge 水位、饱和磁盘或候选 P95 |
| `probe-correlation-envelope.mjs` | 512 组/9,216 行 schema v2 元数据贯穿 App Server、后端、网关、浏览器、Store 和 DOM；覆盖上游重连、reload、缺层、序号和父连接错配 | 纯离线 envelope；不代表生产已分配连接 ID 或安装了 recorder；不含业务正文 |
| `probe-shadow-recorder-lifecycle.mjs` | 默认关闭、10 类非法 manifest/key、主站门禁、HMAC、scaled queue/4 segment 轮转、过期、配置变化、revoke、浏览器回执和组件 EIO 隔离 | 只在 probe 私有 `/tmp` 目录；预算为快速触发而缩小；不接生产四层，也不代表现场 capture 已完成 |
| `probe-shadow-recorder-hook-map.mjs` | 锁定 gateway/backend/browser/Store/DOM/pure Reducer 的 31 个当前源码 anchor、四份 hash、main/rescue/VNC 门禁、内部 header allowlist 和零生产/发布引用 | 静态预实现检查；不安装 recorder、不启动服务/浏览器、不授权 capture，源 hash 变化必须重审 |
| `probe-mobile-field-evidence-bundle.mjs` | 11 场景 × 3 次、33 runs/351 rows fixture；校验模式、checksum、时序、跨层、设备/网络摘要和隐私，并注入 10 类证据失败 | fixture 永远不能作为真机证据；`--bundle` 只验证结构，物理设备仍需 owner attestation 和真实执行 |
| `probe-conversation-migration-reference.mjs` | 七阶段/21 个 commit 边界、owner→admin→account 协议灰度、旧客户端 ACK 禁令、五层 120 种回滚顺序及 4 个发布失败点 | 纯状态机；不读生产、不执行发布或真实 schema/bundle 迁移、不操作 `4321`，不能替代候选升级降级演练 |

当前工具足够重放 M01-M10、M16-M18 的事件序列以及慢消费者的离线时间模型；
`probe-browser-conversation-state.mjs` 覆盖 M13-M14、M25 和 S08。以下场景
仍必须保留为缺口，不能用离线 trace 宣称通过：

- C02/C03：真实手机后台/锁屏仍需按
  [现场协议](conversation-mobile-field-protocol.zh-CN.md) 执行；fixture gate 通过不改变
  `P/X` 状态。
- S10：独立浏览器 storage/socket 的当前订阅行为已通过；物理跨网络设备仍需现场
  F09-F11 bundle，未来 durable ACK 独立游标仍需实现后验证。
- M11-M12、M15、M19-M24：M12、M15、M19、M21、M23 当前失败已由确定性浏览器探针
  闭合；未来提交台账、加密 outbox、草稿持久化和 RPC accepted/unknown 边界仍须在
  实现后验收。
- M13-M14、M25：当前入口行为已经由 Chromium 定性；同步 submit-intent guard、
  稳定提交 ID 和完整 IME composition 状态仍须在实现后验收。
- C12：未来有界队列中的真实 per-client 隔离。
- C13：实现 1 MiB stdin 队列、`drain` 和堵塞 readiness 后，用现有停读探针验收。
- S08 的“切换不终止任务”已通过；三工程弱网/断线耐久组合留到新重放协议实现后。
- G01/G03 仍因提交身份和错误资格部分成立；G02/G07 已证明错误分类；G06 必须等待
  提交台账实现。G04/G05/G08 的当前受控边界已通过。
- §9 的 10,000 次可靠性验收：只允许在实现后的开发候选环境执行。
