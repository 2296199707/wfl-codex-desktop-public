# ADR-0001：可靠会话状态、提交和恢复协议

> 历史设计，已由 [ADR-0002](0002-app-server-conversation-authority.zh-CN.md) 取代。
> 本文中的事件日志、浏览器 ACK/checkpoint、canonical/legacy 双投影和 Sidecar 提交台账
> 没有作为当前生产架构保留，不得据此新增实现或运维开关。

状态：已取代<br>
日期：2026-07-30<br>
决策范围：主站 Codex 会话<br>
明确排除：备用窗口 `1.0 / 4321`

## 1. 背景

主站当前直接把 Codex App Server 实时通知广播给浏览器，并在断线或状态变化时读取
历史快照补齐。这个模型隐含假设：

1. 通知不会丢失。
2. 实时 Item ID 与历史恢复 Item ID 相同。
3. RPC 断线后可以由浏览器安全重试。
4. 视觉折叠足以控制渲染成本。

调查已逐项推翻这些假设。特别是 Codex 0.146 legacy 历史会把实时 `msg_*` 重建为
`item-*`；网关切槽不会保留业务 RPC；服务端没有事件日志或客户端 ACK；超大历史在
每次提交和恢复时产生 5 至 14 秒延迟。浏览器离线路径还会因尝试发送保留的 WebSocket
1001 关闭码而抛错，在 online 后留下新旧两条同时 OPEN 的连接。

## 2. 决策

采用“服务端提交台账 + 有界事件日志 + 每 window ACK + 规范化实体 Store + 增量历史
索引 + 按需渲染”的架构。浏览器不再直接把 App Server 通知和快照对象互相拼接。

不采用以下方案：

