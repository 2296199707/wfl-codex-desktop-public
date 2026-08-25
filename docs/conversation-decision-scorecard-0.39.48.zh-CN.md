# 会话架构决策记分卡与性能验收契约：0.39.48

> 历史调查决策包，不是当前生产门禁。当前架构以
> [ADR-0002](adr/0002-app-server-conversation-authority.zh-CN.md) 为准。

状态：调查阶段决策包；等待所有者接受<br>
基线：WFL `0.39.48-beta` / Codex `0.146.0`<br>
范围：主站会话；明确排除备用窗口 `1.0 / 4321`

本文回答两个问题：

1. 继续修补当前链路、替换 WFL 状态层、切官方实验 WebSocket 或整体重写，哪个方案能
   同时通过已经证明的失败边界？
2. 实现后如何测量性能，避免用少量成功样本、平均值或普通小线程掩盖长线程失败？

它不接受 ADR，也不授权开始生产实现。最终选择仍由所有者决定。

## 1. 不可妥协的硬门禁

方案不能靠总分抵消以下任一失败：

| 门禁 | 必须满足的能力 | 已有反例/证据 |
| --- | --- | --- |
| G1 提交事实 | `prepared/sent/accepted/unknown/terminal` 持久可裁决；`unknown` 不换 Provider 重放 | 写后断线跨 Epoch且历史不可见会双 Turn；SQLite 台账 12 个崩溃点 |
| G2 规范身份 | live/snapshot/JSONL 必须映射到 canonical ID；同文不同提交保持两条 | 五层分类器区分双提交、重复 delta、`msg_* -> item-*` 合并和 DOM render；legacy 同文会清除新 pending；4,096 种子 Reducer |
| G3 重放恢复 | durable cursor、范围 replay、stale generation 拒绝和 calibration fence | 当前只有账户序号和 full refresh；10,000 种子模型及真实 Chromium replay/fence 原型 |
| G4 长历史 | 查看和提交不扫描 200+ MB；历史可摘要、分页、增量索引 | 真实 `thread/read` 8.21 s；55.27 MB 索引模型低于 1.29 s |
| G5 有界资源 | WebSocket/stdin/storage/DOM 同时有消息和字节预算，多用户 executor 隔离 | 慢端和 stdin 各增加约 20-34 MiB；当前 2 MiB 输出/20,000 行 Diff 三次最长 Long Task 2.16-2.39 s且关闭仍保留 80,047 元素；双 UID/GID sidecar 与按需 DOM 原型 |
| G6 渐进迁移 | 旧客户端可继续使用；各层可独立回滚；台账、日志和 JSONL 不因回滚删除 | 7 阶段迁移模型、21 个崩溃点、120 种回滚顺序 |
| G7 支持边界 | 不依赖 upstream 未承诺的幂等或不受支持 transport | App Server WebSocket 当前仍 experimental/unsupported；0.146 版本化 schema 证明 `thread/start`/`turn/start` 无幂等键，也无 WFL ACK/replay |
| G8 运维安全 | 正式安装只做有界检查；失败保留旧后端和管理员对话；普通更新不操作备用窗口 | 全局约束、既往发布事故、迁移模型 4 个部署失败点 |

## 2. 方案比较

标记：

- `F`：已有证据证明无法通过硬门禁。
- `V/D`：调查阶段已有可执行预实现证据，生产实现和候选验收仍未完成。
- `R`：理论可行，但风险或授权需要所有者决定。

| 方案 | G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 | 结论 |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | --- |
| A. 继续局部修 `refreshRecentTurns()`、定时器和文本去重 | F | F | F | F | F | F | V/D | V/D | 排除；每个局部补丁都会在另一断线/身份时序重新失败 |
| B. 保留现有 stdio + HTTP/WebSocket 网关，分阶段替换 WFL 提交、事件、Store、索引和渲染层 | V/D | V/D | V/D | V/D | V/D | V/D | V/D | V/D | **建议选择**；已覆盖所有硬门禁，且可逐层灰度/回滚 |
| C. 直接切官方 App Server experimental WebSocket | F | F | F | F | R | F | F | R | 排除当前版本；transport 变化不解决 WFL 提交、身份、历史、浏览器 ACK 和迁移 |
| D. 一次性重写 transport、后端和 UI | R | R | R | R | R | F | R | F | 不建议；理论上可重做，但扩大故障面，无法提供安全渐进迁移 |

方案 B 不是保留现有状态架构。保留的只是当前已部署、可支持的 App Server stdio 和
主站网关边界；被替换的是：

- 浏览器直接拼接实时通知和 full snapshot 的 Store。
- 无持久事实的发送/重试路径。
- 无 ACK、无重放的广播。
- 每次提交/恢复全历史扫描。
- 折叠但仍解析/挂载全部正文的渲染。

这属于“状态和恢复层替换”，不是继续局部打补丁。

## 3. 为什么不现在改 transport

官方实验 WebSocket 即使未来稳定，也只能替换 WFL 后端到 App Server 的一段 transport。
它不提供：

