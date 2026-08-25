# WFL Windows Host 0.1.0

这是 `windows-codex-remote` 与 `creator-worker` 的共享伴随组件。它以当前 Windows 用户运行，
只向 WFL 建立出站 WebSocket，不开放入站端口，不安装管理员服务，不读取或上传 Codex 凭据。

## 前提

- Windows 10/11；
- Node.js 22 或更新版本；
- 如需本地 Codex：已安装 `codex`，并已在这台 Windows 上使用官方 ChatGPT/Codex 账号登录；
- 一个明确选择的 Creator 工作区。Agent 不会访问该目录以外的文件；
- 远程 WFL 地址必须使用 HTTPS。只有本机 `localhost` 测试允许 HTTP。

## 人工安装和配对

1. 在 WFL 插件中心安装并启用所需插件；普通用户还需要管理员逐项授权。
2. 在“Windows 设备”页面下载版本匹配的 ZIP，并解压到当前用户可写的本地目录。
3. 在普通 PowerShell 中运行 `scripts\install.ps1`。脚本会先要求输入 `INSTALL`，不会静默安装。
4. 在 WFL 的“Windows 设备”页面生成十分钟内有效的单次配对码。
5. 运行 `node src\main.mjs pair`，按提示输入 WFL 地址、配对码、Creator 工作区和本地 Codex 工程。
6. 运行 `start.cmd`。关闭该窗口会停止 Agent；第一版不会偷偷创建开机任务。

设备令牌保存在 `%LOCALAPPDATA%\WFL Codex Desktop\windows-host.json`，并用当前 Windows 用户
ACL 限制。配对码和令牌不会写到 WFL 日志或 URL。撤销设备后必须重新配对。

## 第一版边界

- Codex Remote 通过本机 `codex app-server` 列出、读取和恢复 Thread；只允许向空闲 Thread
  发起 Turn，不接管正在运行的桌面任务。
- Creator Worker 支持限定工作区文本操作、结构化 PPTX/DOCX 生成，以及检测到相应本地工具
  后的 FFmpeg 转码/合并和 Godot 固定预设导出。PDF 还需要 LibreOffice；已有输出文件不会被覆盖。
- 不接受 Shell 字符串、任意可执行文件路径、环境变量或管理员参数。
- 只接受本地盘上的显式绝对工作区；不接受 UNC 网络共享、符号链接或 Windows 保留设备名。
- 断线后不保存待执行动作；非幂等动作不自动重试。
