# WFL Codex 网盘 Android 客户端

本应用是 WFL Codex 对 [Round Sync](https://github.com/newhinton/Round-Sync)
的独立修改版本。Round Sync 及其修改后的 GPL 代码遵循仓库中的
`LICENSE`（GPL-3.0）；rclone 相关代码和许可证见 `LICENSE_rcloneExplorer-1.7.4`
以及上游项目说明。

WFL Codex 定制内容包括：

- WFL Codex 品牌、中文首启说明和 WebDAV 登录引导；
- 支持在登录时填写任意部署实例的 HTTPS `/dav` 地址；
- 使用网站账号认证，并由服务器按账号隔离工程目录和写入权限；
- 关闭会错误指向 Round Sync 官方发行包的自动更新任务。

WFL Codex 定制代码仍按 GPL-3.0 发布。源代码与构建说明随本站仓库提供。
