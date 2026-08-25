# Windows Host 与 Creator Worker

Windows Host 是 WFL Codex Desktop 的可选伴随组件。它让已获授权的用户通过手机或其他浏览器，安全访问自己 Windows 个人电脑上的本地 Codex，并运行限定工作区内的结构化创作任务。

第一版不提供桌面鼠标键盘接管、任意 PowerShell、任意命令执行、管理员服务、静默安装或开机自启。它也不会把 Windows 上的 Codex 登录文件、ChatGPT 会话或 API Key 上传到 WFL 服务器。

## 组件与信任边界

- `windows-codex-remote`：列出用户明确公开的本地工程，读取经过裁剪的 Thread 消息预览，恢复空闲 Thread，并向空闲 Thread 发起 Turn。
- `creator-worker`：在用户明确选择的工作区内读写文本，或运行固定参数结构的 PPTX、DOCX/PDF、FFmpeg 和 Godot 任务。
- `WFL Windows Host`：以当前 Windows 用户身份运行的 Node.js 伴随进程，只向 WFL 建立出站 WebSocket。
- WFL 设备网关：验证设备令牌、用户插件授权以及设备/Thread 租约；断线后不排队、不重放动作。

完整安全决策见 [ADR 0003](./adr/0003-windows-host-and-creator-plugins.zh-CN.md)。

## 管理员启用

1. 打开“设置 → 插件中心”。
2. 安装并启用 `Windows Codex Remote` 或 `Creator Worker`。两者可独立启用，但共用同一个 Windows 伴随组件。
3. 普通用户还需要 `Codex 插件`权限，以及管理员对每个高风险插件的逐用户授权。所有者和管理员仍按自己的账号隔离设备。
4. 撤销逐用户授权、禁用或卸载插件会立即提升设备 epoch、结束租约并断开相应设备连接；旧结果不会被接受。

插件安装不代表伴随组件会自动进入用户电脑。Windows 安装始终需要电脑前的用户明确确认。

## Windows 安装与配对

前提：

- Windows 10/11；
- Node.js 22 或更高版本；
- 若使用本地 Codex，需在这台 Windows 上安装 Codex CLI，并在本机完成官方 ChatGPT/Codex 登录；不需要把账号或 API 交给 WFL 服务器；
- 远程 WFL 地址必须为 HTTPS；只有同一台电脑上的 `localhost` 调试允许 HTTP。

步骤：

1. 已授权用户在插件中心打开“Windows 设备”，下载 `wfl-windows-host-v0.1.0.zip`。
2. 在 Windows 解压 ZIP，以普通 PowerShell 运行 `scripts\install.ps1`。脚本会要求输入 `INSTALL`，并只执行依赖安装和源码检查。
3. 在网页选择需要配对的插件，生成一次性配对码。新配对码会使该用户尚未使用的旧码失效。
4. 在 Windows 运行 `node src\main.mjs pair`，输入 WFL HTTPS 地址、配对码、Creator 工作区和一个本地 Codex 工程。
5. 运行 `start.cmd`。保持此普通用户窗口运行；关闭窗口即停止出站 Agent。

设备令牌只保存在 `%LOCALAPPDATA%\WFL Codex Desktop\windows-host.json`，文件 ACL 仅授予当前 Windows 用户。令牌不进入 URL、浏览器、本地日志或 WFL 持久状态；服务器只保存加盐 HMAC。

## 手机浏览器流程

1. 用自己的 WFL 账号登录手机浏览器。
2. 在插件中心打开 Windows 设备，选择一台在线设备。
3. 本地 Codex：先读取工程，再读取 Thread；只能恢复没有 active Thread/Turn 的 Thread。发送动作使用项目、Thread、浏览器会话、窗口、设备 epoch 和租约 epoch 的完整隔离上下文。
4. Creator Worker：选择任务类型、相对工作目录并编辑结构化 JSON 规格。服务器与 Windows Agent 会分别重新校验字段和路径。
5. 如怀疑设备令牌泄露，直接在网页撤销设备。设备必须重新配对才能再次连接。

同一台设备同一时刻只接受一个浏览器窗口中的一个 Thread 租约。后台 Thread、另一个用户、另一个窗口或迟到结果都不能复用该租约。

## Creator Worker 支持范围

| 类型 | 输出/要求 |
| --- | --- |
| `presentation.generate` | `.pptx`；使用 PptxGenJS 生成结构化标题、正文、项目符号和备注 |
| `document.generate` | `.docx`；输出 `.pdf` 时还需安装 LibreOffice |
| `media.transcode` | `.mp4`、`.webm`、`.mp3`、`.wav`；需安装 FFmpeg |
| `video.compose` | `.mp4` 或 `.webm`；固定缩放、补边和编码参数；第一版不烧录字幕 |
| `godot.export` | `.exe`、`.zip`、`.pck`；需安装 Godot/Godot 4、存在 `project.godot`，并使用项目中已有的导出预设 |

输出先写入同目录随机临时文件，再以排他方式发布；已有目标文件不会被覆盖。工作区路径不接受绝对路径、`..`、符号链接、NTFS ADS、Windows 保留设备名或危险字符。外部工具以固定可执行文件名、固定参数模板和 `shell: false` 运行。

Godot 导出和媒体解析会执行已安装的本地工具，也会处理用户工作区中的工程或媒体，因此仅应对可信工作区启用 Creator Worker。

## 断线、重连与更新

- Agent 断线时，设备租约和未完成调用立即失效；服务器不会保存待执行动作。
- Creator 运行记录会进入 `interrupted` 或 `failed`，不会自动重放非幂等任务。相同用户、设备和 Job ID 只有完全相同的请求才能命中幂等结果。
- 主站蓝绿切换时，网关用 `1012` 关闭设备 WebSocket；Agent 重新出站连接并用设备令牌认证。
- 每账号最多保留 10 台有效设备和 20 条最近撤销记录；每台设备最多同时等待 4 个调用。
- Windows 伴随组件有独立版本。服务器升级不会在个人电脑上静默替换它；用户需重新下载并人工确认更新。

## 明确不支持

- 无人值守桌面游戏操作、远程鼠标键盘或屏幕接管；
- 任意 Shell、PowerShell、管理员命令或用户提交的可执行文件路径；
- 自动安装软件、驱动、防火墙规则、系统服务或计划任务；
- 把 Windows 本地 Codex 凭据迁移到 WFL 服务器；
- 断线期间积压动作，或在重连后猜测性重试。
