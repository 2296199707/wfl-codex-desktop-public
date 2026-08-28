# 新服务器部署

## 适用范围

自动安装器支持使用 systemd 的 Debian 或 Ubuntu。服务默认以 `root` 运行，
因为 Codex 工具、双槽切换和网页内发布需要管理项目文件及 systemd。
请使用独立 VPS 或专用服务器，不要与数据库、网站生产服务等重要业务混部。

固定网络结构如下：

- `127.0.0.1:4317`：稳定网关，Cloudflare Tunnel 只连接这个端口。
- `127.0.0.1:4318`、`127.0.0.1:4319`：双槽后端，不对公网开放。
- `127.0.0.1:4320`、`127.0.0.1:4321`：仅所有者可用的独立救援双槽。
- 防火墙不要放行 `4317` 至 `4321`。

### 工程预览 Origin 与证书

项目预览默认保持安全沙箱，不会猜测服务器域名，也不会把主站域名写进发布包。
管理员可以在主站 `/ops` 的“项目预览域名”区域确认当前实例的 HTTPS Origin；候选
域名只作为提示，必须由所有者确认。确认后服务按用户、工程和入口稳定选择
`preview-1..N.<实例域名>`，旧会话仍会在 Host、账号、项目路径和 Thread 版本校验失败时
被拒绝。DNS、反向代理和证书必须覆盖每个预览子域名；未完成时可随时停用并回到沙箱。若在
后台选择“每会话独立 Origin”，还必须准备 `preview-session-<随机值>.<预览基础域名>` 的
wildcard DNS 与证书；该模式才会把浏览器存储进一步隔离到用户、工程和预览窗口。

访问向导也支持显式配置预览池：

```bash
sudo npm run server:access -- --preview-base-domain preview.example.com --preview-slots 4
```

这会把预览主机加入同一份 Nginx/Certbot 配置，仍不会自动猜测或启用任意域名。日常
本地开发可以直接使用原文件预览工具：

```bash
npm run preview-project -- /srv/wflgame
npm run preview-file -- /srv/wflgame/assets/hero.webp
npm run preview-capture -- http://127.0.0.1:4173 --output /tmp/game.png
```

三个工具默认只监听回环地址；截图工具仅允许目标 Origin 及明确允许的资源，并在 DNS
解析后拒绝回环、私网、链路本地和组播地址。

#### 腾讯云 DNSPod 与证书向导

管理员可以在 `/ops` 的“腾讯云 DNS 与证书向导”中保存腾讯云 SecretId、SecretKey、
DNSPod 根域名、记录目标和证书通知邮箱。凭据只写入主站状态目录下权限为 0600 的
`tencent-cloud-dns.json`，接口和运维日志只返回遮罩后的 SecretId，不返回 SecretKey；
救援窗口不会读取或修改该文件。

推荐先点击“预览写入计划”和“检查 DNS/证书状态”。“一键配置”只有在所有者再次确认后
才会调用 DNSPod API；遇到同名不同记录默认停止，只有勾选“允许替换”才会修改。证书使用
Let's Encrypt DNS-01，TXT challenge 由 DNSPod API 创建并在验证后清理。只有
`access.json` 明确标记为 `nginx-certbot` 且站点文件仍带 WFL 管理标记时，向导才会更新
Nginx；第三方 Nginx、Caddy、面板配置和 Tunnel 不会被覆盖。失败时会恢复本次创建或修改的
DNS 记录，并恢复向导改写前的 Nginx 配置。

每会话 Origin 必须使用独立的预览子域名，例如：

```text
公开 Origin：https://chat.example.com
预览基础域名：preview.example.com
DNSPod 根域名：example.com
自动记录：*.preview.example.com
```

为了避免接管其他业务子域名，自动向导拒绝为根域名直接创建 `*.example.com`。各服务器只
使用自己管理员填写并确认的域名和腾讯云凭据，发布包不会包含某个固定站点域名。

部署前确认服务器可以出站访问：

- Debian/Ubuntu 已配置的 APT 软件源，用于基础包和 Chromium 系统依赖。
- `registry.npmjs.org`（或已配置的 npm registry），用于 `npm ci` 安装锁定依赖。
- `cdn.playwright.dev`，用于下载与当前 Playwright 版本匹配的 Chromium。
- GitHub，用于 Git 克隆、校验或后续版本同步；仅使用已上传的发布包且不启用同步时
  可以不从新服务器访问 GitHub。
