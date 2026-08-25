# 会话架构调查报告：0.39.48 / Codex 0.146.0

> 历史调查证据，不是当前架构说明。文中的事件日志、ACK/checkpoint、canonical 双投影
> 和 Sidecar 提交台账方案已由 [ADR-0002](adr/0002-app-server-conversation-authority.zh-CN.md)
> 取代；保留本文只为追溯当时故障与测量结果。

状态：调查结论，待架构评审<br>
调查日期：2026-07-30<br>
基线提交：`accb59f1d2a53c9a437dd41a9955f3ab78d5b3bf`<br>
主站版本：`0.39.48-beta`<br>
Codex CLI：`0.146.0`

## 1. 范围和硬约束

本轮只调查会话链路，不实现修复、不部署、不推送、不创建标签。当前工作树的
`git status --porcelain` 有 62 项：47 个 tracked 修改、15 个 untracked 路径；tracked
diff 为 12,475 行新增、897 行删除，未把 untracked 调查文档和探针虚计进 diff。
既有内容均按用户修改处理，没有覆盖或还原。`backups/README.md` 的已有删除必须保留。

备用窗口是独立冻结组件 `1.0`，活动端口为 `4321`。本轮没有向备用窗口发测试请求，
没有启动、停止、重启或替换备用服务，也没有修改 `rescue-active-port`、槽位符号链接
或备用资源。后续主站会话架构实现同样不得把备用窗口纳入部署或迁移。

正式版在普通服务器安装或同步时不得运行完整测试、压力测试或浏览器冒烟。本文的
故障注入和高负载测量只允许在开发机、随机端口、`/tmp` 和假后端上执行。
当前普通安装使用离线快速检查；普通主站同步的 `update-app` 同样强制
`CODEX_DESKTOP_QUICK_CHECK_OFFLINE=1`，而 `quick-update-check` 不再读取或请求备用
窗口 readiness。完整仓库/浏览器套件只存在于 candidate 或显式主发布检查分支。

## 2. 现网实际链路

当时的部署域名直接解析到服务器，HTTPS 响应头为 `Server: nginx/1.24.0`，
主机上没有 `cloudflared` 进程或配置。因此本机的实际链路是：

```text
浏览器
  -> 公网 TLS / Nginx :443
  -> 稳定网关 127.0.0.1:4317
  -> 活动主后端 127.0.0.1:4318
  -> 每用户 Codex app-server stdio
  -> JSONL / Codex SQLite / WFL 状态文件
```

Cloudflare Tunnel 是安装文档支持的可选拓扑，但不是本次故障服务器的现行链路，
不能把当前断线归因于 Cloudflare。

Nginx 对 WebSocket 使用 HTTP/1.1、Upgrade/Connection 头以及 3,600 秒读写超时。
网关 HTTP keep-alive 为 120 秒，WebSocket 每 25 秒同时 ping 浏览器和活动后端，
连续两轮未恢复后终止对应连接。浏览器到网关的 WebSocket 在后端槽切换时保持打开，
网关在 500 ms 后连接新后端。

## 3. 各层状态和生命周期

| 层 | 当前权威或缓存 | 序号/身份 | 恢复行为 | 已确认缺口 |
| --- | --- | --- | --- | --- |
| 浏览器 DOM | 已渲染消息节点、折叠和滚动状态 | `messageItemKey` | 全量或局部重新渲染 | 节点数量无硬预算；折叠仍计算并挂载大内容 |
| 浏览器 Store | `activeThread`、8 条线程快照、乐观消息、待处理 RPC | `runtimeEpoch`、最后事件序号、Turn/Item ID | 同 Epoch 软恢复；Epoch 变化重新 bootstrap | 不检测相邻事件缺口；实时和快照 ID 空间不同 |
| 浏览器传输 | 单个 WebSocket、内存 RPC Map | 自增 `requestId` | 指数退避重连 | 无业务 ACK；断开后 RPC 交付状态未知 |
| Nginx | TCP/HTTP 代理状态 | 无应用关联 ID | 关闭连接后由浏览器重连 | 默认访问日志没有连接寿命和关闭码 |
| 稳定网关 | 浏览器与当前槽的桥接对象 | 无连接 ID、无业务序号 | 保持浏览器 WS，重连活动后端 | 不缓冲、不重放、不确认业务 RPC；发送无背压 |
| 用户后端 | 用户运行时、浏览器集合、虚拟线程订阅、任务状态 | 内存 `runtimeEpoch`、`eventSequence` | App Server 重启时换 Epoch；广播新状态 | 无持久事件日志、客户端 ACK 或断线重放 |
| Codex Bridge | stdio 子进程、待响应 RPC Map | 自增 JSON-RPC ID | 子进程退出 1.5 秒后重启 | stdin 写入不处理 `drain`；RPC 交付可能未知 |
| Codex App Server | 线程运行时、官方订阅和分页投影 | Thread/Turn/Item ID | `resume/read/list` 重建历史 | legacy 重建的 Item ID 与实时 Item ID 不稳定 |
| JSONL | 原始持久会话记录 | `response_item.id`、`turn_id` | App Server 扫描并重建 DTO | 214 MB 线程读取慢；没有 WFL 增量索引 |
| Codex SQLite | 目标、日志、记忆和新协议投影 | Codex 自有主键 | 由 Codex 管理 | WFL 不应直接写内部表 |
| WFL 状态 | Goal、任务、恢复、用户和运维记录 | WFL 自有 ID | 服务启动时读取 | 不包含浏览器事件游标和提交台账 |

关联 ID 的静态审计进一步确认：浏览器只有 document 内自增 `rpcId`、
`socketOpenedAt` 和当前 socket 对象；reload 后 `rpcId` 从 1 重置。网关桥接对象没有
`gatewayConnectionId` 或每次上游重连 generation，也不记录 close/error。后端为写租约
临时生成 `threadLeaseOwnerId`，但它不是连接 ID；运维 socket 记录只有 open/close
成功状态和用户，没有关闭码、原因、寿命或父网关连接。`runtimeEpoch/eventSequence`
只出现在后端通知和 status 中。Codex Bridge 的 `nextId` 仅是本子进程 JSON-RPC ID，
子进程重启没有独立 `appServerInstanceId` 或原始通知 ordinal。因此现有现场日志不能把
同一事件从 App Server 贯通到最终 DOM，也不能区分“同一浏览器 socket 上游重连”和
“reload 新 document”。

为先冻结 schema 而不改变生产行为，新增纯离线 correlation envelope 夹具。固定
512 组生成 9,216 行 schema v2 元数据，覆盖 App Server -> 后端 -> 网关 -> 浏览器 ->
Store -> DOM、保持浏览器 socket 的上游重连，以及保留 client 身份但更换 window/socket
身份的 reload。缺少任一层、layer sequence 重复或父连接错配都会被检测；临时
NDJSON/HMAC key 均为 `0600` 并在退出时删除。账户、client/window/checkpoint、
Epoch/generation、RPC 和 Thread/Turn/Item/Submission 只输出分域 HMAC，正文、凭据、
工具输出和 Diff 哨兵均未出现。该结果证明录制 envelope 内部一致，不代表生产 recorder
已经安装。

阶段 0 的安全生命周期另见
[Shadow Recorder 规范](conversation-shadow-recorder-stage0.zh-CN.md)。对应离线模型
验证：默认关闭不创建 segment；rescue、VNC、通配 surface、过期/超时、非 owner-local、
未知组件、错误模式和 symlink key 共 10 类输入均在创建 segment 前拒绝。scaled 预算下
固定产生 4 个 `0600` segment，queue/capacity 只丢 trace，160 个模拟业务事件中断数为
0；manifest/key 变化、过期和 revoke 均只 seal recorder。注入 gateway `EIO` 后 gateway
recorder 独立 sealed，backend 仍成功写一行，readiness 变化和 socket close 都是 0。
错误 token、跨账户、rescue/VNC 和未知正文域的浏览器回执全部被拒绝。该模型仍未接入
生产四层，不能替代定向现场 capture。

## 4. 真实协议录制

调查使用独立 `codex app-server --listen stdio://`、`/tmp` 工作目录、只读沙箱和一个
固定短回复。探针线程读取后已通过官方 `thread/delete` 删除，临时 App Server 已退出。

实时事件顺序如下：

```text
turn/start result
thread/settings/updated
thread/status/changed(active)
turn/started                         items=[]
item/started(userMessage)            id=019f... clientId=wfl-probe-...
item/completed(userMessage)          id=019f... clientId=wfl-probe-...
item/started(agentMessage)           id=msg_0767... text=""
item/agentMessage/delta              itemId=msg_0767... "TRACE"
item/agentMessage/delta              itemId=msg_0767... "_PERSIST"
item/completed(agentMessage)         id=msg_0767... text="TRACE_PERSIST"
thread/tokenUsage/updated
account/rateLimits/updated
thread/status/changed(idle)
turn/completed                       summary id=msg_0767...
```

结论：

- `item/started`、delta、`item/completed` 和 `turn/completed` summary 的助手 ID 一致。
- `item/completed` 是同一个实时 Item 的权威终态，不应追加新 Item。
- `turn/started` 不带 Item；`turn/completed` 只带最终助手消息的 summary。
- `thread/status/changed(idle)` 实际先于 `turn/completed`，不能把 idle 当作已经收到完整
  Turn 的证明。
- `clientUserMessageId` 只回显为用户 Item 的 `clientId`，不是 App Server 原生幂等键。

同一个 Turn 随后从 `thread/read(includeTurns:true)`、`thread/turns/list(full)` 和
`thread/turns/list(summary)` 读取时，用户 Item 被重建为 `item-1`，助手 Item 被重建为
`item-2`。原始 JSONL 中助手 `response_item.id` 仍是 `msg_0767...`。

这证明 Codex 0.146 legacy 历史投影的 Item ID 在“实时事件 -> 恢复快照”之间不稳定。
当前客户端以 Item ID 作为跨实时和快照的唯一身份，因此其核心前提不成立。

## 5. 已稳定复现的故障

### 5.1 回复不出现，刷新后恢复

在同源 HTTP+WebSocket 丢帧代理中，连续丢弃：

1. `turn/completed`
2. 随后的 `thread/status/changed`

丢帧前客户端有一条用户消息、零条助手消息，连接仍显示“Codex 已连接”，发送按钮仍
处于可追加状态。手动刷新后同一 Turn 的助手消息出现。

只丢 `turn/completed` 时，后到的 idle 状态会偶然触发 80 ms 历史刷新并自愈。这是
当前 UI 的旁路校准，不是事件序号重放。连续丢两个事件后，浏览器既不检测序号缺口，
也没有事件日志可请求，漏消息永久保留到手动刷新。

### 5.2 重复消息

真实 215 MB JSONL 中 41,044 个带 ID 的 `response_item` 没有重复。通过官方
`thread/read(includeTurns:true)` 重建后，307 个 Turn ID、5,781 个 Item ID 和 258 个
用户 `clientId` 也分别全部唯一。重复不是 JSONL 写入两份。

Reducer 定向矩阵证明，当实时助手 `msg_*` 与恢复助手 `item-*` 文本相同但 ID 不同，
当前逻辑保留两条。真实协议录制又证明这一 ID 分叉确实发生。运行中快照为了保护尚未
持久化的实时内容，会保留快照未见的 `_live` Item，因此最容易在断线、恢复或手动刷新
落在运行中 Turn 时形成长期重复。

把真实 ID 形态直接输入当前 Reducer 后：

- 运行中 full 快照得到 `item-1`、`item-2`、`msg_live`；用户项凭 `clientId` 成功
  归一，但助手快照和实时项同时存在。
- terminal summary 同样同时保留 `item-2` 与 `msg_live`。
- terminal full 快照会权威替换为 `item-1`、`item-2`，所以部分重复会在下一次完整
  刷新时消失，造成“时有时无”的表象。
