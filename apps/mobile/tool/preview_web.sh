#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
FLUTTER_BIN="${FLUTTER_BIN:-/www/mobile-agent-tooling/flutter/bin/flutter}"
PUB_CACHE="${PUB_CACHE:-/www/mobile-agent-tooling/pub-cache}"
PREVIEW_ROOT="${PREVIEW_ROOT:-/www/mobile-agent-previews}"
PORT="${PORT:-8788}"

[[ -x "$FLUTTER_BIN" ]] || { printf 'Flutter SDK not found: %s\n' "$FLUTTER_BIN" >&2; exit 1; }
mkdir -p "$PREVIEW_ROOT" "$PUB_CACHE"
export PUB_CACHE
FLUTTER_ROOT="$(cd -- "$(dirname -- "$FLUTTER_BIN")/.." && pwd -P)"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0="$FLUTTER_ROOT"
TEMP_PROJECT="$(mktemp -d "$PREVIEW_ROOT/wfl-mobile-preview.XXXXXX")"
trap 'rm -rf -- "$TEMP_PROJECT"' EXIT

"$FLUTTER_BIN" create --platforms=web --project-name=wfl_mobile_preview "$TEMP_PROJECT"
rm -rf "$TEMP_PROJECT/lib"
cp -R "$APP_DIR/lib" "$TEMP_PROJECT/lib"
cp "$APP_DIR/pubspec.yaml" "$TEMP_PROJECT/pubspec.yaml"
sed -i 's#<base href="[^"]*">#<base href="/">#' "$TEMP_PROJECT/web/index.html"
cd "$TEMP_PROJECT"
"$FLUTTER_BIN" pub get
exec "$FLUTTER_BIN" run -d web-server --web-hostname 0.0.0.0 --web-port "$PORT" --dart-define=PREVIEW_MODE=true
