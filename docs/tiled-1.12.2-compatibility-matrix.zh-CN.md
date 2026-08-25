# WFL Tiled 1.12.2 兼容矩阵

- 状态：阶段 9 可执行兼容基线，阶段 10 候选发布收口
- WFL 基线：`0.43.29-beta`
- Tiled 基线：`1.12.2`
- 更新日期：2026-08-12

本矩阵区分“能读取保存”和“能正确显示编辑”。任何单元格为“仅保留”或“计划”的功能，都不能因为
JSON 往返未丢字段就对外宣称完整支持。长期实施顺序见
[地图工作区完整实施计划](map-editor-implementation-plan.zh-CN.md)。

## 支持等级

| 等级 | 含义 |
| --- | --- |
| 完整 | 当前实现和聚焦测试覆盖该层语义 |
| 部分 | 仅覆盖明确列出的子集，其他语义必须警告或保持不可编辑 |
| 仅保留 | JSON 原值无损保存，但当前层不能正确执行该语义 |
| 条件 | 只在运行环境明确具备对应能力时支持，否则明确失败 |
| 计划 | 已冻结输入和目标，尚未进入运行实现 |
| 不适用 | 该语义不由这一层解释 |

“保存完整”表示无修改往返及受支持编辑不会删除该字段，不表示 WFL 能创建或修改这个字段。

## 文档与工程

| 功能 | 解析 | 渲染 | 编辑 | 保存 | 当前证据或限制 |
| --- | --- | --- | --- | --- | --- |
| `.tmj` JSON 地图 | 完整 | 部分 | 部分 | 完整 | [文档测试](../test/tiled-document.test.mjs)、[综合夹具](../test/fixtures/tiled/maps/tiled-1.12.2-features.tmj) |
| 外部/内嵌 `.tsj` | 完整 | 完整 | 部分 | 完整 | 外部 atlas、image collection 可新建并用独立编辑器修改瓦片、动画、碰撞和 Terrain/Wang；内嵌 tileset 仍只随地图保留 |
| 未识别字段和值 | 完整 | 不适用 | 不适用 | 完整 | 深克隆和 JSON 对象往返，不执行白名单重建 |
| `.tiled-project` | 完整 | 不适用 | 部分 | 完整 | 项目会话解析 folders、兼容版本和 Class/Enum/List；地图与瓦片集窗口使用同一安全项目类型上下文，未知定义无损保留 |
| `.world` | 完整 | 完整 | 完整 | 完整 | 独立 World 编辑器支持地图列表、位置/尺寸、命中、拖动、邻接、保存与跳转；[模型测试](../test/tiled-world.test.mjs)与[导航测试](../test/tiled-world-navigation.test.mjs) |
| JSON 对象模板 `.tx` | 完整 | 完整 | 部分 | 完整 | 支持默认值/实例覆盖、相对引用重写、保存模板、素材拖入、解除绑定及 tile object GID 重映射；[测试](../test/tiled-template.test.mjs) |
| `rules.txt` 与规则地图 | 部分 | 不适用 | 部分 | 部分 | 阶段 9 已实现现代连续区域 Automapping、嵌套清单、预览、Worker、TSJ GID 映射和显式 While Drawing；基础/高级夹具已与 Tiled 1.12.2 官方 `TileMap.autoMap()` 逐层对照；旧版 regions、对象输出及六边形/交错规则明确拒绝 |
| Tiled JavaScript extensions | 不适用 | 不适用 | 不适用 | 不适用 | 工程扩展永不执行 |

## 地图、投影与瓦片数据

