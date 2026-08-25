# 会话调查 Goal 可追溯表：0.39.48

> 历史调查追溯表，不代表当前实现状态。当前架构与验收边界见
> [ADR-0002](adr/0002-app-server-conversation-authority.zh-CN.md)。

状态：调查审计；不代表修复已经实现<br>
基线：WFL `0.39.48-beta` / Codex `0.146.0` / `accb59f1d2a53c9a437dd41a9955f3ab78d5b3bf`<br>
范围：仅主站；明确排除备用窗口 `1.0 / 4321`

## 1. 证据等级

| 标记 | 含义 |
| --- | --- |
| V | 已由代码、生产脱敏记录、真实协议录制或确定性探针证明 |
| P | 已有部分证据，但当前遥测或环境不足以完成跨层定责 |
| D | 调查阶段的设计、预算或不变量已经定义，必须在实现后验证 |
| X | 需要当前服务器不具备的真实设备或独立客户端环境 |
| R | 需要所有者评审或接受，不能由调查者代替决定 |
| N/A | 经当前部署拓扑证明不适用；不代表未来启用该组件后的验证已完成 |

`D`、`X`、`R` 和 `N/A` 都不是“测试通过”。它们用于把调查结论、当前拓扑适用性与
未来实现验收分开，防止在缺少证据时勾选完成。

## 2. 逐项追踪