- 通用工具 Item 的晚到 `started` 会把 `completed` 回退成 `inProgress`。

新增的五层同 Turn 探针把 App Server 元数据、浏览器收到的广播、快照响应、浏览器 Store
和最终 DOM 置于同一个随机 `traceId` 下。夹具只注入真实 Codex 已经证明存在的身份形态：
实时助手为 `msg_trace_live_*`，快照助手为 `item_trace_snapshot_agent_*`。连续三次结果
完全一致：

| 阶段 | App Server / 传输 | Store | DOM |
| --- | --- | --- | --- |
| 实时 delta 后 | 原始和浏览器收到的 `turn/started -> item/started -> 2 delta -> item/completed -> turn/completed` 方法、顺序和 ID 完全一致；助手只有 `msg_trace_live_*` | 一个 live 助手 Item | 一个助手节点 |
| 运行中 full 快照 | App Server 返回且浏览器原样收到 `item_trace_snapshot_agent_*` | 同时保留 snapshot `item_*` 和 live `msg_*` | 两个不同 key 的相同助手节点 |
| 终态 full 快照 | 仍返回 snapshot `item_*` | 权威替换为一个 snapshot Item | 恢复为一个节点 |

用户 Item 的实时/快照 ID 也不同，但相同 `clientId` 使它保持一条；其 DOM key 仍从实时 ID
切换成快照 ID。助手没有等价的跨投影键，所以重复首次出现在
`browser-store-running-snapshot-merge`，随后才被 DOM 如实投影。App Server 持久源没有
两条、广播没有重复通知、DOM 也没有自行复制内容。终态 full 快照只是暂时掩盖问题，
不是建立了稳定身份；若到达的是 summary 或下一次 full 校准很晚，重复就会持续存在。

该探针使用 mode `0600` 临时 NDJSON，只保存方法、ID、类型、序号、长度和投影清单，不
保存提示或回复正文。为了读取模块私有 Store，它只在临时 Chromium 请求中内存插桩
`app.js`，磁盘业务资源没有调试导出。它不是生产个案 trace，但与真实协议分叉证据组合后，
已经闭合“哪一层首次产生重复”的确定性因果链。

同一探针随后把四种重复来源放进一个 ID/计数分类矩阵，连续三次结果一致：

| 输入类别 | App Server / 浏览器传输 | Store | DOM | 首次重复层 |
| --- | --- | --- | --- | --- |
| 需恢复线程同 tick 双入口 | 浏览器发出 2 个不同 `clientSubmissionId` 的 `turn/start`；当前同进程后端接受 1、拒绝 1 | 1 Turn / 1 用户 Item | 1 用户节点 | 浏览器提交入口已经形成两次提交尝试；M12 另证明跨 Epoch且历史未可见时两次都能到 App Server |
| 同 Item 的重复 delta 通知 | App Server 原始 2 条，浏览器原样收到 2 条，Item ID 相同 | 1 Item，marker 正文出现 2 次 | 1 节点，marker 正文出现 2 次 | App Server/通知流 |
| live/snapshot ID 分叉 | 原始通知和广播身份完全一致；快照返回另一 Item ID | 运行中从 1 Item 变 2 Item | 随 Store 从 1 节点变 2 节点 | Store 的运行中快照合并 |
| Store 不变，强制 `renderMessages()` 两次 | 无新增通知/RPC | 始终 1 Item、marker 2 次 | 始终 1 节点、marker 2 次 | 无；DOM reconciliation 不自行复制 |

这也解释了“重复消息”为什么不能用一种补丁处理：重复 delta 需要事件身份/ACK 去重；
双提交需要提交台账；live/snapshot 分叉需要 canonical source mapping；DOM 只应保持
稳定 key。旧生产日志缺跨层 ID，不能逐条回溯历史事故，但四种机制现在都能用
`turn/start` 数、通知数、Store Item 数和 DOM 节点数确定分类，不再依赖相同文本猜测。

不能用文本相同去重：用户可以合法连续发送两次相同文字，两个不同 `clientId` 必须
保留。助手的跨投影关联需要稳定的 WFL 规范化身份和来源映射。

### 5.3 快速切换后订阅泄漏

在隔离假 App Server 上快速选择 5 个项目，最终只显示第 5 个线程，但 App Server
仍加载第 2、3、4、5 个线程。第 2、3、4 个选择都被 `selectionVersion` 淘汰。

`resumeThread()` 在 RPC 前发送新 `client/state`，结果返回后若版本过期直接返回，
没有调用 `releaseThreadSubscription()`。后端的 `client/state` 只新增订阅，不会自动
移除该浏览器之前的线程，因此泄漏是确定性的。基础的双标签引用计数、运行中任务保护
和 10 秒短线重连宽限本身正常。

新增的双隔离 Chromium context 探针进一步验证了真实浏览器层行为。两个 context 使用
独立 storage 和 WebSocket，得到两个不同的 session lease owner ID。客户端 A 观察
线程 A 时，完整收到线程 B 的 7 条账户级通知，方法包括 `thread/started`、
`turn/started`、`thread/status/changed`、Hook 和 `turn/completed`；但 A 的消息 DOM
没有出现 B 的助手回复，说明当前是“服务端全广播、浏览器按活动线程丢弃”，不是服务端
按订阅路由。

随后两个 context 同时观察运行中的线程 A。关闭第一个 context 并等待 10.5 秒后，
第二个 context 仍显示运行，官方 `thread/loaded/list` 也仍包含 A；第二端终止 Turn 后，
只要它仍订阅，空闲线程仍保持 loaded，显式 `thread/unsubscribe` 后才卸载。这证明当前
浏览器独立存储/socket 下的引用计数和运行保护成立，但不证明物理第二设备、跨网络或
未来 durable ACK 游标。

### 5.4 连接反复断开

运维原始记录最近约 24 小时包含 301 次打开、290 次关闭。所有关闭都被当前日志归为
`error`，因为只按关闭码是否为 1000/1001 分类，没有连接 ID、关闭码、原因或寿命。
12:00 至 14:00 每小时约 66 至 68 次后端关闭；打开间隔中位数约 47 秒。

随机端口心跳实验验证：

| 客户端行为 | 3.8 个心跳周期后的结果 |
| --- | --- |
| 自动 pong、无业务消息 | 连接保持 |
| 禁用 pong、每 500 ms 发业务消息 | 连接保持 |
| 禁用 pong、完全静默 | 网关终止，客户端看到 1006 |

因此网关不会把正常业务流量误判为失活；手机后台冻结、控制帧被代理丢弃或事件循环长期
阻塞会稳定触发终止。现有生产日志不足以在这些原因之间定责，必须先增加关联 ID 和关闭
遥测。

真实 Chromium 在随机端口、假后端和 1 秒心跳下完成了同一页面的连续生命周期录制：

| 场景 | 浏览器实测 |
| --- | --- |
| 活动主槽 A -> B | `bridge/status starting -> ready`，浏览器始终使用 `browser-ws-1` |
| 文档冻结 3.8 秒 | `browser-ws-1` 保持 OPEN，没有 close/error |
| DevTools offline | 收到 `offline` 且 `navigator.onLine=false`；旧 socket 仍为 OPEN |
| DevTools online | 新建 `browser-ws-2`，此时 `browser-ws-1` 和 `browser-ws-2` 同时 OPEN |
| 网关正常重启 | 两条旧连接都收到 `1012 / Gateway restarting / wasClean=true`；同页新建 `browser-ws-3` |
| 同源拒绝路径 | 真实触发 `error`，随后 `1006 / reason="" / wasClean=false`；角色为 `diagnostic-error` |

增强后的生命周期字段探针连续三次均记录 4 个 open、1 个 error、4 个 close，关闭码集合
固定为 `1006/1012`；每条 envelope 均有单调/Unix 时间戳、`visibility`、
`navigator.onLine`、socket ID 和角色，每条 close 均有 code、reason 和 `wasClean`。
三组已关闭应用 socket 的寿命区间分别为 9,176-9,294 ms、2,602-2,648 ms 和
524-575 ms。`diagnostic-error` 使用同源但被拒绝的真实 WebSocket 握手，只用于触发
Chromium 原生 error/abnormal-close 回调，不构造合成错误，也不发送业务 RPC。

离线路径发现了确定性缺陷。`handleBrowserOffline()` 先把 `state.socket` 清空，再执行
`socket.close(1001, "Browser offline")`。浏览器 WebSocket API 不允许脚本发送保留的
1001：应用只能发送 1000 或 3000 至 4999。Chromium 因此抛出
`Failed to execute 'close' ... 1001 is neither`，关闭没有发生，异常之后的
`scheduleSocketReconnect()` 也没有执行。网络恢复事件仍会另建连接，但旧连接和旧后端
订阅继续存活，直到网关重启；三次测得旧、新两条连接寿命分别为
9,176-9,294 ms 和 2,602-2,648 ms。

旧 socket 的浏览器消息回调会因 `state.socket !== socket` 丢弃后续帧，所以这项证据
本身不证明重复 DOM；它确定证明双连接、旧订阅/资源泄漏和离线恢复状态机不原子。
主槽切换不关闭浏览器 WebSocket、桌面文档冻结不停止网络栈自动 pong、网关正常重启
产生清晰 1012 并同页恢复也都已证明。手机锁屏可能连浏览器网络进程一起冻结，仍须
真机遥测，桌面仿真不能替代该证据。

部署槽 `4318` 的 `app.js`、`boot.js` 和 `index.html` 与工作区 SHA-256 完全一致。
源码没有定时整页刷新；版本 `location.replace` 只在管理员确认刷新版本后执行，启动
恢复条的 `location.reload` 也需要用户点击。因此高频打开不能归因于旧部署资源或隐藏
的页面刷新定时器。

恢复分类探针把同一 document 的 RPC、Epoch、消息 DOM、toast 和 navigation 放在同一
时间轴中。连续三次的结果一致：

| 阶段 | 耗时 | 会话恢复行为 | 页面行为 |
| --- | ---: | --- | --- |
| 首次显式选择线程 | 325-353 ms | 仅 `thread/resume` 和 `thread/goal/get` | 首次渲染消息 |
| 主后端槽 A -> B | 1,132-1,342 ms | Epoch 改变；执行模型、配置、能力、两次 `thread/list`、loaded list、权限、协作模式、`thread/resume` 和 Goal 的完整 bootstrap | 始终为 `browser-ws-1`；小线程消息 DOM 增删均为 0，toast 为 0 |
| 文档冻结 | 3.8 s | 会话 RPC 为 0 | DOM 增删和 toast 均为 0 |
| offline -> online | 2.9 s 左右 | Epoch 不变；会话 RPC 为 0 | DOM 增删和 toast 均为 0，但非法 1001 造成双 OPEN |
| 网关重启 | 1.7 s 左右 | Epoch 不变；会话 RPC 为 0 | “正在重连 -> Codex 已连接”，DOM 增删和 toast 均为 0 |
| 网关断线期间其他线程产生 6 条通知 | 1.69-1.92 s | Epoch 不变、账户序号从 1 推进到 7；对当前线程执行一次 `thread/turns/list` | 当前线程内容未变化，DOM 增删和 toast 均为 0 |

全程 `browser/initialized` 只有一次，Performance Navigation 也只有首次 `navigate` 一条。
因此受控环境已经证明：主槽切换造成的是同一页面、同一浏览器 WebSocket 上的 Epoch
变化和完整 bootstrap，不是页面 reload。同 Epoch 且服务端序号未推进时只恢复传输；
服务端序号推进时不重放缺失事件，而是调用当前活动线程的 `thread/turns/list`。

