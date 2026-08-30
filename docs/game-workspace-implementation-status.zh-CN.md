# 游戏工作区实施状态

- 记录时间：2026-08-30
- 当前分支：`codex/recovery-056-minimal`
- 当前基线提交：`b46a6a3 release: v0.44.65`
- 本轮目标版本：`v0.44.69-beta`
- 本文是本项目当前游戏工作区改造的唯一交接记录。记录已经完成的实现、验证结果、未完成工作和固定决策，避免上下文压缩后重复审查、重复设计或把计划误报为完成。
- 本轮继续完成了工程工作区 UI、最近资源恢复和 `gameProjectId` 的主站/子编辑器贯通，并修复多项目存储根在旧单用户 owner 上未继承的问题；实现与有界回归已完成，当前等待提交和本地候选部署，没有触碰冻结的 4321 救援窗口。

## 先读这里

本项目的游戏编辑工具正在从“多个入口各自拼接绝对路径”整理为“游戏工作区 + 服务端工程上下文”。本次不把
`/srv/aigame`、`/srv/wflgame` 或其他目录写死。`/srv/aigame` 是用户准备新建的游戏目录示例，`/srv/wflgame`
是旧工程参考；WFL 必须支持用户以后选择的任意已授权工程目录。

稳定性原则：

- 资源管理器可以浏览单用户允许的任意目录，但任意目录不会自动升级为游戏工程；
- 游戏工程需要显式登记或通过新建向导创建；
- 服务端是工程路径、工程文件和编辑会话的权威来源；
- 一个账号的一个工程只绑定一个可修改对话，一个对话只绑定一个可修改工程；
- 读取能力可以跨窗口、跨对话使用有权限的工程只读上下文；
- 从任何窗口打开编辑器时，右侧 AI 小窗使用工程已有的绑定对话；外层打开窗口的对话不能覆盖它；
- 不改动地图保存事务、版本冲突、对话恢复和救援窗口的既有保护。

## 已完成

### 原有源码审查

已经阅读并固定以下实现边界：

- `UserRuntime` 及每用户 `stateDirectory` 初始化；
- `/api/projects`、`listProjects()` 和 `assertSafeProjectDirectory()`；
- `MapProjectCatalog`、`MapProjectSessionStore` 和地图/World/瓦片集会话；
- `createTiledMap()`、World/瓦片集创建模块；
- `MapProjectWorkspaceClient`；
- 工具箱、游戏资源详情和地图/World/瓦片集/角色编辑器入口；
- Codex 源码副本 `/www/mobile-agent-tooling/openai-codex-research.oZMeyF`；
- 线程并发结论见 `docs/codex-thread-concurrency-research.zh-CN.md`；
- 工具入口统一结论见 `docs/game-image-tool-unification-plan.zh-CN.md`。

已经确认的原有问题：

- 专业工具同时从 URL hash、`currentProject`、资源预览状态、缓存和子编辑器自己的工程选择推断路径；
- `/srv/aigame` 不是旧项目，也不能作为默认工程；
- 旧地图可以没有 `.tiled-project`，也可以是背景图加对象层，因此不能把地图结构假设写死；
- 工具箱一级同时展示游戏资源、地图编辑器和角色编辑器，存在重复入口；
- 现有地图项目会话和地图资源会话有不同职责，不能粗暴删除其中一个。

### 当前工作树中已有的用户改动

以下修改在本轮开始前已经存在，必须保留并在其上继续工作，不能使用回滚命令覆盖：

- 地图对话绑定存储和路由：`lib/map-conversation-binding-store.mjs`、`server.mjs`；
- 主站和地图编辑器之间的绑定、历史 hydration、跨窗口同步；
- 单用户资源管理器任意目录、上传、下载和相关状态；
- 地图编辑器、资源管理器、主站样式及对应定向测试；
- 方案文档 `docs/game-image-tool-unification-plan.zh-CN.md`。

### 本轮已完成的新增实现

