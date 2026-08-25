# ADR-0002：App Server 权威会话与隔离边界

状态：已接受<br>
日期：2026-08-02<br>
范围：主站 Codex 会话<br>
取代：[ADR-0001](0001-reliable-conversation-state.zh-CN.md) 中未投入生产的事件日志、浏览器 ACK、canonical/legacy 双投影和 Sidecar 提交台账方案

## 决策

Codex App Server 是原生对话内容的唯一权威。WFL 使用官方
`Thread → Turn → Item`，不再建立第二套聊天日志、canonical ID 空间或浏览器恢复日志。

浏览器只有一个内存 `Conversation Store`。Store 按 `accountId + projectId` 分区，再按
官方 Thread ID 保存完整 Thread。`activeThread` 只是当前分区中 Thread 的选中引用；页面
不得直接修改其 Turn、Item、名称或状态，所有写入都通过通知 Reducer 或整 Thread 原子
替换完成。

## 权威边界

| 数据 | 权威来源 | WFL 的职责 |
| --- | --- | --- |
| Thread、Turn、Item 正文 | Codex App Server | 校验、按用户/项目路由并投影到 Store |
| Item 终态 | `item/completed` | 以完整 Item 覆盖同 ID 的流式投影 |
| Turn 终态 | `turn/completed` | 封闭 Turn 状态，并将终态 summary 合并到同 ID Item；保留此前 `item/completed` 的完整 Items |
| Turn 恢复快照 | `thread/resume` / 完整 Turn 分页 | 以完整 Turn 原子替换实时投影 |
| 任务进程状态 | WFL Task Status | 控制发送、停止和进程恢复；不能生成聊天终态 |
| 防重复发送 | 稳定客户端请求 ID与内存/官方 Thread 对账 | 只裁决是否再次发送；不能生成消息或终态 |
| 搜索和历史索引 | Sidecar | 可删除重建的派生缓存；不能阻塞发送、恢复、账号切换或终态 |
| 页面折叠、滚动和选择 | 浏览器 UI 状态 | 不属于聊天内容，也不回写官方 Thread |

## 恢复和历史

- 刷新、重连、工程切换和 Thread 切换统一使用 `thread/resume`。
- `thread/resume` 返回的 Thread 与最近完整 Turn 页面一次性进入 Store；恢复失败时保留
  已显示内容并标记待恢复，不用 `thread/read + thread/turns/list` 拼出替代聊天。
- 更早历史按完整 Turn 分页前插。实时通知与历史 Item 不做长期逐条双路径合并。
- 恢复得到的完整 Turn 可以删除仅存在于流式阶段的陈旧 Item；实时
  `turn/completed` 只是终态 summary，不能删除此前已完成的用户、命令、文件或工具 Item。
- 任务状态接口只报告进程事实。它不得因运行时空闲、Sidecar 台账或超时而合成
  `turn/completed`。

## 多用户、多项目和多线程隔离

- 每个受管用户拥有独立 `UserRuntime`、项目根、Codex Home、Provider Store、Sidecar、
  导入区和写租约。
- 浏览器通知只有在能从活动 Thread、已知 Thread 映射、Thread 列表或通知携带的明确
  `cwd` 得到项目归属时才进入 Store。未知后台 Thread 不得回退写入当前项目。
- 后台 Thread 事件只更新其自己的 Store 分区；不得修改当前页面的 Thread、活动 Turn
  或任务提示。
- 主站和备用窗口通过独立前端、后端 surface 与 Thread 写租约隔离。一个 surface 的
  消息或任务状态不得覆盖另一个 surface。
- WebSocket 和 VNC 连接绑定具体登录 Session。注销、密码变更、用户停用或多用户模式
  撤销会关闭对应 Session/用户连接，不能只依赖 Cookie 过期。
- 管理员会话访问必须保留；维护或权限变化只能重连/恢复，不能用会话禁用作为隔离手段。

## 官方账号与 Provider 切换

- 官方账号上下文由 `officialAccountEpoch + accountId` 标识。登录、重置、额度刷新和任何
  跨 `await` 的异步结果必须在提交结果前调用 `officialAccountContextIsCurrent()`。
- 旧账号迟到的额度、状态、登录完成或重置结果必须丢弃，不能覆盖新账号。
- 有活动任务、Bridge pending、额度刷新或 Thread 写租约时禁止官方账号切换。
- Provider/官方账号 handoff 先 fence 新 App Server 请求，再等待真正的账号边界清空，
  重启 Bridge 后解除 fence。Sidecar 队列不参与 handoff 等待。
- 模型容量不足是独立失败类型。它可以提示重试，但不得触发自动 Provider/模型切换或
  自动降级；自动切换只允许用于明确的连接故障策略。

## Sidecar 约束

`CODEX_DESKTOP_CONVERSATION_SIDECAR=1` 只启用历史搜索/索引 Worker。Sidecar schema v2
在初始化时删除已废弃的事件日志、ACK/source mapping、提交台账与迁移表，包括其中的旧
Outbox 载荷。Sidecar Worker 只暴露健康、管理快照、历史索引和历史身份查询，不再暴露
事件重放、ACK、提交或终态 API。

## 有限例外

以下组件不是原生实时会话的第二权威，但必须明确记录其边界：

1. `ThreadImportStore` 保存用户主动导入的 JSON/Markdown 迁移记录。未物化记录使用合成
   ID 作为只读迁移源；首次原生写入前必须物化为官方 Thread，之后以 App Server 为准。
   Store 位于用户独立状态目录，不能跨用户合并。
2. `RescueChatSnapshotStore` 保存校验和保护的最后有效只读快照，只供冻结备用窗口在
   官方读取损坏或不可用时恢复查看。它不能回写主站 Store、决定聊天终态或绕过写租约。
3. `public/rescue.js` 是独立冻结的生产组件，当前仍维护自己的轻量页面投影。主站架构
   清理不得修改其资产、版本、活动端口、服务或 slot；只有所有者在当前请求中明确要求
   备用窗口升级时才能改变。

## 禁止重新引入

- canonical/legacy 双 ID 或 source alias 聊天路径；
- 浏览器 conversation journal、IndexedDB checkpoint、cursor ACK；
- `observe/replay/calibration` 会话协议；
- 用 Sidecar、任务状态、搜索索引或文本相同判断 Item/Turn 终态；
- 未知后台 Thread 回退到当前项目；
- 因容量满、速率限制或配额错误自动切换模型；
- 在同一版本下部署不同主站代码，或让普通主站更新改变冻结备用窗口。

## 验收要求

每次修改对话恢复或隔离边界，至少覆盖：账号 Epoch 迟到结果、Session 级 WebSocket
撤销、后台 Thread 项目隔离、`thread/resume` 原子恢复、Item/Turn 终态单调、Sidecar
不可阻塞和不可终态化、Bridge handoff fence、写租约，以及容量错误不自动切换。
