# 移动 App 工作台

工具箱中的“移动 App 工作台”统一提供 Flutter Web 预览、依赖准备和 Android APK 构建。

首次使用时，在“文件与项目”中选择移动 App 工程和一个总目录。工具会在总目录下创建：

```text
flutter/       Flutter SDK
pub-cache/     Pub 缓存
generated/     Flutter Android/Web 生成工程
previews/      临时 Web 预览工程
apk/           APK 产物
gradle/        Gradle 缓存
signing/       加密签名配置
logs/          预览日志
```

Flutter SDK、Pub 依赖和 Java keytool 都是按需准备，主安装器不会预装这些移动工具依赖。
预览页面使用内存演示数据；刷新后恢复演示服务器，不连接真实 SSH、API 或供应商。

APK 构建继续使用现有 Android Gradle/MCP 服务，旧的 Android 构建插件接口仍然保留。工作台产生的 APK 写入总目录的 `apk/` 子目录。

移动 App 的 Flutter 生成文件不会写入源码目录。若旧版本曾经生成过 `apps/mobile/android`、`apps/mobile/web`、`.dart_tool` 或 `pubspec.lock`，可以先预览并隔离：

```bash
npm run source:repair -- --dry-run
npm run source:repair -- --apply
```

隔离内容保存在 `.codex-runtime/source-repair/`，不会直接删除；未知源码修改仍会阻止自动同步。

游戏编辑器当前不需要额外安装 Tiled 桌面程序；Tiled `1.12.2` 是文件格式兼容目标。以后游戏工具出现专属依赖，也应由对应工具按需准备，不进入主安装器。
