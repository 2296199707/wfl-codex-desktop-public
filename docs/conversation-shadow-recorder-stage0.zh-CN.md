# 会话 Shadow Recorder 阶段 0 规范

> 历史调查设计，未接入当前生产会话路径。不得把其中的 recorder、ACK/checkpoint 或
> canonical hook 当作待恢复功能；当前架构见
> [ADR-0002](adr/0002-app-server-conversation-authority.zh-CN.md)。

状态：调查设计；尚未接入生产代码<br>
基线：WFL `0.39.48-beta` / Codex `0.146.0`<br>
范围：仅主站；明确排除备用窗口 `1.0 / 4321`

## 1. 目标和非目标

阶段 0 只为短时、经所有者明确授权的故障调查记录脱敏元数据。它用于把浏览器、
稳定网关、活动后端和 Codex App Server 的连接与事件关联起来，不改变提交、订阅、
恢复、重试、Reducer、渲染或任务生命周期。

阶段 0 不是常驻审计日志，不是聊天记录备份，不提供事件重放，也不承担业务正确性。
recorder 不得：

- 读取或导出提示、回复、工具完整输出、Diff、Cookie、Authorization、API Key 或代理
  凭据；
- 因 trace 队列、磁盘、HMAC key、浏览器回执或分析器异常阻塞、关闭、重启或降级任何
  会话；
- 写 Codex JSONL、Codex SQLite、WFL 事件日志设计表或 OpsTrafficStore；
- 记录 `/rescue/ws`、任何 VNC WebSocket、`RESCUE_MODE=true` 后端或
  `rescue-active-port`；
- 进入安装、同步、发布、健康检查或普通服务器测试流程。

## 2. 当前接入断点

| 层 | 当前可用身份 | 当前缺口 | 阶段 0 只读 hook |
| --- | --- | --- | --- |
| 浏览器 `public/app.js` | document 内 `rpcId`、socket 对象、`socketOpenedAt`、Epoch/序号 | 无 client/window/socket ID；close 只能写 console；reload 后局部 ID 重置 | `connectSocket()` 生成 browser socket ID；`sendClientState()` 报告 client/window/socket 身份；`handleSocketMessage()` 产生有界回执 |
| 网关 `gateway.mjs` | 一个 `bridgeWebSocket` 闭包及当前 upstream 对象 | 无 gateway connection/upstream generation；不记录 close/error/队列 | 仅 `pathname === "/ws"` 时在 upgrade、`bridgeWebSocket()` 和每次 `openUpstream()` 分配 ID |
| 后端 `server.mjs` | `threadLeaseOwnerId`、runtime Epoch/eventSequence、用户 runtime | lease owner 不是连接 ID；Ops 日志缺父连接、关闭码、寿命和事件关系 | 仅 `RESCUE_MODE === false` 的主 `wss` 接收网关 ID，分配 backend connection ID，并记录广播/回执 |
| Codex Bridge | 本子进程自增 JSON-RPC ID | 无 app-server instance ID、原始通知 ordinal 或跨广播 trace ID | 每次 `CodexBridge.start()` 分配 instance ID；`handleMessage()` 只导出 method、ordinal、字节和实体 ID HMAC |

浏览器 WebSocket 不能设置自定义握手头。`clientInstanceId/windowNonce/browserSocketId`
只能先随已存在的 `client/state` 上报；网关在此之前最多保留固定大小的 open 元数据，
收到匹配 capture 后再写入。网关到后端使用内部
`x-wfl-gateway-connection-id/x-wfl-gateway-upstream-id`，但这两个头只允许回环上游，
不得从公网请求透传。

## 3. 三重主站门禁

任何一个条件不满足时 recorder 必须表现为不存在：

1. 网关只接受 URL pathname 精确为 `/ws` 且 upstream channel 为 `main`。
2. 后端只在 `RESCUE_MODE === false` 时读取 capture manifest 或创建 recorder。
3. capture manifest 必须声明 `scope.surface = "main"`；`rescue`、VNC 和通配 surface
   都是无效输入。