- WFL 浏览器 `clientSubmissionId` 台账和加密 outbox。
- 跨 WFL 网关/后端重启的 exactly-once 或 `unknown` 裁决。
- 浏览器 window 级 ACK lease 和 IndexedDB checkpoint。
- legacy JSONL 增量索引。
- live/snapshot/JSONL canonical 投影。
- 多用户 sidecar 隔离和主站 DOM 预算。

因此先完成方案 B 不会阻碍未来 transport 替换。未来若官方标记 supported、提供稳定
版本协商并通过相同矩阵，只需替换 source adapter；提交台账、事件日志、canonical
Reducer、索引和浏览器 ACK 仍然保留。

## 4. 性能指标的测量契约

故障矩阵 §8 的数字是通过门槛。本节定义“怎么测”，防止不同版本用不同口径。

### 4.1 场景分层

每项必须分别报告，不能合并平均：

| 类别 | 数据/状态 |
| --- | --- |
| ordinary-warm | 20 Turn、每 Turn 4 Item；进程和索引已热 |
| ordinary-cold | 同样数据；新浏览器 document、新 Worker，允许已有服务进程 |
| legacy-warm | 受控 200+ MiB JSONL、含至少一个 2.6 MiB 行；索引已建立 |
| legacy-cold-index | 同一夹具删除可重建 sidecar 后首次建立；原 JSONL 只读 |
| concurrent-3 | 三项目同时运行，两个标签观察不同线程 |
| concurrent-5 | 五项目同时运行，一个慢客户端，一个大工具输出 |
| reconnect | 连续 replay、可保留 gap、日志淘汰、generation/Epoch 变化分别测量 |

真实所有者历史只允许在明确授权下做只读、脱敏测量；正式门槛使用可重复的 200+ MiB
synthetic legacy 夹具，不能把私有生产正文复制进测试包。

### 4.2 时钟边界

| 指标 | 起点 | 终点 | 时钟 |
| --- | --- | --- | --- |
| WebSocket 状态可用 | 浏览器构造 socket 前 | replay/calibration 完成且 `syncState=live` | 同 document `performance.now()` |
| 打开线程到首屏 | 已接受的点击 handler 入口 | MutationObserver 看到首个最近 canonical Item | 同 document |
| 提交接受回执 | submit intent 同步冻结后 | 浏览器收到台账 `accepted + turnId` | 同 document；另报服务端 prepare/sent/accepted 分段 |
| 浏览器事件到可见 | WebSocket message handler 入口 | 目标 canonical DOM 节点出现对应 revision | 同 document |
| 事件持久化 | sidecar ingress 接收 | SQLite commit 返回 | 同 sidecar monotonic clock |
| IndexedDB ACK | Worker 收到 batch | checkpoint + cursor 事务完成 | 同 Worker monotonic clock |
| 历史索引 | 打开源 fd | checkpoint commit | 同 Worker/sidecar monotonic clock |

跨进程“App Server 发出到浏览器收到”只作为分层诊断：使用关联 ID、两端
`timeOrigin + performance.now()` 和记录的时钟偏差。没有偏差上限时不得把它作为精确
P95；必须同时报告 App Server→WFL、WFL queue/commit、WebSocket、browser→DOM 四段。

### 4.3 样本和统计

- warm 场景每类先 10 次不计入预热，再至少 100 次计入。
- cold/index 场景至少 30 次；每次使用新的派生目录，不复用 sidecar。
- P95 使用 nearest-rank，不插值；同时报告 P50、P95、P99（样本足够时）、最大值、
  成功数、失败数和原始机器可读摘要。
- 超时、崩溃、错误恢复和校准失败作为失败样本保留，不能从延迟统计中删除。
- 不因 GC、fsync、CPU steal 或“偶发”丢弃 outlier；应同时记录对应 CPU、RSS、
  event-loop lag、queue bytes、fsync 和 DOM/Long Task。
- 同一候选在相同提交、Node/Codex/Chromium、内核、文件系统和硬件上至少重复 3 个批次。
- 绝对预算必须全部通过；若相对上一稳定候选退化超过 10%，即使仍低于绝对上限也要
  解释并由所有者接受。

### 4.4 可靠性与性能不能互相抵消

- 10,000 固定种子故障矩阵出现任何重复、漏终态、错误重放、状态回退或半提交，候选失败。
- P95 达标不能抵消一次 `unknown` 被重放。
- 零重复不能抵消 200+ MiB 线程每次提交重新扫描。
- 普通服务器升级只执行版本/权限/schema/端口兼容和部署后 readiness；上述候选测试只在
  开发/候选服务器运行，绝不随正式安装、同步或用户点击更新执行。

## 5. 迁移和回滚的可执行证据

`probe-conversation-migration-reference.mjs` 将 ADR §14-16 的七阶段迁移做成纯状态机：

