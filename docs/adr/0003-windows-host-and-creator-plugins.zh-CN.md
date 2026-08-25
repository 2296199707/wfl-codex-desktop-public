# ADR-0003：Windows Host 与无界面创作插件安全边界

状态：已接受<br>
日期：2026-08-03<br>
范围：主站官方插件中心、Windows 伴随组件、移动浏览器入口<br>

## 目标

WFL 提供两个独立、可选、按用户授权的官方插件：

1. `windows-codex-remote`：从手机或浏览器连接用户自己的 Windows Host，查看设备状态、
   选择工程，并通过本地 Codex App Server 恢复空闲 Thread。
2. `creator-worker`：在用户明确配置的 Windows 工作区中运行结构化、白名单化的创作任务，
   第一版覆盖受限文件操作和已登记工具，不接受任意 Shell。

两个插件共用一个 Windows Host 伴随组件，但安装、启用和用户授权相互独立。伴随组件是普通
用户进程，只建立到 WFL 的出站 TLS WebSocket；WFL 不要求 Windows 开放入站端口。

## 非目标

- 不远程接管 Codex、ChatGPT 或其他桌面程序的鼠标键盘。
- 不提供任意 PowerShell、`cmd.exe`、管理员命令或静默安装。
- 不上传、代理或保存 Windows 上的 Codex `auth.json`、API Key、浏览器 Cookie。
- 不接管正在运行的 Turn；第一版只恢复空闲 Thread。
- 不把设备响应、任务状态或 Creator 台账变成聊天内容的第二权威。
- 不修改或加载冻结的救援窗口、救援服务、端口、slot 或资产。

## 插件和授权模型

WFL 官方插件清单使用受限 schema。除名称、版本和权限外，它必须声明：

- 风险等级和类别；
- WFL 主站版本兼容范围；
- 支持的平台；
- 伴随组件 ID、协议版本、安装方式和是否需要人工确认；
- 依赖插件；
- 是否需要每个用户单独授权。

“已安装并启用”是管理员控制的全局可用性；“用户授权”是第二道门。成员只有在插件全局启用、
其账号拥有对应产品权限，并且管理员授予该插件后才能使用。所有者和管理员也必须在插件安装
后才能使用；安装不会自动给普通成员授权。卸载插件会原子删除其用户授权。

`windows-codex-remote` 和 `creator-worker` 不能互相隐式授权。安装共享伴随组件不会放大任何
用户权限。

## 身份和配对

配对由已登录 WFL 用户在主站发起，服务端生成短期、单次使用的配对码。持有配对码的 Windows
Host 只能完成一次交换；数据库只保存码和设备令牌的带域哈希，不保存明文。

配对成功后，设备令牌只返回一次并留在 Windows 当前用户的私有配置中。设备通过独立
`/device/ws` 出站连接，建立连接后立即在 TLS 通道内认证；令牌不进入 URL、访问日志或浏览器。
设备撤销、用户停用、插件停用/卸载或授权移除都会令 `deviceEpoch` 增长并关闭已有连接。

配对码和设备令牌都不能替代网页 Session，也不能访问普通 `/api`、管理员或救援接口。

## 多用户、多设备和多线程隔离

每个设备调用都绑定以下完整上下文：

```text
userId + pluginId + deviceId + deviceEpoch + threadId + leaseEpoch + callId
```

- 服务端不接受设备自行声明或切换 `userId`。
- 一台设备同一时刻最多由一个 Thread 持有控制租约；租约短期有效，可显式释放。
- 浏览器切换 Thread、设备、用户 Session，或租约过期/撤销时，`leaseEpoch` 增长。
- 异步结果提交前必须再次校验用户、插件、设备 Epoch 和 Thread 租约；迟到结果被丢弃。
- 设备断线时不保留待执行动作队列；重连后必须取得新租约。
- 非幂等设备动作不自动重试。Creator Job 使用 `userId + deviceId + jobId` 台账去重。
- 设备事件只发往拥有相同用户和 Thread 订阅的主站连接，不能回退写入当前页面。

该隔离层独立于官方账号的 `officialAccountEpoch`。远端设备不得改变服务器官方账号，也不得
绕过现有 App Server Bridge、额度刷新或 Thread 写租约隔离。

## Windows Host 协议

设备首先发送 `authenticate`，成功后服务端返回当前 `deviceEpoch`、心跳间隔和允许能力。之后
只允许有限消息：

- `heartbeat` / `heartbeatAck`；
- `capabilities`；
- `callResult`，且必须引用服务端签发的 `callId` 和完整租约上下文；
- `jobProgress`，且必须引用已登记的 Creator Job。

服务端只发送 `call`、`cancelCall`、`leaseRevoked` 和 `disconnect`。请求方法由插件清单及服务端
白名单共同限制，设备不能通过消息扩展权限。

Codex Remote 第一版允许列出本机已明确暴露的工程、列出/读取 Thread、恢复空闲 Thread 和发起
结构化 Turn；Host 必须通过本机 Codex App Server 完成，且 Codex 登录凭据始终留在 Windows。

Creator Worker 第一版只接受结构化操作和工作区相对路径。路径经规范化和真实路径检查后必须
留在已配置根目录内；符号链接不能逃逸。工具运行使用服务端与 Host 双重白名单及固定参数模板，
不接受浏览器或模型提交的可执行文件路径、Shell 字符串、环境变量或管理员标志。

## 与官方动态工具的关系

浏览器提交的 `dynamicTools` 和任意 `item/tool/call` 继续默认拒绝。后续若把设备能力暴露给
Codex，只能由 WFL 服务端根据已安装插件、用户授权和活动 Thread 租约生成工具定义；每次调用
仍重新校验完整设备上下文。Thread 恢复时持久化的旧工具定义不构成授权。

第一版先交付独立的设备/Creator API 和移动入口，不放松现有动态工具策略。

## 安全失败方式

- TLS、心跳、Epoch、租约或权限校验失败：拒绝调用并断开设备，不自动降级。
- 设备离线：明确显示离线，不排队执行。
- Turn 正在运行：返回冲突，不抢占、不点击本地桌面。
- 工具未登记或路径越界：拒绝且不尝试替代命令。
- 迟到/重复结果：不进入对话 Store，不重复完成 Job。
- 服务重启：设备重新认证，所有内存租约失效；持久化设备 Epoch 和 Job 幂等记录继续有效。

## 验收要求

至少覆盖：配对码单次消费和过期、令牌不落日志/明文状态、跨用户设备拒绝、插件未安装/停用/
未授权拒绝、设备撤销与 Epoch 迟到结果、单设备跨 Thread 租约冲突、断线清租约、心跳超时、
Creator Job 幂等、路径逃逸和未知工具拒绝、移动端设备选择/恢复空闲 Thread，以及主站发布不触碰
救援组件。