源码与探针共同证明，这个触发器是账户级 `eventSequence > previousSequence`，不是相邻
缺口检测，也不关心缺失通知属于哪个线程。断线期间只有另一个线程运行，也会让当前线程
读取并合并 recent full 快照，随后执行 `renderActiveThread()`。短夹具因内容完全相同而
没有消息节点增删；但 215 MB 生产线程的官方读取曾耗时 8.21 秒，所以这条无关线程引发的
校准路径仍是多项目并发时卡顿、按钮状态重新派生和长线程闪烁的高风险来源。小线程零 DOM
变更不能外推为长线程绝不会闪烁。

为验证替代状态机不是纸面流程，新增
`probe-browser-reconnect-reference.mjs`。它只在随机回环端口运行一个最小 replay
服务和真实 headless Chromium，不加载当前主站。三次结果完全一致：

| 目标场景 | 真实浏览器参考结果 |
| --- | --- |
| deliberate offline | 先 retire generation，客户端发送合法 4001；旧帧被 generation guard 丢弃 |
| 10 个并发 online 入口 | 只创建 1 个新 socket，9 个调用加入 single-flight |
| 两次服务端受控重启 | 浏览器接收 1012；每次只创建一个新 generation |
| 同 document 重连 | 4 个 socket generation 始终使用同一服务端 `windowInstanceId` |
| 断线期间 3 条事件 | hello 后按 cursor 连续重放；零 `thread/resume`、零 bootstrap、零 calibration |
| 实时漏 cursor 5、先到 cursor 6 | 检出 1 个 gap，只发 1 次 range replay，最终 cursor 6 |
| calibration 期间再次换 generation/Epoch | 第一份结果丢弃；第二份完成 |
| fence 前后各写 1 条事件 | 浏览器在模拟 25 ms 应用延迟中缓冲，最后 buffer 为 0 |
| 最终状态 | 1 个活动 socket；客户端与服务端 8 个 canonical 实体一致 |

这使目标门禁更精确：同 generation 的连续重连只做 replay；可保留范围内的 cursor gap
也优先 replay；只有 generation/Epoch 不兼容、日志已淘汰或明确
`calibrationRequired` 才进行权威校准。不能把“账户序号变了”直接等同于当前线程需要
full snapshot。

该探针只证明浏览器 transport/replay/calibration 组合语义。它的 cursor 在内存中，
没有执行当前 `app.js`、IndexedDB durable ACK、提交台账、pending RPC 裁决、日志淘汰、
reload/new-window、代理超时或真机后台；因此当前 C04/C06/C07 失败仍未被生产修复。

源码不存在“聊天记录已恢复”这一精确文案，用户看到的对应提示是
“已恢复上次对话”；另一条“已找回对话记录，但恢复连接失败：...”属于只读 fallback，
不是同一触发器。生命周期探针新增两种真实 Chromium reload 对照，连续三次一致：

| 文档/缓存条件 | RPC | “已恢复上次对话” |
| --- | --- | ---: |
| 原标签 reload，新 document 继承有效 `sessionStorage` 活动线程快照 | 1 次 `thread/resume` | 0 |
| 新同源 document，初始化时 `sessionStorage` key 为 0，但 `localStorage` 恢复指针存在 | 1 次 `thread/resume` | 1 |
| 原 document 后端换槽，Epoch 改变并完整 bootstrap，活动线程快照仍在 | 1 次 `thread/resume` | 0 |
| 同 Epoch 普通重连或账户序号推进 | 0 次 resume 或 1 次 recent list | 0 |

这与 `recoverActiveThread()` 的唯一 toast 分支吻合：只有 bootstrap 开始时
`state.activeThread` 为空、恢复指针有效、且 `resumeThread()` 成功，才显示该提示。
因此单纯断线、事件缺口或 Epoch 改变都不是充分条件；真正条件是“新/冷 document 没有
可用活动线程快照，只能按持久恢复指针重新 resume”。它会重新渲染对话，但不是
JavaScript 调用的第二次页面 reload。

生产记录中 12:00 至 15:00 的 206 次主后端 WebSocket 打开里，177 次在随后 20 秒内触发
`thread/resume`，中位间隔 7.1 秒；同期共有 188 次 resume。旧日志缺
`clientInstanceId`、`windowInstanceId`、document ID、初始化时缓存状态和 navigation
原因，所以不能把历史 177 次逐例归类；这不再影响触发器本身的确定性结论，但仍影响
生产发生频率统计。

### 5.5 三工程、IME 和同 tick 提交

新增的隔离 Chromium 探针使用三个临时工程、随机主站端口和假 App Server，不连接生产
域名、网关或备用窗口。三个工程分别启动一个保持运行的 Turn 后，在同一页面依次切回
每个工程，三个 Turn 都仍显示运行；捕获到三个不同 Thread ID 和三个不同
`clientUserMessageId`。结合已有 2/4 项目集成测试，当前“切换页面本身不终止后台 Turn”
已有真实浏览器证据。

输入和提交探针得到：

| 场景 | `turn/start` 数量 | 结论 |
| --- | ---: | --- |
| `isComposing=true` 时按 Enter | 0 | 正常阻止 |
| 组合输入仍进行，但事件为 `keyCode=229`、`isComposing=false` | 1 | 失败：当前代码只检查 `isComposing` |
| 普通 idle 线程，同 tick 点击发送并派发 Enter | 1 | 同步 guard 在该路径有效 |
| `activeThreadNeedsResume=true`，同 tick 点击发送并派发 Enter | 2 | 失败：两个不同 `clientUserMessageId` 的独立提交 |

最后一个失败的确定路径是：

1. 两次 `sendPrompt()` 都在入口检查时看到没有 pending。
2. 两次都先进入 `await resumeThread()`；此时尚未设置 `turnPreparationPending` 或
   `pendingTurnRequest`。
3. 第一轮恢复先返回并发出第一个 `turn/start`。
4. 第二轮延迟恢复随后返回，继续使用进入函数时捕获的原文字，创建新的
   `clientUserMessageId` 并发出第二个 `turn/start`。

所以这个重复属于“两次提交”，不是两次通知、Reducer 合并或 DOM 节点重复。入口必须在
任何 `await` 之前同步取得一次性 submit-intent guard；稳定提交 ID 和服务端台账仍是
第二道防线。IME 还要维护 `compositionstart/compositionend` 状态，并把 `keyCode=229`、
`key=Process|Dead` 视为组合输入，不能只信任 `event.isComposing`。

## 6. 性能证据

首次官方读取性能取样时的 Goal JSONL：

- 文件大小：215,714,778 字节。
- 测量快照记录数：76,673 行；后续流式审计时为 76,771 行，线程仍在增长。
- JSONL 中有 305 个 `task_started`；官方读取投影为 307 个 Turn。
- 52,599 条 `response_item`；最大单行 2,625,474 字节。
- Node 主后端约 156 MB RSS；主 App Server 约 240 MB RSS。
- 单次官方 `thread/read(includeTurns:true)` 审计耗时 8.21 秒。

生产运维记录中的 RPC 延迟：

| 方法 | 样本 | P50 | P95 | 最大 |
| --- | ---: | ---: | ---: | ---: |
| `turn/start` | 37 | 6.9 s | 10.1 s | 14.1 s |
| `thread/resume` | 281 | 5.3 s | 8.4 s | 13.4 s |
| `thread/turns/list` | 67 | 5.6 s | 7.7 s | 10.1 s |
| `thread/list` | 374 | 176 ms | 422 ms | 1.0 s |

`TurnStartDeduplicator` 在每个新 `clientUserMessageId` 第一次提交前执行
`thread/read(includeTurns:true)` 并扫描全部历史。它把避免重复提交的成本放在每一次
正常提交上，也解释了 `turn/start` 与超大历史扫描的延迟一致。

每个活动标签还会在 `thread/status/changed(idle)` 或 `turn/completed` 后安排一次
80 ms 的 `thread/turns/list(full)`；同一标签的两个通知会合并成一个计时器，但两个
查看同一线程的标签会各自发起扫描。生产记录曾在同一时刻出现两次约 8.5 秒的
`thread/turns/list`，与该行为一致。

官方分页不能解决已有 legacy JSONL 的扫描成本：即使只请求最近 8 个 Turn，App Server
仍需重建旧历史或其投影。WFL 需要只读增量索引；不能在 UI 每次查看或提交时依赖全文件
扫描。

### 6.1 legacy JSONL 增量索引

后续只读结构快照中，同一持续增长的 0.146 rollout 已到 232,099,377 字节、81,715 行，
零损坏行，最大单行 2,625,474 字节。顶层记录为：

| 类型 | 行数 |
| --- | ---: |
| `response_item` | 55,968 |
| `event_msg` | 24,914 |
| `turn_context` | 467 |
| `world_state` | 172 |
| `compacted` | 150 |
| `inter_agent_communication_metadata` | 34 |
| `session_meta` | 10 |

该审计只输出类型、字段名、计数和行长，没有输出正文。`turn_context.payload.turn_id`
提供 Turn 边界；258 条 `event_msg:user_message` 均具有 `client_id`；Item ID、角色和
阶段位于对应 `response_item`。现有 `scanCodexGoalRollouts()` 已是流式读取，但每次
Goal bootstrap 仍会对选中的最多 512 MiB 文件从头扫描，只按 Goal 事件过滤，没有安全
换行 offset、Turn 边界、byte range 或分页查询，所以不能直接复用为 UI 历史索引。

新增 `probe-legacy-history-index.mjs` 只使用私有 synthetic rollout。四次各扫描
55,270,771 字节、29,561 行和 5,912 个 Turn，夹具包含 2,831,371 字节单行；SQLite
WAL/`synchronous=FULL` 首次建立总耗时为 1,144.119-1,285.193 ms，纯扫描为
899.128-1,002.334 ms，低于每 50 MiB 2 秒预算。索引只保存 HMAC-SHA-256、协议枚举、
Turn/row ordinal 和 byte range，数据库/WAL 中未发现正文哨兵。

探针将 2,173 字节未完成末行留在 safe offset 外，补齐换行并追加 12 个 Turn 后只读取
61,635 个增量字节；向前、向后各查询 8 个 Turn 摘要均不调用 `thread/resume/read`。
截断、inode 替换和头部改写触发重建；模式或预期 UID 不匹配只拒绝，不修复源文件。
commit 前 `SIGKILL` 使 rows/checkpoint 全回滚，commit 后被杀则两者均恢复且重试写入
0 行。

这是索引 schema 和事务边界的预实现证据，不是生产功能。快速路径依赖 Codex rollout
append-only；只校验头部和 safe-offset 尾部 anchor 不能发现任意中段原地改写。正式
方案需要接受该上游契约或增加分块摘要，并仍须在独立 Worker/UserRuntime sidecar、
真实 200+ MiB 文件、饱和磁盘和格式迁移下验收。

前端 20,000 行关闭 Diff 的早期单次测量约 255 ms，并创建约 80,019 个元素节点。当前
折叠只隐藏视觉，渲染前仍对所有描述符执行序列化、哈希、Markdown/Diff 处理和挂载。

新增的随机回环端口 Chromium 性能探针对同一受控场景运行 4 次。它打开最近 8 个
Turn（17 条消息），再流式输出 22,880 个字符，其中含 Markdown 风格标题、强调、行内
代码和 320 个工程文件引用。结果为：

| 指标 | 4 次范围 |
| --- | ---: |
| 打开线程到首条最近消息 | 210-355 ms |
| `thread/resume` 回执到首条最近消息 | 134-274 ms |
| 首条 delta 进入浏览器到文字可见 | 89-120 ms |
| 首条 delta 从假 App Server 发出到浏览器收到 | 240-370 ms |
| 单条助手消息元素节点 / 全部节点 | 335 / 990 |
| 测量窗口 Long Task 比例 | 51%-67% |
| 最长 Long Task | 135-154 ms |