门禁在 recorder 初始化之前执行。不能先创建文件再过滤，也不能依赖端口号猜测 surface。
普通主站发布、槽切换和 gateway migrate 不得读取或修改任何 rescue 文件、服务或链接。

## 4. 授权和 capture manifest

阶段 0 不提供网页“永久开启”开关。只能由服务器所有者在本机创建一次性 manifest；
后续如增加 UI，也必须是 owner-only、重新验证密码、有 CSRF/operation ID 且最终生成
相同的一次性 manifest。管理员或普通用户不能自行开启对其他账户的采集。

私有目录：

```text
.codex-runtime/conversation-shadow/
  capture.json
  digest.key
  segments/
```

- 目录必须是真实目录、属主为服务所有者、模式 `0700`，不得是符号链接。
- manifest 和 key 必须是普通文件、相同属主、模式 `0600`。
- manifest 采用 exclusive create；活动 capture 存在时不得覆盖或复用 capture ID。
- key 是 32 字节随机值。不同 capture 不得复用；原始稳定 ID 只用分域
  HMAC-SHA-256 导出。

manifest 最小字段：

```json
{
  "schemaVersion": 1,
  "captureId": "uuid",
  "issuedAt": 1785450000000,
  "expiresAt": 1785450300000,
  "authorizedBy": "owner-local",
  "scope": {
    "surface": "main",
    "targetUserId": "private-server-only-id"
  },
  "browserReceiptToken": "single-capture-random-secret",
  "components": ["gateway", "backend"],
  "budgets": {
    "durationMs": 300000,
    "segmentBytes": 4194304,
    "segmentsPerComponent": 4
  }
}
```

`targetUserId` 和 receipt token 只存在于 `0600` manifest/内存，不写 trace。capture 最长
10 分钟，默认 5 分钟；不得使用零、负数、无限值或自动续期。过期后必须重新授权并生成
新 ID/key/token。

## 5. 身份和传播

短期拓扑 ID 可在本 capture 内原样记录：

- `browserSocketId`
- `gatewayConnectionId`
- `gatewayUpstreamId`
- `backendConnectionId`
- `appServerInstanceId`
- `captureId/traceId`

下列稳定或用户作用域身份只能写 HMAC：

- account/client/window/window nonce/checkpoint slot；
- runtime Epoch/event-log generation；
- browser RPC/App Server RPC；
- Thread/Turn/Item/Submission；
- 项目路径、供应商/账号内部 ID 和真机现场所需的 source network path。网关只能在内存
  中规范化源地址并输出 capture-key HMAC，不能写原 IP、网段、ASN 或地理位置；HMAC key
  不进入 field bundle。

关系不变量：

```text
一个 browserSocketId
  -> 一个 gatewayConnectionId
    -> 一到多个 gatewayUpstreamId（槽切换/重连时递增）
      -> 每 upstream 一个 backendConnectionId
        -> 当时 UserRuntime 的 appServerInstanceId
```

网关换 upstream 时不能伪造浏览器重新连接。reload 必须创建新的 window nonce、
window instance、checkpoint slot、browser socket、gateway connection 和 backend
connection；account-scoped client identity 可以保持。

App Server 原始事件由后端在读取 stdio 行时生成 `traceId + appServerInstanceId +
upstreamOrdinal`，后续 backend broadcast、gateway forward、browser receipt、Store 和
DOM 使用同一 trace ID。trace 元数据不能进入 Codex 请求或 JSONL。

## 6. 浏览器回执

后端只向目标账户的已认证主站连接发送短期 `conversation-trace/status`，其中只有
capture ID、失效时间和单次连接 challenge，不包含 HMAC key。浏览器在内存中保存：