- 已创建每用户游戏工程注册表 `lib/game-project-workspace-store.mjs`。
- 注册表文件为每个用户的 `stateDirectory/game-project-workspaces.json`，写入使用临时文件加 rename，目录权限为 0700，文件权限为 0600。
- 注册表支持多个工程、稳定随机 `projectId`、按规范化路径幂等登记、打开时记录最近资源和编辑器、快照元数据、revision 冲突检查，以及只取消登记不删除真实目录。
- 已增加定向测试 `test/game-project-workspace-store.test.mjs`，覆盖多工程持久化、稳定 ID、打开/快照、重复路径登记、未知工程、revision 冲突、路径穿越和取消登记保留真实目录。
- 定向测试当前结果：4 项通过。验证命令为 `node --test test/game-project-workspace-store.test.mjs`。
- 已增加 `public/map-editor/map-ai-focus-context.js`，将当前工程地图、图层、对象、瓦片区域或图片层选择转换为统一的机器可读 AI 定位。
- 地图编辑器现在在状态栏显示当前 AI 目标；AI 面板显示完整定位 JSON，并支持复制定位或将定位插入绑定对话输入框。复制和插入都不会自动发送或修改地图；完整地图提示词也会带上同一份定位。
- AI 定位只输出工程相对地图路径、图层/对象 ID、区域坐标和版本，不输出绝对工程路径、图片字节或凭据；它是对现有编辑器会话的辅助，并随当前 `projectId` 工程上下文传递。
- AI 定位定向测试当前结果：3 项通过；地图资源版本和移动端静态检查：10 项通过；验证命令分别为 `node --test test/map-ai-focus-context.test.mjs` 和 `node --test test/map-version-assets.test.mjs test/map-editor-mobile-input.test.mjs`。

### 本轮继续完成的接入

- `UserRuntime.initialize()` 已为普通用户初始化 `GameProjectWorkspaceStore`；救援模式不创建也不暴露该 Store。
- 已提供 `GET/POST/DELETE /api/game-projects` 及工程打开、快照接口；新建工程会生成 `.tiled-project`、初始 `.tmj` 和固定目录骨架，目标目录来自用户选择的项目存储根，不写死 `/srv/aigame` 或其他路径。
- `/api/projects` 会为已登记工程补充 `gameProjectId`、名称、最近资源、最近编辑器和 revision；资源工程仍保留原有项目列表语义。
- 工具箱已增加多工程列表和新建工程向导。工程以稳定 `projectId` 标识，可同时保留多个工程；进入工程会切换主站工程、打开游戏资源工作区，并后台记录最近编辑器，避免额外阻塞进入动作。
- 主站游戏资源页已补齐明确的“游戏编辑器主页”入口；当前工程栏直接显示工程修改对话绑定状态，并提供“绑定当前对话”和“解除绑定”操作。绑定按钮只会在当前 Codex 对话属于当前工程且绑定状态读取完成后启用，仍复用服务端 revision 冲突保护。
- 普通工程和游戏工程共用 `projectRoots` 存储根；本机数据盘使用专用根 `/www/wfl-projects`，不会把 `/www` 下的 Playwright 或构建目录误当作工程。
- 多用户存储中的旧单用户 owner 会在启动时迁移到当前全局 `projectRoots`；因此新增数据盘根后，已有账号和新建游戏工程都能看到同一组选项。
- 地图工作区会把 `gameProjectId` 传给 `MapProjectWorkspaceClient.open()`；地图、World、瓦片集和角色编辑器的入口、URL fragment、内部工作区会话均继续携带同一 ID。服务端会校验 ID 与路径/项目会话一致，旧的无 ID URL 仍保持兼容。
- 工程最近地图会优先恢复；如果最近路径已经不存在或不再被当前工程授权，会回退到本地最近地图标签或工程搜索，不会因陈旧快照阻塞编辑器。
- 快照请求严格使用 `recentResource`、`recentEditor` 字段；普通打开请求只使用 `relativePath`、`editor`，不再向 `/snapshot` 发送错误的 `snapshot` 字段。
- 主站和编辑器上下文贯通的定向测试、服务端游戏工程 API 测试和语法检查均已通过；本轮额外覆盖游戏主页入口、绑定/解除绑定入口和当前对话归属校验。

这意味着工程注册、创建、列表、恢复和编辑器 ID 贯通已经完成；后续只需按实际使用反馈做小范围修正，不要重新设计工程标识或另起路径推断逻辑。

当前提交和部署状态以 `git status` 与发布状态为准。本轮实现已经完成并获得提交、本地部署授权；不执行推送，也不触碰冻结的 4321 救援窗口。

### 地图对话绑定已经具备的行为