这不是生产 P95，也不能代替候选版本的多轮性能验收；它用于隔离当前渲染路径。当前助手
正文没有通用 Markdown 语义渲染：`h1/h2/strong/code/ul/li` 等语义节点为 0，普通语法
按 `white-space: pre-wrap` 文本显示，只有工程文件引用被正则识别并转换成按钮。

320 个引用的物化时机也不是固定终态：2 次在 `item/completed` 前 42-113 ms 由缺失目标
节点后的全量流式 render 创建，另 2 次在 `item/completed` 后 47-49 ms 创建。说明事件
在后端/浏览器排队后，首批 delta、末批 delta 和终态的相对处理顺序会改变实际 DOM
路径，不能只用“delta 定向 patch”静态测试证明流式性能。

同一探针现已加入当前 `app.js` 的有界大载荷场景：假 App Server 向随机回环主站发送
2,097,152 字符命令输出和 577,792 字符、20,000 原始行的结构化 Diff，再按真实
`item/started -> outputDelta/patchUpdated -> item/completed -> turn/completed` 路径
处理。三次结果为：

| 指标 | 三次范围/结果 |
| --- | ---: |
| 完整场景处理窗口 | 9,489-10,279 ms |
| 最长 Long Task | 2,164-2,390 ms |
| Long Task 占窗口比例 | 84.5%-89.6% |
| Diff 可见行节点 | 19,999 |
| Diff 元素节点 / 全部节点 | 80,047 / 120,052 |
| 关闭外层 `<details>` 后 Diff 行/节点 | 与关闭前完全相同 |

命令正文因当前“显示工具输出”偏好可保持未挂载，界面最多也只投影末尾 80,000 字符；
但完整 2 MiB payload 已进入 Store 和描述符签名路径。该组合测试不把 9-10 秒全部归因于
命令输出：其中包含大 Diff 首次渲染、三个终态 Item 引发的重复 reconciliation 以及
快照/状态更新。它证明的是用户实际遇到的组合路径会阻塞，而不是某个孤立解析函数的
微基准。生产 recorder 仍可补发生频率，但“是否会阻塞主线程/延迟可见更新”已经由当前
代码的真实浏览器路径稳定证明。

### 6.2 事件日志存储预算

协议参考模型不能回答真实加密、fsync 和 SQLite 页面开销，因此又在开发 ext4 上运行
有界存储探针。环境为 Node 22.23.1、SQLite 3.51.3、WAL、`synchronous=FULL`，
payload 使用 AES-256-GCM 并绑定账户、generation、cursor、source 和 canonical ref
作为 AAD。三次重复共写 9,888 条、79.125 MiB 明文输入：

| payload / batch | 事务 P95 三次范围 | 最大事务 | 50,000 条数据库外推 |
| --- | ---: | ---: | ---: |
| 256 B × 16 | 3.519-4.239 ms | 4.646 ms | 48.447 MiB |
| 4 KiB × 16 | 4.465-5.985 ms | 15.519 ms | 241.089 MiB |
| 64 KiB × 1 | 2.878-3.407 ms | 15.172 ms | 3,201.294 MiB |
| 256 KiB × 1 | 21.326-31.013 ms | 31.013 ms | 12,670.898 MiB |

这不是生产 P95，但已推翻“50,000 条与 64 MiB 可同时硬保证”的假设。事件日志必须是
短期增量重放层，不复制 JSONL 中最大 2.6 MiB 的完整终态；单条和单事务明文均限制
64 KiB，batch 最多 16 条/4 ms。超过单条上限写 `calibrationRequired` barrier，并从
JSONL 增量索引做权威校准。64 MiB 字节硬上限优先，落后 window 必须显式 resync，
不能为 2 小时 ACK 软目标无界增长。

同一探针在 event insert、source mapping、task state、account cursor 和 commit 后分别
杀死真实子进程。前四处重开后全部回滚，commit 后四张表全部可见；同 source 重试最终
均只有 cursor 1、2 两条记录，`integrity_check=ok`。密钥缺失事务没有推进 cursor，
明文哨兵未出现在 SQLite/WAL，文件模式均为 `0600`。这支持 ADR 的原子边界，但 Node
内置 SQLite API 仍为 experimental，正式实现必须放进独立存储 executor；managed
多用户采用每 UserRuntime sidecar，legacy 单用户可用 Worker thread。候选实现还须
重测多账户和 IndexedDB，不得在后端主事件循环同步落盘。

### 6.3 浏览器 checkpoint 和 durable ACK

服务端 ACK 只有在浏览器能原子恢复规范化实体和 cursor 时才有意义。新增探针不加载
主站，而是在随机回环空白页和临时 Chromium profile 中建立 strict IndexedDB 事务，
把实体、不可变 checkpoint 根和 `(accountId, checkpointSlotId)` durable head 一起
提交。三次独立 profile：

| 逻辑 checkpoint | 事务 P95 范围 | P99 范围 | 最大 |
| --- | ---: | ---: | ---: |
| 32 实体 / 32 KiB | 5.5-8.4 ms | 6.8-9.1 ms | 9.1 ms |
| 128 实体 / 512 KiB | 22.0-23.4 ms | 22.0-23.4 ms | 23.4 ms |
| 256 实体 / 2 MiB | 45.0-49.2 ms | 45.0-49.2 ms | 49.2 ms |

所以每事件复制完整 checkpoint 会放大写入。ACK 路径应只写结构共享后的脏实体和新根，
以 16 事件/32 KiB/16 ms 为上限；512 KiB 页面和最多 2 MiB 的合并在 Worker 后台执行，
根指针最后用小事务切换。

显式 abort、连续三次 Worker 在首条写成功后终止，以及一次 CDP renderer crash 都得到
全回滚，没有实体、根或 cursor 半可见。完成的 cursor 42/10 实体在 reload 和整个浏览器
重启后都能读回，但 document nonce 每次变化。账户 A 清理后记录为 0，账户 B 的 7 个
实体/cursor 47 不受影响。同账户两个 checkpoint slot 并发建立 cursor 61/73，slot A
再推进到 62 后 slot B 仍为 73，证明不能使用账户单例 head；reload 只能把旧根作为
seed，新 document 必须取得新 slot。

该 Chromium profile 的 `navigator.storage.persisted()` 连续为 false。15.625 MiB
benchmark 逻辑随机数据连同原子性/slot 夹具使使用量增加 20.694-28.741 MiB；
abort/crash/删除并重启后估算仍有 39.473-41.490 MiB，说明 LevelDB
tombstone/compaction 不会同步返还物理空间。应用必须
按账户维护逻辑 8 MiB 初始预算，登出/撤销验证记录不可查询，但不能承诺物理文件立即
缩小。站点数据被清理或驱逐时 checkpoint 消失是合法输入，服务端必须权威 resync。

## 7. 背压和交付语义

三个连续链路都没有完整背压：

- 网关 `client.send()` 和 `upstream.send()` 没有 callback、队列或 `bufferedAmount`
  上限。
- 主后端广播 `client.send(JSON.stringify(...))` 没有 callback、队列或慢客户端隔离。
- `CodexBridge.write()` 不检查 stdin 返回值，也不等待 `drain`。

Codex 官方 stdio transport 内部使用 128 条有界队列，但 WFL 在其前后仍可无限积压。
超大 Diff、工具输出和历史快照会造成事件循环停顿、队头阻塞或内存增长。

新增的双客户端随机端口探针用假 App Server 发送严格封顶的 128 帧 × 64 KiB
（每轮 8 MiB），慢客户端在开始前暂停 TCP 读取，快客户端正常消费。连续两次结果为：

| 路径 | 快客户端完成 | 慢端恢复前帧数 | 慢端恢复后排空 | 暂停期间进程 RSS 增量 |
| --- | ---: | ---: | ---: | ---: |
| 直连主后端 | 257-371 ms | 0 | 30-63 ms | 后端 20.8-23.2 MiB |
| 临时网关 -> 主后端 | 271-361 ms | 0 | 31-36 ms | 网关 19.9-21.5 MiB；后端 7.8-8.0 MiB |

所以当前 8 MiB 短样本没有证明慢端拖慢快端，却稳定证明内存隔离不存在：发送路径接受
全部数据，既没有 per-client 消息/字节上限，也没有 `bufferedAmount` 或排队时间指标。
RSS 包含 JSON 解析、序列化、WebSocket 和运行时临时对象，不能把每个字节都归因于某一
条队列，也不能把这个范围线性外推；但多个慢窗口会共享同一进程内存预算，当前没有
阻止继续增长的控制面。

App Server stdin 也已用独立随机端口探针验证。假 App Server 先正常完成启动和一次
`thread/list`，随后只对该临时子进程执行 `SIGSTOP`，确保它完全不再读取 stdin。
主后端接着收到 128 个各带 64 KiB 填充的只读 RPC，总计仍封顶 8 MiB：

| 指标 | 连续两次结果 |
| --- | ---: |
| 浏览器发送 128 个 RPC | 123-134 ms |
| 停读期间返回的 RPC | 0；128 个全部未决 |
| 主后端 RSS 增量 | 33.8-35.3 MiB |
| 假 App Server RSS 增量 | 0 |
| `/internal/codex-ready` | 6.8-10.3 ms，仍错误返回 `codexReady=true`、`threadListReady=true` |

这直接证明 `child.stdin.write()` 返回值被丢弃和缺少 `drain` 不只是静态风险：堵塞和
全部未决状态被吸收到主后端内存，现有 readiness 也无法发现写通道已不可用。该探针
没有等待 120 秒 RPC 超时，也没有访问正式服务；实现后必须验证 1 MiB 上限、堵塞
readiness 和 `unknown` 交付语义。

### 7.1 跨用户存储公平性

当前 `runtimeByUserId` 把所有 `UserRuntime` 放在同一个 Node 后端进程中；每个用户有
独立 Codex Bridge/App Server 子进程和 `stateDirectory`，但主事件循环共享。若未来把
事件日志放进主线程或一个全局同步 Worker，一个用户的大输出会成为其他用户的队头阻塞。

Worker thread 时序探针连续九轮，以 SQLite 探针的毫秒量级模拟每事务服务时间：

| 场景 | B 用户终态完成时间 |
| --- | ---: |
| A 先排 64 个 64 KiB 事务，全局 FIFO | 202.196-205.922 ms |
| 同一 backlog，账户 round-robin | 4.928-5.860 ms |
| A 已进入不可抢占 50 ms 事务，单公平 Worker | 52.023-52.756 ms |
| 同一慢事务，每 UserRuntime 独立 executor | 1.532-2.116 ms |

round-robin 能消除已有 backlog 饥饿，却无法抢占正在执行的同步事务。因此多用户正式
方案不能只做共享 Worker 公平队列：每个活跃 UserRuntime 应懒加载独立存储 sidecar 和
数据库，managed 用户 sidecar 以用户 UID/GID 运行，legacy 才允许 Worker thread。
每用户 ingress 使用 48 条/3 MiB 高水位、32 条/2 MiB 低水位、64 条/4 MiB 硬上限；
暂停只作用于该用户 Bridge stdout。

探针还验证 A 在 48 个 64 KiB 事件时暂停、排空 16 个后恢复，此时 B 的终态仍被接受，
已接受事件丢弃数为 0。同用户内仍严格保持源顺序，不能为了终态优先越过早期 delta；
单条大事件通过 64 KiB barrier 边界缩短不可抢占时间。该时序使用模拟存储耗时，不是
真实 sidecar P95，候选实现必须加入 SQLite、IPC、UID/GID 和磁盘竞争复测。

为避免把上述模拟直接当成进程隔离证据，又加入了 root 限定、完全离线的真实 sidecar
探针。它把两个子进程分别降权到 `daemon` UID/GID 1/1 和 `nobody`
65534/65534，每个进程只持有自己的 `0700` stateDirectory 和 `0600` SQLite/WAL/SHM；
A 访问 B 的数据库路径在打开前即被拒绝。

