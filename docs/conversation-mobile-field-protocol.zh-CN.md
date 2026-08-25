# 会话真机与第二设备现场协议

> 历史调查执行规范，未作为当前会话协议启用。当前架构以
> [ADR-0002](adr/0002-app-server-conversation-authority.zh-CN.md) 为准。

状态：调查执行规范；尚无真实设备结果<br>
基线：WFL `0.39.48-beta` / Codex `0.146.0`<br>
目标：为 C02、C03、S10 和 Goal #16/#27/#45 取得不可由桌面模拟替代的证据<br>
范围：仅主站；备用窗口 `1.0 / 4321`、VNC 和正式安装流程全部排除

## 1. 证据原则

桌面 Chromium 的 page freeze、两个 browser context 和网络 fault proxy 已经证明部分
协议边界，但不能证明：

- Android/iOS 在真正进入后台或锁屏后，浏览器网络进程、WebSocket control frame、
  JavaScript timer 和 IndexedDB 的实际生命周期；
- Wi-Fi 与蜂窝切换时 NAT、IP、TLS/WebSocket 和操作系统网络栈的共同变化；
- 两台物理设备、独立浏览器存储和不同公网路径同时观察同一线程时的连接与订阅归属。

因此真机项只能由真实设备执行。移动设备模拟、DevTools throttling、CDP lifecycle、
桌面标签冻结、虚拟机或两个 browser context 都不能把状态从 `X` 改成 `V`。

现场 bundle 可以证明 trace 的完整性、设备/网络摘要不同和场景时序，但不能仅靠
user-agent 密码学证明设备一定是物理硬件。最终证据还必须包含所有者对设备、网络和
手工动作的明确确认；报告中同时保留这一限制。

## 2. 执行前置条件

在以下条件全部满足前不得开始现场采集：

1. [Shadow Recorder 阶段 0](conversation-shadow-recorder-stage0.zh-CN.md) 已经过独立
   评审，并只在所有者指定的主服务器以一次性 manifest 开启。
2. recorder 明确显示 `surface=main`、目标测试账户、5 分钟默认/10 分钟硬上限和
   capture ID；不得连接 `/rescue/ws`。
3. 使用专用非 owner 测试账户、空测试项目和新建线程；线程中不得存在个人信息、真实
  代码、凭据或第三方数据。
4. 每个业务动作只发送短固定标记，例如 `FIELD-A-01`；模型回复固定短 token。不得运行
   大工具、压力、并发洪泛、完整测试或浏览器冒烟。
5. 主站版本、Codex 版本、gateway policy、Nginx 配置摘要和 recorder schema 已记入
   manifest。版本变化后本轮作废。
6. 设备时钟启用自动校时。服务端时间为跨设备权威；浏览器 monotonic time 只在同一
   document 内比较。

## 3. 设备和网络矩阵

最小有效矩阵需要：

| 角色 | 设备 | 浏览器存储 | 网络 |
| --- | --- | --- | --- |
| A | 一台真实手机 | 独立正式浏览器 profile，非隐私模式 | Wi-Fi，可切换蜂窝 |
| B | 第二台物理设备，手机或电脑 | 与 A 不共享 profile、cookie jar 或 session storage | 与 A 不同公网路径；优先蜂窝或另一宽带 |

必须记录但不导出原值：

- OS family/version、浏览器 family/major、设备型号类别；
- `clientInstanceId/windowInstanceId/browserSocketId` 的 HMAC；
- source network path 的 HMAC。服务端可对规范化源地址做 capture-key HMAC，但不得把
  原 IP、网段、ASN 查询结果或地理位置写入 trace；
- viewport、timezone 和 user-agent 只保存白名单分类或 HMAC。

设备 ID、network path digest 不同只能证明采集看到不同身份/路径，不能替代所有者的
物理设备确认。

## 4. 现场场景

每个场景独立新建 run ID，至少重复 3 次。任一次失败都保留，不得只重跑并删除失败。

| ID | 场景 | 手工步骤 | 必须出现的证据 |
| --- | --- | --- | --- |
| F01 | 手机前台空闲 | A 保持页面前台 120 秒，不操作 | 同一 browser socket；至少 4 个 heartbeat 周期；无重连 |
| F02 | 后台 2 分钟 | A 前台 ready 后切到其他应用 120 秒，再返回 | visibility hidden/visible；后台区间；返回后的连接或新 generation；最终 ready |
| F03 | 锁屏 2 分钟 | A ready 后锁屏 120 秒，解锁并回到页面 | owner action marker；浏览器/网关/backend 生命周期；恢复结果 |
| F04 | 锁屏 10 分钟 | 同 F03，锁屏 600 秒 | 长冻结区间；旧连接结局；新连接/校准；最终 Store/DOM |
| F05 | Wi-Fi -> 蜂窝 | A 前台 ready，关闭 Wi-Fi 并等待蜂窝 ready | 同设备两个 network path digest；socket close/open；恢复时间 |
| F06 | 飞行模式恢复 | A 开飞行模式 30 秒后关闭 | online false/true；旧 socket 结局；只能有一个活动 generation |
| F07 | 活动 Turn 时刷新 | 发送固定短 token，确认 Turn accepted 后刷新一次 | Submission/Turn ID HMAC；reload 新 window/socket；最终一个用户 Item、一个助手 Item |
| F08 | 浏览器进程退出 | A ready 后从系统任务切换器结束浏览器，30 秒后重开 | 旧连接 close/timeout；新 document/window；线程最终状态 |
| F09 | 双设备共同观察 | A/B 打开同一测试线程 120 秒 | 两组独立 device/window/socket/network digest；相同 Thread HMAC；两份订阅 |
| F10 | 单端关闭 | F09 后关闭 A，B 保持 15 秒并接收一条短终态 | A close；B 连接不变；B 在 A close 后仍收到并渲染终态 |
| F11 | 一端锁屏、另一端执行 | A 锁屏 120 秒；B 发一条固定短 token | Turn 不因 A 消失而停止；B 完成；A 解锁后校准为同一 Turn/Item |