| # | Goal 要求 | 状态 | 证据 | 剩余门槛 |
| ---: | --- | :---: | --- | --- |
| 01 | 冻结会话修改并记录基线、工作树和拓扑 | V | 调查报告 §1-2；当前 62 项 porcelain（47 tracked 修改、15 untracked 路径）和 tracked diff 12,475+/897- 已记录；调查包审计器会在任一数字漂移时失败 | 实现 Goal 前重新冻结一次基线 |
| 02 | 禁止触碰备用窗口 `1.0 / 4321` | V | 调查报告 §1；ADR 明确排除；本轮诊断未访问备用服务；普通 `update-app` 强制离线 quick check，quick-check 已无 rescue readiness 请求；审计器检查诊断无 `:4321` endpoint 且发布入口无诊断引用 | 后续实现、部署仍须执行同一边界 |
| 03 | 绘制浏览器到 JSONL/SQLite 的完整链路 | V | 调查报告 §2 | Cloudflare 是可选拓扑，不是本机现行链路 |
| 04 | 列出各层状态、缓存、序号、订阅和生命周期 | V | 调查报告 §3 | 实现后补新协议状态表 |
| 05 | 建立故障分类 | V | 调查报告 §5、§8；故障矩阵 M/C/S/R/G | 无 |
| 06 | 为每类故障建立最小复现、频率和环境 | P | M01-M25、C01-C18、S01-S14、R01-R09、G01-G08；生产频率见报告 §5；Goal/Provider 见 §7.4；真机协议定义 11 场景 × 3 次及 bundle gate | C02/C03 尚需真机；S10 尚需物理跨网络；C14-C18/G06 属于实现验收 |
| 07 | 采集真实浏览器 WebSocket 生命周期字段 | V | 隔离 Chromium 连续三次均录制 4 open/1 error/4 close，字段含双时间戳、可见性、online、socket ID/角色、关闭码/原因/`wasClean` 和应用连接寿命；真实拒绝握手为 error→`1006/空原因/false`，网关重启为 `1012/Gateway restarting/true`，并证明 offline 双 OPEN，见报告 §5.4/C01-C11 | 生产逐例频率仍归 Goal 06/未来默认关闭 recorder；不影响真实浏览器字段采集结论，真机锁屏仍归 Goal 16/45 |
| 08 | 设计跨浏览器、网关、后端和 App Server 关联 ID | V/D | 静态审计确认当前各层断点；故障矩阵 §1、ADR §4/§13；512 组 correlation envelope 验证父子关系、上游重连和 reload 身份；阶段 0 §10 又把 31 个 hook 锁定到当前四份 source hash，并识别首次 upstream/connection request 传递约束 | 默认关闭的生产 recorder 接入后验证真实贯通率；任一 source hash 变化先重审 hook |
| 09 | 记录 Epoch、序号、Thread/Turn/Item/Submission ID 和时间戳 | V/D | schema v2 区分 layer sequence、upstream 序号、event-log generation/cursor、双时间戳和所有实体 HMAC；9,216 行夹具通过缺层/重复序号/父连接错配检测；hook map明确六个逻辑层/七个记录阶段及 RPC/snapshot trace root | 当前生产未同时记录全部字段，浏览器 raw ID仍须由后端授权后 HMAC |
| 10 | 设计 App Server 原始事件与浏览器事件的只读录制 | V | 故障矩阵 §1-2、ADR §13、阶段 0 recorder 规范；五层 Turn/correlation 探针为 `0600` 脱敏元数据；生命周期模型覆盖默认关闭、10 类非法授权/路径、队列/轮转、过期、revoke、回执准入和组件 EIO 隔离；静态 hook探针验证 31 个入口、纯 Reducer无副作用、内部头不接受公网输入和生产/发布引用为 0 | 生产只读遥测仍需独立接入并经过 owner授权，不能把设计、夹具或 hook map当常驻日志 |
| 11 | 对同一 Turn 比较协议、广播、快照、Store 和 DOM | V | 单一随机 `traceId` 五层探针连续两次稳定通过；真实协议分叉见报告 §4，完整因果链见 §5.2 | 生产个案关联仍依赖未来 `clientInstanceId/windowInstanceId`，但确定性复现门槛已闭合 |
| 12 | 判定重复/消失来自提交、通知、合并还是 DOM | V | 统一五层分类器连续三次覆盖四类：双入口先发两个不同提交 ID；同 Item 两条 delta 为 Store 1/正文 2/DOM 1；live/snapshot ID 分叉为 Store 1→2、DOM 1→2；Store 不变强制 render 两次仍 DOM 1。M12 另证明写后断线跨 Epoch且历史不可见时同一提交在 App Server 产生两个 Turn；M23 证明同文 legacy 首次消失在 Store settlement，见 §5.2、§7.2/M05/M11/M12/M23/M25 | 旧生产个案缺关联遥测，不能逐例回溯发生频率；四种机制及首个错误层已可确定分类 |
| 13 | 定位回复刷新后才出现的中断层 | V | 丢 `turn/completed` 和 idle 后，连接健康但 Store 无回复；刷新快照恢复，见报告 §5.1/M10 | 新协议需用 ACK 重放证明自动恢复 |
| 14 | 定位“聊天记录已恢复”的触发来源 | V | 源码对应唯一提示为“已恢复上次对话”。真实 Chromium 三次对照证明：有效 session 活动快照 reload 为 resume 1/toast 0；Epoch 换槽完整 bootstrap 为 toast 0；新同源 document 初始化 session key 0、持久恢复指针存在时为 resume 1/toast 1。触发器是无活动快照的冷 document 按恢复指针成功找回，见报告 §5.4/C07 | 旧生产 206 次打开/177 次 resume 因缺 document/window ID 仍不能逐例统计频率，但不影响触发器定责 |
| 15 | 绕过 Cloudflare、Nginx 和网关对照 | N/A | 当前 DNS/HTTPS 入口由 Nginx 直接代理到主站网关；未发现 Cloudflare Tunnel 进程或配置，且报告 §2、§5.4 已完成 Nginx/网关对照 | 若未来启用 Cloudflare，新增独立对照 Goal；在当前拓扑不为此结论做合成测试 |
| 16 | 检查心跳、后台节流、锁屏、代理超时和事件循环 | P/X | 桌面冻结 3.8 个周期保持同一 WS；offline 复现非法 1001 和双 OPEN；静默心跳矩阵完成；现场 F01-F06/F08 与 33-run bundle gate 已定义 | 手机后台/锁屏/切网必须真实执行；生产事件循环延迟需 recorder |
| 17 | 验证两轮心跳及业务流量是否被当成 pong | V | 自动 pong、无 pong+业务、无 pong+静默三组随机端口实验，见报告 §5.4/C09-C11 | 无 |
| 18 | 检查队列深度、字节、阻塞、慢客户端和队头阻塞 | V/D | WS 慢端使后端/网关增加 20.8-23.2/19.9-21.5 MiB；App Server 停读增加 33.8-35.3 MiB 且 readiness 误绿；C17 barrier；C18 Worker 模型证明全局 FIFO/不可抢占阻塞，真实双 UID/GID sidecar + SQLite/WAL 证明磁盘竞争、`SIGSTOP`/`SIGKILL` 时 peer 终态仍隔离，同时每 192 个 A IPC 请求有 177-178 次 `child.send()` 返回 false | 当前生产仍无队列/字节指标；实现 `drain`、per-runtime sidecar 水位、barrier 和 readiness 后重测 |
| 19 | 检查大工具输出、Diff、快照的阻塞 | V | 当前 `app.js` 三次真实 Chromium 组合输入 2 MiB 命令输出和 20,000 行 Diff：处理 9,489-10,279 ms、最长 Long Task 2,164-2,390 ms、Long Task 占 84.5%-89.6%；关闭后仍有 19,999 Diff 行、80,047 元素/120,052 全部节点。真实长历史官方读取 8.21 s；WS/stdin 两类 8 MiB 背压见 §6-7、§10/R01/R07/C12-C13 | 生产 recorder 仍用于频率/队列归因；当前代码会阻塞主线程和积压发送路径的结论已稳定复现 |
| 20 | 对照 `rust-v0.146.0` 源码核对协议语义 | V | 报告 §9；官方 tag `e363b08c` 的 event handling、thread lifecycle、transport 和 protocol；版本锁定探针对本机 0.146 stable/experimental schema 验证方法、通知、历史分页、提交字段及 ACK/replay 缺口并保留四份 SHA-256 | 当前手册会持续更新；升级 Codex 后必须重新生成 schema、重跑真实录制并核对成熟度 |
| 21 | 录制真实 Item/Turn ID 与顺序 | V | 报告 §4 的独立官方 App Server 录制 | 当前顺序只代表实测和协议不变量，不假设所有通知严格固定 |
| 22 | 验证 `item/completed` 覆盖同 ID 流式 Item | V | 官方手册、0.146 源码、真实录制及 M01/M02 | 当前 WFL 通用工具晚到 started 仍会回退，属于已证明缺陷 |
| 23 | 区分 `event_msg`、`response_item` 和 v2 通知 | V | 报告 §4、§9；0.146 `bespoke_event_handling.rs` 和 legacy 重建实测 | 新 canonical mapper 仍待实现 |
| 24 | 审计 thread 生命周期方法调用场景 | V | 报告 §3、§5.3、§6-7、§9；矩阵 S01-S14 | 新协议实现后复审调用频率 |
| 25 | 调查 250 ms 退订策略与切换/Goal | V | 快速切 5 线程泄漏 3 个淘汰订阅；运行任务保护/10 秒宽限通过，见 §5.3、S01-S05 | 修复 selection lease 后回归 |
| 26 | 验证 2、3 及更多项目并行不因切页停止 | V | 2/4 项目集成覆盖；3 工程 Chromium 中三个不同 Turn 切换后均运行；见 S06-S08 | 弱网组合属于新 ACK/重放实现验收 |
| 27 | 验证多标签/多设备订阅引用和权限 | P/X | 双标签集成覆盖；两个隔离 Chromium context 证明账户广播/DOM 隔离、独立租约 ID、共同观察、10.5 秒单端退出和最终退订；现场 F09-F11 要求两台设备/不同 network digest/owner attestation | 物理跨网络 bundle 仍缺；durable ACK/独立游标属于实现后验收 |
| 28 | 审计 optimistic、Queue、Steer、重试和恢复状态机 | V | 报告 §7.2；M12、M15、M19-M24；可控断线证明 Queue 只记布尔值，重连读取修改后的正文/附件/工程，reload 丢普通草稿；M23 证明 recent 校准会在 RPC 未决、上游未执行时按旧文本清掉 optimistic Store/DOM；写后断线证明 Turn pending 的重投/error/reload 分支；M15 证明 Steer 跨 Epoch历史未命中时被 409 恢复成普通输入、人工发送改变为新 Turn，reload 会无声丢失；M22 证明新线程跨 Epoch 停止自动重试却恢复普通草稿，人工重发创建第二线程；预实现 SQLite 台账补充验证状态/transition/outbox 原子边界；官方 #25268 仅作队列旁证 | 新提交台账/outbox 接入生产后重测 |
| 29 | 设计稳定 `clientSubmissionId` | D/V | ADR §4-5；M12 探针证明浏览器当前 `clientUserMessageId` 在重连重投中稳定；SQLite 探针验证 `(account, submission)` 唯一约束、同冻结载荷幂等和不同载荷冲突 | document 同步 guard、服务端 prepare API 和生产并发重试尚未实现 |
| 30 | 设计提交台账位置和保留期 | D/V | ADR §5：WFL SQLite WAL、AES-GCM 短期 outbox、HMAC 摘要、24 小时硬过期；12 个真实 `SIGKILL` 点证明 state/history/purge 原子性；到期 prepared→cancelled、sent/unknown→unresolved-abandoned；M12/M19-M22 证明现有内存/历史/草稿不能替代台账 | 密钥来源、管理员配置、新线程 `unknown` 产品语义和生产 sidecar 仍需评审/实现 |
| 31 | 交付未知禁止盲目重发 | V/D | M12 证明历史不可见时自动重投会双执行；M15/M22/M24 证明 Steer 类型、空线程和普通错误会诱导错误重发；SQLite 探针验证 unreadable outbox 保持 blocked `unknown`、恢复密钥不自动重放、过期不改写为 rejected/cancelled | 实现持久台账后，用同一浏览器故障探针验证 App Server 始终只执行一次或保持 `unknown` |
| 32 | 设计规范化 Thread/Turn/Item Store | D/V | ADR §4、§7；纯内存 canonical 模型实现 threads/turns/items/submissions/source aliases 独立 Map，4,096 种子下 28,758 个随机逻辑 Item 始终对应 28,758 个 canonical key | 数据结构与预实现身份规则已闭合；生产影子 Reducer、持久 checkpoint 和迁移仍未实现 |
| 33 | 定义实时/重放/快照共用 Reducer | V/D | canonical 模型让 live/replay/JSONL/snapshot/full calibration 全部经过一个 `dispatch()`，167,251 action 阻止 54,542 次 Item 和 81,215 次 Turn 回退；事件日志模型另验证 cursor/barrier | 唯一 Reducer 语义已可执行；仍需阶段 2 影子接入真实五层事件并跑完整实体差异矩阵 |
| 34 | 普通重连只恢复传输 | V/D | 当前无序号变化的 offline/online 与 1012 已证明零会话读取；新增随机回环真实 Chromium 目标原型三次用合法 4001、10 路 online single-flight、旧 generation guard 和同 document window lease，断线 3 条事件连续 replay 后 `thread/resume/bootstrap/calibration` 均为 0 | transport/replay 目标语义已闭合；当前生产仍有非法 1001/双 socket、无 durable ACK/重放，pending RPC 还须台账裁决，代理/真机/候选未验收 |
| 35 | 只在 Epoch 变化或缺口时权威校准 | V/D | 当前槽切换重量级 bootstrap 与无关账户序号误校准已定责；真实 Chromium 目标原型三次对可保留 cursor gap 只做一次 range replay，generation/Epoch 变化才 calibration，期间再次换代丢弃旧结果，fence 前后事件缓冲归零并与 8 个服务端实体一致 | 门禁和 fence 参考语义已闭合；生产事件日志/Reducer/校准、日志淘汰、提交/任务优先恢复及候选故障注入仍待实现 |
| 36 | 评估有界日志、ACK 和断线续传 | V/D | ADR §6 与 C14-C18；协议模型、SQLite WAL/AES-GCM、五个事务崩溃点、Chromium strict IndexedDB/双 slot；10,000 种子组合模型验证旧 generation ACK/空 seed/resync；新增真实 Chromium 组合验证 socket generation、range replay、stale calibration/fence；双非 root sidecar 覆盖 IPC、独立数据库、磁盘竞争、停顿/崩溃和 WAL 重开 | 协议与预实现可行性已闭合；生产 sidecar、加密台账组合事务、Bridge 实际水位、饱和磁盘、移动浏览器和存储压力仍待实现/遥测 |
| 37 | 禁止文本相同作为消息去重/结算依据 | V/D | M23 连续三次证明旧无 ID 同文用户 Item 会清除新 pending；canonical 模型执行 0 次文本身份比较，同内容不同提交保持两条、候选不唯一保留 `ambiguousProjection` | 禁令与 mapper 参考语义已闭合；生产 mapper/影子差异和真实 legacy 长线程仍待实现验收 |
| 38 | 审计 `refreshRecentTurns()` 覆盖和运行状态 | V | 报告 §6、§7.2、§10；M05/M16/M23/R06；M23 精确证明 recent 校准在新上游执行前清除未绑定 pending；canonical 模型证明 `prepared\|sent\|unknown` optimistic 项可在 full calibration 下保留 | 新 Reducer 替换旧 refresh 赋值路径后回归 |
| 39 | 审计发送按钮状态来源 | V/D | 报告 §10；ADR §11 定义纯 selector | 当前仍由本地 Turn/pending/transport 多源驱动 |
| 40 | 测量长线程、恢复、分页、Markdown、Diff 和 DOM | V | 首次 215 MB 线程 RPC 基线、8.21 s read、20,000 行 Diff；后续只读结构快照为 232,099,377 字节/81,715 行/2,625,474 字节最大行；4 次 Chromium 首屏/流式/Markdown 风格文本/DOM/Long Task 见报告 §6 | 候选实现仍须按矩阵 §8 采集正式 P95，不能把结构快照或 4 次基线当验收 |
| 41 | 旧历史摘要/分页，查看不触发重 resume | V/D | ADR §9、报告 §6.1；55.27 MB synthetic SQLite 索引四次在 1.144-1.285 s 建立，验证 safe newline、增量 byte range、前后各 8 Turn 分页、重建、权限拒绝和两个真实 `SIGKILL` 边界，官方 RPC 调用为 0 | 设计和预实现存储语义已闭合；生产 Worker/UserRuntime sidecar、append-only 契约、真实 200+ MiB、格式迁移和查看路径接入仍待独立实现 Goal |
| 42 | 折叠块保留内容并按需渲染 | V/D | ADR §11、报告 §10.1、R01/R07；隔离 Chromium 三次在 20,000 行 Diff、2 MiB 工具输出、512 KiB 推理正文下保持关闭 body 读取/明细节点为 0，收起卸载投影而 raw Store 内容不变，重开不重复读取 Diff raw | 按需内容引用和投影生命周期已闭合；当前 `app.js`、Worker 失败恢复、Markdown/选区/搜索/无障碍、内存压力和手机仍待实现验收 |
| 43 | 大 Diff 延迟解析并设预算 | V/D | ADR §11、矩阵 §8、报告 §10.1；隔离 Worker 三次解析 20,000 行为 1.8-2.6 ms，首批/次批各 500 行，10 行 Diff/8 KiB 文本主线程切片最大 0.5-0.6 ms，关闭 0 行、首批后 558 元素/1,081 全部节点、零 Long Task | 分批预算已可执行；生产 Worker/DOM/CSS、真实 Diff/Markdown、候选设备 P95 和 Worker crash 仍待独立实现 Goal |
| 44 | 稳定 key、锚点、折叠和未读位置 | V/D | ADR §4、§7、§11；canonical 模型证明 live/snapshot 合并沿用同一 key；隔离 DOM 三次进一步保留打开节点/500 行投影，100 次流式 patch 零 full render，前插 16 Turn 后 anchor 原节点且位移 0 px，未读 canonical key 保持 | key 与 DOM 参考语义已闭合；生产 canonical Store/patch、选择/搜索位置和真实移动滚动仍未实现 |
| 45 | 覆盖手机后台、锁屏、弱网、刷新和前后台 | P/X | 桌面冻结、offline/online、网关重启已覆盖；M19/M21 已证明载荷/草稿丢失；C04 已确定失败；现场 F01-F11、每项 3 次和 10 类 evidence rejection 已固化 | 真实手机 bundle 尚未产生，desktop/fixture 不可替代；C04 修复后须复测 |
| 46 | 建立 drop/duplicate/reorder/delay/disconnect/restart 注入 | V/D | `inject-conversation-trace.mjs` 提供逐层离线规则；定向探针覆盖真实浏览器/随机端口；新增组合参考模型以 10,000 固定种子提交 242,587 条事件，六类故障全部命中且两次输出一致 | 调查用通用组合注入器已闭合；候选生产 Reducer、队列、sidecar、IndexedDB 和订阅租约仍须用同一类矩阵正式验收 |
| 47 | 覆盖双击、输入法、RPC 超时和三项目 | V/D | M11-M15、M20、M22、M25、S06-S08；真实 Chromium 证明 IME 229 误提交、恢复前双 `turn/start`、写后断线跨进程双执行、Steer 409 降级/刷新丢失和新线程人工重建 | 持久台账下的超时裁决属于实现验收 |
| 48 | 覆盖 Provider、额度、无限重试、Goal 暂停和切换 | V/D | 33/33 Goal/Provider/官方账号隔离单元测试；随机端口 `probe-goal-provider-recovery.mjs` 证明 G04/G05/G08，并证明 G02/G07 错误分类；报告 §7.4 | G01/G03 的提交身份、G06 `unknown` 裁决及修复后的 401/429 分类仍需实现验收 |
| 49 | 高负载只在开发机，普通服务器只做有界检查 | V | 调查报告 §1；矩阵 §10；ADR §15；所有诊断探针均无 package/install/update/release 引用；静态审计确认普通安装为 offline quick check、普通 update 不调用 full/browser suite，完整套件仅在 candidate/显式主发布分支 | 发布/安装代码继续遵守全局约束 |
| 50 | 制定性能指标 | V/D | 故障矩阵 §8、决策记分卡 §4；已冻结 ordinary/legacy/concurrent/reconnect 分层、同进程单调时钟和跨进程分段边界、warm 100/cold 30/同候选 3 批样本、nearest-rank P50/P95/P99、失败/outlier 保留及正式安装禁跑候选测试 | 测量契约已可执行；候选生产实现仍须采样，绝对预算或 >10% 相对退化的调整需所有者接受 |
| 51 | 制定可靠性指标 | V/D | 故障矩阵 §9 已定义零重复、零漏终态、零错误重放/回退/半提交等指标；预实现组合模型已证明这些断言可机器执行并区分 `unknown`，但明确不冒充候选通过 | 候选实现仍需完整 10,000 次，包含真实 Reducer、存储、浏览器、队列、订阅、租约和多用户隔离 |
| 52 | 比较修现有链路和替换传输/状态层 | V/D | 决策记分卡 §1-3 以提交、身份、重放、历史、资源、迁移、支持和运维八项硬门禁比较四方案；排除局部修补、当前直切 experimental WebSocket 和一次性全重写，建议方案 B 保留受支持 transport 边界并分阶段替换 WFL 状态/恢复层 | 比较和排除理由已闭合；方案选择仍须所有者接受，Codex transport 支持状态变化后重评 |
| 53 | 不直接采用实验性 App Server WebSocket | V/D | 官方手册明确 experimental/unsupported；ADR §2 | Codex 版本变化后重新评估 |
| 54 | 输出状态权威、顺序、幂等、恢复和订阅 ADR | V/D | ADR §3-13、决策记分卡；崩溃反证审查、10,000 种子组合模型、SQLite/IndexedDB/sidecar 探针和真实 Chromium replay/fence 原型已把 upstream/log 双序号、事务、过滤 cursor、reload lease 与校准边界变成可执行预实现断言 | ADR 技术不变量已闭合；生产四层接入、候选矩阵、隐私/容量参数和所有者采纳仍未完成 |
| 55 | 输出迁移、兼容、灰度、回滚和数据保护 | V/D | ADR §14-16、决策记分卡 §5、`probe-conversation-migration-reference.mjs`；七阶段 21 个崩溃点、owner→admin→account、v1 ACK 禁令、120 种回滚顺序/600 次转换及 4 个发布失败点已验证，schema/台账/JSONL 删除、`unknown` 重放、备用窗口操作和普通服务器重型测试均为 0 | 迁移条款已成为可执行纯模型；真实数据库、旧 bundle、服务切流、升级降级和候选恢复仍待独立实现 Goal |
| 56 | 报告和方案通过后再建立实现 Goal | R | 调查报告、矩阵、ADR 和本表已经形成评审包 | 所有者接受 ADR 后才能结束调查 Goal 并建立实现 Goal |