- 仅当服务器没有受支持的 Node.js 和 npm 时，`deb.nodesource.com` 用于安装
  Node.js 22。

安装器会先尝试 `https://chatgpt.com/codex/install.sh` 安装官方 Codex CLI。只有该
地址被阻断、连接失败或超时，才回退到 npm registry 上的官方 `@openai/codex`
包。npm registry 同时承担应用依赖安装，不是可以和 Codex 官方安装地址二选一的
网络来源。

Claude Code 是可选组件。新服务器安装流程不会下载 Claude；安装完成后 Claude
工作页会保持禁用，并提示管理员前往版本中心下载已审查版本。Codex、主站部署和
备用窗口均不依赖 Claude。已有服务器若已包含 Claude，常规更新会继续保留它。

## 1. 准备安装源

支持两种安装源，二选一即可。

### 方式 A：克隆公开仓库

公开稳定分支可通过 HTTPS 只读克隆，不需要 GitHub 账号、Token 或 Deploy Key。

```bash
sudo -i
apt-get update
apt-get install -y git ca-certificates
git clone --branch stable https://github.com/2296199707/wfl-codex-desktop-public.git /srv/wfl-codex-desktop
cd /srv/wfl-codex-desktop
git status --short
git describe --tags --exact-match
```

继续安装前，`git status --short` 必须没有输出，`git describe` 必须显示当前
发布标签，本地分支必须跟踪 `origin/stable`。

### 方式 B：上传发布安装包

从已发布服务器取得同一版本的两个文件并上传到新服务器：

- `wfl-codex-desktop-v0.44.63-beta.tar.gz`
- `wfl-codex-desktop-v0.44.63-beta.tar.gz.sha256`

先独立核对校验值，再解压到固定目录：

```bash
cd /root/install
sha256sum -c wfl-codex-desktop-v0.44.63-beta.tar.gz.sha256
tar -xzf wfl-codex-desktop-v0.44.63-beta.tar.gz -C /srv
mv /srv/wfl-codex-desktop-v0.44.63-beta /srv/wfl-codex-desktop
cd /srv/wfl-codex-desktop
```

安装包不包含 Git 凭据、网页密码、API 密钥、Codex 登录状态或对话。若希望离线
安装后改为跟踪公开稳定分支，可以在固定目录初始化 Git 并确认远端可读：

```bash
git ls-remote https://github.com/2296199707/wfl-codex-desktop-public.git HEAD
```

## 2. 启动安装向导

无论使用 Git 克隆还是发布安装包，进入项目目录后只执行这一条命令：

```bash
sudo bash install.sh
```

交互终端会自动启动中文向导，不再要求手写长参数。向导依次完成：

1. 自动识别 Git 克隆或发布安装包；找不到同版本 `.tar.gz`/`.sha256` 时提示输入路径。
2. Git 克隆会沿用公开 `origin/stable`；发布包安装只有在远端已安全配置时才启用
   版本中心同步，“以后可能需要更新”不等于当前已经具备同步条件。
3. 明确选择安装中完成 OpenAI 官方设备登录、安装中配置 Responses 兼容 API
   供应商，或只部署程序后去网页配置。选择网页配置时，在完成授权前不能发送对话。
4. 选择自动生成网页登录密码或隐藏输入自定义密码；现有密码会原样保留。
5. 明确选择浏览器访问方式，不提供容易误选的默认编号：已有域名应选择域名方式；
   仅当长期只使用本机或 SSH 转发时才选择本地方式。随后展示完整安装摘要和待办项，
   确认后才开始修改系统。
6. 安装、快速兼容检查和深度自检全部通过后，再进入对应的网络访问配置；只有在
   向导中明确选择额外完整测试，才会在新服务器重复候选阶段的全套测试。

安装包会再次验证外部 SHA-256、内部版本清单和安全路径。选择版本中心同步时，
还会确认包内提交属于指定远端；不启用同步也可以完成离线安装，以后再运行
访问或安装向导不会覆盖已有密码和本地数据。

确认后安装器依次执行：

