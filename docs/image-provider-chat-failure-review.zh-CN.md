# 图片供应商主站调用审查记录

- 状态：本轮修复完成，待提交
- 日期：2026-08-30
- 代码分支：`codex/recovery-056-minimal`
- 当前主站后端：`0.44.70-beta`（4318）；网关：4317
- 范围：确认“图片供应商探测能返回图片，但主站对话 `generate_image` 失败”的原因；修复地图编辑器误报“未绑定供应商”；保留安全的网络诊断信息
- 约束：未触碰冻结的救援窗口 4321；未提交、推送或部署

本文是后续继续调查或修复前的必读记录。先查本文的“当前结论”和“剩余边界”，不要重复从截图或主站表象开始判断。

## 1. 当前结论

真实供应商链路已由图片 MCP 工具成功调用并返回图片，因此不能把当前问题归因于供应商完全不可达，也不能归因于游戏工作模式或工程绑定。

主站此前显示的 `IMAGE_PROVIDER_UNREACHABLE` 仍可能表示供应商请求阶段的瞬态 DNS、TLS、连接、超时或连接重置错误。之前的统一错误名没有携带底层安全分类，排查信息不足。本轮已让安全分类随 Worker、工具服务和 HTTP 错误响应传递，但不记录 API Key、Prompt、完整 URL 或完整供应商响应。

地图编辑器的“未绑定供应商”是一个确定的能力投影错误，已经修复：路由现在读取 Provider Store 的公共快照，执行请求仍使用私有配置，密钥不会进入前端。

## 2. 真实供应商验证

在用户授权后，通过当前真实图片供应商的 MCP 工具执行了一次受控生成：

| 项目 | 结果 |
| --- | --- |
| 供应商 | 当前活动供应商 |
| 模型 | `gpt-image-2` |
| 请求尺寸 | `1536x1536` |
| 实际返回尺寸 | `1254x1254` |
| 格式 | PNG |
| 文件大小 | `1762746` bytes |
| 文件 | `/srv/aigame/assets/generated/provider-check-20260830.png` |

本次调用未向 MCP 传入 `providerId`，由工具使用当前活动供应商；图片已在本机检查，内容和格式有效。返回尺寸与请求尺寸不同，但没有因此被拒绝，符合当前“供应商返回尺寸以实际结果为准”的行为。

这次验证证明供应商可达并能返回图片，但不等同于每一种模型、操作、尺寸组合都稳定兼容，也不替代主站网关路径验证。

## 3. 代码链路证据

### 3.1 主站请求链

1. 主站前端在 [public/app.js:23737](/srv/wfl-codex-desktop/public/app.js:23737) 向 `/api/images/generate` 发起请求。
2. `/api/images/generate` 在 [server.mjs:17117](/srv/wfl-codex-desktop/server.mjs:17117) 使用 `generate` 并进入独立图片 Worker。
3. Worker 通过 [server.mjs:17223](/srv/wfl-codex-desktop/server.mjs:17223) 获取供应商私有配置。
4. [lib/openai-image.mjs:29](/srv/wfl-codex-desktop/lib/openai-image.mjs:29) 按操作选择 generation 或 edits 端点。
5. 没有 HTTP 状态码的底层异常会统一变成 `502 IMAGE_PROVIDER_UNREACHABLE`；现在会额外归类为 `dns`、`tls`、`connect`、`timeout`、`reset` 或 `network`。

### 3.2 探测链路

兼容性探测按每个测试项目的操作和尺寸发起请求，并会比较供应商返回尺寸与探测预期。探测使用的 `outpaint`/`edit` 请求和主站 `generate` 请求不是同一条组合，所以“探测返回图片”不能直接证明主站所有生成参数都稳定。

## 4. 已完成的最小修复

### 4.1 地图能力公共快照

地图能力路由 [server.mjs:21801](/srv/wfl-codex-desktop/server.mjs:21801) 已从私有 `getImageApi()` 改为 `runtime.providerStore.snapshot().imageApi`。公共快照提供 `configured`、`providerId` 和公开能力；私有密钥仍只在服务端执行阶段读取。

### 4.2 网络错误安全诊断

以下模块已保留安全的 `transportPhase` 字段：

- [lib/openai-image.mjs](/srv/wfl-codex-desktop/lib/openai-image.mjs)
- [scripts/image-execution-worker.mjs](/srv/wfl-codex-desktop/scripts/image-execution-worker.mjs)
- [lib/image-worker-runner.mjs](/srv/wfl-codex-desktop/lib/image-worker-runner.mjs)
- [lib/image-provider-tool-service.mjs](/srv/wfl-codex-desktop/lib/image-provider-tool-service.mjs)
- [scripts/image-provider-mcp.mjs](/srv/wfl-codex-desktop/scripts/image-provider-mcp.mjs)
- [server.mjs](/srv/wfl-codex-desktop/server.mjs)

只允许固定分类值通过边界；API Key、Prompt、完整 URL 和完整响应正文仍不会进入诊断结果。

## 5. 定向测试结果

已通过单独地图 HTTP 测试：

```text
map image HTTP jobs stage, preview, isolate, and explicitly publish a candidate
1 pass
```

已通过并行运行的 5 个相关测试文件，共 47 项：

```text
node --test \
  test/openai-image.test.mjs \
  test/image-execution-worker.test.mjs \
  test/image-worker-runner.test.mjs \
  test/image-provider-tool.test.mjs \
  test/map-image-http.test.mjs

47 pass, 0 fail
```

覆盖内容包括：普通生成、流式响应、编辑/扩图、供应商错误脱敏、网络错误分类、Worker 传递、MCP 诊断字段、地图公共能力投影、地图任务和资源发布流程。

之前合并运行出现过一次 `MAP_IMAGE_MAP_SESSION_INVALID`；随后单独运行和同一组并行运行均通过，目前没有复现该失败，暂不把它当作实现回归。若后续再次出现，应优先记录并行命令、环境变量和子进程输出，再判断是否是测试环境竞态。

## 6. 剩余边界

- 尚未对主站公网网关执行新的计费型真实 `generate` 请求；本轮真实验证走的是图片 MCP 工具。
- 尚未证明某个具体供应商是否只稳定支持 `/images/edits`，或是否拒绝某个模型/尺寸组合。
- 没有运行完整仓库测试、压力测试或浏览器全量 smoke，符合当前普通服务器和冻结救援窗口约束。

后续如需进一步定位主站真实生成，只做一次管理员确认的受控请求，并记录操作、模型、请求尺寸、HTTP 状态、耗时和供应商请求 ID，不记录凭据或原始响应。

## 7. 当前文件状态

本轮修改：

- 图片请求错误分类及安全字段传递：6 个实现文件
- 地图能力公共快照：`server.mjs`
- 相关定向回归测试：4 个测试文件
- 本审查记录：本文

当前尚未提交、推送或部署。后续操作前先读取本文，避免重复审查或误把真实供应商成功与主站全部参数组合兼容混为一谈。