## 3. 当前结论

调查已经稳定证明四个 P0：

1. 事件没有 ACK/重放，漏帧后连接可保持“健康”但回复永久不可见。
2. legacy 实时 `msg_*` 与恢复 `item-*` 身份分叉，旧 Reducer 会保留重复助手项。
3. `turn/start` 没有持久提交台账，写后断线无法安全判断是否重发。
4. 同 owner 短写会释放运行 Turn 的长租约，线程写隔离不成立。

当前不能用更多局部 UI 补丁弥补这些不变量。实现顺序必须从页面身份和租约开始，再进入
影子 Reducer/索引、提交台账、事件日志/ACK，最后切换渲染。

此外已经稳定证明一个 P1 传输缺陷：浏览器离线处理尝试发送保留的 1001 关闭码，
Chromium 抛错后旧 socket 保持 OPEN；online 又创建新 socket，形成双连接和旧订阅泄漏。

尚未闭合的证据按性质分为：

- 外部环境：真实手机锁屏、移动弱网和第二设备。
- 新遥测：跨层连接 ID、关闭码、长任务、队列字节和完整五层 trace。
- 实现验收：ACK、台账、慢消费者、有界队列、Provider/Goal 剩余错误分类与
  `unknown` 故障注入，以及 10,000 次矩阵。