1. 检查 systemd、操作系统、安装目录和至少 2 GiB 可用空间，并阻止并发安装。
2. 安装系统基础包；缺少合适版本时安装 Node.js 22。重跑时如果环境已经满足，
   会跳过 APT 和 NodeSource，不重复修改系统包。
3. 验证 Git 标签与上游，或验证安装包 SHA-256、内部清单及可选只读远端。
4. 缺少 Codex 时，先从 OpenAI 官方安装地址下载；该地址连接失败或超时后，
   自动改用 npm registry 上的官方 `@openai/codex` 包。
5. 使用 `npm ci` 安装锁定依赖，并安装 Playwright Chromium 及系统依赖。
6. 按向导选择执行 OpenAI 设备登录，或通过官方 Codex `config/batchWrite` 激活
   Responses 兼容 API 供应商；也可以明确跳过，稍后在网页中配置。
7. 首次生成网页用户名和密码，只保存密码的 scrypt 哈希。
8. 按实际源码目录生成主站 systemd 单元，执行快速兼容检查（或明确选择的完整测试）后，
   再执行带 watchdog 的双槽发布；全新安装随后从已验证活动发布槽初始化备用窗口双槽，
   默认把活动入口固定为 `4321`。检测到已有备用状态时，这一步只准备主站，不重启、切换
   或替换冻结的备用组件。
9. 检查稳定网关、活动后端、密码权限、回环绑定和真实 `thread/list`。
10. 根据选择引导配置域名、Cloudflare Tunnel 或仅本地访问。

首次生成的网页密码只显示一次，需要当场记录。安装中断后可以重复运行同一
命令；已满足的系统依赖会跳过，已有密码不会被覆盖。正式发布在独立 systemd
worker 中运行，SSH 断开后仍会继续。应用依赖始终需要可用的 npm registry；
Codex 官方安装地址不可用时，安装器才通过同一 registry 安装官方 npm 包。

Playwright 只安装浏览器测试实际使用的完整 Chromium，不再额外下载 headless
shell。安装器会把实际缓存路径持久化到 runtime；如果根分区空间不足，会自动
选择检测到的非根挂载盘，更新时也会先恢复/校验对应 Playwright 修订号的缓存，
不会因为旧的 `~/.cache/ms-playwright` 符号链接失效而直接判定更新失败。系统依赖
成功后会记录私有检查点，重跑不再重复 APT；浏览器下载超过 20 分钟会停止并给出
明确错误，修复 CDN 访问或预置与当前 Playwright 修订号一致的缓存后可直接重跑。完整实测记录见
[deployment-test-2026-07-20.zh-CN.md](deployment-test-2026-07-20.zh-CN.md)。

### Codex 授权方式

向导提供三种互斥选择：

1. **OpenAI 官方账号设备登录**：未登录时运行 `codex login --device-auth`，按终端
   显示的地址和一次性代码完成授权。
2. **OpenAI Responses 兼容 API 供应商**：依次输入供应商名称、HTTPS Base URL、
   模型 ID，并隐藏输入 API Key。本机 `localhost`、`127.0.0.1` 或 `[::1]` 服务
   可以使用 HTTP，并可留空 API Key。
3. **稍后配置**：先完成程序部署，登录网页后访问 `/#providers`，在 API 供应商
   中心新增并切换。运维中心“部署”页也会持续显示这项待办。

供应商 API Key 不进入命令参数、安装摘要、日志或发布包。它由每台服务器独立的
AES-256-GCM 密钥加密保存在 `.codex-desktop/providers.enc.json`，密钥文件与密文
文件权限均为 `0600`。Codex 子进程运行时只通过专用环境变量取得解密后的 Key。
再次运行安装向导时，已有活动供应商会被保留，不会要求重新输入或切回官方登录。

安装器会通过 Codex app-server 重新读取配置并执行 `thread/list`，确认配置可加载且
本地服务就绪。它不会自动发送真实模型提示，因此不会产生推理费用，也不能证明
API Key 的余额、额度或模型权限有效；部署后应在网页中新建一次测试对话确认实际调用。

只检查已经准备好的环境，不进行安装：

```bash
npm run server:check
```

无人值守自动化仍可使用原有参数，并显式关闭交互；未提供访问方式时会安全地
使用 `local`，不会安装 Nginx 或 Cloudflare：