- 绑定按用户和工程持久化；
- 绑定修改使用 revision 检查，旧客户端不能覆盖新绑定；
- 同一个 Thread 不能同时绑定两个工程；
- Thread 被物化或删除时可以迁移/清除绑定；
- 地图编辑器可以从服务端加载绑定、同步到主站并恢复同一个对话的历史；
- 绑定状态按账号切换清理，避免旧账号状态泄露到新账号。

## 当前状态

本阶段实现项已完成。剩余事项属于后续可选增强，不是当前工作区接入的阻塞项：

- 已登记但目录被移动/删除的工程，目前保留在列表中并显示不可用；后续可增加重新定位登记入口。
- 当前验证以语法、Store、会话客户端、服务端工程 API 和静态 UI 契约为主；未运行完整仓库测试或完整浏览器套件，也未把静态检查结果冒充真实浏览器交互验收。
- 主站没有删除旧地图/World/瓦片集/角色 URL；旧入口仍用于兼容，新的首选入口是工具箱中的游戏工程工作区。

### 验证记录

- 语法检查：`node --check server.mjs`、`node --check public/app.js`、`node --check public/map-project-session.js`、`node --check public/map-editor/map-editor.js`、`node --check public/map-editor/world-editor.js`、`node --check public/map-editor/tileset-editor.js`、`node --check public/character-editor/character-editor.js`，全部通过。
- 定向测试：`node --test test/game-project-workspace-store.test.mjs test/game-project-workspace-create.test.mjs test/map-project-sessions.test.mjs test/map-project-session-client.test.mjs test/map-conversation-binding-store.test.mjs test/map-ai-focus-context.test.mjs test/map-workspace-ui.test.mjs test/tileset-editor-ui.test.mjs`，49 项通过。
- 存储根迁移回归：`node --test test/multi-user-store.test.mjs test/game-project-workspace-store.test.mjs test/game-project-workspace-create.test.mjs`，16 项通过。
- 服务端工程 API：`node --test --test-name-pattern='game project' test/server.test.mjs`，1 项通过。
- 未执行：完整仓库测试、完整浏览器套件、推送和 4321 救援窗口操作；本轮提交与本地部署待发布流程完成后补充结果。

## 不在本阶段做

- 不修改救援窗口 `4321`、救援服务、槽位或资产；
- 不把任意资源管理器目录自动登记为游戏工程；
- 不删除旧编辑器页面和旧 URL；
- 不重写地图保存/版本冲突/对话恢复机制；
- 不把读取限制错误地扩大为修改限制；
- 不在普通部署服务器运行完整测试套件；
- 不推送或操作 4321；提交和本地部署必须使用新版本及现有蓝绿流程。

## 目标数据结构

工程登记项至少包含：

```js
{
  projectId,
  name,
  projectPath,
  projectFile,
  initialMap,
  preset,
  orientation,
  width,
  height,
  tilewidth,
  tileheight,
  initializeGit,
  recentResource,
  recentEditor,
  revision,
  createdAt,
  updatedAt,
  snapshotAt
}
```

子编辑器最终消费的上下文以服务端返回值为准：

```js
{
  projectId,
  projectSessionId,
  projectFile,
  relativePath,
  resourceKind,
  editorSessionId,
  threadId,
  accessMode,
  accountId,
  version
}
```

`projectPath` 可以在服务端内部存在，但不应再由 AI、旧 hash 或子编辑器输入作为最终权威。

## 下一步工作锚点

下一次恢复实现时先读取本记录和 `git status --short --branch`，从实际使用反馈或剩余可选增强开始；不要重复创建工程 Store、重复设计路径规则或重新审查 Codex 并发源码。

## 恢复工作时的检查点

- 先读取本文和 `git status --short --branch`，不要假设工作树干净，也不要重做“源码审查”和“工程 Store 创建”。
- 先确认当前用户最新要求；若只是继续实现，先检查“当前状态”和“验证记录”。
- 每完成一项，只在本文对应章节记录实际代码和验证命令；没有运行过的测试只能写“未验证”。
- 未经用户明确要求，不执行推送或救援窗口操作；提交和本地部署按当前授权执行。

每完成一个步骤，都要在本文的“已完成”或“尚未完成”中更新状态和验证结果。若工作树状态、当前分支或用户最新要求发生变化，
先更新本文再继续编码。
