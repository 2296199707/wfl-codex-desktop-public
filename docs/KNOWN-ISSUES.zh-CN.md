# 待处理问题记录

用于记录后台和主界面中已经发现的问题及处理状态。后续问题继续追加到本文件，避免在上下文压缩或跨轮次协作时遗漏。

## ISSUE-001：切换项目后 Worktree 列表没有按项目隔离

- **发现时间**：2026-08-20
- **状态**：已修复，未部署
- **现象**：当前工程切换到 `sj` 后，Worktree 面板仍显示其他项目（例如 `wfl-codex-desktop-v0.43.55-beta`）下的 4 条 Worktree 记录。不同项目之间显示了相同的 Worktree 列表。
- **复现**：
  1. 在项目选择器中切换到 `sj`。
  2. 打开“Worktree”面板。
  3. 观察列表仍出现 Codex Desktop 项目的 Worktree 记录。
- **正确行为**：当前工程为 `sj` 时，只显示 `sj` 对应项目下的 Worktree；切换到其他项目后，列表应随当前项目切换，不能混用其他项目的记录。
- **已定位方向**：前端 Worktree 侧栏使用全局加载路径（`loadCodexWorktrees({ all: true })`），随后直接渲染 `state.codexWorktrees`，没有按当前工程的来源项目路径过滤。当前工程如果本身是 Worktree，还需要先解析回其来源项目路径再过滤。
- **相关代码**：`public/app.js` 中的 `loadCodexWorktrees`、`renderSidebarWorktrees`、`codexWorkspaceSourceProject`。
- **修复说明**：Worktree 列表统一按当前工程对应的来源项目路径过滤；当前工程本身是 Worktree 时先回到来源项目路径再过滤。
- **注意**：这不是 Worktree 分支名称或 `baseRef` 展示问题；此前针对 detached 分支显示的临时修改不能解决本问题，暂不作为修复方案。

## ISSUE-002：点击侧栏项目名会刷新当前对话并切换当前工程

- **发现时间**：2026-08-20
- **状态**：已修复，未部署
- **现象**：点击侧栏中的项目名称时，当前实现会直接执行项目切换，导致当前工程改变、当前对话被刷新或清空。用户只是想查看该项目下的对话列表，却被迫改变了当前工作上下文。
- **复现**：
  1. 在当前工程中打开一个对话并保留在对话页面。
  2. 点击侧栏中另一个项目的项目名称，而不是点击具体对话。
  3. 观察当前工程或当前对话被切换、刷新。
- **正确行为**：点击项目名称只切换侧栏的对话列表浏览范围，展示所选项目下的对话；在用户尚未选择具体对话前，`state.currentProject`、当前对话、对话内容、任务状态和连接状态都必须保持不变。只有点击具体对话后，才切换到该对话所属项目并打开对话。
- **已定位方向**：`public/app.js` 的 `renderProjects()` 将项目按钮直接绑定到 `selectProject(project)`；该函数包含完整项目切换逻辑。需要将“浏览项目对话列表”与“切换当前工程”拆开，并让线程列表加载使用浏览中的项目，点击具体对话时再执行真正切换。
- **相关代码**：`public/app.js` 中的 `renderProjects`、`selectProject`、`loadThreads`、`loadClaudeSessions`、`resumeThread`、`resumeClaudeSession`。
- **修复说明**：项目名称点击改为仅切换侧栏浏览范围；具体点击对话时才切换当前工程并恢复对话，同时对 Codex/Claude 列表请求增加版本和路径校验，避免旧请求覆盖新列表。

## ISSUE-003：Worktree 绑定对话的项目级展示和新建边界不清晰