```bash
sudo bash install.sh --non-interactive --skip-codex-login
```

跳过后，在完成官方登录或网页供应商配置前不能开始 Codex 对话。

## 3. 三种访问方式

### 方式 1：已有域名，服务器可直接开放 80/443

输入已经解析到本机的域名后，可以选择：

- 保留宝塔、1Panel、Nginx 或 Caddy 等现有反向代理，向导只核对参数，不改配置。
- 由向导安装 Nginx 和 Certbot，生成独立站点并申请 HTTPS 证书。

自动配置要求域名 DNS 已生效、公网可以访问本机 `80/443`，且域名没有被其他
站点占用。向导检测到同域名或非本项目创建的配置时会停止，不会覆盖现有网站。
现有代理的源站必须为 `http://127.0.0.1:4317`，并启用 WebSocket 与 HTTPS。

### 方式 2：使用 Cloudflare Tunnel

适用于没有公网入口、不能开放 `80/443`，或只希望服务器主动连出 Cloudflare
的情况。向导会逐步提示在 Zero Trust 中创建 Tunnel 和 Public Hostname，源站
固定填写：

```text
http://127.0.0.1:4317
```

随后隐藏输入 Linux connector token；token 只保存到 root 所有、权限为 `0600` 的
`/etc/cloudflared/token` 文件，并由 systemd 通过 `--token-file` 使用，不进入命令
参数、命令历史、项目、访问状态元数据或发布包。向导会安装并启动 `cloudflared`。
如果检测到已有 connector，只允许核对或启动现有服务，不会替换其凭据。

迁移已有域名时先使用临时 hostname 验证新服务器，再切换正式 hostname，确认
正常后停止旧 connector。不要长期让同一 hostname 同时连接两个独立服务器，
否则请求会落到不同的 Codex 对话存储。

### 方式 3：仅本机或 SSH 转发

向导不修改防火墙、反向代理或 Cloudflare。本机浏览器打开：

```text
http://127.0.0.1:4317
```

从自己的电脑连接远程服务器：

```bash
ssh -p 22 -N -L 4317:127.0.0.1:4317 root@服务器地址
```

这条命令应在本地电脑的 PowerShell 或终端中运行，不是在服务器终端中运行。
SSH 使用非标准端口时替换 `-p 22`。保持 SSH 连接后，在自己的电脑打开
`http://127.0.0.1:4317`。
如果服务器以前配置过公网代理，本地模式会提示但不会擅自停止或删除它；需要先
确认该代理没有承载其他服务，再由管理员单独下线。

以后需要切换访问方式时，只重跑访问向导，不重新安装应用：

```bash
cd /srv/wfl-codex-desktop
sudo npm run server:access
# 或：sudo bash install.sh --configure-access
```

其他选择“稍后配置”的项目也有独立入口，不需要重新运行完整安装器：

```bash
cd /srv/wfl-codex-desktop
sudo npm run server:password  # 重置单用户网页密码，会重启活动后端
sudo npm run server:updates   # 仅为自有 SSH 镜像生成只读 Deploy Key
```

`server:password` 只处理尚未启用多用户的单用户密码。多用户已经配置后，应打开
`/#account`，使用当前密码复验后修改所有者账户密码，命令行向导会拒绝制造两套
不一致的密码。公开仓库 HTTPS 克隆无需执行 `server:updates`；只有使用自有私人
SSH 镜像时才需要把它显示的公钥加入 Deploy keys，并关闭 **Allow write access**。
私钥保留在 `/root/.ssh`，不会进入项目、网页或命令参数。

管理员可在 `/ops#deployment` 查看“首次部署收尾”清单。页面仅显示脱敏状态、
跳转入口和可复制的 SSH 命令，不接收 Deploy Key 私钥，也不直接修改 root 网络配置。

## 4. 验证与排障

```bash
npm run server:doctor
npm run release:status
systemctl status wfl-codex-desktop-gateway.service
curl -I http://127.0.0.1:4317/
```

