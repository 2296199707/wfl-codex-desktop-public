# WFL Codex Web Workspace

[简体中文](README.zh-CN.md) | [English](README.md)

WFL Codex Web Workspace 是一个可自行部署的 **Codex 网页工作区**，让你在电脑、
平板或手机浏览器中使用 Codex：发送任务、查看执行过程、处理审批、管理历史对话，
并让 Codex 在项目目录中读写代码、执行命令和运行测试。

官方 Codex 运行在你的服务器上，WFL 通过官方 `app-server` 协议提供网页界面。
你可以在电脑上开始一个对话，再用手机打开网站查看进度、追加要求或继续原来的对话，
无需在每台访问设备上安装 Codex。项目文件与对话保存在服务器上，浏览器是操作入口。

围绕网页里的 Codex 对话，WFL 配套提供工程管理、文件编辑、终端、Git 差异和运行预览，
方便你检查 Codex 做了什么，再继续提出修改要求。图片、游戏编辑和 SSH 等工具可按需启用。

使用前需要登录你自己的 Codex 官方账号，或配置兼容的 API 供应商；模型调用使用该账号或
供应商的额度。命令执行与文件修改遵循当前账号权限和所选审批设置。

当前版本：`v0.45.0`。版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 在网页里使用 Codex

- **发送任务并跟进执行**：在对话中让 Codex 阅读项目、编写功能或排查问题，查看回复、工具调用和命令结果，按需追加要求、处理审批或终止任务。
- **管理多个工程与对话**：为不同项目建立对话，切换、置顶、分支和恢复历史，让后续工作继续沿用原来的上下文。
- **选择模型与工作方式**：在网页中配置供应商、模型、推理强度和权限模式，并管理 Codex 扩展。
- **从不同设备继续使用**：电脑、平板和手机访问同一网站，登录后打开自己的工程和对话，查看任务进度并继续操作。
- **检查实际成果**：直接查看文件、Git 差异和网页预览，把发现的问题继续发给 Codex 修改。

## 基本使用流程

1. 登录网站，在供应商设置中完成 Codex 官方账号登录，或配置兼容的 API 供应商。
2. 创建或选择一个工程目录；已有代码可以通过文件管理器上传，也可以在服务器上准备好后打开。
3. 新建 Codex 对话，选择模型、推理强度和权限模式，描述任务；在对话里查看 Codex 的回复、工具执行和审批请求。
4. 使用文件管理器、终端、Git 差异和预览检查结果，在原对话中继续提出修改要求。
5. 下次进入网站时，选择原工程和对话继续工作。对话和项目保存在服务器上，不依赖某一台浏览器设备。

## Codex 对话与工作区功能

| 功能 | 网页中可以做什么 |
| --- | --- |
| 对话管理 | 新建、切换、置顶、分支、导入导出和恢复对话，折叠查看长对话。 |
| 执行与审批 | 查看工具执行过程和任务状态，处理审批、追加任务要求或终止执行。 |
| 模型与供应商 | 配置官方账号或兼容 API，选择模型、推理强度和权限模式。 |
| 项目与文件 | 选择工程目录，浏览和编辑文件，上传下载，使用终端和 Git 差异检查改动。 |
| 独立工作目录 | 新对话可选择 Git Worktree，在单独的工作目录中处理分支任务。 |
| Codex 扩展 | 通过 Codex 扩展中心管理其扩展能力。 |
| 多设备界面 | 使用桌面、平板或手机访问，支持简体中文和 English。 |

对话、模型、配置和审批基于官方 Codex 的协议接入。具体模型能力与可用参数取决于
安装的 Codex 版本及所选供应商。

## 配套工具与可选扩展

以下功能用于配合 Codex 检查成果、处理素材或调用外部服务，可按需要配置使用。

### 预览与创作工具

| 入口 | 用途 |
| --- | --- |
| 浏览器预览 | 打开工程中的网页或游戏，检查运行效果，并按需生成截图。 |
| 图片工作室 | 使用已配置的图片供应商生成、编辑和扩展图片，管理工程素材。 |
| 游戏编辑器 | 新建、命名和重新打开游戏工作工程，管理地图、瓦片集、World 与角色资源。 |
| 地图与角色动作编辑器 | 编辑 Tiled JSON 地图的图层、瓦片、对象和碰撞信息，以及角色动画和动作清单。 |
| 移动 App 工作台 | 准备 Flutter 工程依赖、进行 Web 预览和构建 Android APK。 |

游戏工程可以保存各自的工作设置，供下次打开时继续使用。在同一账号内，游戏工具的
AI 修改采用工程与对话一对一绑定；编辑器右侧 AI 小窗使用该绑定对话，并与主站同步上下文。
可以解除绑定后更换对话，其他对话仍可读取其有权限访问的工程。地图、瓦片集、图片等
继续作为独立文件保存；可用编辑操作取决于当前地图类型和所选图层。

图片生成需要单独配置可用的图片供应商，Flutter 预览和 APK 构建需要相应工具链。
Web 预览用于检查浏览器运行效果，设备端行为仍需在目标设备上验证。