- 文本相同去重：会删除用户合法重复输入。
- 每次重连完整 `thread/resume`：成本高且会制造实时/快照竞态。
- 只增加刷新定时器：不能证明事件完整，也会加重历史扫描。
- 直接切到实验性 App Server WebSocket：没有解决 WFL 提交、身份和历史索引问题，
  还增加版本与部署风险；[官方手册](https://learn.chatgpt.com/docs/app-server.md)
  当前也明确标记该 transport 为 experimental and unsupported。
- 把所有事件永久保存：无界存储和隐私风险不可接受。

## 3. 权威边界

| 数据 | 权威来源 |
| --- | --- |
| 提交是否已接受 | WFL 服务端提交台账 |
| Turn 是否终结 | App Server 终态事件，经 WFL 事件日志持久化 |
| 实时文本和工具进度 | WFL 跨 App Server Epoch 的持久有界事件日志 |
| 持久历史内容 | Codex JSONL/官方读取结果 + WFL 只读索引 |
| 实时与历史 Item 对应关系 | WFL 规范化投影映射 |
| 浏览器已处理位置 | 每 window 的 event-log generation/cursor ACK |
| 页面选择、折叠、滚动 | 浏览器本地 UI 状态 |
| 后台任务生命周期 | WFL 服务端任务状态，不属于页面 |

WFL 不直接修改 Codex JSONL 或 Codex 内部 SQLite。增量索引是可删除重建的派生数据。

## 4. 身份模型

### 4.1 稳定 ID

- `clientInstanceId`：一次浏览器安装/账户作用域的随机 ID。
- `windowNonce`：每个 document 启动时只在内存中新建的随机值；不得从
  `sessionStorage` 读取，因为 `window.open()` 会复制父页的初始 session storage。
- `windowInstanceId`：服务端在页面注册时签发并绑定账户、`clientInstanceId` 和
  `windowNonce`；只在该 document 内存中保存，不能由客户端自行复用。
- `gatewayConnectionId`：网关为每条浏览器连接签发，并在连接上游时传给后端。
- `connectionId`：后端为本次连接签发并与 `gatewayConnectionId` 关联。
- `traceId`：一次提交或恢复操作跨层关联 ID。
- `clientSubmissionId`：用户每次明确提交生成的 UUID；同一次网络重试必须复用。
- `upstreamEventId`：`runtimeEpoch + upstreamEventSequence`，只标识当前 App Server
  generation 的源事件；Epoch 改变后可重新从小序号开始。
- `eventLogGeneration`：WFL 持久事件库的 generation。数据库重建或不可兼容迁移时更换。
- `eventCursor`：WFL 事件库内账户作用域、跨 App Server Epoch 单调递增的游标；ACK、
  重放和校准只使用 `eventLogGeneration + eventCursor`，不能使用上游序号代替。
- `checkpointId`：浏览器 IndexedDB 中不可变规范化 checkpoint 的随机 ID，携带账户、
  schema、实体范围和持久事件游标；它是可验证缓存，不是页面、连接或租约身份。
- `checkpointSlotId`：服务端随 `windowInstanceId` 签发的本 document checkpoint head
  槽位；同 document 重连可续用，reload/新标签必须取得新 slot。slot 只决定哪个 head
  可推进，不能充当页面身份或 ACK lease。
- `canonicalTurnId`：官方 Turn ID。
- `canonicalItemId`：WFL 规范化 ID，不假设等于某一次投影的 Item ID。

### 4.2 Item 投影映射

同一 canonical Item 可拥有多个 source key：

```text
live:msg_0767...
snapshot:turn-id:item-2
jsonl:response_item:msg_0767...
user-client:wfl-probe-persist-...
```

映射优先级：

1. 用户 Item 使用 `clientId`。
2. JSONL `response_item.id` 与实时 ID 精确匹配。
3. 同一 Turn 内使用持久顺序、角色、阶段、来源类型和相邻持久记录建立投影映射。
4. 无法唯一关联时保留两个 canonical Item 并标记 `ambiguousProjection`，触发后台校准。

文本摘要只能用于诊断和最后的歧义提示，不能作为自动删除依据。

这条禁令已有用户消息反例。新提交尚未绑定 Turn 时，同 Epoch 重连的 recent 校准会遍历
旧 Turn；旧 legacy 用户 Item 没有 `clientId` 且文字相同，当前
`settlePendingUserMessage()` 会在新 RPC 仍未决、App Server 执行数仍为 0 时清除
optimistic Store，DOM 随后移除 pending 节点。权威 Item 后到才重新显示消息。因此：

- pending 只能由同一 `clientSubmissionId/clientId`、台账回执或明确 Turn 绑定结算。
- legacy Item 缺稳定 ID 时必须保留 pending 并标记歧义，不能用文本补身份。
- snapshot/recent 校准不得清除 `prepared|sent|unknown` 提交对应的 optimistic 投影。

五层确定性探针验证了映射必须发生在 Store 合并之前。实时 `msg_*` 和运行中 full 快照
`item_*` 在 App Server/广播层各自都只有一条；旧 Store 因 source key 不同保留两条，
DOM 随后按两个稳定 key 渲染两次。用户项凭 `clientId` 没有重复，但 key 仍发生切换；
终态 full 快照把助手恢复成一条也只是权威替换，不会补出缺失的跨投影关系。因此：

- source key 不能直接充当 canonical ID。
- snapshot mapper 必须先输出 canonical ID，再进入 §7 的 Reducer。
- 映射成功后实时、重放、运行快照和终态快照都必须保持同一 DOM key。
- terminal full 恰好删除重复不能记为“已修复”，summary 和长时间运行 Turn 仍会暴露问题。

## 5. 提交台账

台账按账户隔离，建议使用 WFL 自有 SQLite WAL。唯一键为
`(accountId, clientSubmissionId)`。

状态机：

```text
prepared -> sent -> accepted -> terminal
    \         \-> rejected
     \         \-> unknown -> accepted
      \-> cancelled          \-> unresolved-abandoned
```

只有尚未调用 App Server write 的 `prepared` 可以安全进入 `cancelled`。`sent` 表示
已经开始向 App Server 交付；此后断线必须进入 `unknown`，不能伪装成 `cancelled` 或
`rejected`。`unresolved-abandoned` 只表示用户不再等待/自动重试，绝不表示上游没有执行，
也永远不能用原提交 ID 或新 Provider 自动重放。`rejected` 仅用于收到明确、无副作用的
App Server 拒绝响应。

字段至少包含：

- 账户、线程、提交 ID、提交类型 `start|steer`。
- 提示和附件清单的加盐摘要。
- 短期加密 outbox 载荷，包括输入、附件不可变引用和执行设置；只在
  `prepared|sent|unknown` 期间保留，绝不把明文写入日志。
- 目标 Provider/账号、模型、权限设置摘要。
- App Server RPC ID、Turn ID、用户 `clientId`。
- prepared/sent/accepted/terminal 时间戳。
- 当前交付状态、终态、错误分类、用户放弃等待状态和最后裁决时间。
- 过期时间和清理版本。

### 5.1 请求流程

1. 用户手势入口在任何 `await` 之前同步取得 document 级 submit-intent guard，生成
   `clientSubmissionId` 并冻结输入快照；重复 click/Enter 入口直接复用或退出。
2. 浏览器先 `submission/prepare`，服务端事务性插入 `prepared`。需要 resume 的线程也
   必须先 prepare，再恢复传输/订阅，不能先 await `resumeThread()`。
3. 服务端返回同一 `clientSubmissionId` 的现有记录或新记录。
4. `prepare` 同时冻结完整载荷。文字、附件、Skill、App、线程、模型、权限和 Provider
   后续不再从输入框或当前 UI 设置读取。
5. 服务端写 App Server 前记录 `sent`。
6. `turn/start` 返回 Turn 后记录 `accepted` 和 Turn ID，再向浏览器回执；此时可删除
   可重放明文，只保留摘要和必要的裁决索引。
7. 收到终态事件后记录 `terminal`，并按保留策略清理 outbox。

冻结必须发生在用户点击时，而不是连接恢复时。当前基线的可控断线反例连续三次证明：
点击时没有发出 RPC；随后编辑正文并移除附件，重连会发送修改后的正文和零附件；从原
工程既有线程切到另一个工程，重连会在新工程创建新线程再发送。`queuedPromptAfterReconnect`
因此只是发送意图，既没有 payload 快照，也没有 destination 快照，不能作为 outbox。

同一提交 ID 的重试只读取台账，不再次调用 App Server。新的相同文字必须生成新的提交
ID，因此仍是合法第二次输入。

加密 outbox 使用 WFL 独立状态密钥和账户级附加认证数据，默认 24 小时硬过期；
`accepted` 后立即最小化，`terminal/cancelled/unresolved-abandoned` 后只保留不含正文的
审计字段。密钥缺失或密文损坏时提交停在 `unknown`，不能降级为明文或盲重放。

硬过期只描述“不再保存可重放正文”，不能改写交付事实。到期时：

- `prepared` 且台账证明从未开始 App Server write，原子转为 `cancelled` 并清除 outbox。
- `sent|unknown` 原子转为 `unresolved-abandoned` 并清除 outbox；这只表示系统不再保留
  恢复载荷，不能显示成上游拒绝、取消或未执行。
- `accepted` 在写入 Turn ID 的同一事务立即清除 outbox，不等待 24 小时；后续只保留
  提交摘要、状态、关联 ID 和审计时间。

`probe-submission-ledger-storage.mjs` 用临时 SQLite WAL/`synchronous=FULL`、严格表、
`(account_id, submission_id)` 唯一键、AES-256-GCM 和 HMAC-SHA-256 实现了这一状态模型。
12 个真实 `SIGKILL` 点覆盖 prepare、sent、unknown、accepted 和过期清理的 state/purge/
commit 边界：commit 前状态、transition history 和密文清理全部回滚，commit 后同操作
重试只返回既有 transition。密钥缺失、密文损坏和同 ID 不同载荷均不会写明文或盲重放；
所有数据库/WAL/SHM 为 `0600`，明文哨兵未落盘。256 条 2 KiB outbox、768 个事务的最近
三次开发机基线中，prepare P95 为 2.208-2.356 ms，状态迁移 P95 为 1.827-1.872 ms。
这只证明存储边界可行，不证明 App Server 上游 exactly-once，也不代表生产台账已接入。

### 5.2 交付未知裁决

若 stdio 写入后 App Server 或网关断开：

1. 标记 `unknown`，禁止自动换 Provider 后重放。
2. 使用已知 Turn ID、用户 `clientId` 和增量索引查询。
3. 找到匹配 Turn 时补记 `accepted`。
4. 只有台账仍在 `prepared` 且 App Server write 从未被调用时才可原提交重放；一旦
   进入 `sent`，现有 App Server 没有足以证明“未执行”的协议。
5. 无法证明时维持 `unknown`。用户可以继续查询、放弃等待，或明确选择“作为可能重复的
   新消息发送”；最后一种必须生成新提交 ID 并提示风险。

该边界已有确定性反例，而不只是理论推断。写后断线探针连续两次得到：

- 同 Epoch 重投相同 `clientUserMessageId`，进程内缓存使 App Server 只执行一次。
- 跨 Epoch 且历史已可见时，新进程扫描 `thread/read(includeTurns:true)` 找回原 Turn。
- 跨 Epoch 但已接受提交尚未出现在历史时，同一 ID 再次到达 App Server，产生第二个
  Turn。
- 若已接受结果被替换成普通 `rpc/error`，浏览器会清除 pending 并恢复输入；换 Epoch
  且历史不可见后人工重发会使用新 ID，再产生一个 Turn。

所以全历史扫描只能作为 `unknown -> accepted` 的一种查询证据，不能替代台账，也不能
授权在查询未命中时重放。历史“当前没看到”不等于 App Server“没有执行”；网关错误也
必须带机器可读交付状态，不能让浏览器从中文错误文案推断是否可重发。

`turn/steer` 使用同一条裁决规则，并在台账中永久保留提交类型。Steer 写后丢结果的
受控反例显示：同 Epoch 由内存缓存找回，跨 Epoch且历史可见时按用户 Item `clientId`
找回；历史尚不可见时，新后端会因任务状态默认为 idle 返回普通 409，浏览器再把内容
恢复成普通输入。人工发送会生成新的 `turn/start`，不再是对原 Turn 的 Steer；reload
则连 pending Steer 和冻结输入都不恢复。上游 Steer 在这些场景中只执行一次，是当前
拒绝时序的偶然结果，不是 exactly-once 保证。

因此 `unknown` Steer 不得转换成 `start`、普通草稿或可直接重发输入。页面恢复后必须
显示它仍属于原 Turn，并只允许继续查询、放弃或明确作为可能改变因果关系的新消息发送；
最后一种操作必须生成新提交 ID 和新台账记录。普通 409 只有在台账证明原 Steer 未进入
`sent` 时，才可作为未执行结论。

页面 reload 后先从台账恢复本账号未终结提交，再恢复输入区。未点击发送的普通草稿不进
服务端台账；它按账号和线程保存在浏览器 IndexedDB，设置字节/附件数量/过期上限，并在
提交 accepted 后删除。敏感账户可通过策略完全关闭草稿持久化。

普通草稿的受控 reload 反例也连续三次得到正文和附件均为空，且没有误发 `turn/start`。
所以草稿 IndexedDB 与服务端提交 outbox 是两个不同生命周期：未点击内容只能恢复为
可编辑草稿；点击后的冻结提交必须恢复为带交付状态的记录，不能混回普通输入。

当前反例中，结果丢失后在自动重投前 reload，新 document 没有再次调用 `turn/start`，
但 pending 和冻结输入也都消失，输入框为空。这个结果不能记成“避免重复成功”：页面
同时丢失了提交事实和恢复载荷，无法向用户区分 accepted 与 unknown。

### 5.3 新线程的两阶段边界

现有 App Server 的 `thread/start` 没有 WFL 可用的幂等键。若线程已经创建，但响应在
后端进程崩溃前没有进入台账，WFL 无法仅凭 cwd/时间戳证明某个空线程属于哪次提交。
因此不能承诺跨进程的 exactly-once `thread/start`：

1. 浏览器先创建 WFL `draftThreadId` 和提交台账记录，冻结首条提示。
2. 同一后端进程内，重复请求由台账/单航班返回同一进行中结果。
3. `thread/start` 进入 `sent` 后若结果丢失，不自动再创建第二个线程；提示保留在加密
   outbox，记录保持 `unknown`。
4. 后台只列出可能的空线程候选供诊断，不按 cwd、时间或标题自动绑定。
5. 用户可等待查询，或明确新建另一次提交；疑似孤立空线程按独立保留策略清理。

只有上游将稳定 idempotency key 写入线程创建协议，或 WFL 能在同一原子边界控制线程
持久化时，才能把这部分升级为严格 exactly-once。ADR 不虚构当前协议没有的保证。

确定性反例已经验证这条边界。首次 `thread/start` 在 App Server 创建空线程后丢失结果：

- 同 Epoch 浏览器用同一 `_wflClientThreadRequestId` 重投，进程内单航班返回同一线程。
- 该私有 ID 在调用 App Server 前已被剥离，不能写入或查询上游线程。
- 跨 Epoch 浏览器不自动重投；原空线程可见，原输入恢复成普通草稿，但两者没有持久关联。
- 人工再次发送生成新 ID，并创建第二个线程。

因此跨 Epoch 停止自动重试是必要但不充分的。UI 必须显示持久 `unknown` 提交及其候选
空线程，保留加密 outbox，并把“重新作为新提交发送”设计成明确的风险操作，不能恢复成
看似可安全发送的普通输入。

## 6. 事件日志和 ACK

WFL 为每个账户维护持久 `eventCursor`，它不随 App Server `runtimeEpoch` 重置。上游
`runtimeEpoch/upstreamEventSequence` 只用于源事件去重和诊断；两套序号不得混用。

事件摄取按账户串行，并在广播前完成一个 SQLite 事务：

```text
App Server notification
  -> validate/sanitize
  -> map source key to canonical ID
  -> transaction {
       append encrypted canonical event with next eventCursor
       update source mapping + task/submission state
     }
  -> commit
  -> broadcast
```

事务提交失败时不得广播或推进游标，readiness 必须降级；进程重启从已提交日志和状态表
重建。`upstreamEventId` 建唯一约束，崩溃重读同一源事件时只返回既有 `eventCursor`。
这样不会出现“浏览器见过事件，但日志/任务状态没有”或“日志有终态，任务表仍运行”的
半提交状态。

事件 payload 可能含回复、工具输出或 Diff，必须用 WFL 状态密钥按账户 AAD 加密，文件
模式 `0600`；明文元数据只保留 cursor、类型、规范 ID、字节数和时间。密钥不可用时绝不
降级明文：迁移期账户继续旧协议，强制切换后则进入只读/degraded，直到密钥恢复。payload
按保留策略删除，不能借“遥测不记正文”误以为重放日志可以明文落盘。每行保存 `keyId`；
密钥轮换必须先让旧 key 保持只读解密能力，待旧 payload 全部过期后再销毁，不能因轮换
把未 ACK 事件强制变成 resync。

浏览器按连续序号处理并发送累计 ACK。收到 `N+2` 而最后 ACK 为 `N` 时，不应用
`N+2`，先请求 `[N+1, ...]` 重放。

ACK 是可恢复性承诺，不只是内存处理进度。浏览器把规范化实体 checkpoint 和
`durableEventCursor` 在同一 IndexedDB 事务中提交后，才能向服务端 ACK 该游标。页面
可先渲染更高的内存 `appliedCursor`，但服务端不得据此提前回收事件；崩溃后从较低的
durable cursor 重放是允许的，Reducer 必须幂等。每个 `windowInstanceId` 独立 ACK，
多标签不能共用一个游标。

浏览器事务必须请求 IndexedDB `durability: "strict"`，并在
`transaction.oncomplete` 后才把 cursor 标为 ACK-eligible。一次增量 checkpoint 最多
覆盖 16 个事件、32 KiB 脏实体或 16 ms，达到任一条件就提交；根记录、脏实体版本和
`checkpointHeads(accountId, checkpointSlotId)` 指针在同一 `readwrite` 事务。完整
checkpoint 不得每事件复制，改为不可变页面和结构共享：页面最多 512 KiB，单轮合并
最多 2 MiB，可提前在 Worker 后台写入；最后用小事务原子切换该 slot 的不可变
checkpoint 根和 durable cursor。失败或废弃根产生的孤立页面由后台 GC 清理。

不同 window 绝不能共享一个账户级“最新 checkpoint”。同账户两个 slot 可以指向不同
观察集合和 cursor，任一 slot 更新不得覆盖另一个。当前 document 可把最新不可变
`checkpointId` 作为 seed 指针放在 `sessionStorage`；reload 或 `window.open()` 即使复制
了该 seed，也只能作为新 document 的只读缓存起点，注册后必须取得新的
`windowInstanceId + checkpointSlotId` 才能推进 head。旧 slot 在对应 ACK lease 过期且
不再作为 seed 后才可 GC。

当前浏览器不支持 strict durability 时，不得谎报 durable ACK：保持内存
`appliedCursor`，使用旧协议或执行权威校准。IndexedDB 也可能被用户清站点数据、浏览器
存储压力或隐私模式驱逐；`navigator.storage.persisted()` 为 false 是正常环境，不是
错误。新 document 没有兼容 checkpoint 时必须返回 `resyncRequired` 并从官方历史校准，
不能假设服务端事件日志仍保留从 0 开始的所有 payload。

`windowInstanceId` 只活在当前 document，reload 后必须签发新 ID，不能为“续 ACK”而
复用旧页面身份。新 document 可把兼容的 IndexedDB `checkpointId` 和
`eventLogGeneration/eventCursor` 作为缓存种子提交，但这只建立新的 ACK lease；服务端
仍验证 generation/保留窗口并重放或返回 `resyncRequired`。旧 window 的 ACK lease 在
连接关闭或心跳租约过期后失效，不能让崩溃标签把日志保留时间无限延长。

握手不能只返回当前 cursor 数字。服务端还必须明确本代日志的保留起点，以及客户端给定
seed 是否可连续重放；以下两种情况一律返回机器可读的 `resyncRequired`：

- 客户端 ACK/seed 的 `eventLogGeneration` 与当前代际不同。服务端不得推进旧 lease，
  客户端也不得把旧 ACK 被拒绝误报成持久成功；现有 checkpoint 只能暂时维持只读画面，
  随后走权威校准。
- 日志重建后当前 `eventCursor` 即使恰好为 `0`，新 document 没有 checkpoint 也不能
  假设“从零重放”等于完整历史。若当前 canonical 状态包含重建前实体，或日志保留起点
  不是本代第一条完整状态，必须先校准；空日志不证明空对话。

10,000 个固定种子的离线组合故障模型实际命中了 52 次旧代际 ACK 拒绝、5 次不兼容
checkpoint 和 2 次“重建后空 seed”校准。最初模型把后两类误当作可从零重放，随即产生
缺失 canonical Item；加入上述 handshake 后所有场景才收敛。该结果证明协议必须显式
表达 resync，不代表生产已经实现。

线程 payload 过滤不能在账户游标上制造隐式跳号。对 `[N+1, M]` 的实时/重放响应，每个
window 必须收到连续 envelope：

- 当前观察线程、该 window 持有的提交及账号级小摘要发送 `full` canonical event。
- 其余事件发送不含正文的 `skip` envelope，但仍携带相同 `eventCursor`。
- 新观察一个此前 skip 的线程时，先写入/返回 `subscriptionBarrier` 并按 §8.4 做带栅栏
  校准，再接收后续 full 事件。

因此 ACK 表示“连续处理了 full 或 skip envelope”，不是“见过账户所有正文”。服务端
可按当前观察集合重建重放区间；客户端不得把合法 skip 当成缺帧。

`subscriptionBarrier` 是持久事件日志中的控制记录，自己占用一个账户 `eventCursor`，
不能只作为易失 RPC 响应。观察集合切换必须按以下顺序执行：

1. 保持旧观察集合，记录 `baseCursor`，经同一 App Server 连接读取新线程权威快照；
   读取期间到达的事件继续写日志并按旧集合投递 full/skip。
2. 快照响应的顺序边界确定后，在账户摄取队列中原子追加
   `subscriptionBarrier(fenceCursor, nextObservationRevision)`。该 barrier 之前的事件
   属于旧观察集合和本次校准，之后的事件留在日志中等待新集合。
3. window 连续应用旧集合 envelope 到 barrier，并把 checkpoint、durable cursor 和
   barrier ACK 持久化；未完成这一步不得应用新集合。
4. 经统一 Reducer 应用截至 `fenceCursor` 的 canonical calibration，再激活新的观察
   revision，最后按新集合投递 `(fenceCursor, currentCursor]` 的 full/skip envelope。
5. 快照读取或 barrier 后应用期间 `eventLogGeneration/runtimeEpoch` 改变时，废弃校准
   且不激活新集合；保留现有 Store，只能从新代际重新建立 barrier。

这保证此前对新线程收到的 skip 不会被误当成正文已经加载，校准期间 barrier 之后到达的
事件也不会丢失。

事件日志是短期增量重放层，不是第二份完整 transcript。Codex JSONL 和 WFL 只读索引仍
保存大工具输出、Diff 和终态正文的持久权威内容；事件日志只内联重放所需的增量和状态
转换。若终态重复携带已经由连续 delta 表达的完整正文，canonical 事件只保存终态、
内容摘要和实体引用，不再复制整段正文。若无法证明 delta 完整，必须写校准 barrier，
不能用摘要冒充正文。

事件日志建议：

- SQLite WAL、`synchronous=FULL`，按账户分区；同步数据库调用必须在独立存储
  executor 执行：managed 多用户使用每 UserRuntime sidecar，legacy 单用户可使用
  Worker thread；不得阻塞后端事件循环。
- 单次事务最多 16 条、累计最多 64 KiB 明文 payload，最迟 4 ms 提交；达到任一上限
  就立即 flush。审批、终态和提交回执可以提前 flush。
- 单条内联 payload 上限 64 KiB；超过后不参与普通 batch，事务性写入
  `calibrationRequired` barrier。
- 单账户实际数据库字节硬上限 64 MiB。正常情况下争取保留最近 30 分钟，并在小事件
  场景尽量保留 50,000 条；时间、条数和慢客户端 2 小时都是软目标，不能覆盖字节硬上限。
- 超限前压缩可替代进度事件，绝不压缩终态、审批、提交和文本 delta。
- 接近硬上限时先压缩可替代进度；仍不足时为落后 window 写入明确 resync fence、
  返回 `resyncRequired` 并结束其旧 ACK lease，再回收 fence 以前的 payload。不得为
  保留慢 ACK 无界增长，也不得静默制造 cursor 空洞。
- 单个不可压缩事件超过记录上限时，事务性写入 `calibrationRequired` barrier 和规范
  实体引用，等待持久历史可读后走 §8.4；不得截断正文后伪装成完整事件，也不得静默跳过。

开发机上的有界存储探针使用 ext4、Node 22.23.1、SQLite 3.51.3、WAL +
`synchronous=FULL` 和 AES-256-GCM 账户 AAD。三次重复共写入 9,888 条/79.125 MiB
明文输入：

- 256 B × 16 条事务 P95 为 3.519-4.239 ms。
- 4 KiB × 16 条事务 P95 为 4.465-5.985 ms。
- 64 KiB × 1 条事务 P95 为 2.878-3.407 ms。
- 256 KiB × 1 条事务 P95 已升至 21.326-31.013 ms。

实际 SQLite 页面和索引开销下，50,000 条 256 B 事件外推约 48.447 MiB；4 KiB、64 KiB
和 256 KiB 事件分别约 241.089 MiB、3,201.294 MiB 和 12,670.898 MiB。这证明
50,000 条只能是小事件尽力目标，也支持 64 KiB 内联/事务字节上限。五个真实子进程
`SIGKILL` 点验证：event、source mapping、task state、account cursor 均在 commit 前
回滚，commit 后全部可见且同 source 重试返回既有 cursor。密钥缺失事务保持原 cursor，
明文哨兵未出现在数据库/WAL，所有文件为 `0600`。

这些数据不是生产 P95 或密码学审计。Node 内置 SQLite API 当前仍为 experimental；
正式实现必须选定可维护的绑定并放入独立存储 executor：managed 多用户采用每
UserRuntime sidecar，legacy 单用户可用 Worker thread；候选环境还须重测
SQLite/IndexedDB、多账户公平调度、checkpoint 和真实 payload 分布。

当前所有 `UserRuntime` 共存在同一个主 Node 进程，但每个用户已有独立 Bridge/App Server
子进程和 `stateDirectory`。事件日志不能由主线程同步写，也不能把所有用户串到一个
不可抢占的全局 Worker：

- 多用户模式为每个活跃 UserRuntime 懒加载一个独立存储 sidecar 子进程和用户数据库，
  以该用户 UID/GID 启动；空闲且无 ACK lease 后可关闭，重开时从 WAL 恢复。
- legacy 单用户模式可使用独立 Worker thread，但接口、队列和崩溃语义必须相同。
- 打开数据库前校验真实路径位于该用户 `stateDirectory`、不是符号链接，属主 UID/GID
  匹配且数据库/WAL/SHM 均为 `0600`；不满足时只降级该用户并报告，不能自动接管。
- 主进程与 sidecar 间每 UserRuntime ingress 队列使用 48 条/3 MiB 高水位、
  32 条/2 MiB 低水位和 64 条/4 MiB 硬上限。到高水位即暂停该用户 Bridge stdout；
  降到低水位再恢复，其他用户 Bridge 不受影响。
- 高低水位间的余量只吸收已经解析或 IPC 在途事件。若单个不可压缩事件会越过硬上限，
  先把它转换成小型 `calibrationRequired` barrier；已接受业务事件不得丢弃。
- 同一用户保持 App Server 源顺序，终态不能越过更早 delta。多项目共享一个账户 cursor，
  通过 64 KiB 事务/barrier 控制最长阻塞，而不是重新排序。
- sidecar 卡死、退出或 SQLite readiness 失败只把该 UserRuntime 标为 storage degraded，
  停止新的持久 ACK/提交接受并触发恢复；管理员和其他用户会话继续可用。

实际 Worker thread 调度探针以已测事务量级模拟服务时间。连续九轮中，一个用户先排入
64 个 64 KiB 事务时，另一个用户终态在全局 FIFO 后完成需 202.196-205.922 ms；账户
轮转降为 4.928-5.860 ms。但当第一个用户已经进入不可抢占的 50 ms 事务，单公平 Worker
仍需 52.023-52.756 ms；独立 UserRuntime executor 为 1.532-2.116 ms。这证明轮转只能
解决 backlog 公平性，不能替代每用户故障隔离。该探针模拟存储耗时，不是 SQLite P95；
正式 sidecar 仍按故障矩阵验收。

预实现 sidecar 探针进一步用两个真实非 root UID/GID 子进程、两个 owner-only
`stateDirectory` 和两个 SQLite WAL 数据库验证该边界。五次独立执行的 15 轮中，B
用户空载终态提交为 1.370-5.826 ms；A 用户每轮同时排入 64 个事务、每事务
16 × 4 KiB 时，B 为 2.378-8.649 ms，并在 A 只完成 3-6 个事务时返回。A 被
`SIGSTOP` 时 B 仍在 3.270-4.697 ms 提交，被 `SIGKILL` 后 B 为
2.157-4.259 ms；A 以原 UID/GID 重启后恢复 cursor 3,072 且
`integrity_check=ok`。跨 runtime 数据库路径被拒绝，两个
`stateDirectory` 为 `0700`，数据库/WAL/SHM 均匹配各自 UID/GID 且为 `0600`。

后四次带计数执行中，A 的 192 个 IPC 请求有 177-178 次 `child.send()` 返回 false。输入最终
排空不等于发送路径安全；正式父进程必须在每 runtime 高水位停止读取/发送，并等待
callback 和低水位恢复。该探针每轮只有 4 MiB 输入，事件表也省略加密台账组合事务；
它证明进程、凭据、路径、IPC 和普通磁盘竞争下的预实现隔离可行，不证明生产 Bridge
水位、饱和物理磁盘、cgroup 资源边界或候选 P95。

Epoch 改变不代表浏览器立即清空 Store。先读取提交台账和持久任务状态，再对活动线程
执行权威校准。

## 7. 规范化 Reducer

实时事件、事件重放、分页历史和权威快照必须进入同一个纯 Reducer。禁止各调用路径
直接修改 `activeThread.turns`。

Reducer 不变量：

- Thread 和 Turn 按 canonical ID 唯一。
- Item 按 canonical ID 唯一；source key 可多对一。
- 状态只允许单调前进。
- `completed` 不得被晚到 `started` 覆盖。
- authoritative snapshot 可删除已确认不存在的持久项，但不能删除尚未裁决的 live 项。
- delta 只应用一次且必须连续；缺口触发重放。
- summary 只能补空，不能缩短 full 内容。
- DOM 是 Store 的投影，不参与去重。

建议实体结构：

```text
threadsById
turnsById
itemsById
turnOrderByThread
itemOrderByTurn
sourceKeyToCanonicalItem
submissionsById
upstreamEventToCursor
eventLogGeneration
appliedEventCursorByWindow
durableEventCursorByWindow
```

`probe-canonical-reducer-reference-model.mjs` 把上述结构实现为唯一 `dispatch()` 入口，
实时 `msg_*`、事件重放、JSONL `response_item`、快照 `item_*` 和 full calibration
全部生成同一种 action。固定 4,096 个种子共处理 167,251 个 action、28,758 个随机逻辑
Item；live/snapshot/JSONL 三类 source 最终仍为 28,758 个 canonical key。模型阻止
54,542 次 Item 终态回退和 81,215 次 Turn 回退，且文本相等身份比较次数为 0。

定向反例进一步验证：同 `clientSubmissionId` 的 optimistic/官方用户 Item 合并到同一
key；两个相同内容但不同提交 ID 的用户消息保持两条；live/snapshot ID 分叉后折叠状态
仍绑定原 canonical key；`prepared|sent|unknown` 项不会被无关 full calibration 删除；
映射候选不唯一时保留 `ambiguousProjection`，而不是按文本猜测删除。两次固定种子证据
摘要为同一 SHA-256。该脚本不执行当前生产 Reducer/DOM/IndexedDB，只证明身份、单调和
校准规则内部一致；阶段 2 的影子 Reducer 仍须用真实五层投影做差异验收。

IndexedDB checkpoint 可能包含会话正文，必须按账户和 schema 分区，设置总字节、单线程
Turn 数和过期上限；登出、撤销账号或切换所有者时清理对应分区。敏感账户可关闭正文
checkpoint，只持久 cursor 和最小实体摘要，代价是 reload 后执行权威校准。checkpoint
永远是缓存，不因本地时间更晚而覆盖事件日志或官方历史。

初始默认逻辑预算为每账户 8 MiB、最多 8 个线程、每线程最近 80 个 Turn、非活动 7 天
过期，并且每个活动 slot 最多保留两个可达 checkpoint 根；这些值是评审项，不是
浏览器 quota 推断。
每个根记录逻辑 payload 字节，GC 和登出清理按账户 key range 执行并验证其他账户仍可读。
LevelDB 删除可能只写 tombstone、不会立即缩小物理文件，因此配额只按可达逻辑字节裁决；
`navigator.storage.estimate()` 只做压力遥测，不能当作清理完成条件。超过预算时降级为
摘要 checkpoint 并在下次 document 注册时要求校准，不能保留一个缺正文却声称可独立
恢复的高 cursor。

开发机临时 Chromium profile 的 strict IndexedDB 探针连续三次得到：

- 32 KiB/32 实体事务 P95 5.5-8.4 ms，P99 6.8-9.1 ms。
- 512 KiB/128 实体事务 P95 22.0-23.4 ms。
- 2 MiB/256 实体事务 P95 45.0-49.2 ms。
- 显式 abort、三次 Worker 中途终止和一次 renderer crash 都为全回滚，未出现半
  checkpoint；reload 和整个浏览器重启后 cursor 42/10 个实体仍可读，document nonce
  每次改变。
- 账户 A 清理后实体/根/head 均为 0，账户 B 的 7 个实体和 cursor 47 保留。
- 同一账户两个并发 slot 分别保持 cursor 62/73；更新 slot A 后 slot B 未变化。

测试 Chromium 的 `navigator.storage.persisted()` 连续为 false。15.625 MiB benchmark
逻辑随机数据连同原子性/slot 夹具使 origin 用量增加 20.694-28.741 MiB；
abort/crash/删除并重启后估算仍为 39.473-41.490 MiB，证明物理回收和逻辑删除不同步。
探针不执行生产 Store；正式版本仍
须在真实移动浏览器、存储压力和多账户切换下验证。

## 8. 重连和恢复

传输层先采用显式 socket generation 状态机。每次连接都有唯一 generation，只有当前
generation 可以更新 Store、连接状态或 RPC；retired generation 的消息一律忽略并
释放其观察租约。浏览器发起的 close 只能使用 1000 或应用自定义的 3000 至 4999，
不能发送只允许接收的保留码 1001/1012。`offline` 关闭 intent、实际 close event 和
online 重连调度是三个独立事实：

- 先原子地把 generation 标为 retired，再拒绝/裁决该 generation 的 pending RPC。
- 使用合法自定义码发起 best-effort close；即使调用抛错或网络无法完成关闭握手，
  也必须在 `finally` 完成状态迁移，不能依赖 close event 才允许 online 重连。
- online 只创建一个新 generation；并发 online、visibility 和 timer 通过 single-flight
  合并。旧 generation 即使仍处于 OPEN/CLOSING，也不得继续持有观察租约。
- 收到网关 1012 表示受控服务重启，但业务 RPC 仍按是否已发送进入 accepted/unknown
  裁决，不能仅凭 wasClean 假定未执行。

### 8.1 同 Epoch 普通重连

1. 建立新 `connectionId`。
2. 客户端发送 `clientInstanceId`、本页内存中的 `windowNonce`、已有服务端签发的
   `windowInstanceId/checkpointSlotId`（仅同 document 重连）、`checkpointId`、
   `eventLogGeneration`、durable `eventCursor`、活动线程和待裁决提交。
3. 服务端为新 document 签发新 `windowInstanceId`；同 document 重连只能续租匹配
   `clientInstanceId + windowNonce` 的原 window/slot，不能接受 reload 后冒用；新
   document 即使提交旧 checkpoint seed，也必须取得新的 window/slot。
4. 服务端返回连续 full/skip envelope 并重放缺失事件；generation 不匹配或游标已淘汰
   时返回 `resyncRequired`。
5. 浏览器继续使用现有 Store 和 DOM，不调用 `thread/resume`。
6. 恢复完成后再启用发送。

目标 P95 为 1.5 秒，200+ MB legacy 线程为 2.5 秒。

当前受控基线中，offline/online 和网关 1012 重启在 Epoch、服务端序号都不变时已经不调用
`thread/resume`、`thread/list` 或 `thread/turns/list`，消息 DOM 也没有增删。断线期间由
另一个线程产生 6 条通知后，Epoch 不变但账户序号从 1 推进到 7，原页面会对当前活动线程
执行一次 `thread/turns/list`，耗时 1.69-1.92 秒；它没有重放那 6 条缺失通知。

这证明现有无缺口路径没有主动重读历史，但不能视为本节目标已经实现：客户端仍没有
durable ACK 和缺口重放，账户级序号推进会误触发无关当前线程的 full 校准，offline 还会
因非法 1001 留下两个 OPEN socket，已发送 RPC 也没有裁决语义。

### 8.2 Epoch 改变

1. 保留当前 Store 为可见只读状态。
2. 读取提交台账、任务状态和最后持久事件。
3. 对活动 Turn/最近 Turn 进行分页权威校准。
4. Reducer 生成最小差异。
5. 只更新变化节点，不显示误导性的“全部聊天记录已恢复”。

当前受控基线在主后端槽切换后保持同一个 browser WebSocket 和同一个 document，但
`runtimeEpoch` 改变并执行模型、配置、能力、线程列表、权限、协作模式、
`thread/resume` 和 Goal 的完整 bootstrap，耗时 1,132-1,342 ms。小线程没有消息 DOM
增删或 toast，全程也只有一次 navigation，因此它不是页面 reload；本节要求把这类
重量级 bootstrap 收敛为提交/任务恢复后的有栅栏权威校准，且不能把“当前小线程未重绘”
外推为长线程不会闪烁。

### 8.3 序号缺口

相同 `eventLogGeneration` 中，只要 incoming envelope 的
`eventCursor > lastApplied + 1` 就是缺口；`skip` envelope 也连续占用一个 cursor。
上游序号不参与这个判断。当前代码只过滤 `incoming <= lastApplied`，必须更改。缺口
期间允许滚动和复制，但发送进入“正在同步”，直到重放或校准完成。

重连握手中的 `eventSequence > previousSequence` 只能说明断线期间至少有账户事件，不等于
当前线程缺少快照。应先按账户日志重放并由 canonical reducer 按 Thread ID 路由；不能因
其他线程推进账户游标就读取当前线程的 recent full 快照。

### 8.4 权威校准栅栏

快照读取可能持续数秒，期间通知仍在到达。不能在读取结束后直接用快照覆盖 Store：

1. 后端创建 `calibrationId`，记录请求前
   `eventLogGeneration/baseCursor` 和 `runtimeEpoch`，继续把后续事件写入日志。
2. 通过同一 App Server 连接请求快照；RPC 响应到达时记录同一 log generation 的
   `fenceCursor`。该连接上已观察到的通知顺序就是校准栅栏。
3. 服务端生成带 `baseCursor/fenceCursor` 的 canonical calibration，不删除未裁决
   live/unknown 项。
4. 浏览器先经同一 Reducer 应用校准，再幂等重放 `(baseCursor, fenceCursor]` 和之后的
   事件；不能把快照直接赋值给 `activeThread.turns`。
5. 事件日志已经越过 `baseCursor` 时，保留当前 Store 为只读并请求新的栅栏，不使用
   无法排序的旧快照。
6. 校准期间 `eventLogGeneration` 或 `runtimeEpoch` 改变时立即废弃本次结果，从新的
   generation/Epoch 重建栅栏；不同 generation 的 cursor 绝不比较大小。

这样即使快照包含了读取期间已经持久化的部分事件，重放也只会幂等合并；如果快照尚未
包含某个实时 Item，重放仍会恢复它。

`scripts/conversation-diagnostics/probe-event-log-reference-model.mjs` 用纯内存固定种子
模型反证了上述顺序。默认 512 个种子覆盖 17,700 条事件、2,893 次上游 Epoch 代际和
1,505 个超预算 barrier；定向场景得到
`full, skip, full, skip, barrier, full` 的连续 cursor。模型还验证 Epoch 变化会废弃
校准、reload 签发新 window、事务内崩溃不留下半提交、提交后部分广播可通过幂等重放
恢复。它不执行生产代码，只证明 ADR 不变量内部一致；现网通过仍需实现后的故障注入。

`probe-conversation-fault-matrix.mjs` 再把 drop、duplicate、reorder、delay、
disconnect 和 restart 组合到同一离线模型。默认 10,000 个固定种子累计提交 242,587
条事件，触发 26,419 次 cursor 缺口、16,149 个重复/晚到帧、5,236 次 App Server
重启、762 次日志代际重建和 6,000 个保持 `unknown` 的提交；两次完整运行输出摘要
一致。模型要求每个客户端最终经范围重放或权威校准与服务端 canonical 投影一致，旧
代际 ACK 不推进 lease，reload 不复用 window，`unknown` 不跨 Provider 重放。它仍不
执行生产 Reducer、SQLite/IndexedDB 或真实队列，因此不能替代候选实现的 10,000 次
正式验收。

`probe-browser-reconnect-reference.mjs` 又把上述规则放进真实 headless Chromium
WebSocket，而不是继续只用内存客户端。三次固定场景均创建 4 个 transport generation，
最终只有 1 个活动 socket；一次 deliberate offline 先 retire 旧 generation，再使用
合法应用码 4001，10 个并发 online 入口有 9 个加入同一 single-flight。旧 generation
注入帧被拒绝，同 document 的服务端 `windowInstanceId` 在所有重连中保持不变。两次
服务端 1012 都只新建 transport，没有使用客户端保留码。

同一 `eventLogGeneration` 下，断线期间 3 条事件通过 hello range replay 恢复；实时
故意漏掉 cursor 5、先收到 cursor 6 时只发起 1 次范围重放并收敛到 cursor 6。这两种
路径的 `thread/resume`、完整 bootstrap 和 calibration 次数均为 0。随后服务端更换
event-log generation/runtime Epoch 才进入 calibration：第一份快照期间再次换代，
旧结果被丢弃；第二份快照 fence 前写入 cursor 1，响应后写入 cursor 2，浏览器在
25 ms 模拟应用延迟中缓冲二者，最终清空 buffer 并与服务端 8 个 canonical 实体一致。

该探针证明 socket generation、single-flight、连续重放、缺口重放、代际校准和 stale
fence 丢弃能够在真实浏览器消息调度下组合执行，但不执行当前 `app.js`，cursor 也只在
内存。它没有验证 IndexedDB durable ACK、提交台账和 pending RPC 裁决、日志淘汰、
reload/new-window、代理超时或真机后台。生产接入和候选故障矩阵仍是独立门槛。

### 8.5 Goal、Provider 和错误分类

Turn 重试入口必须先把错误归一为互斥类别，再决定是否恢复：

| 类别 | 例子 | 自动动作 |
| --- | --- | --- |
| `connectivity` | stream/connection 变体无 4xx，或 408/425/可重试 5xx | 同一提交内有界重试；达到上限后暂停，可按有界退避恢复或切换供应商 |
| `quota` | `usageLimitExceeded`，或任一 HTTP 变体状态码 429 | 标记额度暂停；不得进入连接无限重试；等待明确额度刷新或用户切换 |
| `credentials` | `unauthorized`，或任一 HTTP 变体状态码 401/403 | 保留账号/配置资料并标记失效；停止自动请求，等待重新登录或用户切换 |
| `policy` | `badRequest`、`cyberPolicy`、`sandboxError`、套餐或管理员策略拒绝 | 明确拒绝，不自动重试或切换身份 |
| `unknown-delivery` | App Server 写入后 RPC 结果丢失 | 进入提交台账裁决，禁止换供应商重放 |

优先读取官方 camelCase `error.codexErrorInfo`；对象变体中的 `httpStatusCode` 优先于
变体名称。`responseTooManyFailedAttempts` 有状态码时按状态码归类，无状态码时进入
人工检查，不能假定为连接。只有结构化字段缺失时才允许受限的文案 fallback，无法确认
时归为 `unknown`，绝不默认加入无限重试。

错误分类必须在 `TurnRetryLimiter` 之前或成为其输入，不能等到供应商目标检查才分类。
只有 `connectivity` 有资格设置 `resumeWhenAvailable=true` 和
`suspendedReason=provider-unavailable`。无限重试仍必须采用有上限的频率阶梯与抖动，
且后台/前台切换不能重置累计退避。App Server 的 `willRetry=true` 只描述 Codex 当前
内部重试状态，不授予 WFL 自动恢复或切换供应商资格。

手动 after-Turn 暂停只禁止后续 Turn，当前已接受 Turn 继续到终态；immediate 暂停才
尝试中断。手动暂停清除所有连接恢复 timer。供应商只能在账户运行时空闲且 Goal 已
稳定暂停后切换；继续前验证供应商、模型、额度和凭据，并记录 before/after。切换只
影响新的 `clientSubmissionId`；任何 `sent/unknown` 旧提交必须先按 §5.2 裁决。

## 9. 增量历史索引

WFL 为 legacy JSONL 建立只读 sidecar：

- 以设备、inode、文件大小、mtime 和头部摘要识别源文件。
- 保存最后安全换行偏移和该偏移前的尾部 anchor 摘要，增量扫描新增记录；未完成末行
  只记录为 trailing bytes，补齐换行前不得进入索引。
- 索引 `turn_context.payload.turn_id` 边界、用户 `clientId`、
  `response_item.id`、角色、阶段、字节区间和 HMAC 摘要；正文仍只存在原 JSONL。
- 原文件缩短、设备/inode 改变、头部摘要或已索引尾部 anchor 不匹配时废弃并后台重建。
- 原文件权限、UID/GID 校验失败时只报告，不修复或接管。
- sidecar 可随时删除重建，不是持久历史权威。
- managed 用户仍按 §6 使用各自 UID/GID 的 `UserRuntime` sidecar；legacy 单用户索引
  至少移到独立 Worker，不能用同步 SQLite 和 JSON 解析阻塞主后端事件循环。

提交去重首先查台账，其次查增量索引，不再执行完整
`thread/read(includeTurns:true)`。

普通打开线程先返回索引中的最近 Turn 摘要，再异步请求官方页校准。不要仅为了查看
执行重量级 `thread/resume`；只有用户要继续写入或官方订阅不存在时才 resume。

0.146 真实 rollout 的只读结构快照为 232,099,377 字节、81,715 行、零损坏行，最大
单行 2,625,474 字节；其中 55,968 行 `response_item`、24,914 行 `event_msg`、
467 行 `turn_context`。用户 `client_id` 位于 `event_msg:user_message`，Item ID、
角色和阶段位于相应 `response_item` payload。该扫描只汇总类型和字段名，没有输出或
复制正文。当前 `scanCodexGoalRollouts()` 虽然使用流式逐行读取，但每次最多仍会线性
扫描 512 MiB，且没有安全偏移、Turn 索引或分页结构；它只适合现有 Goal 启动恢复，
不能充当本节的历史 sidecar。

`probe-legacy-history-index.mjs` 在私有临时目录实现了该 schema 的预实现模型。四次各自
建立 55,270,771 字节、29,561 行、5,912 个 Turn 的 SQLite
WAL/`synchronous=FULL` 索引，包含 2,831,371 字节单行；首次建立总耗时为
1,144.119-1,285.193 ms，核心扫描为 899.128-1,002.334 ms，满足每 50 MiB 不超过
2 秒的开发机预算。2,173 字节未完成末行在四次初扫中均未被索引，补齐换行后与后续
12 个 Turn 只扫描旧 safe offset 之后的 61,635 字节。

同一探针还验证：

- 截断、inode 替换和头部改写分别触发完整重建。
- `0640` 模式和预期 UID 不匹配在打开 sidecar 前拒绝，原模式和属主不被修复。
- Turn 摘要向前、向后各分页 8 条，不调用任何官方 RPC。
- sidecar 只含 HMAC-SHA-256、协议枚举和字节区间，数据库中不存在正文哨兵。
- `SIGKILL` 发生在 rows/checkpoint commit 前时全部回滚；commit 后被杀时两者都恢复，
  重试新增 0 行。

这仍是合成数据和 Node experimental SQLite 上的预实现证据。它不读取真实正文，不是
生产 sidecar，也没有证明 200+ MiB 候选、多 UserRuntime 公平性、饱和磁盘或 Codex
未来格式兼容。其快速增量判断依赖 rollout 的 append-only 契约；任意位置原地改写若不
改变头部或已索引尾部 anchor，必须由更强的分块摘要/重建策略处理，不能静默声称完整。

## 10. 背压

每个方向使用独立有界队列：

| 队列 | 消息上限 | 字节上限 | 超限动作 |
| --- | ---: | ---: | --- |
| 后端 -> 浏览器 | 256 | 4 MiB | 合并进度；否则关闭慢客户端并要求重放 |
| 浏览器 -> 后端 RPC | 128 | 1 MiB | 拒绝新 prepare，已有提交不丢 |
| 后端 -> App Server stdin | 128 | 1 MiB | 等待 `drain`，超时进入 unknown |
| App Server -> 后端解析 | 128 | 8 MiB | 暂停 stdout，恢复后继续 |
| UserRuntime -> 存储 sidecar ingress | 48 高/64 硬 | 3 MiB 高/4 MiB 硬 | 只暂停该用户 stdout；32 条/2 MiB 后恢复 |

所有 WebSocket send 使用 callback，并持续记录 `bufferedAmount`、队列深度、最大等待
时间和丢弃的可压缩事件数。一个慢客户端不能阻塞同账户其他客户端。

当前 8 MiB 隔离基线已经证明不能只验收快客户端延迟：暂停一个客户端时，快客户端仍在
257-371 ms 完成，但直连后端 RSS 增加 20.8-23.2 MiB，或临时网关 RSS 增加
19.9-21.5 MiB。假 App Server 完全停读 stdin 时，主后端又在 123-134 ms 内接收
128 个/8 MiB RPC，全部无结果并增加 33.8-35.3 MiB RSS，同时 readiness 仍误报全绿。
候选实现必须同时断言：

- 快客户端延迟在预算内。
- 慢客户端达到 4 MiB/256 条预算后停止继续排入普通业务事件。
- 终态、审批、提交回执和文本 delta 不被静默丢弃；关闭慢端时返回可重放原因。
- 同账户其他客户端、网关和后端 RSS 不随慢端输入继续无界增长。
- App Server stdin 写入返回 `false` 后暂停新写并等待 `drain`；等待超时的已发送 RPC
  进入 `unknown`，不得作为未执行自动重发。
- stdin 堵塞期间 readiness 报告写通道 degraded，并暴露队列消息数、字节数和最老
  等待时间；不能只根据子进程仍存活和上一次 `thread/list` 成功判定 ready。

## 11. 渲染

- 最近窗口默认只挂载 8 个 Turn，早期 Turn 用固定高度占位和滚动锚点。
- 文件修改、命令、工具输出和推理默认仅渲染标题、状态和统计。
- 关闭状态不得解析 Markdown、语法高亮或 Diff 行，也不得创建明细 DOM。
- 展开后分批挂载，首批最多 500 行；继续滚动再加载。
- 每帧主线程预算 8 ms，超过后让出。
- Store 更新按 canonical key 生成最小 DOM patch。
- 新流式 Item 在首条 delta 前按 canonical key 建立轻量骨架；目标节点缺失时不得退化
  为整个窗口的 `renderMessages()`。
- canonical Store 始终保留原始助手文本。若产品启用 Markdown，解析和消毒属于可见层
  的增量投影，工程文件引用从 token/AST 生成；流式和终态必须复用同一节点结构，不能
  在终态把整段 `textContent` 替换成另一棵 DOM。
- 折叠、滚动、未读和搜索位置按 canonical ID 保存，不受 source key 改变影响。
- Item 维护单调 `revision`；渲染层比较 key/revision，不在每次 render 深序列化和哈希
  全部 source。
- 历史缓存移到 Worker + IndexedDB，禁止在流式或终态事件处理路径同步序列化数 MiB
  数据到 `sessionStorage`。
- 发送按钮只由 `transportState`、`syncState`、`submissionState` 和权威 `turnState`
  的 selector 派生；事件处理器不得直接互相覆盖按钮状态。
- composer 维护显式 `compositionActive`。`compositionstart` 到 `compositionend` 期间，
  以及 `event.isComposing`、`keyCode=229` 或 `key=Process|Dead` 时，Enter 都不得创建
  submit intent；组合结束后的独立 Enter 才是新手势。

`probe-on-demand-render-reference.mjs` 将这些渲染约束实现为不加载主站的隔离 Chromium
参考原型。三次运行都以 80 个 Turn、20,000 行 Diff、2 MiB 工具输出和 512 KiB 推理
正文为夹具：关闭时只挂载最近 8 个 Turn/56 个元素节点/78 个全部节点，三类正文读取和
明细节点均为 0；展开 Diff 时 Worker 解析为 1.8-2.6 ms，主线程以每批 10 行挂载
首批 500 行，工具预览再按每帧 8 KiB 挂载；全部主线程切片最大为 0.5-0.6 ms，
页面为 558 个元素节点/1,081 个全部节点且无 Long Task。继续加载第二个
500 行页面不再次读取原始正文；收起后明细节点回到 0，重新展开仍使用 Worker 缓存，
原始内容始终保留在 Store。

同一模型把 live 和 snapshot alias 映射到同一 canonical key 后，打开的 Diff 节点、
500 行内容和折叠状态均未替换；100 次流式 patch 增加 0 次全量 render，单次最大
0.1-0.2 ms。向历史前方插入 16 个 Turn 时保持原节点和 canonical 未读 key，滚动 anchor
三次位移均为 0 px。这证明本节的虚拟窗口、正文引用、Worker 投影、分批挂载和稳定 key
能够组合执行。

该模型不执行当前 `app.js`，不代表生产 UI 已修复，也没有覆盖 Markdown 消毒、
选区/搜索、无障碍、Worker 崩溃、内存压力、真实手机或候选版本性能。实现时仍必须用
相同夹具比较生产 DOM，并在 Worker 失败时保留 raw canonical 内容、清除派生缓存后允许
重新展开；不得退化为主线程一次性解析全部正文。

## 12. 订阅

浏览器选择线程与运行任务生命周期分离：

- `client/state` 只表示 UI 当前观察对象。
- 服务端维护每客户端的精确观察集合，切换为 replace 操作，不是只 add。
- 每个异步选择创建 selection lease；过期结果在返回前必须释放对应 lease。
- 任务运行时即使观察引用为零也不 unsubscribe。
- 最后观察者离开且任务空闲后进入 10 秒重连宽限，再调用官方 unsubscribe。
- 多设备各有独立 ACK 和观察集合。
- 线程事件只发送给观察该线程或持有该提交的客户端；账号级任务中心收到有界摘要，
  不把所有大 Item 广播给所有标签页。
- 过滤只改变 envelope 是 `full` 还是 `skip`，不能省略账户 `eventCursor`。新观察线程
  必须先建立 `subscriptionBarrier` 并校准，防止先前 skip 的内容被误当成已加载。

### 12.1 写租约

页面观察身份、提交身份和写租约身份分离：

- lease owner 使用服务端签发的 `windowInstanceId`，不能信任可由新标签复制或客户端
  任意复用的 session storage 值。
- 长任务租约由 `(threadId, clientSubmissionId/turnId)` 持有，不依赖页面连接存活。
- 同 owner 可重入获取必须返回独立 child token 或递增引用计数；释放短写只减少自己的
  引用，绝不能删除父级长租约。
- `archive/delete/fork/settings/goal` 等短写要声明是否能与运行 Turn 并行；未明确允许
  的操作返回冲突，不能因为 owner 相同绕过。
- 进程重启从持久租约和提交台账重建活动 owner；过期清理由任务终态和硬超时共同裁决。

验收必须包含“长 Turn -> 同窗口短写 -> 另一进程争抢”的确定性测试，断言长租约直到
Turn terminal 都存在。

## 13. 遥测

新增脱敏字段：

- `browserSocketId`、`gatewayConnectionId`、`gatewayUpstreamId`、
  `backendConnectionId` 和 `appServerInstanceId`；每次上游重连必须新建 upstream/backend
  ID，但不能伪造浏览器 socket 已重连。
- WebSocket open/close/error、关闭码、原因分类、寿命、可见性和 `navigator.onLine`。
- runtime Epoch/upstream 序号、event-log generation/cursor、full/skip/ACK 游标和最大缺口。
- RPC prepare/sent/result/unknown 延迟。
- 队列消息数、字节数、`bufferedAmount` 和等待 `drain` 时间。
- 历史索引命中、扫描字节和构建耗时。
- Reducer 合并、歧义投影和 DOM patch 数量。

不采集提示或回复明文。持久状态表内部使用规范 ID；导出的诊断遥测只使用每次采集独立
密钥的 HMAC ID，不能导出原始账户/Thread/Turn/Item ID。连接 ID 只在短期诊断窗口内
保留，临时 HMAC 密钥与 trace 同期删除。

导出 schema 必须同时包含 `captureId/traceId/layer/direction/kind/layerSequence` 和双
时间戳。只有本次采集内随机、短期的连接拓扑 ID 可原样记录；账户、client、
window/checkpoint、Epoch/generation、RPC、Thread/Turn/Item/Submission ID 一律输出
分域 HMAC。关闭原因使用白名单分类，不导出任意错误正文。

纯离线 envelope 探针以固定 512 组生成并校验 9,216 行记录，覆盖 App Server 到 DOM、
同浏览器连接的网关上游重连和 reload 新 document。它能拒绝缺层、重复 layer sequence
与父连接错配，且原始 ID、提示、回复、凭据、工具输出和 Diff 哨兵均未进入 trace；
临时 NDJSON/key 都是 `0600` 并在退出时删除。该探针只冻结 schema 和隐私边界，阶段 0
仍须把默认关闭的 recorder 接入生产四层后才能采集现场证据。

阶段 0 的完整授权、主站三重门禁、浏览器回执和资源生命周期见
[Shadow Recorder 阶段 0 规范](../conversation-shadow-recorder-stage0.zh-CN.md)。
recorder 必须由 owner-local 一次性 manifest 开启，默认 5 分钟、硬上限 10 分钟；
每组件最多 4 × 4 MiB segment，内存队列最多 1,024 条/4 MiB。overflow、capacity、
过期、revoke、manifest/key 变化或 I/O 错误都只 seal trace，不得改变 socket、
Bridge、readiness 或业务返回。

离线生命周期模型已经覆盖默认关闭、10 类非法 manifest/key、scaled queue/segment
轮转、过期、manifest/key mutation、显式 revoke 和浏览器 receipt admission。注入
gateway `EIO` 后只封存 gateway recorder，backend 仍写入；业务中断、readiness 变化和
socket close 都为 0。该结果证明生命周期设计可执行，不代表生产 hook 已安全接入。

## 14. 迁移

### 阶段 0：只读观测

加入录制和指标，不改变用户行为。验证关闭码、ID 分叉率和队列峰值。

### 阶段 1：修复写租约和页面身份

先修复已证明会提前释放长租约的安全不变量，引入每 document 的
`windowInstanceId`。同时把 submit-intent guard 移到所有 await 之前，并补齐 IME
composition 状态。Turn 重试在本阶段引入 §8.5 的错误分类，立即禁止 quota 和
credentials 进入连接无限重试；该阶段不改变消息投影。

### 阶段 2：影子 Reducer 和索引

新 Reducer 与旧 Store 并行计算但不渲染；记录差异。索引后台建立，失败时回退官方读取。

### 阶段 3：提交台账和加密 outbox

先对新提交启用台账，旧客户端仍可使用 RPC，但服务端为其生成提交 ID。禁止跨 Provider
自动重放 unknown 提交。

### 阶段 4：事件日志和 ACK

先上线加密日志、原子摄取和 generation/cursor，验证崩溃边界；再对 owner/admin 灰度
full/skip envelope 与 ACK，最后按账户开启。旧客户端继续接收广播，新客户端协商协议
版本。任何阶段都不能让旧客户端 ACK 新游标或参与新日志回收。

当前候选实现使用两个互不混淆的开关：

- `CODEX_DESKTOP_CONVERSATION_SIDECAR=1` 启用加密 Sidecar、提交台账和 canonical
  日志；关闭时 rollout 必须为 `off`。
- `CODEX_DESKTOP_CONVERSATION_ROLLOUT=thread|account|all` 控制浏览器 canonical
  投影切流。`thread` 必须同时设置
  `CODEX_DESKTOP_CONVERSATION_ROLLOUT_THREADS`，`account` 必须同时设置
  `CODEX_DESKTOP_CONVERSATION_ROLLOUT_ACCOUNTS`，两者均为逗号分隔的精确 ID
  allowlist。配置为空、格式错误或 Sidecar 未启用时拒绝启动，不能静默扩大到全站。

未显式设置 rollout 但 Sidecar 已启用时，为兼容早期候选测试按 `all` 处理；正式本地切流
必须显式依次使用 `thread`、`account`、`all`。Thread 灰度只允许当前活动 Thread 进入
canonical observation；切换到 allowlist 外 Thread 时服务端先撤销该窗口 canonical
投影，再恢复 legacy broadcast，浏览器不会拿旧 Thread 的 ACK 推进新 Thread。
`npm run conversation:rollout -- --mode=...` 只以 `0600` 原子写入主站运行目录的
`conversation-rollout.env`，不会自行重启或切换服务；主站 backend unit 在下一次候选启动
时读取该文件，因此每个阶段仍必须走受检的 standby-handoff 和健康验证。

### 阶段 5：新 Store 和按需渲染

按账户功能开关启用；保留旧渲染只读回退一个正式版本。

### 阶段 6：移除全历史提交去重

台账和索引达到可靠性门槛后，删除每次 `turn/start` 的全量 `thread/read`。

### 迁移状态机的预实现证据

`probe-conversation-migration-reference.mjs` 将上述七阶段做成纯状态机，并在每阶段注入
`before-transaction`、`after-draft-before-commit` 和 `after-commit`：

- 14 个 commit 前崩溃全部保留旧状态；7 个 commit 后崩溃均在恢复时识别为已提交，
  每阶段最终恰好应用一次。
- 协议 v2 依次按 owner、admin、account 开启。协议 v1 始终走 legacy broadcast，
  服务端拒绝其 ACK，且其连接不能推进事件日志回收水位。
- 新渲染、ACK、提交入口、索引和全历史去重五层可按任意顺序回滚；120 种排列、
  600 次状态转换均不删除 schema 表、台账或 JSONL，也不把 `unknown` 跨 Provider
  重放。
- 候选启动后、兼容检查失败、切流前和切流后四个发布失败点都回到仍在运行的旧后端；
  管理员对话权限始终保留。
- 模型记录的备用窗口操作、普通服务器完整测试、浏览器冒烟和压力测试均为 0。

这是迁移条款的一致性证据，不是生产迁移实现。它不运行当前发布程序、不连接生产状态，
也没有验证真实数据库升级/降级、旧浏览器 bundle 或候选服务进程。

## 15. 兼容和数据保护

- 协议协商字段 `conversationProtocolVersion`，不支持时使用旧广播。
- 数据库 schema 仅向前追加，旧二进制忽略新表。
- sidecar 和事件日志损坏时隔离重建，不触碰 JSONL。
- 事件日志重建必须更换 `eventLogGeneration`，旧 checkpoint/ACK 一律触发 resync，不能
  在新库复用旧 cursor 数字。
- 浏览器 checkpoint 按账户限额、过期并在登出/撤销时清理；不得把一个账户的本地缓存
  用作另一个账户的恢复种子。
- 升级前只做有界兼容检查；不在普通服务器跑故障矩阵。
- 正式部署失败不得停止当前活动主后端。
- 所有迁移不读取或修改备用窗口的端口、服务、槽位和资源。

## 16. 回滚

回滚开关按层独立：

1. 新渲染 -> 旧渲染。
2. 新 Reducer -> 旧 Store，只读保留台账。
3. ACK 重放 -> 旧广播，但继续写事件日志。
4. 新提交入口 -> 旧 RPC，但已存在台账记录不得再次执行。
5. 索引 -> 官方读取。

回滚不能删除提交台账或把 `unknown` 当成失败后重放。ACK 回滚后停止接受新 ACK lease，
但日志继续写到所有已协商客户端退出或被显式 resync；事件日志和索引可以随后停止写入，
保留到确认无恢复需求后按保留策略清理。

五个回滚开关的 120 种顺序已经由上述迁移模型穷举。每一步都先查询既有提交台账，
`submission-unknown` 始终保持 Provider A、执行次数 1；ACK 回滚后仍继续 append 事件
日志，renderer 回滚只切到旧只读视图，index 回滚只恢复官方读取。该证据不能替代候选
版本对真实 schema、双版本 bundle 和服务切流的升级/降级演练。

## 17. 采纳门槛

实现 Goal 开始前必须评审并接受：

- 本 ADR 的权威边界和身份模型。
- 提交台账的 `unknown` 处理。
- 事件保留和隐私策略。
- 队列、DOM 和延迟预算。
- 备用窗口排除边界。

四种候选方向的硬门禁比较、建议方案 B，以及性能场景、时钟边界、样本量和 P95/P99
统计口径见
[会话架构决策记分卡与性能验收契约](../conversation-decision-scorecard-0.39.48.zh-CN.md)。
该记分卡仍是等待所有者接受的调查材料；本文和预实现探针都不构成自动采纳，也不授权
开始生产实现。

正式发布前必须通过
[故障矩阵](../conversation-failure-matrix-0.39.48.zh-CN.md)
的全部可靠性断言，并在开发候选环境证明 200+ MB legacy 线程不再阻塞正常提交。

移动生命周期和物理多设备必须按
[真机现场协议](../conversation-mobile-field-protocol.zh-CN.md) 验收：11 个场景各
3 次，bundle 层完整、checksum/时钟/隐私 gate 通过且有 owner 对物理设备、不同网络和
手工动作的确认。桌面 freeze、移动模拟、两个 browser context、synthetic fixture 或
单次成功都不能替代 C02/C03/S10 的现场证据。未来 ACK 协议实现后必须用同一协议重测
每设备独立 window/ACK lease。

评审必须逐项明确接受或修改：

1. `unknown` 永不自动重放，用户“作为新消息发送”可能重复的产品语义。
2. 当前上游协议下，新线程跨后端崩溃不能承诺 exactly-once。
3. 加密 outbox 的密钥来源、24 小时硬过期、到期后的
   `cancelled|unresolved-abandoned` 语义和管理员可配置边界。
4. 事件日志 64 MiB 硬上限优先于 30 分钟/50,000 条/慢客户端 2 小时软目标，以及
   64 KiB 单条/事务字节上限、16 条/4 ms batch 和落后 window 强制 resync 语义。
5. 事件 payload 的加密密钥、原子摄取失败时的 degraded/read-only 行为。
6. durable ACK 的 strict IndexedDB 要求、16 事件/32 KiB/16 ms 增量窗口、512 KiB
   后台页面、每账户 8 MiB/8 线程/80 Turn/7 天默认预算，以及 reload 后新 window、
   站点数据驱逐和旧 checkpoint 语义。
7. 按线程过滤时 full/skip envelope、subscription barrier 与连续账户游标语义。
8. canonical 映射遇到歧义时“保留两项并校准”，不做文本删除。
9. 迁移阶段、owner/admin 灰度顺序和一个正式版本的只读回退期。
