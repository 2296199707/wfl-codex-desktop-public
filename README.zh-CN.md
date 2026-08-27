# WFL Codex Web Workspace

[简体中文](README.zh-CN.md) | [English](README.md)

WFL Codex Web Workspace 是运行在浏览器中的 Codex 工作区界面，底层直接使用官方 Codex
`app-server` 的对话、模型、配置和审批协议。它适合部署在专用 Debian/Ubuntu
服务器上，通过 HTTPS 域名、Cloudflare Tunnel 或 SSH 端口转发访问。

当前版本：`v0.44.56-beta`。版本变化见 [CHANGELOG.md](CHANGELOG.md)。

项目存储根目录可以通过 `CODEX_DESKTOP_PROJECT_ROOTS` 配置为多个路径，Linux
服务器用冒号分隔，例如 `/srv:/www`。创建工程时可在弹窗中选择存储位置，第一项
仍作为默认主存储；备用服务器可将项目放到单独挂载的数据盘。

## 主要功能

- 工程与对话切换、长对话折叠、分支、置顶、导入导出和恢复。
- 模型、推理强度、API 供应商、服务器隔离浏览器中的官方 Codex OAuth 登录及图片生成配置。
- 新服务器默认不安装 Claude Code；未安装时 Claude 工作页保持禁用并引导管理员
  到版本中心下载已审查组件，Codex 不受影响；已有服务器的内置 Claude 会继续保留。
  左上角可切换独立的 Claude Code 运行时；Claude 供应商按用户加密保存，支持
  原生 stream-json 会话、官方账号、MCP、个人 Skills、自定义 Agents、用户级
  Plugins，以及新对话 Worktree 和工程内额外目录；Claude 兼容中心固定已审查
  CLI、参数、权限模式、Effort 与 stream-json 基线，提供不含路径和账号信息的
  Doctor 摘要，阻止原生自动更新，并在轻量更新检查中拒绝未审查候选；Codex
  新对话也可选择账户
  隔离的 Worktree，并支持 Local 安全交接、正式分支和恢复快照；Claude 与
  Codex 使用分离会话；独立备用窗口仍然只运行 Codex。
- 工程上传下载、文件管理、代码编辑和 HTML/游戏浏览器预览。
- 文件管理器可按需打开独立的 Tiled JSON 地图编辑器；`.tmj` 地图和外部 `.tsj`、图片、音频继续
  独立保存，桌面、平板和手机均支持图层、瓦片、对象、碰撞、撤销、版本冲突及大地图分块原子保存。
  AI 修改采用用户显式复制提示词、粘贴结构化补丁、预览并确认的流程，只进入当前窗口撤销历史，
  不自动调用对话或保存文件。
- 游戏工程预览保持 HTML、脚本、样式、图片、音频和地图为独立原文件；也可以在本机使用
  `npm run preview-project -- /srv/wflgame`、`npm run preview-file -- assets/hero.webp`
  和 `npm run preview-capture -- http://127.0.0.1:4173 --output game.png`。预览服务默认只监听
  `127.0.0.1`，截图会阻止私网/回环以外的未授权目标和跨 Origin 资源请求，不会把资源打包进 HTML。
  主站内的项目截图同样通过隔离 Render Worker 排队，遵循管理员手动设置的截图并发、内存和超时；
  Worker 失败或关闭不会影响浏览器编辑、保存和聊天主站。
  管理员后台还可选择每会话独立 Origin（需要 wildcard 证书），把游戏的 localStorage、IndexedDB
  和 Service Worker 存储进一步隔离到用户、工程和预览窗口。
- 管理员运维中心内置腾讯云 DNSPod 与 Let's Encrypt DNS-01 向导：SecretId/SecretKey 只保存在
  服务器 0600 私有文件中，支持先预览 DNS 写入计划、检查解析/TLS/HTTPS，再显式确认创建记录、
  申请证书和更新由 WFL 管理的 Nginx；已有第三方反向代理不会被覆盖。每会话模式要求使用独立
  预览子域名（例如 `preview.example.com`），自动化不会接管根域名的 `*.example.com`。
- 可选多用户、独立 Linux 用户目录、空间配额、Token 限额和套餐管理。
- 可选 Windows Codex Remote 与 Creator Worker：个人 Windows 只建立出站连接，管理员逐用户授权后可从手机恢复空闲的本地 Codex Thread，或在限定工作区运行结构化文档、演示、媒体和 Godot 任务；不提供桌面接管或任意管理员 PowerShell。见 [Windows Host 指南](docs/WINDOWS-HOST.zh-CN.md)。
- 运维中心、健康评分、任务与请求日志、告警、备份和工作区迁移。
- 测试后执行带独立恢复 watchdog 的双槽更新；仅所有者可使用独立的
  `/rescue.html` 备用窗口，并在官方索引损坏时读取带校验的最后有效聊天快照。
