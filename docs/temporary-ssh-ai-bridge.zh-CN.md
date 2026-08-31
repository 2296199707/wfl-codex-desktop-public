# WFL 临时 SSH AI 接管记录

更新时间：2026-08-31

## 1. 范围和边界

这里记录的是 WFL 网站的 `secure-ssh-access` 插件，不是 Codex 原生插件、Codex 插件市场条目，也不是本地 Codex CLI 的安装扩展。

WFL 网站中的 Codex app-server 通过一个由网站运行时注入的私有 MCP 适配器使用此能力。插件页负责创建和撤销临时授权；AI 只能使用已经由管理员在插件页创建的活动授权。

## 2. 根因

修复前，临时 SSH 插件只有网站 HTTP 接口和 `scripts/plugin-ssh-access.mjs` 查询 CLI，没有接入 AI 的 MCP 工具。Codex 运行时只注入了 `wfl_persistent_ssh`，所以 AI 看不到临时授权，也无法执行临时 SSH 命令。

这与浏览器页面、登录会话或 Codex 原生插件市场无关。正确入口是 WFL 服务端的用户运行时和私有 Unix Socket。

## 3. 当前设计

```text
WFL 插件页
  └─ 创建/撤销临时 SSH 授权
       └─ TemporarySshAccessService（网站服务端）
            ├─ 公钥模式：服务端生成临时密钥并写入目标机
            ├─ 密码兼容模式：密码只用于建立内存 SSH 控制会话
            └─ 到期/撤销时清理授权并终止活动命令

WFL 用户运行时
  └─ 私有 Unix Socket
       └─ wfl_temporary_ssh MCP
            ├─ list_temporary_ssh_access
            └─ run_temporary_ssh_command
```

每个 WFL 用户运行时使用独立的 MCP Socket。Socket 不把密码、私钥或凭据路径放入 MCP 参数、AI 返回值或日志。每次工具调用仍在服务端重新检查：

- 当前后端必须是可写主后端；
- `secure-ssh-access` 必须已安装并启用；
- 当前账号必须是 `owner` 或 `admin`；
- `accessId` 必须对应仍未过期的临时授权。

临时 SSH 工具不使用持久 SSH 配置，也不允许 AI 自己传入目标 URL、密码、私钥或任意凭据。`wfl_persistent_ssh` 仍只访问持久 SSH 插件中已启用的服务器；AI 不能通过一个工具切换到另一个工具的授权。

## 4. 命令行为

该能力的目标就是让管理员授权后的 AI 执行远程运维命令，因此没有远程命令白名单，也没有把命令改成固定的诊断集合。命令以非交互式 SSH 进程执行，当前仅有传输层边界：

- 单条命令最长 32 KiB，禁止 NUL、回车和换行；
- 默认超时 60 秒，调用方可设置 1 到 120 秒；
- 标准输出和错误输出合计最多 1 MiB；超出后终止进程并标记 `truncated`；
- MCP 工具等待时间为 130 秒，覆盖远程命令最长等待时间和少量传输余量。

这些边界用于防止 MCP Socket 或网站进程被无限挂起，不改变目标服务器的实际权限，也不替管理员决定应该执行什么运维命令。

## 5. 撤销和生命周期

- 插件页撤销授权时，先终止该授权关联的活动 SSH 命令，再关闭密码控制会话或移除临时公钥。
- 授权到期清理本地密钥、已知主机文件、控制 Socket 和记录文件。
- 插件停用或卸载前，如果仍有临时授权，网站要求先撤销授权；因此停用后不会留下可继续使用的远程入口。
- MCP 的能力声明会轮询活动授权状态。插件被停用或授权状态变化后，工具列表会收到 `notifications/tools/list_changed`；即使客户端没有刷新列表，服务端工具调用仍会再次拒绝。
- 救援窗口不提供此能力，且本次实现没有修改救援窗口、`4321` 或其资产。

## 6. 已完成文件

- `lib/temporary-ssh-access.mjs`：服务端执行、输出收集、超时、撤销/到期终止。
- `lib/persistent-ssh-tool-service.mjs`：复用 WFL 私有 Socket 传输并支持能力查询。
- `scripts/temporary-ssh-mcp.mjs`：WFL 网站使用的 MCP 适配器。
- `server.mjs`：为每个用户运行时接入临时 SSH Socket 和 MCP 配置，并执行实时授权检查。
- `plugins/catalog/secure-ssh-access/plugin.json`：增加 `command:remote` 权限，版本为 `1.2.0`。
- `test/temporary-ssh-access.test.mjs`、`test/temporary-ssh-tool.test.mjs`：服务、撤销、MCP、管理员能力和网站运行时接线回归。

## 7. 验证记录

2026-08-31 已通过：

- 相关模块 `node --check`；
- `node --test test/temporary-ssh-access.test.mjs`：12/12；
- `node --test test/temporary-ssh-tool.test.mjs`：2/2；
- `node --test test/persistent-ssh-servers.test.mjs test/plugin-store.test.mjs`：16/16。

以上是服务端和 MCP 的有界验证，不等同于已经连接某台真实目标服务器。真实端到端验证仍需要管理员在 WFL 插件页创建授权，并使用一台可达、主机指纹可验证的测试 SSH 服务器；测试凭据不应写入仓库、日志或对话。

本批次发布使用新的主站版本和既有蓝绿流程，不复用旧版本号，也不操作冻结的救援窗口；真实目标服务器验证仍按上面的凭据和主机指纹要求执行。