| 功能 | 解析 | 渲染 | 编辑 | 保存 | 当前证据或限制 |
| --- | --- | --- | --- | --- | --- |
| orthogonal | 完整 | 完整 | 部分 | 完整 | 坐标、命中、画笔和对象基础操作已覆盖 |
| isometric | 完整 | 完整 | 部分 | 完整 | 正反投影、对象坐标和可见区域已覆盖 |
| staggered | 完整 | 完整 | 部分 | 完整 | `staggeraxis/index` 校验及命中已覆盖 |
| hexagonal | 完整 | 完整 | 部分 | 完整 | side length、命中及 60/120 度 GID 标志已覆盖 |
| oblique | 完整 | 完整 | 部分 | 完整 | `skewx/skewy` 可逆性、坐标和命中已覆盖 |
| 未识别 orientation | 完整 | 仅保留 | 仅保留 | 完整 | 明确警告，当前按正交坐标显示 |
| orthogonal `renderorder` | 完整 | 完整 | 仅保留 | 完整 | 四种顺序均按全局行列排序，有限层和跨 chunk 图层已覆盖 |
| map `backgroundcolor` | 完整 | 完整 | 仅保留 | 完整 | 按 Tiled `#AARRGGBB` 解析；浏览器与 Worker 使用同一背景语义和 alpha |
| 有限地图数组数据 | 完整 | 完整 | 完整 | 完整 | 视口读取不复制整图数组 |
| 无限地图 chunks | 完整 | 完整 | 完整 | 完整 | 负坐标、新 chunk、空 chunk 回收及撤销已覆盖 |
| Base64 无压缩、zlib、gzip | 完整 | 完整 | 完整 | 完整 | 原编码契约保留，导出副本重新编码 |
| Base64 zstd | 条件 | 条件 | 条件 | 条件 | 仅运行时提供原生 zstd stream 时启用，否则明确失败 |
| 32 位 GID 翻转/旋转 | 完整 | 完整 | 部分 | 完整 | Stamp 的水平/垂直/对角翻转和 90 度旋转会组合格子布局与 GID 标志；六边形 Stamp 当前仅开放水平/垂直翻转，tileset transformations 编辑待后续 |
| 稳定 GID 与跨地图 Stamp | 完整 | 完整 | 完整 | 完整 | 按 canonical TSJ 路径复用目标 `firstgid`，缺失同工程 TSJ 分配新范围；重映射保留本地 ID 和全部翻转位，范围不足或未映射时明确失败 |
| 瓦片选择集合 | 完整 | 完整 | 完整 | 不适用 | 独立矩形选择、四向连通魔棒、全层同类选择及替换/追加/减去/交集已覆盖；默认忽略 GID 翻转位，无限地图只扫描已有 chunks，选择是窗口状态而非地图字段 |

## 图层显示语义

| 功能 | 解析 | 渲染 | 编辑 | 保存 | 当前证据或限制 |
| --- | --- | --- | --- | --- | --- |
| tile/object/image/group 四类图层 | 完整 | 完整 | 部分 | 完整 | 嵌套组、跨组拖动、拖出、多选批量结构操作和单次撤销已覆盖；高级属性编辑分阶段补齐 |
| visible、opacity、offset、x/y | 完整 | 完整 | 完整 | 完整 | 组容器继承可见性、透明度和位置 |
| layer `mode` blend mode | 完整 | 完整 | 仅保留 | 完整 | 13 种 Tiled mode 均映射；高级模式使用显式 back buffer 和图层 alpha filter |
| `tintcolor` | 完整 | 完整 | 仅保留 | 完整 | RGB 乘色和 alpha 均按 Tiled `#AARRGGBB` 应用，支持组继承 |
| map/layer parallax | 完整 | 完整 | 仅保留 | 完整 | map origin、视口中心及嵌套组有效因子乘积与 Tiled 一致 |
| image layer repeat | 完整 | 完整 | 部分 | 完整 | 单个 `TilingSprite` 按当前视口双向铺图，保留图片原点相位 |
| image layer transparent color | 完整 | 仅保留 | 仅保留 | 完整 | 字段保留并警告 |

## 对象

| 功能 | 解析 | 渲染 | 编辑 | 保存 | 当前证据或限制 |
| --- | --- | --- | --- | --- | --- |
| 矩形、点、椭圆、多边形、折线 | 完整 | 完整 | 完整 | 完整 | 创建、命中、多选变换、旋转、对齐，以及多边形/折线顶点增删拖动和数值编辑均已覆盖 |
| tile object | 完整 | 完整 | 完整 | 完整 | GID、尺寸、旋转、透明度和九种 alignment 可编辑；动画、tile offset、render size 和 fill mode 均用于渲染 |
| text object | 完整 | 完整 | 完整 | 完整 | 文本、字体、字号、颜色、粗斜体、下划线、删除线、kerning、水平/垂直对齐、换行和对象框裁剪均可编辑 |
| capsule | 完整 | 完整 | 完整 | 完整 | 按短边半径绘制横向或纵向胶囊轮廓，可作为普通对象或碰撞创建和变换 |
| object opacity | 完整 | 完整 | 完整 | 完整 | 对象容器 alpha 与图层/组透明度逐级组合，属性面板可编辑 |
| 对象模板实例 | 完整 | 仅保留 | 部分 | 完整 | 引用安全校验、模板合并、相对引用重写和解除绑定模型已覆盖；查看器与项目素材拖入仍待接入 |
| 出生点、传送点、碰撞 Class | 完整 | 完整 | 完整 | 完整 | 使用通用 Tiled Class/属性，不绑定具体引擎；当前地图 Portal/Spawn 连线和 World 跨地图检查均已覆盖 |
| 对象数组顺序和 `draworder` | 完整 | 完整 | 完整 | 完整 | 置顶/上移/下移/置底修改稳定数组顺序；`topdown/index` 同时控制渲染和命中 |