### 插件与 AI 工具

WFL 插件页用于启用和配置网站提供的扩展能力。支持 AI 调用的插件会在授权后提供相应工具，
让 AI 在对话中执行操作；仅安装插件不等于已配置供应商、凭据或目标服务器。

- **AI 供应商真实测试**：复用已保存的供应商，测试 Responses 请求、流式响应、结构化输出和 Agent 工具调用流程，并查看结果。
- **临时 SSH 与持久 SSH**：配置目标服务器和授权，让 AI 通过 SSH 执行远程运维任务。
- **Windows Codex Remote 与 Creator Worker**：连接个人 Windows，恢复空闲的本地 Codex 对话，或在限定工作区执行文档、媒体和 Godot 等任务。需要安装配套组件并由管理员授权，见 [Windows Host 指南](docs/WINDOWS-HOST.zh-CN.md)。

网站插件页与 Codex 扩展中心是不同入口：前者管理 WFL 的服务集成，后者管理 Codex 自身的扩展。

### 可选 Claude Code 运行时

也可在版本中心安装可选的 Claude Code 组件，再通过左上角切换运行时。
Claude Code 使用独立会话和供应商配置，支持其 MCP、Skills、Agents 与 Plugins；
Codex 与 Claude Code 的对话分别管理。新服务器默认不安装 Claude Code。

## 账号与服务器管理

- 单用户网页登录；可选多用户模式，提供邀请注册、独立 Linux 用户目录、空间配额和 Token 限额管理。
- 管理员服务器文件管理器、项目存储位置设置，以及运维中心的健康检查、任务与请求日志、告警和备份迁移。
- 域名与 HTTPS 配置，支持现有反向代理、Cloudflare Tunnel，以及 DNSPod / Let's Encrypt 配置向导。
- 版本中心和可恢复的蓝绿更新；独立备用窗口供所有者在主站异常时进行恢复，主站更新不会自动升级备用窗口。

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
- `git describe --tags --exact-match` 必须显示当前发布标签 `v0.45.0`。
- 本地分支必须跟踪 `origin/stable`；不要使用产生 detached HEAD 的标签克隆方式，
  也不要在源码目录中保留手工改动。

进入工程后，唯一需要执行的安装命令就是 `sudo bash install.sh`。向导会依次要求：

1. 确认 Git 或发布安装包来源，并选择是否准备后续版本同步。
2. 选择官方 OpenAI 设备登录、Responses 兼容 API 供应商或稍后网页配置。
3. 设置所有者网页登录密码；自动生成的密码只显示一次。
4. 选择浏览器访问方式并复核完整安装计划。
5. 安装依赖、运行快速兼容检查、创建服务并执行可恢复的双槽发布。普通服务器
   安装时使用有界的兼容性与健康检查，完整测试留在开发或候选验证环境执行。
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
sha256sum -c wfl-codex-desktop-v0.45.0.tar.gz.sha256
tar -xzf wfl-codex-desktop-v0.45.0.tar.gz -C /srv
mv /srv/wfl-codex-desktop-v0.45.0 /srv/wfl-codex-desktop
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

已启用网页登录保护时，未登录访问首页通常会返回 `302`，跳转到 `/login.html`；
受保护的 API 则返回 `401`。这表示需要登录，不代表服务启动失败。
使用安装时配置的网页账号和密码登录；单用户默认用户名为 `codex`，以安装结果为准。

选择“稍后配置 Codex”时，登录网页后打开 `/#providers` 添加并启用 API 供应商，
否则对话无法发送。

## 后续配置与更新

### 项目存储位置

管理员可在侧栏设置数据盘目录，创建普通工程或游戏工程时选择可用的存储位置。
没有数据盘也可以使用默认项目目录，不要求固定的磁盘挂载路径。

也可通过 `CODEX_DESKTOP_PROJECT_ROOTS` 配置多个项目存储根目录，Linux 服务器
用冒号分隔，例如 `/srv/projects:/mnt/data/projects`，第一项作为默认主存储。
使用数据盘前应确认已挂载且服务账号有访问权限。

### 访问配置与版本更新

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

更新器会在隔离目录安装依赖并运行快速兼容检查。默认在候选验证通过后立即强制蓝绿切换，
不等待运行中的对话；正在执行的任务可能中断，浏览器随后会自动重连。若本次
维护需要等待空闲，可显式设置 `CODEX_DESKTOP_FORCE_UPDATE=0`。候选后端仍由独立
watchdog 保护，启动失败时恢复旧后端或完成候选。
后端启动前必须先通过 Codex 与数据恢复门禁；维护 worker 失败时会先修复 Codex
CLI，再恢复后端拓扑。

备用服务使用独立的 `4320/4321` 双槽和 active-port 文件，组件版本与主站版本号
分离，具体组件版本以备用窗口显示为准。全新安装会从同一发行包准备备用
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

- 项目、对话、账号凭据和上传文件属于服务器上的私有数据，不包含在公开源码或
  发布安装包中。更新流程会管理程序及运行时文件，重要数据仍应定期备份。
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