五次独立执行共 15 轮真实 SQLite/WAL 竞争，B 的空载终态为 1.370-5.826 ms；A 每轮
排入 64 个事务、每事务 16 × 4 KiB 时，B 为 2.378-8.649 ms，并在 A 只完成
3-6 个事务时返回。A 被 `SIGSTOP` 时 B 仍在 3.270-4.697 ms 提交，A 被
`SIGKILL` 后 B 为 2.157-4.259 ms；A 重启后恢复 cursor 3,072，
`integrity_check=ok`。

后四次带计数执行的每 192 个 A IPC 请求中，`child.send()` 有 177-178 次返回 false，直接
证明独立 sidecar 不能替代父进程水位和 send callback。该结果把 C18 从纯调度模型推进
到真实 IPC、凭据、WAL 和进程故障边界，但事件表仍是简化形状，每轮输入仅 4 MiB，
尚未覆盖生产加密台账组合事务、Bridge stdout 水位、饱和磁盘、cgroup 或候选 P95。

网关在活动槽切换时保持浏览器 WebSocket，但旧后端已经接收的 RPC 回复可能随上游连接
一起消失。网关只发送 `bridge/status`，不重放业务 RPC。浏览器因此只能标记
`deliveryUnknown`；对 `turn/start` 盲目重试会有双执行风险。

### 7.2 提交队列、刷新和交付未知

当前“重连后发送”不是一个真正的队列。`queuedPromptAfterReconnect` 只保存布尔值，
没有冻结用户点击时的文字、附件、Skill、App、线程、模型和供应商。恢复后
`flushQueuedPromptAfterReconnect()` 再次读取当时的输入框和当前设置并调用
`sendPrompt()`。因此用户在断线期间继续编辑、删附件、切设置或切活动任务，会改变
已经点击发送的内容；若活动 Turn 在重连期间变化，原本的新 Turn 还可能变成 Steer。

随机端口 Chromium 与可控断线代理已连续三次验证这不是只存在于源码的风险：

| 场景 | 断线点击后的浏览器 RPC | 重连后实际请求 |
| --- | ---: | --- |
| 点击时有正文和 1 个附件，随后改正文并移除附件 | 0 | `turn/start` 使用修改后的正文，附件数为 0 |
| 在工程 A 的既有线程点击，随后切到工程 B | 0 | 在工程 B 先 `thread/start`，再向新线程 `turn/start` |
| 只填写正文和附件，未点击发送即 reload | 0 | 不自动发送，但新 document 的正文和附件均为空 |

这同时闭合 M19 和 M21 的当前失败复现。第一、二行证明等待重连的只是发送意图布尔值，
不是点击时 payload/destination 快照；第三行证明普通草稿也没有本地持久层。探针只在
内存中把测试输入分类为 original/edited，输出不含正文、附件内容或路径。

Turn 和 Steer 请求在当前页面内会保留完整参数及稳定 `clientUserMessageId`，同一后端
进程内的内存去重能覆盖部分重试。但页面刷新后：

- `pendingTurnRequest`、`pendingSteerRequest` 和 `queuedPromptAfterReconnect` 全部丢失。
- 线程 session cache 明确把 `pendingUserMessage` 规范化为 `null`。
- 未发送草稿和附件选择也不持久化。
- 服务端没有提交台账，无法告诉新页面某次 RPC 是未发送、已接受还是仍在执行。

新建对话还是两阶段操作：先 `thread/start`，再 `turn/start`。若第一步已成功但结果
丢失，后端进程内 `ThreadStartDeduplicator` 可返回同一结果；后端重启后该映射消失，
空线程又没有用户 `clientId` 可供历史查询。当前页面会拒绝跨 Epoch 自动重试，但会
遗留无法关联的空线程；刷新页面还会同时丢失原提示。

乐观用户消息另有一个误匹配：在 `turn/start` 结果返回前，pending 尚未绑定 Turn。
如果历史用户 Item 没有 `clientId`，`matchesPendingUserMessage()` 会退化为文本相等，
并允许它匹配任意旧 Turn。同 Epoch 断线和序号推进探针已连续三次复现完整时间线：

| 时点 | pending Store | pending DOM | pending RPC | App Server 新请求 |
| --- | ---: | ---: | ---: | ---: |
| 首次请求被代理截住并断线 | 1 | 1 | 1 | 0 |
| 无关线程推进序号，重连执行 `refreshRecentTurns()` | 0 | 0 | 1 | 0 |
| 原请求重试真正放行、权威用户 Item 到达 | 0 | 0 | 0 | 1 |

测试线程的旧 legacy Item 与新提交文字相同但没有 `clientId`。校准遍历旧 Turn 时，
`settlePendingUserMessage()` 在 App Server 尚未执行新请求前就清掉 pending；因此首个
错误层是浏览器 Store 的 refresh settlement，DOM 只是随后忠实移除节点。权威 Item
最终到达会让消息重新出现，所以用户看到的是“发送后消失、稍后又回来”，并可能误以为
需要再次发送。文本相等不能作为提交裁决或自动删除依据。

写后断线现已由随机端口 Chromium 故障代理连续两次稳定复现。代理让首次
`turn/start` 完整到达假 App Server，只丢弃对应 `rpc/result`，随后终止浏览器连接；
整个录制只保留 ID、Epoch、方法、次数和状态：

| 场景 | 浏览器 `turn/start` | App Server `turn/start` | 返回 Turn | 当前安全来源 |
| --- | ---: | ---: | --- | --- |
| 同 Epoch | 2 次，同一 `clientUserMessageId` | 1 | 两次均为 `boot1_1` | 进程内 Promise/TTL 缓存 |
| 跨 Epoch，历史可见 | 2 次，同一 ID | 1 | 两次均为 `boot1_1` | 新进程 `thread/read(includeTurns:true)` 全历史扫描 |
| 跨 Epoch，历史尚不可见 | 2 次，同一 ID | 2 | `boot1_1`、`boot2_1` | 无 |
| 已接受后替换成普通 RPC error，再换 Epoch | 2 次，人工重发使用新 ID | 2 | `boot1_1`、`boot2_1` | pending 被清除，无裁决 |
| 结果丢失后、自动重投前 reload | 1 | 1 | 第二次回执不存在 | pending 和冻结输入一起丢失 |

这证明浏览器并未因收到过 `turn/started` 而裁决 pending；连接恢复后仍自动重投原参数。
现有 `TurnStartDeduplicator` 也不是持久幂等边界：后端重启会清空缓存，而
`clientUserMessageId` 只有在上游历史已经可见时才能阻止第二次执行。最后一个场景中，
相同提交产生两个不同 Turn，正是 `accepted` 与持久历史可见之间的窗口。网关在上游
不可用时返回的普通 `rpc/error` 也不携带 `accepted|unknown`，无法缩小这个窗口。
第四个场景进一步把首次成功结果替换成与网关相同类别的普通 `rpc/error`：浏览器将其
当作明确失败，清空 pending 并恢复输入；换 Epoch 后历史不可见，页面允许再次发送，
新 `clientUserMessageId` 又创建一个 Turn。普通错误因此会把未知交付误导成可安全重发。

第五个场景在首次结果丢失后立即 reload，同一后端和 Epoch 保持运行。新 document 没有
自动重投，所以 App Server 仍只执行一次；但 pending 提交和原冻结输入都没有恢复，
`promptInput` 为空。历史快照后来是否能看见 Turn 不能弥补这个缺口：页面已经失去
`sent|unknown|accepted` 状态、原始 outbox 和用户是否仍在等待的事实。

这些结果闭合 M12、M20、M24 的当前失败复现，但没有让未来提交台账“通过”：只有持久
`sent/unknown/accepted` 台账才能在跨 document、跨进程边界保留事实。

为验证该台账不是无法落地的抽象，新增
`probe-submission-ledger-storage.mjs`。它在临时 SQLite 3.51.3 WAL/
`synchronous=FULL` 中使用 `(account_id, submission_id)` 唯一键、严格状态/transition
表、AES-256-GCM outbox 和 HMAC-SHA-256 摘要，完整覆盖
`prepared -> sent -> unknown -> accepted -> terminal`。同 ID 同冻结载荷返回既有记录，
不同载荷稳定拒绝；密钥缺失或密文损坏保留 blocked `unknown`，恢复密钥也不会自动重放。

12 个真实子进程分别在 prepare、sent、unknown、accepted 和 24 小时清理的 state、
outbox purge、commit 后被 `SIGKILL`。commit 前主状态、transition history 和密文清理
全部回滚；commit 后重试只返回既有 transition。到期 `prepared` 安全转为 `cancelled`，
`sent|unknown` 只转为 `unresolved-abandoned`，没有伪装成 rejected/cancelled。256 条
2 KiB outbox、768 个事务的最近三次开发机基线中，prepare P95 为 2.208-2.356 ms，
迁移 P95 为 1.827-1.872 ms；数据库/WAL/SHM 均为 `0600`，明文哨兵未落盘。

这仍是预实现存储证据：它不接当前 `TurnStartDeduplicator`、App Server 或生产 sidecar，
也不能让上游获得本来不存在的幂等键。M11/M12/M20/M22/M24 继续保持当前失败/待实现，
但台账位置、加密、状态原子性和 24 小时清理语义已经有可执行数据支撑。

同一套随机端口故障代理也已连续两次覆盖 `turn/steer`。首次 Steer 已由假 App Server
执行，但对应 `rpc/result` 被丢弃：

| 场景 | 浏览器 `turn/steer` | App Server `turn/steer` | 当前结果 |
| --- | ---: | ---: | --- |
| 同 Epoch | 2 次，同一 `clientUserMessageId` | 1 | 进程内 `TurnStartDeduplicator` 返回原结果 |
| 跨 Epoch，Steer 用户 Item 已在历史可见 | 2 次，同一 ID | 1 | 新进程按历史 `clientId` 找回原 Turn |
| 跨 Epoch，历史尚不可见 | 2 次，同一 ID | 1 | 新进程任务状态默认为 idle，重试在上游调用前收到普通 409；内容被恢复成普通输入 |
| 上一场景随后人工发送 | 新增 1 次 `turn/start`，使用新 ID | Steer 不再重试 | Steer 的语义被改变为新 Turn |
| 结果丢失后、自动重投前 reload | 1 | 1 | 新 document 不重投，也不恢复 pending Steer 或冻结输入 |

因此 Steer 没有出现 M12 那种上游双执行，只是当前失败路径碰巧在 App Server 前被
`TaskStatusTracker` 拒绝；这不构成持久交付保证。历史可见性和进程内任务状态决定同一
提交会被找回、被拒绝还是在刷新时无声丢失。普通 409 还会把“向当前 Turn 追加指令”
变成“可以直接发送的新 Turn”，属于提交类型和因果关系丢失。Steer 必须与 Start 一样
进入持久提交台账；`unknown` 不得自动降级成普通输入。

新线程的第一阶段另由独立 Chromium 探针连续两次验证：

| 场景 | 浏览器 `thread/start` | App Server `thread/start` | 线程结果 | 后续 |
| --- | ---: | ---: | --- | --- |
| 同 Epoch 丢结果 | 2 次，同一 `_wflClientThreadRequestId` | 1 | 两次均为 `thread_*_boot1_1` | 自动进入该线程的首个 `turn/start` |
| 跨 Epoch 丢结果后人工重发 | 自动重试前 1 次；人工重发后共 2 次、不同 ID | 2 | `thread_*_boot1_1`、`thread_*_boot2_1` | 原空线程可见；输入恢复后新线程启动首个 Turn |