- 决策门槛：ADR 的隐私、保留、容量预算与迁移顺序需要所有者接受。

## 4. 2026-07-31 结案审计记录

本轮只做主站只读拓扑核验、隔离诊断脚本/fixture 和文档审计，没有修改生产会话源码；
未部署、未推送、未创建标签，也未向冻结的备用窗口发起请求或执行代码、数据、服务
操作。主站入口的 DNS/HTTPS 响应为 Nginx，站点配置的上游为回环主站网关；当前
没有 Cloudflare Tunnel 这一层。因此 Goal 15 以 `N/A` 结案，而不是把“没有该层”
误写成 Cloudflare 已通过。

剩余状态没有被人为升级：

- `V`：Goal 07 已由三次真实 Chromium 生命周期字段录制闭合；Goal 14 已由三次 reload/new-document 对照定位；Goal 19 已由当前 `app.js`
  三次大载荷路径稳定复现；Goal 12 已由统一五层重复来源分类器连续三次闭合，不再依赖
  UI 表象或文本相同推断。
- `P`：仅 Goal 06，仍缺真机/跨网络环境和生产逐例频率。
- `P/X`：Goal 16、27、45，仍缺真实手机/跨网络第二设备证据；桌面 Chromium 和合成
  bundle 不能替代现场证据。
- `V/D`：Goal 55 的迁移与回滚规则已经由纯状态机验证，但真实数据库、旧 bundle、
  候选服务切流和升级降级演练仍属于后续实现 Goal。
- `R`：Goal 56 等待所有者接受 ADR、容量/保留、密钥来源、`unknown` 交互和现场设备
  安排；调查 Goal 在此之前保持 active。

因此本调查包的结论是“根因和实现边界已闭合，生产修复尚未开始”，不能据此宣称当前
会话 UI 已修复或允许直接发布。