- 每阶段覆盖 `before-transaction`、`after-draft-before-commit` 和 `after-commit`。
  14 个 commit 前故障全部回滚，7 个 commit 后故障恢复为恰好提交一次。
- owner → admin → account 顺序灰度。协议 v1 客户端始终使用 legacy broadcast，ACK
  被拒绝，也不能推进日志 retention；只有本 wave 的 v2 客户端进入 event-log。
- renderer、ACK、submission、index、dedup 五个回滚开关穷举 120 种顺序、600 次转换。
  没有删除 schema 表或台账；`unknown` 始终保留 Provider A/执行次数 1，对 Provider B
  的尝试只返回原记录。
- ACK 回滚停止接受新 ACK，但 event log 继续 append；renderer 回滚只切旧只读视图；
  index 回滚只走官方读取；submission 回滚仍先查既有台账。
- 候选启动、兼容失败、切流前失败和切流后失败四个点都恢复旧活动后端，旧后端从未先停，
  管理员对话始终允许。
- JSONL 修改、备用窗口操作以及普通服务器完整/冒烟/压力测试均为 0。

该模型不执行真实数据库迁移、旧浏览器 bundle、发布程序或服务进程，所以不能代替候选
升级/降级演练。它证明的是迁移条款内部一致、回滚次序不应删除可靠性事实。

## 6. 建议决定

建议所有者接受以下方向后，再建立独立实现 Goal：

1. 选择方案 B：保留当前受支持 transport 边界，分阶段替换 WFL 状态/恢复层。
2. 接受 `unknown` 永不自动重放和新线程当前不能承诺跨进程 exactly-once。
3. 接受事件日志、IndexedDB、队列、DOM 和历史索引预算；调整数字时保留测量口径。
4. 接受 owner→admin→account 灰度和一个正式版本的旧只读渲染回退期。
5. 接受所有回滚保留台账/日志/JSONL，普通更新永不操作备用窗口。

仍不能由调查者代替所有者决定的项目：

- outbox/事件正文加密密钥来源和管理员配置边界。
- `unknown` 的用户提示与“作为可能重复的新消息发送”交互。
- 事件保留期和磁盘预算最终值。
- 真机现场测试的设备/网络安排。

相关材料：

- [ADR-0001](adr/0001-reliable-conversation-state.zh-CN.md)
- [调查报告](conversation-architecture-investigation-0.39.48.zh-CN.md)
- [故障与性能矩阵](conversation-failure-matrix-0.39.48.zh-CN.md)
- [Goal 可追溯表](conversation-investigation-traceability-0.39.48.zh-CN.md)

## 7. 调查结案与后续分流清单

调查 Goal 只有在所有者明确接受或修改以下决定后才能结束；“继续”或允许本轮审计不等于
自动采纳：

1. 选择方案 B，并保持 App Server 当前受支持的 stdio/网关边界。
2. `unknown` 永不自动重放；用户只能通过带重复风险提示的“作为新消息发送”创建新提交。
3. 接受当前上游条件下新线程跨后端崩溃不能承诺 exactly-once。
4. 确定 outbox 和事件 payload 的密钥来源、轮换、丢失后的只读/degraded 行为。
5. 接受或修改 24 小时 outbox、64 MiB 事件日志、IndexedDB、队列和 DOM 默认预算。
6. 接受 full/skip envelope、subscription barrier、canonical 歧义保留两项并校准。
7. 接受 owner→admin→account 灰度、一个正式版本旧只读渲染回退，以及所有回滚不删除
   台账、事件日志或 JSONL。
8. 指定真实手机和第二台跨网络设备的现场测试安排；没有设备时对应项继续保持 `P/X`。
9. 保持普通服务器正式安装只做有界兼容/readiness 检查，并永久排除冻结的备用窗口。

所有者接受后，建立独立实现 Goal，严格按以下顺序推进：

- 阶段 0：默认关闭、一次性授权的只读 Shadow Recorder；先验证关联 ID 和隐私边界。
- 阶段 1：页面/window 身份、单连接 generation 和线程写租约；不改变消息投影。
- 阶段 2：影子 canonical Reducer 与增量历史索引；只比较差异，不切换 UI 权威。
- 阶段 3：提交台账、加密 outbox 和 `unknown` 交互；禁止交付未知自动重发。
- 阶段 4：有界事件日志、每 window durable ACK、range replay 和 calibration fence。
- 阶段 5：切换 canonical Store、按需 Worker 渲染、稳定节点/锚点和纯发送按钮 selector。
- 阶段 6：在一个正式版本只读回退期后，才移除旧全历史扫描和文本去重路径。

实现候选必须在开发/候选服务器完成故障矩阵、200+ MiB 历史、3/5 项目并行、移动现场和
升级/降级演练。正式安装包本身不得运行完整测试、浏览器冒烟或压力测试；失败切流必须
保留旧后端和管理员对话能力。任何阶段失败都回滚该阶段开关并保留可靠性事实，不能通过
清空台账、事件日志、JSONL 或浏览器状态来制造“恢复成功”。