- 界面支持简体中文和 English，语言偏好只保存在当前浏览器。

## 新服务器快速安装

### 1. 确认环境

安装器支持带 systemd 的 Debian 或 Ubuntu，需要：

- `root` 权限和至少 2 GiB 可用磁盘空间。
- 一台专用 VPS 或隔离服务器，不要与数据库等重要生产业务混部。
- 公开仓库通过 HTTPS 只读克隆，不需要 GitHub Token 或 Deploy Key。

全新安装需要服务器能够出站访问：

- Debian/Ubuntu 已配置的 APT 软件源，用于系统基础包和 Chromium 系统依赖。
- `registry.npmjs.org`（或已配置的 npm registry），用于 `npm ci` 安装锁定依赖。
- `cdn.playwright.dev`，用于下载与当前 Playwright 版本匹配的 Chromium。
- GitHub，用于克隆公开仓库和检查后续稳定更新。
- 仅当服务器没有受支持的 Node.js 和 npm 时，访问 `deb.nodesource.com` 安装
  Node.js 22。

安装器会先尝试 `https://chatgpt.com/codex/install.sh` 安装官方 Codex CLI；该地址
被阻断或不可用时，才从 npm registry 安装官方 `@openai/codex` 包。npm registry
本身仍是应用依赖的必需来源，因此不能把它和 Codex 官方安装地址理解为二选一。

安装器会自动安装 Node.js、官方 Codex CLI、锁定的 npm 依赖、Playwright
Chromium 和 systemd 服务。全新服务器不需要提前手动安装 Codex 或 Node.js。

### 2. 克隆并启动向导

```bash
sudo -i
apt-get update
apt-get install -y git ca-certificates
git clone --branch stable https://github.com/2296199707/wfl-codex-desktop-public.git /srv/wfl-codex-desktop
cd /srv/wfl-codex-desktop
git status --short
git describe --tags --exact-match
sudo bash install.sh
```

- `git status --short` 必须没有输出。
- `git describe --tags --exact-match` 必须显示当前发布标签 `v0.44.56-beta`。
- 本地分支必须跟踪 `origin/stable`；不要使用产生 detached HEAD 的标签克隆方式，
  也不要在源码目录中保留手工改动。

进入工程后，唯一需要执行的安装命令就是 `sudo bash install.sh`。向导会依次要求：

1. 确认 Git 或发布安装包来源，并选择是否准备后续版本同步。
2. 选择官方 OpenAI 设备登录、Responses 兼容 API 供应商或稍后网页配置。
3. 设置所有者网页登录密码；自动生成的密码只显示一次。
4. 选择浏览器访问方式并复核完整安装计划。
5. 安装依赖、运行快速兼容检查、创建服务并执行可恢复的双槽发布；只有明确选择
   额外完整测试时才会在本机重复候选阶段已通过的全套测试。
6. 完成域名、Cloudflare Tunnel 或本地访问配置。

SSH 意外断开不会中止已经进入后台的发布任务。重新连接后可查看：

```bash
cd /srv/wfl-codex-desktop
npm run release:status
```

## 使用发布安装包

没有 Git 克隆条件时，上传同一版本的 `.tar.gz` 和 `.sha256` 两个文件：

```bash
cd /root/install
sha256sum -c wfl-codex-desktop-v0.44.56-beta.tar.gz.sha256
tar -xzf wfl-codex-desktop-v0.44.56-beta.tar.gz -C /srv
mv /srv/wfl-codex-desktop-v0.44.56-beta /srv/wfl-codex-desktop
cd /srv/wfl-codex-desktop
sudo bash install.sh
```

安装包不包含 API Key、网页登录密码、Git 私钥、Codex 登录状态、对话或项目数据。
通过公开仓库克隆的安装会直接跟踪 `origin/stable`。只有从发布包离线安装并希望
改用自有 SSH 镜像时，才需要运行 `sudo npm run server:updates` 配置只读密钥。

## 三种访问方式

### 已有 HTTPS 域名

域名先解析到服务器。可以保留宝塔、1Panel、Nginx 或 Caddy 的现有反向代理，
也可以让向导安装 Nginx 和 Certbot。反向代理必须满足：

```text
源站：http://127.0.0.1:4317
WebSocket：启用
HTTPS：启用
```

### Cloudflare Tunnel

适用于不开放 `80/443` 或没有直接公网入口的服务器。在 Cloudflare Zero Trust
创建 Tunnel 和 Public Hostname，Service URL 填：

```text
http://127.0.0.1:4317
```

向导会隐藏读取 connector token，并只把它保存到 root 所有、权限为 `0600` 的
`/etc/cloudflared/token` 文件；systemd 通过 `--token-file` 启动连接器。令牌不会
进入项目、状态元数据、命令参数、shell 历史或发布包。

### 本机或 SSH 转发