- account-scoped `clientInstanceId`；
- 每 document 新建的 `windowNonce`；
- 服务端签发的 `windowInstanceId/checkpointSlotId`；
- 每次 `connectSocket()` 新建的 `browserSocketId`。

浏览器最多缓存 64 条或 64 KiB 回执，250 ms 合并发送；每批最多 16 条/16 KiB。回执只含
method/type、序号、ID、字节、可见性、online、close code 和单调时间，不含 message
正文。队列溢出只增加 `browserReceiptDropped`，不得阻塞渲染或 WebSocket。

网络断开后的 close 回执可在同 document 下一条连接上补发；reload/进程崩溃导致其丢失
是合法诊断缺口，不能为保存 trace 把回执写进聊天 Store、IndexedDB canonical
checkpoint 或 `sessionStorage`。网关/后端 close 记录仍用于说明传输侧事实。

receipt 必须匹配 capture ID、challenge、目标账户和当前连接。过期、重放、跨账户、
未知字段、单条超过 8 KiB或累计超预算都只丢弃 trace，不影响会话。

## 7. 进程队列和文件预算

每个组件独立写自己的 segment，不能让 gateway 等 backend 文件锁：

| 预算 | 默认 | 硬上限 |
| --- | ---: | ---: |
| capture 时长 | 5 分钟 | 10 分钟 |
| segment | 4 MiB | 4 MiB |
| 每组件 segment 数 | 4 | 4 |
| 内存队列 | 1,024 条 / 4 MiB | 同左 |
| 单条 NDJSON | 8 KiB | 8 KiB |
| flush batch | 32 条 / 64 KiB / 100 ms | 任一先到 |
| 浏览器回执队列 | 64 条 / 64 KiB | 同左 |

文件名只含 capture ID、component、segment ordinal 和进程启动随机 ID，不含用户名、
Thread ID 或项目名。目录 `0700`、文件 `0600`、exclusive create、无符号链接。

业务发送路径只调用不等待的 `record()`。当 recorder 队列达到硬上限、segment 用尽、
写入返回 `ENOSPC/EIO/EPERM`、key/manifest 变化或时钟到期时：

1. 原子地把本组件状态变为 `sealed`；
2. 尽力写一个不含业务 ID 的终止原因和 drop 计数；
3. 停止接受 trace；
4. 不抛给业务调用者，不关闭 socket，不暂停 Bridge，不修改 readiness。

trace 是诊断数据，flush 不参与业务事务，也不要求每行 fsync。seal 时可 fsync 当前
segment；进程崩溃留下的最后半行由分析器标为 truncated tail 并忽略。

## 8. 生命周期

```text
disabled
  -> armed（manifest/key/权限/时限/主站范围验证通过）
  -> active
  -> sealed(reason=expired|capacity|io-error|revoked|process-exit)
  -> analyzed
  -> deleted
```

- `disabled` 和验证失败都不得创建 segment。
- `active` 不允许修改 manifest、key、target 或 budget；任何变化立即 seal。
- gateway/backend 可以独立失败，分析结果必须列出缺失 component，禁止假装 capture
  完整。
- 原始 trace/key 默认最长保留 24 小时。分析产出脱敏聚合后立即删除 key 和原始
  segment；无法删除时报告失败，不延长采集。
- revoke 只停止 recorder，不断开或终止任何对话。

## 9. 分阶段接入顺序

1. 先实现与生产无引用关系的生命周期模型，覆盖权限、过期、轮转、overflow、I/O
   故障、跨账户 receipt 和 rescue 拒绝。
2. 独立评审 schema、隐私和资源预算。
3. 只接 gateway/backend，默认关闭，在开发机随机 capture 验证父连接关系。
4. 再接浏览器回执和 App Server raw ordinal；仍不接 Reducer 或业务恢复逻辑。
5. 通过边界审计后，才允许在所有者指定的一台主服务器做最长 5 分钟的定向现场采集。