- **发现时间**：2026-08-20
- **状态**：已修复，未部署
- **结构说明**：Worktree 与“对话”是侧栏中并列的独立页签；每个 Worktree 作为独立隔离工作区，当前规则下最多绑定一条 Codex 对话。Worktree 页是工作区管理入口，不是另一份对话列表；绑定关系应显示在具体对话的 Worktree 属性中。
- **现象**：Worktree 绑定一条对话后，在“对话”页中会以虚拟工程/项目级上下文出现，容易让用户感觉 Worktree 分支已经变成项目同级，而且这个上下文下不能继续新建第二条对话。与此同时，Worktree 页中的“已绑定”或“待创建”也属于重复或多余的常态提示。点击 Worktree 页的“新建”时，当前实现还只创建 Worktree 目录，不会同时创建并绑定对话，用户需要继续执行额外的新对话流程。
- **复现**：
  1. 打开侧栏的“Worktree”页签。
  2. 在“对话”页打开一个运行在 Worktree 中的对话。
  3. 观察当前上下文看起来像一个独立项目，且不能在同一 Worktree 下继续新建对话；再打开 Worktree 页观察其绑定/待创建提示。
- **正确行为**：Worktree 与“对话”是侧栏中并列的独立页签，这个结构保留；点击 Worktree 行直接打开对应对话，但不额外加载一份 Worktree 对话列表，侧栏仍可停留在 Worktree 页。已有绑定关系在具体对话头部的 Worktree 属性中体现。当前“一 Worktree 一对话”的隔离约束可以保留；点击未绑定 Worktree 或 Worktree 页“新建”后，应一次完成“创建 Worktree → 创建并绑定一个空对话 → 打开该对话”。普通删除允许保留绑定对话和恢复快照；同时删除 Git 分支仍要求先重新绑定对话。
- **已定位方向**：`public/app.js` 的 `submitSidebarWorktreeForm()` 只调用 Worktree 创建接口，`openSidebarWorktree()` 和 `newThread()` 负责后续准备；实际 `thread/start` 目前在首次发送消息时才执行，并通过 `_wflWorktreeId` 绑定 Worktree。前端还把 Worktree 路径作为虚拟项目上下文使用。需要拆分 Worktree 工作区展示与普通项目新建语义，整理 Worktree 行的直接打开行为，并合并新建 Worktree 与空对话创建、绑定和打开流程，同时保持服务端“一 Worktree 一对话”的约束。
- **相关代码**：`public/app.js` 中的 `renderProjects`、`submitSidebarWorktreeForm`、`openSidebarWorktree`、`newThread`、`sendPromptOnce`、`prepareCodexWorktreeForNewThread`；`server.mjs` 中项目列表的 Worktree 虚拟项目映射和 `thread/start` 的 `_wflWorktreeId` 绑定校验。
- **修复说明**：Worktree 行点击直接恢复对应对话到聊天区，同时保持 Worktree 侧栏，不再调用对话列表加载；未绑定 Worktree 使用独立的“创建并绑定空对话”路径；默认删除不再被绑定关系拦截；侧栏最后位置在刷新和重连后恢复。

## ISSUE-004：缺少可配置的 1M 上下文设置

- **发现时间**：2026-08-20
- **状态**：已修复，未部署
- **现象**：Codex 当前虽然能够接收和显示上下文用量，但设置界面没有提供上下文窗口大小选项。用户希望根据官方支持情况选择 1M 上下文，而不是只能使用当前默认值或由模型自动决定。
- **正确行为**：在 Codex 设置中增加上下文窗口配置，至少提供“自动/模型默认”和“1M 上下文”选项；保存后应作用于后续新建对话，并在当前模型不支持时明确禁用或提示，不能仅修改前端显示数字。需要按官方协议使用正确的请求参数，并在恢复对话时保持设置语义一致。
- **已定位方向**：前端已有 `thread/tokenUsage/updated`、`modelContextWindow` 和上下文压缩相关状态，但尚未形成用户可编辑的上下文窗口设置及对应的启动/设置请求参数。实现前需要确认官方 Codex app-server 对 1M 上下文的实际支持范围和参数名称。
- **相关代码**：`public/app.js` 中的 Codex 设置、`renderCodexWorkspaceSettings`、`rememberThreadTokenUsage` 和 `thread/tokenUsage/updated` 处理；`server.mjs` 中 Codex RPC 参数校验与转发。
- **修复说明**：设置页增加 Codex 默认/自动和 1M Token 选项，使用官方 `model_context_window` 配置键并由服务端校验；设置作用于后续新对话，当前对话只采用 Codex 实际上报的上下文窗口。

后续发现的问题按 `ISSUE-005`、`ISSUE-006` 继续追加，记录现象、复现步骤、正确行为、定位方向和修复状态。