## 瓦片集、Terrain 与属性

| 功能 | 解析 | 渲染 | 编辑 | 保存 | 当前证据或限制 |
| --- | --- | --- | --- | --- | --- |
| atlas tileset | 完整 | 完整 | 部分 | 完整 | 可新建并编辑图片、网格、逐 tile 属性、动画、碰撞和 Terrain/Wang；批量高级操作待后续 |
| image collection tileset | 完整 | 完整 | 部分 | 完整 | 可新建、添加和删除工程图片；稀疏本地 tile ID 稳定，逐图尺寸、属性、动画和碰撞均校验 |
| tile offset | 完整 | 完整 | 完整 | 完整 | 独立 TSJ 编辑器可修改，当前 tile object 渲染同步应用 |
| object alignment | 完整 | 完整 | 完整 | 完整 | 独立 TSJ 编辑器可修改九种 alignment；不同地图方向的未指定默认值均用于 tile object |
| `tilerendersize` / `fillmode` | 完整 | 完整 | 完整 | 完整 | 独立 TSJ 编辑器可修改，tile/image 渲染按 stretch/preserve-aspect-fit 应用 |
| tile animation | 完整 | 完整 | 完整 | 完整 | 可增删、排序和修改 frame tile ID/duration，帧引用按 atlas 容量或 collection 稳定 ID 校验；编辑器与地图查看器均确定性播放 |
| tile collision object group | 完整 | 不适用 | 部分 | 完整 | 可创建和编辑矩形、椭圆、胶囊、多边形、折线及坐标/尺寸/旋转/名称/Class；对象自定义属性和 objectgroup 高级字段原样保留 |
| probability | 完整 | 不适用 | 完整 | 完整 | 独立 TSJ 编辑器可修改或移除非负 probability；随机 Stamp 按显式 seed 确定性消费 |
| Terrain/Wang Set | 完整 | 不适用 | 部分 | 完整 | 可编辑 Set 类型、Class、代表瓦片、颜色、概率、颜色代表瓦片、8 位 wangid 和 Terrain Brush；颜色自定义属性等高级字段保留并警告 |
| 基础属性与 Class 值 | 完整 | 不适用 | 部分 | 完整 | 地图层和对象属性面板已加载项目 Class 默认值及嵌套成员，未知成员无损；file 资源选择器与类型定义迁移待后续 |
| Enum | 完整 | 不适用 | 完整 | 完整 | 加载项目字符串/整数 Enum 与 flags，使用受定义约束的单选或多选控件 |
| Tiled 1.12 List 属性 | 完整 | 不适用 | 部分 | 完整 | `{type,value}` item 数组可用结构化 JSON 控件编辑和类型化校验，未知 item 字段无损；逐项可视编辑器待后续 |

## 统一警告契约

当前已识别但尚不能完整执行的语义使用：

```json
{
  "severity": "warning",
  "code": "tiled-feature-preserved-only",
  "feature": "image-layer-transparent-color",
  "path": "$.layers[0].transparentcolor",
  "message": "透明色字段已保留，但当前查看器尚未应用该语义",
  "support": {
    "parse": "full",
    "render": "preserve-only",
    "edit": "preserve-only",
    "save": "full"
  }
}
```

要求：

- `feature` 是稳定机器标识，界面不能通过解析中文消息判断能力；
- `path` 指向原始 JSON 位置；
- `support` 使用导出的固定枚举，不使用自由文本；
- warning 不阻止无损打开和保存，error 继续阻止不安全或结构无效的文档；
- 浏览器和 Render Worker 使用同一解析诊断，不能一边警告、一边静默按错误效果导出。

