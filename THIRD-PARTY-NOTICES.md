# Third-party notices

This is an attribution index for the open-source components identified in the
WFL Codex Web Workspace source tree and dependency locks. It does not replace the
license text shipped by an upstream project and it does not relicense
third-party code. The WFL Codex Web Workspace code itself is MIT-licensed.

The repository does not commit node_modules, Flutter caches, Gradle caches, or
Playwright browser binaries. When those dependencies are installed, retain
their original license and notice files.

## Main Node.js application

Direct runtime dependencies in package.json at the 0.44.55 audit
baseline:

| Package | Version | License | Upstream |
| --- | ---: | --- | --- |
| @fontsource/jetbrains-mono | 5.3.0 | OFL-1.1 | https://github.com/fontsource/font-files |
| @fontsource/manrope | 5.3.0 | OFL-1.1 | https://github.com/fontsource/font-files |
| @jsquash/jpeg | 1.6.0 | Apache-2.0 | https://github.com/jamsinclair/jSquash |
| @jsquash/webp | 1.5.0 | Apache-2.0 | https://github.com/jamsinclair/jSquash |
| @novnc/novnc | 1.7.0 | MPL-2.0 | https://github.com/novnc/noVNC |
| compression | 1.8.1 | MIT | https://github.com/expressjs/compression |
| express | 5.2.1 | MIT | https://github.com/expressjs/express |
| lucide | 1.25.0 | ISC | https://github.com/lucide-icons/lucide |
| pixi.js | 8.19.0 | MIT | https://github.com/pixijs/pixijs |
| playwright | 1.61.1 | Apache-2.0 | https://github.com/microsoft/playwright |
| sharp | 0.35.3 | Apache-2.0 | https://github.com/lovell/sharp |
| ssh2 | 1.17.0 | MIT | https://github.com/mscdex/ssh2 |
| ws | 8.21.1 | MIT | https://github.com/websockets/ws |
| yaml | 2.9.0 | ISC | https://github.com/eemeli/yaml |

Important transitive notices:

- sharp's Linux libvips packages declare LGPL-3.0-or-later. Its platform
  packages also declare Apache-2.0 and MIT where applicable.
- noVNC is MPL-2.0 and contains separately licensed documents and vendored
  pako. Retain the license files under node_modules/@novnc/novnc/.
- @fontsource packages and bundled font files remain OFL-1.1.
- tweetnacl is Unlicense and tslib is 0BSD. Other audited npm transitive
  packages use MIT, ISC, BSD-3-Clause, or Apache-2.0 according to metadata.

The audit found 112 installed npm package metadata entries: 83 MIT, 9
Apache-2.0, 8 ISC, 4 BSD-3-Clause, 2 LGPL-3.0-or-later, 2 OFL-1.1, 1 MPL-2.0,
1 0BSD, 1 Unlicense, and 1 package declaring combined Apache-2.0/LGPL/MIT.
A later lockfile change requires a fresh audit.

Playwright downloads browser binaries separately. This repository does not
redistribute Chromium; a server operator that mirrors those binaries must
also provide Chromium's BSD and third-party notices.

The installer also obtains the official OpenAI Codex CLI separately from the
application source package. The audited 0.149.0 npm package declares
Apache-2.0: https://github.com/openai/codex. It is an external prerequisite,
not a vendored WFL component.

## Windows companion

companion/windows-host is WFL-owned MIT-licensed code. Its direct dependencies
docx and pptxgenjs are MIT. Its lockfile also records jszip (MIT OR
GPL-3.0-or-later), pako (MIT AND Zlib), and sax (BlueOak-1.0.0). The remaining
packages retain the licenses recorded in companion/windows-host/npm-shrinkwrap.json.

## Flutter mobile projects

### android/

This is a separate SyncVault-derived application, not a relicensable part of
the WFL web server. Its application code remains BSD 3-Clause under
android/LICENSE.md. Dependency versions are recorded in android/pubspec.lock
and the Android Gradle files.

The direct package archive audit for the locked Flutter dependencies found:

- MIT: animated_tree_view, dio, file_picker, fl_nodes, flutter_dotenv,
  flutter_fancy_tree_view, flutter_hooks, flutter_launcher_icons, flutter_svg,
  flutter_web_auth_2, fpdart, freezed, freezed_annotation, hooks_riverpod,
  injectable, injectable_generator, introduction_screen, launch_at_startup,
  logger, permission_handler, riverpod_annotation, riverpod_generator,
  riverpod_lint, sentry_flutter, tray_manager, and window_manager.
- BSD-family: archive, build_runner, connectivity_plus, crypto, flutter_lints,
  flutter_local_notifications, glob, google_fonts, google_sign_in, googleapis,
  googleapis_auth, hashlib, http, json_annotation, json_serializable,
  microsoft_graph_api, oauth2, package_info_plus, path, path_provider,
  url_launcher, and watcher.
- Apache-2.0: get_it, hive_ce, hive_ce_flutter, hive_ce_generator, and mockito.

Flutter SDK packages retain the Flutter BSD license. The git-sourced ini_v2
and workmanager packages must retain and ship the license files from their
checked-out upstream revisions; their license was not inferred from hosted
package metadata.

### apps/mobile/

This is WFL-owned MIT-licensed preview/client code. Its Flutter dependencies
are declared in apps/mobile/pubspec.yaml. The bundled Noto Sans SC font is
separately licensed under SIL Open Font License 1.1; see
apps/mobile/assets/fonts/OFL.txt.

## Bundled Android drive client

tools/wfl-codex-drive and the APKs under public/downloads are derived from
Round Sync/rcloneExplorer. They remain GPL-3.0 and are not covered by the root
MIT license. Preserve tools/wfl-codex-drive/LICENSE,
LICENSE_rcloneExplorer-1.7.4, and NOTICE-WFL-CODEX.md, as well as the
upstream attribution shown by the Android client's license screen.
The APK metadata intentionally continues to declare GPL-3.0.

## Fonts and assets

Manrope and JetBrains Mono are OFL-1.1. Noto Sans SC is OFL-1.1. Icons and
rendering libraries are covered by the lucide, pixi.js, and noVNC entries
above. Project-specific assets are MIT-licensed only when WFL-owned; external
trademarks and artwork retain their own rights.

This inventory is a technical review rather than legal advice. Before
redistributing a rebuilt APK, browser bundle, or native dependency, regenerate
the dependency locks and verify the exact license files in the build output.
