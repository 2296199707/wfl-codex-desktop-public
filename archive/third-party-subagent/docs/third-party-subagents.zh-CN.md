# 第三方子代理

当前实现使用官方 DeepSeek Harness 的 `SubagentRuntime`，WFL 只提供每用户 Host
Bridge、供应商配置和 Codex/MCP 传输适配。子代理身份、父子关系、持久化、继续执行、
中断、列表和 settlement 由官方 Harness runtime 管理。

官方参考：[OpenAI Docs：Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

## 工具

MCP 只暴露官方语义所需的四个工具：

- `subagent`：启动子代理。默认后台运行并返回 durable `childId`；设置
  `run_in_background=false` 时等待本次前台结果。
- `send_message`：向已有后台子代理发送下一轮消息，返回消息已排队的确认。
- `interrupt_agent`：中断子代理当前轮次，已排队消息保留。
- `list_agents`：列出当前父会话的 child 或 descendants 状态。

后台子代理完成后，官方 Harness 会向 Host Agent inbox 投递 settlement。WFL 再把已
验证的 settlement 适配到对应 Codex 父线程；这不是轮询，也不是 WFL 自己合成的任务
终态机。

## 设置

在“API 供应商”中配置一个普通供应商，然后在“第三方子代理”设置中选择该供应商和
实际接口协议：

- OpenAI Responses；或
- OpenAI Chat Completions。

模型、Base URL 和 API Key 直接使用所选供应商配置。可以选择 DeepSeek、GPT 或其他
兼容所选协议的模型，不要求固定供应商品牌。

这里没有第三方子代理专用模型、角色、回合数、工具次数、费用、Token 或任务预算项。
供应商额度不由 WFL 截断；runtime 启动/关闭超时只保护进程传输，不会把正在执行的子
代理按预算提前结束。

## 权限与安全边界

- 子代理使用已验证父会话的绝对 `cwd` 和 sandbox 模式。
- 父子关系通过官方持久化 child 元数据校验，不能用同一用户的另一个父线程控制该
  child。
- socket 和认证 token 为每用户运行时独立生成；token 不进入 MCP 工具参数、模型上下文
  或日志。Host binding 文件权限为 `0600`，不保存 API Key。
- 当前跨进程桥尚未实现 Codex `ask/on-request` 到 Harness `approval/request` 的完整
  往返。因此父会话需要人工审批时安全拒绝，绝不静默改成 `never`。
- 断开 MCP 调用会取消对应的前台运行；后台 child 的生命周期由官方 runtime 继续拥有。

## 并发与恢复

同一父会话可以并发启动多个 child；官方 Harness 为每个 child 保留独立身份和 session。
多个 child 同时完成时，Host Bridge 会按官方 inbox 顺序逐条接收 settlement，不重复、不
丢失。runtime 重启后，Host binding 和官方 session 可用于列出 child、继续发送消息并
进行 cold resume。

WFL 不新增自定义队列状态、角色系统或 continuation 状态。Host Bridge 中只保留完成
跨进程传输所需的临时连接、归属校验和 settlement 投递适配。

## 当前未完成的验证

- 真实 Codex app-server 对 MCP `_meta` 父 thread/turn 元数据、重连和后端重启的完整
  行为仍需实测；fake app-server 结果不能替代真实证据。
- 已修复已有 durable child 运行期间的供应商切换：旧 runtime 会继续持有运行中的 child，
  新任务只在官方 `activity` 全部为 `inactive` 且请求收敛后切换；状态不明时 fail closed。
- 已修复 runtime 并发首次启动时的所有权竞态；多个 child 共享同一个已登记 runtime，不会
  覆盖引用并遗留孤儿进程。runtime 重启后供应商配置已改变时，会按持久化 `providerId`
  恢复旧 provider，旧 child 完成后才切换到新 provider；旧 provider 无法验证时 fail closed。
- 真实 `ask` approval 往返尚未开放，当前保持 fail closed。

详细调查和每次验证记录见：[第三方子代理长期研究日志](./third-party-subagent-long-term-research.zh-CN.md)