未带密码的 `curl` 返回 `401 Unauthorized` 代表网关与密码保护正常。完整
自检应显示官方 Codex、密码记录、稳定网关、深度就绪和回环绑定全部 `PASS`。
`Deployment recovery circuit breaker` 正常应为 `clear`。如果它显示 `FAIL`，系统已经停止
自动恢复重试并把 Codex 或后端拓扑失败原因保存在
`.codex-runtime/deployment-recovery-failure.json`；主站不会因此每两秒无限重启。处理原因后
重新执行一次对应的发布或恢复操作，成功会自动清除该记录。Codex 恢复失败不会阻止主后端
启动，但未完成的数据恢复仍是严格启动门槛，以免带着交换到一半的数据提供服务。

后续更新优先在版本中心点击“同步更新”。等价的 SSH 命令是：

```bash
cd /srv/wfl-codex-desktop
npm run app:update:check
npm run app:update:wait
npm run app:update:status
```

更新器会在隔离目录完成依赖安装和快速兼容检查；完整测试、浏览器验证和主服务器
部署证明已由同一提交的候选记录提供。默认在候选验证通过后立即强制蓝绿切换，
不等待运行中的对话；正在执行的任务可能中断，浏览器随后会自动重连。若本次
维护需要等待空闲，可显式设置 `CODEX_DESKTOP_FORCE_UPDATE=0`。候选后端仍由独立
watchdog 保护，启动失败时恢复旧后端或完成候选。
即使更新窗口断开，后台任务仍会继续，可重新登录服务器执行
`npm run app:update:status` 查看结果。

本机所有者已在 2026-08-14 记录长期偏好：主站或官方 Codex 更新默认使用强制
切换，不等待运行中的任务空闲；只有本次明确要求等待空闲时才设置
`CODEX_DESKTOP_FORCE_UPDATE=0` 走 drain。强制切换
仍必须使用新版本和现有蓝绿候选流程，完成版本/协议、watchdog、写入隔离、网关
和就绪检查；它不绕过安全门槛，也不触碰冻结的 4321 救援窗口。

发布归档和本地 beta 候选包会先在临时目录生成并校验，再同步、原子发布归档与
`.sha256`。生成过程被中断时不会先删除最后一组可用文件；重新执行候选打包或发布
即可覆盖同一候选身份。若状态显示校验文件缺失，不要手动创建空文件，先重新运行
对应的候选打包/发布流程并重新检查 `release:status`。

应用包包含独立的 `1.1.8备用窗口`，但已有服务器同步主站时不会自动切换、
重启或替换备用窗口。只有所有者从 `/rescue/` 的升级控制复验密码并确认，或明确
执行以下命令时，才会升级备用窗口：

```bash
sudo npm run server:rescue-update
```

命令先把当前已验证的活动正式发布放入非活动槽做健康检查，再把同一候选提升到
固定救援端口 `4321`；网关确认通过后才完成，失败会恢复原活动救援槽。
从旧单槽备用服务升级时，旧界面还没有该控制，第一次必须使用上面的命令行；
完成双槽转换后，后续版本才可直接在备用窗口升级。备用组件升级固定采用强制
切换：不会等待正在运行的备用任务，任务可能中断或丢失；候选槽仍会先完成版本与
健康验证，切换或验证失败时恢复原活动槽。候选备用组件版本必须严格高于当前版本。

从 `v0.37.0` 或 `v0.37.1` 首次升级到 `v0.37.2` 时，旧后端无法上报上传、设置、
审批和后台写入是否空闲，因此必须先结束全部对话和写入，再执行一次显式兼容
切换：

```bash
cd /srv/wfl-codex-desktop
git fetch --prune --tags origin
git merge --ff-only v0.37.2
npm ci
npm run check
CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED=1 npm run release:wait
npm run server:doctor
```

若版本中心已经完成测试并把源码快进到 `v0.37.2`，只需在干净源码目录执行最后
两条命令。不要永久设置 `CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED`。兼容确认失败发生
在 drain 之前，不会停止当前后端或禁用对话。

## 5. 数据边界

一键安装只部署程序，不会从旧服务器复制以下内容：

- `.codex-desktop` 中的网页密码、API 供应商密钥、插件状态和恢复索引。
- `.codex-runtime` 中的活动端口、发布锁、运行状态和临时插件密钥。
- `~/.codex` 中的官方登录令牌、配置和对话存储。
- 项目目录、上传文件、Git 凭据和 Cloudflare 凭据。