`_wflClientThreadRequestId` 在 WFL 服务端调用 App Server 前被剥离，所以上游线程没有该
关联键。同 Epoch 的 one-call 只来自 `ThreadStartDeduplicator` 的进程内 Promise/TTL
缓存。跨 Epoch 时 `rpcWithSameRuntimeRetry()` 正确停止自动重试，但页面没有持久
`unknown` 记录：原空线程只以普通列表项出现，输入恢复成可发送草稿，二者没有提交关联。
人工再次发送生成新 ID 和第二个线程。因此“不自动重试”只避免系统自动重复，不能阻止
UI 诱导的人工重复，也不能恢复首条提示的冻结 outbox。

### 7.3 多标签页和写租约

后端对每个 WebSocket 保存一个累计 `subscribedThreadIds`。`client/state` 每次只 add
当前线程，不 replace 旧观察集合；正常成功切换后客户端会显式 unsubscribe 前一线程，
但被 `selectionVersion` 淘汰的异步选择在返回前直接退出，因此不会释放它已经加载的
线程。所有 Codex 通知又广播给账号的所有 WebSocket，不按观察线程过滤，所以标签页
越多，序列化、网络和无关事件处理成本越高。

双隔离浏览器探针与代码审计一致：非活动客户端收到另一线程的 7 条通知，最终 DOM
保持隔离。该结果证明浏览器过滤避免了直接串屏，但不能消除后端序列化、网络传输和
客户端 JSON 解析成本；大 Item 仍会被无意义地送到所有同账户窗口。

`THREAD_LEASE_OWNER_ID` 保存在 `sessionStorage`。真实 Chromium 探针证明
`window.open()` 创建的新标签会复制父标签当时的值，之后两边才独立：

```json
{"copiedIntoNewTab":"window-parent","parentAfterChildMutation":"window-parent"}
```

所以这个 ID 不是可靠的页面实例 ID。更严重的是，`ThreadWriteLeaseStore.acquire()`
对同 owner 的可重入获取返回同一个 token。长 Turn 持有租约时，同 owner 的
`thread/name/set`、`thread/settings/update`、Goal、归档等短写会取得相同 token；
短写 `finally` 再释放它，实际把长 Turn 的租约目录一并删除。隔离探针结果为：

```json
{"sameToken":true,"shortReleaseSucceeded":true,"longLeaseStillPresent":false}
```

运行时内存仍暂时认为长租约存在，下一次续租才发现它消失。在此窗口中，另一个进程或
表面可以重新取得该线程写租约。这个问题没有直接证明已造成当前重复消息，但它破坏了
“一个线程只有一个写 owner”的基础不变量，必须在会话架构实现前单独修复。

### 7.4 Provider、Goal 和无限重试

四个独立测试文件的 24 项测试全部通过，证明当前存储和控制面具备以下受控行为：

- fast/balanced/patient 重试频率使用有上限的阶梯和 ±10% 抖动，不是忙循环。
- after-Turn 手动暂停不会中断当前 Turn；immediate 模式才请求中断。
- 手动暂停会取消连接自动恢复，供应商 before/after 审计和暂停状态会落盘。
- usage/token budget 等终态不会被 Goal 恢复存储改成连接重试。
- 自动供应商切换默认关闭，至少需要两个授权目标，并要求显式确认身份和计费变化。
- 后台任务的无限重试有界且可以关闭。

另 9 项官方账号隔离测试证明：失效账号的邮箱、套餐、周额度快照和代理资料在存储重开
后保留，凭据保持加密，无效账号不能被重新激活；这些官方额度状态不借用管理员分配的
API Provider 存储。所以下述 G07 失败限定在 Turn 错误分类，不否定账号资料保留。

新增随机回环端口探针又走通了真实 WFL HTTP/WebSocket 控制面：after-Turn 暂停请求后，
受控 1.2 秒 Turn 继续运行约 1.19 秒并自然完成；空闲切换第二供应商后 before/after
审计保留，恢复后的新 Turn 使用第二供应商环境且只启动一次；主服务重启且没有浏览器
时，原 `manualPauseRequestedAt` 和原生 `paused` Goal 都得到恢复。探针只使用临时
HOME/state、假 App Server 和两个本地模型端点，没有生产请求，也没有访问 `4321`。

但错误分类存在确定性缺陷。`TurnRetryLimiter` 不区分错误类别，第 5 次 timeout、
429/quota 和 401/invalid API key 都调用 `pauseGoalForConnectivity()`。三组服务器探针
全部得到：

```json
{"status":"paused","resumeWhenAvailable":true,"suspendedReason":"provider-unavailable"}
```

因此开启无限重试时，额度耗尽和失效凭据也会按连接故障退避重试；自动故障切换的
`providerFailoverErrorCode()` 虽能区分 `quota`/`credentials`，却只用于目标检查和
切换失败，不覆盖 Turn 重试入口。G02、G07 当前失败；G01/G03 仅部分成立。G06 仍因
没有持久提交台账而不可裁决，不能在交付未知时跨供应商自动重放。

官方 App Server 手册与固定提交 `e363b08c` 都给出了结构化分类，不需要先依赖错误
文案：`error.codexErrorInfo` 可为 `"usageLimitExceeded"`、`"unauthorized"`，或带
`httpStatusCode` 的 `httpConnectionFailed`、`responseStreamConnectionFailed`、
`responseStreamDisconnected`、`responseTooManyFailedAttempts` 对象。源码中的
`willRetry=true` 只由中间 `StreamError` 产生，表示 Codex 正在重试；它不是 WFL
自动恢复、无限重试或跨供应商切换的授权。探针携带这些 0.146 结构化字段后，当前
WFL 仍把三类错误统一写成 `provider-unavailable`，所以根因是分类入口缺失，不是
测试文案碰巧相似。

## 8. 根因排序

### P0

1. 无 ACK、持久事件日志和断线重放，导致漏事件后连接仍显示正常。
2. legacy 实时与恢复 Item ID 不稳定，当前 Reducer 的身份模型错误。
3. `turn/start`/`turn/steer` 没有服务端持久提交台账，RPC 交付未知无法安全裁决。
4. 可重入短写会释放正在运行 Turn 的长写租约，跨窗口/进程写隔离可失效。

### P1

5. 浏览器离线处理发送非法 1001 关闭码，抛错后留下旧连接和旧订阅；恢复时可出现
   两条同时 OPEN 的 WebSocket。
6. `TurnStartDeduplicator` 每次提交全量读取超大历史。
7. 每个活动标签在 Turn 完成后再次扫描 recent full 历史。
8. 快速切换的过期结果没有释放虚拟订阅。
9. 离线队列不冻结载荷；刷新会丢失 pending、Steer、草稿和交付未知状态。
10. 未绑定 pending 可用文本误匹配旧 Turn，合法重复输入可能被错误清除。
11. 网关、后端 WebSocket 和 App Server stdin 缺少有界背压。
12. 普通重连、事件校准和完整 bootstrap 的职责混合。
13. 发送按钮由本地 `activeTurnId` 驱动，与服务端任务状态和提交状态分裂。
14. `sendPrompt()` 在需恢复线程上先 await、后设置 guard，同 tick 手势可发出两个
    不同提交 ID。
15. 输入框没有独立 composition 状态，`keyCode=229` 且 `isComposing=false` 时会误提交。
16. Turn 重试不区分连接、额度和凭据错误，429/401 可被错误加入无限连接恢复。

### P2

17. 折叠内容仍被同步解析和挂载，DOM 没有预算。
18. session cache 在主线程反复同步序列化、哈希和写 `sessionStorage`。
19. 连接日志缺少关联 ID、关闭码、寿命和队列指标。
20. 静态源码正则测试较多，未覆盖真实 ID 分叉、丢帧与乱序组合。

## 9. 官方契约核对