任何阶段都不得随正式安装或同步自动开启 recorder，也不得把 recorder 失败加入发布
失败条件。阶段 0 完成不等于会话可靠性修复完成。

## 10. `0.39.48` 当前代码 hook 映射

本节只把 §2 的抽象断点映射到当前工作树，不实现 recorder。映射由
`probe-shadow-recorder-hook-map.mjs` 静态校验；任一源文件 SHA-256 变化后必须重新审计，
不能机械沿用旧行号。

| 文件 | SHA-256 | 当前行数（含尾部分隔） |
| --- | --- | ---: |
| `gateway.mjs` | `ea7299b0cd269ca45780ef05e55fd7354e2ee02d7e5db2cffbdcd15082d84959` | 427 |
| `server.mjs` | `4de3f3eb12293c61bc62f87f673f8337c5439b971ffbd645eed48a05ac47a916` | 18,528 |
| `public/app.js` | `c774d9b249608296b852fc5df3aff778e428f7a505b9309bfb036dcf26757a65` | 28,059 |
| `public/thread-state.js` | `7977762663a7ebcf5261b15816567ae01429e1bdafc3059c2f013d04cd812926` | 512 |

行号只是本表快照；函数名、调用顺序和重新计算后的 SHA-256 才是评审依据。

### 10.1 Gateway

| 当前入口 | 未来只读 hook | 必须保持的不变量 |
| --- | --- | --- |
| `server.on("upgrade")`，约 L100 | URL/origin 通过后，仅对 pathname 精确 `/ws` 分配 `gatewayConnectionId`；在 upgrade 闭包内建立 capture context | `/rescue/ws` 和所有 VNC pathname 在 recorder 初始化前退出；不能按端口猜 surface |
| 首次 `openUpstream()`，约 L119 | 在首次 upstream 创建前分配 `gatewayUpstreamId`，随闭包传给 `bridgeWebSocket()` | 首个 upstream 早于 `bridgeWebSocket()` 创建，不能事后补 ID |
| `bridgeWebSocket()`，约 L222 | 记录 browser/upstream open、error、close、ping/pong、寿命、方向字节和 `bufferedAmount` | `record()` 不 await；不得因 trace 改变 heartbeat、reconnect 或 migrate |
| `forwardUpstreamMessage()`，约 L250 | 记录 backend→browser 转发尝试；只解析外层白名单 trace 元数据和长度 | 不记录或 HMAC 原始正文；浏览器 receipt 才证明页面实际收到 |
| `attachUpstream()`，约 L282 | 每次 reconnect/migrate 创建新 upstream generation | 不创建新 browser/gateway connection ID，不伪造页面重连 |
| browser `message`，约 L291 | 记录 browser→backend 方向、长度和白名单 outer type | 不能为了 trace 缓冲、重放或修改业务 frame |
| browser `close`，约 L311 | 封存连接寿命、close code/reason class、drop 计数 | 清理 timer/upstream 的现有顺序不变；seal 失败不可抛出 |
| `openUpstream()`，约 L330 | 在现有公网 header allowlist 处理完成后，程序自己添加两个内部 ID header | 当前 allowlist 不含保留 header；永远不得透传用户传入的同名 header |

内部头只允许：

```text
x-wfl-gateway-connection-id
x-wfl-gateway-upstream-id
```

后端必须同时确认来源是 loopback、pathname 是主 `/ws`、`RESCUE_MODE === false`，否则
忽略这些头。不得把 capture ID、receipt token、用户 ID 或 HMAC key放进握手头。

### 10.2 Backend 与 Codex Bridge