此方式不修改公网配置。在本地 Windows PowerShell 运行：

```powershell
ssh -p 22 -N -L 4317:127.0.0.1:4317 root@SERVER_IP
```

SSH 不是 `22` 端口时替换 `-p` 后的数字。保持 PowerShell 窗口运行，再打开：

```text
http://127.0.0.1:4317
```

服务只应监听回环地址。不要在公网防火墙放行 `4317` 至 `4321`。

## 安装后验证

```bash
cd /srv/wfl-codex-desktop
npm run server:doctor
npm run release:status
systemctl status wfl-codex-desktop-gateway.service
curl -I http://127.0.0.1:4317/
```

未提供网页登录凭据时，`curl` 返回 `401 Unauthorized` 表示网关和密码保护正常。
浏览器登录默认用户名是 `codex`；密码为安装向导中生成或设置的值。

选择“稍后配置 Codex”时，登录网页后打开 `/#providers` 添加并启用 API 供应商，
否则对话无法发送。

## 后续配置与更新

```bash
cd /srv/wfl-codex-desktop
sudo npm run server:access    # 重新配置域名、Cloudflare 或本地访问
sudo npm run server:password  # 重置单用户网页登录密码
sudo npm run server:updates   # 仅供发布包安装或自有 SSH 镜像配置更新源
sudo npm run server:rescue-update # 所有者明确批准后，独立升级备用窗口
```

后续升级优先使用网页“版本中心 -> 检查并升级”。命令行等价流程为：

```bash
npm run app:update:check
npm run app:update:wait
npm run app:update:status
```

更新器会在隔离目录安装依赖并运行快速兼容检查。正式版本的完整测试、浏览器验证
和主服务器部署证明已在候选阶段完成。默认在候选验证通过后立即强制蓝绿切换，
不等待运行中的对话；正在执行的任务可能中断，浏览器随后会自动重连。若本次
维护需要等待空闲，可显式设置 `CODEX_DESKTOP_FORCE_UPDATE=0`。候选后端仍由独立
watchdog 保护，启动失败时恢复旧后端或完成候选。
后端启动前必须先通过 Codex 与数据恢复门禁；维护 worker 失败时会先修复 Codex
CLI，再恢复后端拓扑。

备用服务使用独立的 `4320/4321` 双槽和 active-port 文件，组件版本与主站版本号
分离；当前包包含 `1.1.8备用窗口`。全新安装会从同一个已验证发行包准备备用
服务，但已有服务器同步主站时不会自动切换、重启或替换备用窗口。只有所有者在
当前请求或备用界面中明确批准，才执行 `server:rescue-update`：它会先在非活动槽
验证当前活动正式发布包，再把同一候选提升到固定救援端口 `4321` 并让稳定网关
原子确认；失败时恢复原槽。该流程
固定为强制更新，不等待备用任务结束，允许任务中断或丢失；候选备用组件版本必须
严格递增。
主窗口与备用窗口共享按对话隔离的写租约，不能同时修改同一对话。
从旧单槽备用服务升级时，旧界面尚无新入口，因此首次转换需执行命令行命令；
完成后才可在备用窗口中升级后续版本。

## 数据与安全边界

- 源码更新不会复制或覆盖 `.codex-desktop`、`.codex-runtime`、`~/.codex`、用户
  HOME、项目、对话、上传文件或代理凭据。
- 多用户模式默认关闭，只接受管理员生成的一次性邀请，不提供公开注册。
- Linux 用户目录隔离不是容器级网络隔离；不可信租户应使用独立虚拟机或容器。
- API Key 会使用服务器本地密钥加密保存，但服务器 `root` 仍拥有系统管理权限。
- 数据迁移前先使用备份中心或工作区迁移功能，不要把私有状态提交到 GitHub。

详细资料：

- [完整新服务器部署手册](docs/server-deployment.zh-CN.md)
- [服务器更新说明](docs/SERVER-UPDATES.md)
- [移动 App 工作台](docs/mobile-app-tool.zh-CN.md)
- [工作区迁移](docs/workspace-migration.zh-CN.md)
- [多用户安全边界](docs/MULTI-USER-SECURITY.zh-CN.md)
- [版本更新记录](CHANGELOG.md)

## 许可证

WFL Codex Web Workspace 自有代码采用 MIT License，详见 [LICENSE](LICENSE) 和
[第三方许可清单](THIRD-PARTY-NOTICES.md)。android/ 下的 SyncVault 客户端
和 tools/wfl-codex-drive/ 下的网盘客户端是独立组件，分别保留 BSD-3-Clause
和 GPL-3.0；字体及依赖继续适用清单中列出的原许可证。

## 本地开发

本地开发需要先安装并授权官方 Codex CLI：

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
npm ci
npx playwright install chromium
npm run setup:check
npm start
```

打开 `http://127.0.0.1:4317`。提交前运行：

```bash
npm run check
```
