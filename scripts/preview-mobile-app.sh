#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

SESSION=""
ACCESS_KEY=""
BUILD_ID=""
PROJECT=""
PREVIEW_ROOT=""
WORKSPACE=""
STORAGE_ROOT=""
while (($#)); do
  case "$1" in
    --session) SESSION="$2"; shift 2 ;;
    --access-key) ACCESS_KEY="$2"; shift 2 ;;
    --build-id) BUILD_ID="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --preview-root) PREVIEW_ROOT="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --storage-root) STORAGE_ROOT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ "$SESSION" =~ ^[a-f0-9]{24}$ && "$ACCESS_KEY" =~ ^[A-Za-z0-9_-]{43}$ && "$BUILD_ID" =~ ^[a-f0-9]{16}$ && "$PROJECT" == /* && "$PREVIEW_ROOT" == /* && "$WORKSPACE" == /* && "$STORAGE_ROOT" == /* ]] || exit 2
FLUTTER_BIN="${FLUTTER_BIN:-$STORAGE_ROOT/flutter/bin/flutter}"
[[ -x "$FLUTTER_BIN" ]] || { echo "Flutter SDK is not prepared" >&2; exit 1; }
export PUB_CACHE="${PUB_CACHE:-$STORAGE_ROOT/pub-cache}"
export PATH="$(dirname "$FLUTTER_BIN"):$PATH"
FLUTTER_ROOT="$(cd -- "$(dirname -- "$FLUTTER_BIN")/.." && pwd -P)"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0="$FLUTTER_ROOT"

mkdir -p "$PREVIEW_ROOT"
READY_MARKER="$PREVIEW_ROOT/.wfl-preview-ready"
rm -f -- "$READY_MARKER"
mkdir -p "$(dirname "$WORKSPACE")"
exec 9>"${WORKSPACE}.lock"
flock 9
node "$SCRIPT_DIR/stage-mobile-app-preview.mjs" --reset-workspace "$WORKSPACE"
"$FLUTTER_BIN" create --no-pub --platforms=web --project-name=wfl_mobile_preview "$WORKSPACE"
node "$SCRIPT_DIR/stage-mobile-app-preview.mjs" \
  --project "$PROJECT" \
  --preview-root "$WORKSPACE"
cd "$WORKSPACE"
"$FLUTTER_BIN" pub get
"$FLUTTER_BIN" build web \
  --release \
  --no-pub \
  --no-web-resources-cdn \
  --no-wasm-dry-run \
  --pwa-strategy=none \
  --base-href "/tools/mobile-preview/${SESSION}/${ACCESS_KEY}/" \
  --dart-define=PREVIEW_MODE=true
node "$SCRIPT_DIR/stage-mobile-app-preview.mjs" \
  --publish-web "$WORKSPACE/build/web" \
  --preview-root "$PREVIEW_ROOT"
printf '%s\n' "$BUILD_ID" > "$READY_MARKER"