当前 [Codex App Server 官方手册](https://learn.chatgpt.com/docs/app-server.md) 与
0.146 源码和实测在以下关键点一致：

- `turn/started` 的 items 为空，客户端必须消费 `item/*`。
- `item/started` 的 ID 与 delta 的 `itemId` 对应，`item/completed` 是该 Item 的
  权威终态。
- `thread/turns/list` 是实验分页接口，`itemsView` 可选 `notLoaded|summary|full`。
- `thread/items/list` 也是实验接口，只有活动线程存储支持 Item 分页时可用，否则官方
  明确返回 unsupported-method。
- `thread/unsubscribe` 只移除当前 App Server 连接的订阅；最后订阅退出后，官方仍有
  30 分钟无订阅且无活动宽限，再卸载并发送 `thread/closed`。
- App Server WebSocket transport 目前仍标记为 experimental and unsupported。官方
  虽提供有界队列和 overloaded 错误，但不能据此直接替换 WFL 当前生产传输。

手册没有承诺 legacy 历史投影的 Item ID 必须与实时 ID 永久一致，也没有提供 WFL
所需的浏览器 ACK、事件重放或 `turn/start` 幂等语义。这些必须由 WFL 自己实现。

### 9.1 来源分层和可证明范围

本报告按以下优先级使用资料，不能把低一层的材料提升为协议契约：

| 层级 | 来源 | 本报告使用方式 |
| --- | --- | --- |
| 1 | [Codex App Server 官方手册](https://learn.chatgpt.com/docs/app-server.md) | 协议、成熟度和生命周期的规范依据 |
| 2 | [`rust-v0.146.0`](https://github.com/openai/codex/tree/rust-v0.146.0) 标签源码 | 解释本次固定版本的实际转换、订阅和队列实现 |
| 3 | 本机真实 0.146 协议录制、生产脱敏日志和确定性探针 | 证明 WFL 当前版本实际出现的行为 |
| 4 | openai/codex GitHub issue | 只支持风险方向和测试场景，不代替协议或本机证据 |

0.146 源码映射：

| 结论 | 标签源码 |
| --- | --- |
| `EventMsg` 被转换为 v2 `turn/*`、`item/*` 通知 | [`bespoke_event_handling.rs`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/app-server/src/bespoke_event_handling.rs) |
| `clientUserMessageId` 传给核心并回显为用户 Item 的 `clientId` | [`turn_processor.rs`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/app-server/src/request_processors/turn_processor.rs) 和 [App Server README](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/app-server/README.md) |
| 最后订阅者退出后是 30 分钟“无订阅且无活动”宽限 | [`thread_lifecycle.rs`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/app-server/src/request_processors/thread_lifecycle.rs) |
| `thread/turns/list`、`thread/items/list` 是实验接口，后者可返回 unsupported | [`thread_processor.rs`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/app-server/src/request_processors/thread_processor.rs) 和 [`common.rs`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/app-server-protocol/src/protocol/common.rs) |
| 官方 transport 内部使用有界 channel | [`transport/mod.rs`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/app-server-transport/src/transport/mod.rs) 和 [`lib.rs`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/app-server/src/lib.rs) |
| legacy 读取会同时解释 `event_msg` 和 `response_item` | [`thread_processor.rs`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/app-server/src/request_processors/thread_processor.rs)；具体 `msg_* -> item-*` 分叉由本报告真实录制证明 |

四个 issue 的使用边界：

| Issue | 可支持的判断 | 不能证明的内容 |
| --- | --- | --- |
| [#33558](https://github.com/openai/codex/issues/33558) | 单次 UI 手势可能产生两个独立 `thread/start`/`turn/start`；同步 guard 与协议幂等都需要覆盖 | 这是用户报告，不证明 WFL 已发生同一种前端双回调 |
| [#25268](https://github.com/openai/codex/issues/25268) | OpenAI 贡献者明确说明 Queue 当前由客户端处理且不会持久化；支持 durable outbox/queue | 不定义 WFL 应采用的数据库、加密或保留期限 |
| [#29590](https://github.com/openai/codex/issues/29590) | eager resume/历史加载会造成卡顿；支持轻量读取和渐进历史 | 不证明 WFL 的 5-14 秒延迟只由同一个官方客户端缺陷造成 |
| [#27592](https://github.com/openai/codex/issues/27592) | 共享队列等待会产生队头阻塞，消息数预算不能替代字节预算 | 讨论的是 remote-control 路径，不是 WFL 网关的直接证据 |

因此，P0 根因只建立在本机代码、生产记录和确定性复现上；issue 只用于防止测试矩阵遗漏
已在相邻官方客户端出现的失败模式。

### 9.2 当前手册与 0.146 版本锁定

官方手册会持续更新，不能把 2026-07-31 可见的新说明反向当作固定 `0.146.0` 的全部
运行契约。当前手册已经描述 stdio、Unix socket、experimental WebSocket、WebSocket
认证和 ingress overload；其中 WebSocket 仍明确是 experimental and unsupported。
本报告继续使用手册判断成熟度，但用版本化生成物判断 0.146 的协议形状。

`probe-app-server-version-contract.mjs` 对本机 `codex-cli 0.146.0` 分别生成 stable 和
`--experimental` JSON Schema，未启动 App Server、未读取对话状态。结果为：

| 项目 | 0.146 版本化证据 |
| --- | --- |
| 请求方法 | stable 90 个；experimental 127 个 |
| 服务端通知 | stable/experimental 均为 70 个 |
| 历史分页 | `thread/turns/list`、`thread/items/list` 只在 experimental schema |
| Item/Turn 顺序面 | stable 包含 `item/started`、agent delta、`item/completed`、`turn/started`、`turn/completed` |
| 提交身份 | `turn/start.clientUserMessageId` 为 `string\|null` |
| 上游幂等 | `thread/start` 和 `turn/start` 都没有 `clientSubmissionId` 或 `idempotencyKey` |
| WFL 恢复 | 没有 `eventLogGeneration`、`eventCursor`、ACK 或 range replay 请求 |
| transport help | stdio、Unix socket、WebSocket、off 和两类 WebSocket auth 均存在 |

稳定/实验 ClientRequest SHA-256 分别为
`c1a834d8f1b96a3a51ce1a254a4e16bc679e31227e5200f429e4152afeb4b923` 和
`41188ef1f3507f7a6dfc238a935dabd39eaa71c954c27fb27e6c55c6d9dd8176`；
ServerNotification 分别为
`b0168c86f69029a51bb30adf78307d563cca96237cc76d2244aea6a1f5a7c7d0` 和
`89608a4d65d713a85940f8eefb9bf2e87a94cbf2abac3ed069fad7cb6f078872`。

这进一步收紧了方案边界：`clientUserMessageId` 可以作为 source identity，但 schema
没有承诺它是 exactly-once 幂等键；新版手册所述 App Server transport 背压也不提供
浏览器到 WFL 的 durable ACK、提交台账或 canonical Store。schema 不编码 transport
成熟度、队列容量或运行时交付语义，因此这些结论仍分别依赖当前官方手册、0.146 tag
源码和真实故障录制，不能互相替代。

## 10. 渲染、折叠和发送状态审计

Codex 主站已经有稳定 transcript key 和节点 reconciliation，流式助手文本也优先只
更新目标节点；这比每个 delta 全量清空 DOM 好。但剩余成本仍足以解释长线程卡顿：

- `renderMessages()` 每次为窗口内所有描述符执行 `JSON.stringify` 和 FNV 哈希。
  Item 内的大型 Diff/工具输出即使折叠也会被完整序列化和扫描。
- 文件修改的外层 `<details>` 即使关闭，`renderFileChangeItem()` 仍立即解析每个 Diff
  并创建全部行节点；20,000 行受控 Diff 约 255 ms、约 80,019 个 DOM 节点。
- 命令和推理关闭时虽可不填正文，但其完整 source 仍参与签名；任何全局 render 都要
  重新遍历这些内容。
- 实时 `msg_*` 变成快照 `item-*` 后，transcript key 和折叠 key 都变化，节点会替换，
  折叠和滚动锚点不能稳定继承。
- thread cache 最多保留 80 Turn / 3 MiB，但持久化在主线程同步执行多次
  `JSON.stringify`、`TextEncoder` 和 `sessionStorage.setItem`；超限候选即使最终被
  放弃，也已经支付序列化成本。
- 助手正文不是通用 Markdown 渲染。流式阶段通常直接设置 `textContent`，终态/全量
  render 才重新扫描工程文件引用；若 `flushStreamItemRender()` 找不到目标节点，它会
  退化为 `renderMessages()`。受控探针中，这条退化路径使 320 个引用有时在终态前创建、
  有时在终态后创建，并产生 51%-67% 的 Long Task 窗口占比。

发送按钮只有一个 DOM 写入口 `setTurnBusy()`，但其输入不是单一状态机。
`conversationBusy()` 主要看页面内 `activeTurnId` 和 pending 标志，不把服务端
`taskStatusSnapshot` 作为权威运行状态。`refreshRecentTurns()` 每次根据历史页重新计算
`activeTurnId`；而官方实测 idle 通知早于 `turn/completed`，历史投影也可能延迟。
因此一次早到/旧快照可暂时清空或恢复 `activeTurnId`，让按钮在“普通发送/Steer/禁用”
之间闪动。服务端最终可能拒绝错误的新 Turn，但 UI 已经表现为卡顿和状态不可信。

修复方向不是再加一处 `setTurnBusy()`，而是让按钮成为规范化 Store 中
`transport + sync + submission + turn` 四个单调状态的纯派生值。

### 10.1 按需渲染参考模型

`probe-on-demand-render-reference.mjs` 没有修改或加载主站，而是在隔离 headless
Chromium 中组合验证 ADR §11 的目标结构。夹具固定包含：

- 80 个 Turn，只挂载最近 8 个，早期 72 个用一个高度占位。
- 20,000 行 raw Diff，关闭时只读取预计算的行数、增删和字节统计。
- 2 MiB 命令输出和 512 KiB 推理正文，关闭时只读取 title/bytes。
- live/snapshot 两个 source alias 指向同一 canonical Item。

三次结果一致：

| 指标 | 范围/结果 |
| --- | ---: |
| 初始最近窗口 | 8 Turn / 56 元素节点 / 78 全部节点 |
| 关闭状态正文读取 / Diff 明细节点 | 0 / 0 |
| 初始 render（含两个 animation frame） | 18.3-36.7 ms |
| Worker 解析 20,000 行 Diff | 1.8-2.6 ms |
| 首批展开 | 500 行 / 558 元素节点 / 1,081 全部节点 |
| 主线程 10 行 Diff / 8 KiB 文本切片最大值 | 0.5-0.6 ms |
| 继续加载 | 再增加 500 行，raw body 仍只读取 1 次 |
| 100 次流式定向 patch | 0 次 full render；单次最大 0.1-0.2 ms |
| source alias 校准 | 原节点、打开状态和已挂载 500 行均保留 |
| 前插 16 个旧 Turn | 原 anchor 节点保留；三次位移均为 0 px |
| Long Task | 0 |

较粗的第一版曾使用每帧 25 行 Diff，并把 64 KiB 工具预览一次写入：前三次组合切片最大
5.5-6.3 ms，但第四次出现一次超过 8 ms 的断言失败。失败版本没有把两类切片分开记录，
所以不能事后猜测是哪一类。增加分类计时后，10 行 Diff 切片最大约 0.8 ms，而单次
64 KiB 预览曾占 5.7 ms；最终模型因此同时收紧为 10 行 Diff 和 8 KiB 文本切片，再从
零连续运行三次得到上表结果。这个反例说明“平均够快”不能代替每帧硬预算。

收起 Diff 后明细 DOM 回到 0，raw canonical 正文仍保留；重新展开从 Worker 派生缓存
恢复首批 500 行，不重复读取 raw body。2 MiB 工具输出只按需挂载 64 KiB 预览，收起
立即卸载预览；从未展开的 512 KiB 推理正文读取为 0。未读位置继续绑定 canonical
key，不随 source alias 变化。

这把 Goal #42-#44 从纯文字预算推进为可执行预实现语义，但不代表现有 `app.js` 已通过。
模型没有覆盖真实 CSS/Markdown/文件链接、选区、搜索、无障碍、Worker 崩溃与重建、
内存压力、手机硬件或候选版本。生产实现必须把同一断言接到真实 canonical Store 和
DOM，且 Worker/cache 失败只能丢派生投影，不能丢原始内容或触发全窗口刷新。

## 11. Goal 覆盖审计

| 调查组 | 结论 | 证据位置 | 后续状态 |
| --- | --- | --- | --- |
| 基线、工作树、备用边界 | 已证明 | §1 | 保持约束 |
| 生产拓扑和状态权威 | 已证明；关联 schema 已由 9,216 行夹具验证，31 个 recorder hook已锁定到当前四份 source hash | §2-3、ADR §13、阶段 0 规范 §10 | 待接入默认关闭的生产 recorder；hash 变化先重审 |
| 官方事件顺序和 ID | 已证明 | §4、官方手册 | 真实 0.146 录制完成 |
| 漏回复、重复、乱序 | 当前失败已稳定复现；统一五层分类器把双提交、重复通知、快照合并和 DOM render 分开定责；canonical Reducer 以 4,096 种子完成预实现身份/单调/校准验证 | §5、§11.1、故障矩阵 M01-M18/M23/M25 | 待影子/生产 Reducer 与 ACK 重放接入，参考模型不代表 UI 已修复 |
| 网关、Nginx、心跳 | 当前主槽/冻结/重启已证明且 offline 双连接失败已复现；三次 reload/new-document 对照精确定位恢复 toast；隔离真实浏览器目标原型验证合法 close、single-flight、generation guard 和 1012 恢复 | §5 | 待生产 transport/replay 接入；手机锁屏和代理待现场遥测 |
| Cloudflare 对照 | 当前生产不适用（`N/A`） | §2 | 将来启用时建立独立对照 Goal；当前不运行合成 Cloudflare 测试 |
| Queue、Steer、刷新 | 已完成静态和受控输入审计；SQLite/AES-GCM 台账状态机、12 个崩溃点和 24 小时清理已做预实现验证 | §7.2、M11-M24 | 待生产台账/outbox 接入，预实现探针不代表当前失败已修复 |
| 多项目、多标签、订阅 | 2/4 项目集成、3 工程 Chromium 和 5 线程切换已测 | §5、§7.3、S01-S14 | 多设备 ACK 待实现期 |
| 写租约隔离 | 已稳定复现失败 | §7.3、S11-S12 | 必须先修 |
| 长线程和渲染 | 当前 `app.js` 三次 2 MiB 输出/20,000 行 Diff 为 9.49-10.28 s、最长 Long Task 2.16-2.39 s且关闭后仍保留全部 Diff 节点；隔离按需原型验证零关闭正文、500 行分批、稳定节点/锚点 | §6、§10、R01-R09 | 待生产 Worker、canonical Store/DOM 接入及手机/候选验收 |
| 旧历史摘要和分页 | 55.27 MB 合成索引四次低于 1.29 s；残行、重建、权限、分页和两个崩溃边界已验证 | §6.1、ADR §9 | 待生产 Worker/UserRuntime sidecar、真实 200+ MiB 和格式迁移验收 |
| 背压、事件日志和 ACK | WS/stdin 8 MiB、SQLite WAL/AES-GCM、五个存储崩溃点、双 UID/GID sidecar、Chromium strict IndexedDB/renderer crash、真实浏览器 replay/fence 目标链路及 10,000 种子组合模型已测 | §5、§6.2-6.3、§7、C12-C18 | 待实现有界队列、生产 sidecar/浏览器 Worker 与移动存储压力；参考模型不替代 C14-C18 候选验收 |
| Provider、Goal、无限重试 | G04/G05/G08 已通过受控探针；G02/G07 已稳定复现错误分类 | §7.4、故障矩阵 G01-G08 | 修复分类；G01/G03/G06 随提交台账验收 |
| 迁移、兼容、灰度、回滚 | 七阶段/21 个崩溃点、owner→admin→account、120 种回滚顺序和 4 个发布失败点已完成纯状态机验证 | ADR §14-17、决策记分卡 §5 | 待真实数据库/旧 bundle/候选服务升级降级演练和所有者接受 |
| 普通服务器测试边界 | 已定义 | §1、故障矩阵 §10 | 禁止正式安装跑冒烟/压力 |

剩余“待真机”和“待实现”不是用猜测补成通过：手机锁屏需要真实设备遥测；ACK、事件
日志、提交台账、队列和新 Reducer 的离线协议模型已经运行 10,000 个固定种子，但只有
实现后才能执行覆盖生产组件的 10,000 次候选验收。两者不能混记。它们不改变本报告已
证明的根因，也不能作为继续局部补丁的理由。

真机缺口已经转化为可执行但尚未运行的
[手机/第二设备现场协议](conversation-mobile-field-protocol.zh-CN.md)：11 个场景各
3 次，覆盖前台、后台、2/10 分钟锁屏、Wi-Fi/蜂窝切换、飞行模式、活动 Turn 刷新、
浏览器进程退出和两台跨网络设备共同观察/单端退出/一端锁屏。配套 bundle validator
使用 33-run/351-row synthetic fixture 验证私有文件、checksum、时序、所需层、设备/
网络摘要、稳定 ID HMAC 和禁用内容，并稳定拒绝 10 类伪造或不完整证据。fixture 明确
输出 `fieldEvidenceAccepted=false`；user-agent/bundle 也不能密码学证明物理硬件，
必须加 owner attestation。由于真实设备尚未执行，C02/C03/S10 和 Goal #16/#27/#45
继续保持 `P/X`，没有被设计文档错误升级。

2026-07-31 结案核验再次确认：域名的 HTTPS 入口为 Nginx，站点配置直接代理到回环
主站网关，未发现 Cloudflare Tunnel 进程或配置。Goal #15 因而标为当前拓扑 `N/A`；
这只证明该层不在现行链路中，不代表未来启用 Cloudflare 后已经通过绕过对照。

56 项逐条证据等级、对应章节和剩余门槛见
[会话调查 Goal 可追溯表](conversation-investigation-traceability-0.39.48.zh-CN.md)。

### 11.1 架构反例审计

对 ADR 再按断线和崩溃边界反推后，补充了十三个不能省略的不变量：

1. RPC 一旦进入 `sent`，`unknown` 不能改写为“已取消/已拒绝”；用户放弃等待也不能
   暗示上游没有执行。
2. `thread/start` 没有上游幂等键。响应在后端崩溃前丢失时，跨进程 exactly-once
   当前不可实现；只能保留加密提示、停止自动再建并显式暴露 `unknown`。
3. 浏览器 ACK 必须晚于规范化 checkpoint 和 durable cursor 的同一 IndexedDB 事务；
   只在内存应用后 ACK 会在页面崩溃时永久跳过事件。
4. 权威快照读取期间仍有实时事件，必须用 `baseCursor/fenceCursor` 缓冲并幂等重放；
   不能在 8 秒读取结束后直接覆盖当前 Store；校准期间 log generation/Epoch 变化必须
   丢弃结果。
5. 诊断摘要使用每次采集独立密钥的 HMAC-SHA-256；裸 SHA-256 会让短提示受到枚举和
   跨采集关联风险。
6. 浏览器 close intent、实际 close event 和重连调度必须分离；不得发送保留关闭码，
   也不得让关闭调用异常跳过重连或留下仍可接收事件的旧 generation。
7. App Server 的 `runtimeEpoch/upstreamEventSequence` 会在重启后变化，不能充当持久
   ACK 游标；WFL 必须另有跨上游 Epoch 的 `eventLogGeneration/eventCursor`。
8. 按线程过滤 payload 时，账户 cursor 不能静默跳过未观察事件。每个 cursor 必须向
   window 交付 full 或 skip envelope，新观察线程先建立 barrier 并校准。
9. `windowInstanceId` 属于一个 document，reload 后不得复用。IndexedDB checkpoint 只能
   作为新 window 的缓存种子，不能继承旧 ACK lease 或页面权限；正文缓存必须按账户
   限额、过期并在登出/撤销时清理。
10. canonical 日志、source 映射和任务/提交状态必须在同一事务提交后广播；事件 payload
    含正文时必须按账户加密，密钥缺失不能降级明文。
11. 单个不可压缩事件超过日志预算时必须写 `calibrationRequired` barrier 并走带栅栏
    权威校准，不能截断后伪装完整，也不能静默丢弃。
12. 旧 `eventLogGeneration` 的 ACK 必须被服务端拒绝且不能推进 lease；客户端收到拒绝
    后保留旧 Store 只读并 resync，不能把本地 checkpoint 成功误报成服务端已经持久接受。
13. 日志重建后当前 cursor 即使是 0，也不证明日志覆盖 canonical 全历史；没有兼容
    checkpoint 的新 document 必须依据服务端保留起点/`resyncRequired` 权威校准，不能
    从空日志推断空对话。

这些修正已经写入 ADR §4-8、§12-17 和故障矩阵，不改变 P0 排序，但收紧了提交与恢复方案的
可证明边界。

规范化身份也已从文字规则变成
`probe-canonical-reducer-reference-model.mjs`。该纯内存模型让实时 `msg_*`、重放、
JSONL `response_item`、快照 `item_*` 和 full calibration 全部进入一个 `dispatch()`
Reducer。4,096 个固定种子共处理 167,251 个 action；28,758 个随机逻辑 Item 在三种
source 下仍保持 28,758 个 canonical key，阻止 54,542 次 Item 和 81,215 次 Turn
终态回退。

定向反例证明 M05 的 live/snapshot ID 分叉可以在 Store 前归一且保留原折叠 key；
M04 的同文不同提交仍为两条；M23 的 `unknown` optimistic 项不会被不相关 legacy 同文
Item 结算或被 full calibration 删除；候选不唯一时保留 `ambiguousProjection`。整个
模型没有执行一次文本相等身份比较，两次固定种子证据摘要一致。它不执行当前
`thread-state.js`、DOM 或 IndexedDB，所以只闭合 Reducer 设计可执行性，不能声称生产
重复/闪烁已经修复。

为避免这些决定只停留在文字层，新增
`probe-event-log-reference-model.mjs` 作为纯内存、无网络的协议参考模型。默认固定
512 个种子累计覆盖 17,700 条事件、2,893 次上游 Epoch 代际和 1,505 个超预算 barrier；
定向覆盖 C14-C17 的上游序号重置、连续 full/skip、持久 subscription barrier、reload
新 window lease、事务内/commit 后/部分广播崩溃，以及单条不可压缩终态超限。

模型确定了订阅切换的唯一安全顺序：旧观察集合处理到持久 barrier，checkpoint/ACK
落盘，校准新线程到 barrier fence，激活新集合，再投递 fence 后事件。校准期间 log
generation 或 runtime Epoch 改变则废弃结果。该结果只证明 ADR 内部一致，不代表当前
生产代码已经实现或通过 C14-C17。

新增的 `probe-conversation-fault-matrix.mjs` 把原先分散的 drop、duplicate、
reorder、delay、disconnect 和 restart 叠加到同一离线恢复模型。默认 10,000 个固定
种子累计提交 242,587 条事件，触发 26,419 次 cursor 缺口、16,149 个重复/晚到帧、
5,236 次 App Server 重启、762 次事件日志代际重建、2,677 次 reload 和 6,000 个保持
`unknown` 的提交；两次完整输出 SHA-256 一致。

第一版组合运行还实际找出两个设计漏洞：旧 generation 首帧被 drop 时，客户端会在尚未
看见新代际的情况下发送旧 ACK；日志重建后新 document 没有 checkpoint 时，从 cursor
0 重放无法恢复重建前实体。模型加入 `ACK generation rejected -> resync` 和“空 seed
不代表完整历史”后才全部收敛。因此这两条已经提升为 ADR handshake 不变量。该模型仍
没有执行生产 Reducer、数据库、浏览器和队列，不能替代实现后的 10,000 次候选验收。

随后真实 SQLite 存储探针又修正了容量与 batch 假设：64 MiB 必须是优先硬上限，
50,000 条只能在小事件下尽力满足；事务采用 16 条/64 KiB/4 ms 三重上限，单条超过
64 KiB 走校准 barrier。五个 `SIGKILL` 点和密钥缺失均未产生半提交。该探针仍不替代
生产 sidecar/legacy Worker 和多账户调度验收。

浏览器 strict IndexedDB 探针进一步确定 ACK 必须使用 16 事件/32 KiB/16 ms 的增量根，
完整页面后台写入；abort、Worker 终止和 renderer crash 均不得留下半 cursor。由于站点
存储未获 persisted 且物理删除异步，checkpoint 始终是可丢缓存，缺失后必须 resync。

### 11.2 方案比较、性能契约和迁移证据

[会话架构决策记分卡与性能验收契约](conversation-decision-scorecard-0.39.48.zh-CN.md)
将本报告的反例收敛为八项不可用总分抵消的硬门禁。比较结果是：

- 继续局部修 `refreshRecentTurns()`、定时器或文本去重无法满足提交事实、规范身份、
  durable replay、长历史和渐进迁移，排除。
- 当前直接切 App Server experimental WebSocket 只替换一段 transport，不能提供 WFL
  台账、浏览器 ACK、canonical Store、索引或迁移，排除。
- 一次性重写扩大切换故障面，无法给出逐层安全回滚，不建议。
- 建议保留当前受支持的 stdio/HTTP/WebSocket 边界，分阶段替换 WFL 提交、事件、
  Store、索引和渲染层，即记分卡方案 B。

记分卡同时冻结了候选性能的测量契约：ordinary warm/cold、200+ MiB legacy
warm/cold-index、3/5 项目并行和各类重连必须分开报告；同 document/Worker/sidecar
使用单调时钟，跨进程只作分段诊断；warm 至少 100 个计入样本，cold/index 至少 30 个，
同一候选至少 3 批；保留所有超时、崩溃和 outlier，并同时报告 nearest-rank P50/P95/
P99、最大值及失败数。该口径用于解释故障矩阵 §8 的门槛，不能用少量平均值代替。

`probe-conversation-migration-reference.mjs` 又把 ADR §14-16 变成纯状态机。七阶段分别
覆盖 commit 前后 21 个崩溃点：14 个 commit 前全部回滚，7 个 commit 后恢复为恰好一次；
协议按 owner→admin→account 灰度，v1 旧客户端不能 ACK 或推进 retention；五层开关的
120 种回滚顺序、600 次转换均未删除 schema 表/台账、未重放 `unknown`。四个候选发布
失败点均保留旧活动后端和管理员对话权限，JSONL 修改、备用窗口操作以及普通服务器
完整/冒烟/压力测试均为 0。

这些是方案 B 的可执行预实现证据，不是生产实现或正式发布验证。模型没有运行真实
数据库迁移、旧 bundle、服务切流或候选发布；最终架构方向、密钥来源、`unknown`
交互、保留容量和现场设备安排仍须由所有者接受。

## 12. 结论

当前问题不是一个 UI 刷新函数的局部缺陷，而是提交、事件、快照和渲染四个状态面没有
统一身份与恢复协议。继续在 `refreshRecentTurns()`、定时器或文本去重上追加补丁会在
另一种断线时重新产生漏消息、重复消息或状态回退。

后续应按
[ADR-0001](adr/0001-reliable-conversation-state.zh-CN.md)
实现服务端提交台账、有界事件日志、客户端 ACK、规范化 Reducer、JSONL 增量索引和
按需渲染。实现前必须先通过
[故障矩阵](conversation-failure-matrix-0.39.48.zh-CN.md)
中的确定性测试，并由所有者接受
[决策记分卡](conversation-decision-scorecard-0.39.48.zh-CN.md) 中的方案与未决项。