## 阶段 0 自动验证

[兼容基线测试](../test/tiled-compatibility-baseline.test.mjs)当前验证：

1. Tiled 1.12.2 综合 TMJ 无修改 JSON 往返；
2. List、透明色和模板引用等尚未实现语义的警告；背景、renderorder、blend、opacity、capsule、视差、tint 和 repeat 已进入完整渲染，不再产生仅保留警告；
3. 综合 TSJ 的 Wang、碰撞和 List 往返警告，probability 的随机 Stamp 消费、Terrain Brush 的显式 seed 和共享边/角选择，以及 render size、fill mode 和 alignment 的完整渲染；
4. 五种 orientation 的结构校验；
5. Project、World 和模板输入夹具被冻结；Automapping 夹具已进入阶段 9 纯数据和真实 Chromium 执行回归；
6. 所有兼容 warning 都包含四层支持状态。

候选服务器另外运行：

```bash
node scripts/check-tiled-1.12.2-compatibility.mjs
```

该脚本要求真实 Tiled `1.12.2`，在没有图形会话时通过 `xvfb-run` 启动。它把夹具复制到一次性临时工程，
由 Tiled 导出 TMJ/TSJ，再用 WFL 重新解析并检查 List、blend mode、capsule、object opacity、Wang、
tile collision、render size、fill mode、object alignment，以及阶段 5 的十对象夹具、对象顺序、出生点和
传送点语义。Tiled CLI 可能把对象 `class` 规范化为兼容字段 `type`，WFL 对两者使用相同语义识别。
阶段 9 又把两组 Automapping 夹具加入同一候选服务器检查：脚本使用一次性 Tiled 配置目录和真实编辑器
会话调用官方 `TileMap.autoMap()`，等到结果原子写出后终止自己启动的整个进程组。基础夹具验证缺失输出层
创建及外部 TSJ 从规则 `firstgid=1` 到目标 `firstgid=100` 的映射；高级夹具验证 `Other`（含空格）、
`IgnoreHorizontalFlip` 和 `NoOverlappingOutput`。官方与 WFL 的层名和完整 GID 数组必须相同。该检查不在
普通用户服务器的部署流程中运行。

坐标、命中、编码、编辑和瓦片集的详细行为继续由
[渲染模型测试](../test/tiled-render-model.test.mjs)、
[tile codec 测试](../test/tiled-tile-codec.test.mjs)、
[编辑文档测试](../test/tiled-edit-document.test.mjs)和
[瓦片集测试](../test/tiled-tileset-model.test.mjs)负责；阶段 6 的 Stamp 变换、确定性随机和命名库由
[瓦片工具测试](../test/tile-tool-model.test.mjs)与
[命名 Stamp 测试](../test/tile-stamp-library.test.mjs)覆盖；跨地图 TSJ 复用、firstgid 分配及 32 位 GID
重映射由[稳定 GID 测试](../test/tiled-gid-reuse.test.mjs)覆盖；瓦片矩形、魔棒、同类和集合运算由
[瓦片选择测试](../test/tile-selection-model.test.mjs)及
[瓦片工具浏览器测试](../test/browser/map-tile-tools.test.mjs)覆盖；阶段 5 对象创建和变换由
[对象模型测试](../test/map-object-model.test.mjs)与
[对象往返测试](../test/tiled-object-editing.test.mjs)覆盖；外部 TSJ 基础字段、tile 属性、probability、动画和
碰撞由[瓦片集编辑文档测试](../test/tiled-tileset-edit-document.test.mjs)、
[瓦片集编辑器界面测试](../test/tileset-editor-ui.test.mjs)与
[项目工作区浏览器测试](../test/browser/map-workspace.test.mjs)覆盖。

## 官方依据

- [Tiled 1.12.2 发布说明](https://www.mapeditor.org/2026/05/27/tiled-1-12-2-released.html)
- [Tiled 1.12 发布说明](https://www.mapeditor.org/2026/03/13/tiled-1-12-released.html)
- [Tiled JSON Map Format](https://doc.mapeditor.org/en/stable/reference/json-map-format/)
- [Tiled Projects](https://doc.mapeditor.org/en/stable/manual/projects/)
- [Tiled Worlds](https://doc.mapeditor.org/en/stable/manual/worlds/)
- [Tiled Templates](https://doc.mapeditor.org/en/stable/manual/using-templates/)