| 当前入口 | 未来只读 hook | 必须保持的不变量 |
| --- | --- | --- |
| `CodexBridge.start()`，约 L714 | 每个实际 child spawn 新建 `appServerInstanceId`，raw ordinal 从 1 开始 | restart 必须换 ID；不能把 ID传进 Codex 请求、环境或 JSONL |
| `consume()` / `handleMessage()`，约 L776/L787 | newline 完成后记录字节、response/request/notification 分类、method 和 HMAC 实体 ID；创建 `traceId` | JSON parse 失败只记长度/原因类，绝不复制当前错误日志里的原始 line |
| `request()` / `write()`，约 L818/L841 | pending 元数据旁记录 method、RPC HMAC、trace root、写入字节和 `stdin.write()` 布尔值 | 阶段 0 只观察，不改变 timeout、重试、pending resolve 或 stdin 背压行为 |
| bridge `notification` handler，约 L1095 | raw→public 转换时以 EventEmitter 的本地第二参数携带 trace metadata | 不向 `rawPayload`/`publicPayload` 注入字段，避免进入任务状态或 Store |
| `broadcast()`，约 L2267 | 对目标账户 outer WFL frame附加短期 trace metadata，并记录每 client 发送尝试 | trace 字段不进入 `payload`；无 capture 时 frame 必须字节级保持旧形状 |
| `updateClientState()` / `releaseClient()`，约 L2409/L2796 | 绑定/释放 client、window、socket、active thread 和 receipt challenge | receipt 失败不影响订阅、审批重分配或 10 秒 reconnect grace |
| backend upgrade / connection，约 L9370/L9455 | 只在已认证主 `/ws` 且非 rescue 时接受网关 ID，分配 `backendConnectionId` | 当前 connection callback 没有 request；未来只能显式传入已验证 context，不能读未验证全局头 |
| `client/state` / 新 receipt type，约 L9483 | 完成 capture challenge 和身份绑定；receipt 使用独立严格分支 | receipt 不能进入 RPC allowlist、持久写 admission 或线程 lease |
| `send()` / close，约 L9588/L9598 | 记录 backend→gateway 尝试、callback 结果、close code、队列量 | 记录失败不能关闭 socket、改变返回值或修改 Ops readiness |

App Server notification 的 trace metadata 应作为 EventEmitter 的第二个本地参数传播，例如
概念形状 `emit("notification", message, traceMeta)`；它不是协议字段。只有后端构造
`codex/notification` 外层 frame时，才在活动 capture 下临时加入可被浏览器回执的
`trace`。浏览器在进入现有 Reducer 前分离该字段，业务 `payload` 保持不变。

RPC response、snapshot 和通知使用不同 trace root：

- App Server notification：在完整 stdout line 解析后创建 root。
- browser RPC：在浏览器冻结 request ID/method 时创建 root，gateway 只转发，后端将其
  关联到 App Server RPC ID；response 继承该 root。
- `thread/read`/分页 snapshot：继承对应 RPC root，不能伪装成实时 notification。

### 10.3 Browser、Store 和 DOM

| 当前入口 | 未来只读 hook | 必须保持的不变量 |
| --- | --- | --- |
| `connectSocket()`，约 L7447 | 每次调用新建 `browserSocketId`；记录 constructor/open/error/close、visibility、online、寿命 | 不修复或改变当前 reconnect；旧 generation 回执只能由后续同 document socket 尽力补发 |
| WebSocket `message` / `handleSocketMessage()`，约 L7477/L7735 | 在 parse 前记录 frame 字节，parse 后记录 outer type/trace；处理 `conversation-trace/status` | 不读取正文；无 capture 或无合法 challenge 时不创建 receipt |
| `sendClientState()`，约 L8145 | 在 status challenge 到达后追加 client/window/socket 身份并重新上报 | 原 thread/visible/Epoch/sequence 字段保持；身份只在内存和认证连接中存在 |
| `handleCodexNotification()`，约 L16205 | 记录 protocol ingress、序号过滤结果和目标实体；进入现有分支前剥离 outer trace | 不改变 return 分支、刷新调度或实体合并 |
| `upsertTurn()` / `upsertItem()`，约 L27469/L27483 | mutation 后发 `store/apply` receipt，包含 canonical/source key HMAC、状态和 revision | 不在纯 Reducer 内记录；record 异常不能回滚 Store |
| streaming delta分支，约 L16466起 | 每次实际 Item mutation 后记录定向 revision；可按同 trace/method 合并 receipt | 不复制 delta，不能为了 trace 增加 render |
| `refreshRecentTurns()`，约 L27533 | 对 snapshot calibration 记录 RPC root、before/after entity 数和被替换/保留 key 数 | recorder 不允许调用、延迟或重试 refresh |
| `reconcileTranscriptNodes()` / `renderMessages()`，约 L17733/L17809 | 记录 desired/created/reused/replaced/removed 计数、anchor key HMAC和耗时 | 不遍历或摘要正文；不改变 DOM key、签名、scroll 或 refreshIcons |
| `flushStreamItemRender()`，约 L18405 | 记录定向 patch或 fallback full render、节点存在性和耗时 | 不读取最终文本；receipt 排队不得占用 animation frame预算 |