新服务器应独立完成 Codex 登录和网页密码设置。项目及确实需要保留的对话
数据应单独备份、核对权限并加密传输，不要把这些私有目录提交到 GitHub。

## 6. 多用户与安全边界

多用户默认关闭，不会改变现有单用户服务器。所有者从网页“设置”进入独立的
`/users` 用户管理页并重新输入
当前网页登录密码后才能启用。启用后只接受一次性邀请注册，邀请默认 24 小时
过期且只能使用一次；登录和注册请求需要同源来源并有失败限速。

每个托管用户会得到独立的 Linux 系统 UID/GID、`0700` HOME、`CODEX_HOME`、
工程目录、恢复记录、加密供应商库和 Codex Bridge。停用用户会立即失效所有
会话并断开 WebSocket；重新启用时会创建新的运行上下文。管理员只能分配自己
有权使用的加密供应商副本，也可以单独授权成员保存自己的自定义 API 供应商。
普通成员只看到个人空间用量和额度，不会收到主机 CPU、内存或整盘信息。
用户管理页还可以分配滚动 5 小时、UTC 周一开始的自然周和 UTC 自然月 Token
限额；只使用 Codex 官方上报的用量，未上报时不会估算或误拦截。

管理员可以把自己的工程以只读或可编辑方式共享给已授权用户。共享使用 Linux ACL；
可编辑共享要求目标用户启用文件系统硬配额，应用软配额用户只能接收只读共享。
新服务器会安装 `acl`、bubblewrap、AppArmor、Xvfb、`xauth`、`xdotool` 和 `ffmpeg`；
后四项只用于服务器官方 OAuth 浏览器的画面与输入。Ubuntu 限制非特权 `userns` 时，
发布流程只为 Codex 启动的 bubblewrap 加载专用子进程配置，不会全局关闭安全限制。

这不是容器级隔离。后端为了执行双槽升级、插件和 systemd 操作仍以 `root` 运行；
普通用户可以读取主机上其他世界可读文件，管理员也拥有主机管理能力。只邀请
可信账号并使用专用 VPS。若需要不可信租户、网络级 SSRF 防护或强制网络隔离，
应改用独立虚拟机/容器、独立网络策略和单独的 Codex 服务，而不能只依赖本功能。

应用配额统计托管用户整个 HOME，包含工程、上传、Codex 对话和缓存；没有文件系统
配额时属于软限制，单次 Codex 任务可能在检查间隙短暂超出。新服务器会安装
`quota` 工具，但只有 HOME 所在文件系统实际启用了 `usrquota`/`uquota` 并由管理员
配置 `setquota` 后才是硬限制。不要让安装器自动修改生产挂载参数；修改后应重启
一个测试账号并验证写入、删除和恢复行为。

### 备份与恢复

代码发布包和 Git 同步不会复制多用户数据。所有者可在 `/ops#backups` 创建手动或
每天/每周的加密数据备份，并限制保留 1 到 30 份。备份范围包括：

- `CODEX_DESKTOP_STATE_DIR` 下的 `multi-user.json`、`users.json`、`invites.json`、
  `project-shares.json`、`audit.ndjson`、`user-state/` 和加密供应商文件；登录会话被排除。
- `CODEX_DESKTOP_MULTI_USER_ROOT` 下的每个用户 HOME、工程、上传和 `CODEX_HOME`。
- 旧单用户所有者的 `~/.codex`、项目目录以及 Cloudflare/反向代理配置（如确实需要）。

备份中心使用 AES-256-GCM、SHA-256 校验和单独恢复密钥。下载、删除、密钥导出和恢复
只有所有者可以操作，恢复还要求完整备份编号和当前密码，并只允许相同 `machine-id`、
相同应用版本的同机恢复。恢复任务会等待当前 Codex 任务结束再短暂重启后端；它不是
跨服务器迁移工具。不要把备份或恢复密钥放入 GitHub，也不要把 API Key、会话 Cookie 或邀请令牌写入工单。
迁移到新服务器时必须先创建相同的系统账号和 UID/GID，再恢复文件权限；当前版本
没有“一键跨服务器迁移租户”的按钮，项目下载和对话导出是面向用户的可移交格式。
