# 开源 Codex Web / Linux 浏览器端可靠性调研

调研日期：2026-08-12

## 范围

本调研针对社区开源的 Codex Web、Linux WebUI 与远程 agent 项目，不以 OpenAI 官方网页为替代目标。WFL 继续以本机 Codex CLI `app-server` 为协议核心，不把浏览器直接连接到 Codex 进程，也不把 CLI 凭据下发给浏览器。

本次固定查看了以下仓库和提交：

- [chenyanshan/codex-web](https://github.com/chenyanshan/codex-web) `0fcbc6f20f3bdc16c8f766115332c1d8c3ff4e55`
- [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui) `80ebbff999f354b80ac9ffbac9580cf51d3ea9f0`
- [Pedregoneric/codex-webui](https://github.com/Pedregoneric/codex-webui) `cd8cdccc44c0db1281aa5d9ed6955d37080bb68f`
- [jinshenganyuci/Linux-Codex-Webui](https://github.com/jinshenganyuci/Linux-Codex-Webui) `4daa9071ee8ceeb28fc236547885d80bbbdebff0`
- [harryneopotter/Codex-webui](https://github.com/harryneopotter/Codex-webui) `4fe02bc5ace9d9f7837e821b3c269c62ef032fcc`
- [kzahel/yepanywhere](https://github.com/kzahel/yepanywhere) `405f7d9b47968e7d331a1c82f71d81c9e525c168`
- [happier-dev/happier](https://github.com/happier-dev/happier) `89d49bd6437e32e4c48c66c50f8f282fcfefdc1c`
- [agent-of-empires/agent-of-empires](https://github.com/agent-of-empires/agent-of-empires) `47119c7dc463c1aa7b654db8d3324a80abec2666`
- [mixpeek/amux](https://github.com/mixpeek/amux) `835ff4a6e08a7162ff53bf2190c3f815400df897`

## 可采纳的共同模式

1. **浏览器、Web 服务、Codex runtime 分层。** `app-server` 只通过本机 stdio 运行，不直接开放网络端口；HTTP/WebSocket 层负责认证、授权、RPC 白名单和重连。
2. **凭据留在宿主机。** 浏览器仅接触 WFL 会话，不接触 Codex CLI 安装目录、认证文件或供应商密钥。
3. **CLI 升级是协议迁移。** 升级后不能只检查 `codex --version`，还要验证 `app-server`、协议 schema、thread 创建/读取/恢复、流式通知、中断和 workspace 行为。
4. **连接状态和任务结果分离。** WebSocket 重连成功不代表原 turn 成功；服务重启、runtime 中断、供应商错误和投递状态不确定必须分别表达。
5. **进程生命周期独立。** UI 刷新或断线不应直接终止 agent；服务更新必须显式重启对应 runtime，并展示被中断任务的可恢复状态。
6. **更新前快照、更新后健康检查、失败回滚。** `amux` 的运维说明也强调先快照、再更新、健康检查失败自动恢复，而不是在不可恢复的中间态持续重启。

## 不直接采用的方案

- 不用某个轻量 WebUI 整体替换 WFL。它们通常不具备 WFL 已有的多用户隔离、项目权限、版本哈希、原子保存、双后端切换和恢复事务。
- 不用 tmux 作为 Codex 对话权威。tmux 适合保持终端进程，但不能替代 `app-server` 的 thread/turn 状态、幂等投递与结构化恢复。
- 不把复杂的云端 daemon、端到端加密协议或移动推送栈直接引入本地部署。可借鉴进程解耦思想，但不扩大当前故障修复范围。
- 不伪造浏览器端没有实际实现的能力；工具目录与协议能力必须来自真实可用的 runtime 探测。

## 对 WFL 的直接决策

- Codex 更新在替换 CLI 前执行部署只读预检，确认活动 release、依赖、网关和蓝绿恢复资产可复用。
- 默认在候选验证通过后强制切换后端，不等待任务自然结束；管理员可显式设置
  `CODEX_DESKTOP_FORCE_UPDATE=0` 选择一次性等待模式。
- 回滚后的 CLI 状态记录为 `recovered` 终态，显示完成时间和实际耗时，不继续显示“已运行”。
- 救援组件不解析主站插件状态，避免主站未来 schema 变化阻止救援监听端口。
- 救援 systemd 单元采用有界失败重启，禁止 `Restart=always` 与无限 StartLimit。
- 主站和救援组件继续独立版本、独立切换和独立冻结。

## 验收基线

- CLI 更新前预检失败时，CLI 字节和所有后端拓扑保持不变。
- 新 CLI 安装后若 stage、activation 或协议验证失败，可离线恢复精确旧版本，且没有 recovery journal、lock 或 prepared deployment 残留。
- 浏览器重连后明确展示 turn 是完成、中断、失败还是投递状态不确定。
- 主站插件状态即使使用未来未知格式，救援服务仍能进入 ready。
- 救援连续启动失败达到限制后停止重启风暴，主站和 SSH 不受高频拉起影响。