`public/thread-state.js` 的 `matchesPendingUserMessage()`、`mergeThreadItem()`、
`upsertThreadItem()` 和 `mergeTurn()` 保持纯函数，不直接接 recorder。否则诊断副作用会
混入单元测试、快照合并和未来 Worker。Store receipt 必须由 `public/app.js` 的调用层在
mutation 成功后发出；DOM receipt 只由 DOM 调度层发出。

浏览器没有 HMAC key。它可以在已认证连接中把 raw source ID放入有界 receipt，后端必须
先校验 capture/challenge/账户/window，再在写盘前 HMAC。raw ID不得写 console、
`sessionStorage`、IndexedDB 或任何 trace segment。

### 10.4 六个逻辑层、七个记录阶段

同一实时 Item 的允许顺序是：

```text
app-server/raw
  -> backend/public-projection
  -> backend/send-attempt
  -> gateway/forward-attempt
  -> browser/transport-received
  -> browser/store-applied
  -> browser/dom-applied
```

前四层由进程 recorder 直接写 segment；后三层由浏览器 receipt 回到后端后写入。每层有
独立 `layerSequence`，不能用墙钟先后替代序号。缺少 browser receipt可以说明
reload/crash/overflow，但不能反推 frame 未到；缺少 backend/gateway component必须把整个
capture 标成 incomplete。

### 10.5 接入前静态和失败验收

当前探针必须保持：

- 四个源文件 hash与已评审基线一致，或明确触发重新映射。
- 31 个 hook anchor仍存在；生产代码中 recorder identifier 数为 0。
- `package.json`、安装、更新、部署、quick-check 和 release 脚本引用数为 0。
- gateway 公网 header allowlist 不接受两个内部 ID header。
- 不启动服务器/浏览器、不读取对话、不访问备用窗口。

未来真正接入时，至少增加以下失败断言后才能在开发机授权一次 capture：

1. disabled/非法/过期 manifest 创建 segment 数为 0，业务 frame 字节不变。
2. gateway/backend 任一 recorder抛错、队列满、`ENOSPC/EIO/EPERM` 时，业务返回、
   socket close、Bridge restart 和 readiness 变化均为 0。
3. `/rescue/ws`、VNC、`RESCUE_MODE=true`、跨账户和伪造内部头的 trace 行数为 0。
4. raw prompt/reply/delta/tool/Diff/Cookie/Auth/API Key哨兵在内存导出和 segment 中均为 0。
5. capture撤销/过期只 seal recorder，管理员和普通用户的现有对话都不被中断。
6. 无活动 capture时，主站 frame、RPC、DOM 和性能基线与接入前一致。

本节完成的是可审查的 hook 设计，不是阶段 0 生产接入，也不能把 Goal #07/#12/#14/#19
中缺失的生产关联证据标为已采集。