弱网不使用流量洪泛。若需要验证高延迟，只能使用真实移动网络自然抖动或操作系统公开的
低数据模式；不得在普通服务器运行压力或随机丢包工具。确定性 drop/reorder 继续留在
开发机 fault proxy。

## 5. 手工动作的时间边界

每次操作由现场观察者在控制页或本地记录器产生只含 run ID 的 marker：

```text
run/started
action/backgrounded | action/locked | action/network-switch | action/reload
action/foregrounded | action/unlocked | action/network-ready | action/reopened
run/ended
```

marker 不得声称操作系统已经完成某动作，只记录观察者按下按钮的时刻。锁屏/物理设备
事实由 owner attestation 确认；浏览器 trace、网关 close 和后端连接只证明系统实际观察
到的后果。

时间规则：

- `startedAt <= actionAt <= resumedAt <= endedAt`；
- F02/F03 hidden/lock 区间至少 120 秒，F04 至少 600 秒，F06 offline 区间至少 30 秒；
- 每层 `layerSequence` 严格递增；同 document 的 monotonic time 不回退；
- 跨 document、跨设备只用服务端 Unix 时间和 trace parent relationship 比较；
- 任一设备时钟与服务端偏差超过 5 秒时，该 run 标记 `clock-invalid`，不能计入延迟。

## 6. 必须采集的层

连接类场景至少需要：

```text
observer marker
browser lifecycle/receipt
gateway connection + upstream generation
backend connection + runtime Epoch
```

涉及 Turn/Item 的 F07、F10、F11 还必须具有同一个 trace ID 的：

```text
App Server raw method/ordinal
backend broadcast
gateway forward
browser receipt
Store canonical apply
DOM key/revision
```

缺任一层只能标记 `incomplete`，不能根据最终 UI 倒推中间层正常。close 事件在进程被系统
直接杀死时可能天然缺失；此时必须有 gateway/backend timeout/close 和后续新连接证据，
并把 browser close 记为 `not-observable`，不能伪造 clean close。

## 7. Evidence bundle

目录必须是真实 `0700` 目录，文件为普通 `0600` 文件且无符号链接：

```text
field-bundle/
  manifest.json
  checksums.json
  observer.ndjson
  gateway.ndjson
  backend.ndjson
  browser-a.ndjson
  browser-b.ndjson
```

manifest 包含：

- schema、capture ID、WFL/Codex/gateway policy/recorder schema；
- `fixture=false`；
- owner attestation：确认设备为物理设备、A/B 是两台设备、网络路径确实不同、动作按协议
  执行；
- 设备/浏览器分类和全部敏感身份 HMAC；
- 11 个场景各 3 个 run 的时间、设备角色和期望层；
- capture 开始/结束、时钟偏差和已知异常。

`checksums.json` 为其他文件保存 SHA-256 和字节数。它只能发现 bundle 后续被修改，不能
证明动作真实发生。

禁止字段和内容：

- prompt/reply/text/content/toolOutput/diff/cookie/authorization/apiKey/phone/email；
- 原始账户、client/window、Epoch、RPC、Thread/Turn/Item/Submission、IP 或项目路径；
- 屏幕截图、录屏和浏览器导出的 Cookie。

现场原始 HMAC key 不进入 bundle。完成聚合后按阶段 0 规范删除原 trace 和 key。

## 8. 证据判定

bundle 校验通过只表示结构、时序、层、checksum 和隐私约束成立。产品结果分别判定：

- `observed-pass`：所需层完整，且目标不变量成立；
- `observed-fail`：所需层完整，稳定显示重复、漏失、双连接、错误恢复或任务停止；
- `incomplete`：缺层、缺 owner attestation、时钟无效或操作区间不足；
- `not-run`：场景没有执行满 3 次。

当前可靠性目标：

- 一个 window generation 同时最多一个活动 browser socket；
- 同 Epoch 短线恢复目标 P95 1,500 ms、硬上限 2,500 ms；
- F07 每个 Submission 最多一个上游 Turn，最终每个 canonical Item 一个 DOM 节点；
- F09-F11 两设备使用独立 window/socket/未来 ACK lease；一端离开不退订或终止另一端；
- 运行 Turn 不因页面后台、锁屏、切网、刷新或另一设备关闭而停止；
- 任何 `deliveryUnknown` 不自动盲重发。

现有 `0.39.48` 尚未实现 durable ACK/event log，所以现场基线很可能是
`observed-fail`。稳定失败仍是有效调查证据；不得把“没有修好”混同为“采集无效”。

## 9. 状态升级规则

在 recorder 尚未接入、现场 bundle 尚未生成前：

- C02/C03 保持 `P/X`；
- S10 的隔离 context 部分保持 `P`，物理跨网络部分保持 `X`；
- Goal #16/#27/#45 不得标记完成。

只有 bundle 校验通过、每场景 3 次、owner attestation 存在且跨层结果已归因后，才能把
对应项升级为 `V` 或“已稳定复现失败”。单一截图、用户口述、桌面模拟、一次成功或缺层
trace 都不满足门槛。
