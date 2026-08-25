#!/usr/bin/env bash
set -Eeuo pipefail
# Installer secrets must never be expanded by a caller-provided `bash -x`.
set +x

INVOCATION_DIR="$(pwd -P)"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
STATE_DIR="${CODEX_DESKTOP_STATE_DIR:-$SOURCE_DIR/.codex-desktop}"
RUNTIME_DIR="${CODEX_DESKTOP_RUNTIME_DIR:-$SOURCE_DIR/.codex-runtime}"
CHECK_ONLY=0
SKIP_LOGIN=0
CODEX_AUTH_MODE=""
CONFIGURE_ACCESS_ONLY=0
INTERACTIVE=-1
PACKAGE_ARCHIVE=""
PACKAGE_CHECKSUM=""
GIT_REMOTE=""
SOURCE_MODE=""
PASSWORD_MODE=""
CUSTOM_PASSWORD=""
OWNER_USERNAME="${CODEX_DESKTOP_USERNAME:-codex}"
OWNER_USERNAME_PLAN=""
ACCESS_MODE=""
ACCESS_HOSTNAME=""
ACCESS_REVERSE_PROXY=""
ACCESS_EMAIL=""
PROVIDER_NAME=""
PROVIDER_BASE_URL=""
PROVIDER_MODEL=""
PROVIDER_API_KEY=""
CURRENT_STEP="initial preflight"
INITIAL_RESCUE_INSTALL=1
NODE_SOURCE_SETUP_SHA256="575583bbac2fccc0b5edd0dbc03e222d9f9dc8d724da996d22754d6411104fd1"
CODEX_INSTALLER_SHA256="ba92dd27e5c06f0d3bbc58bfa4b9cfb6599cd2742fbb1f92a2765e6c07dedb5a"
CODEX_CLI_VERSION="${CODEX_DESKTOP_CODEX_VERSION:-0.149.0}"

usage() {
  printf '%s\n' \
    "Usage: sudo bash install.sh [options]" \
    "" \
    "Installs a fresh Debian/Ubuntu server from a verified Git checkout or release package." \
    "Interactive terminals get a guided setup, including optional browser access." \
    "The service always binds only to 127.0.0.1:4317." \
    "" \
    "Options:" \
    "  --archive PATH          Verify this release .tar.gz before package installation" \
    "  --checksum PATH         SHA-256 file (defaults to ARCHIVE.sha256)" \
    "  --git-remote URL        Prepare package installs for future synchronized updates" \
    "  --access-mode MODE      existing-domain, cloudflare, or local" \
    "  --hostname HOST         Public hostname for the selected access mode" \
    "  --reverse-proxy MODE    existing or nginx (existing-domain only)" \
    "  --email ADDRESS         Certbot address for managed Nginx HTTPS" \
    "  --skip-codex-login      Install now and configure Codex authorization later" \
    "  --non-interactive       Never prompt; defaults to local-only access" \
    "  --configure-access      Rerun only the browser-access wizard" \
    "  --check                 Check an existing installation without changing it" \
    "  -h, --help              Show this help"
}

while (($#)); do
  case "$1" in
    --archive|--checksum|--git-remote|--access-mode|--hostname|--reverse-proxy|--email)
      option="$1"
      (($# >= 2)) || { printf '%s requires a value.\n' "$option" >&2; exit 2; }
      case "$option" in
        --archive) PACKAGE_ARCHIVE="$2" ;;
        --checksum) PACKAGE_CHECKSUM="$2" ;;
        --git-remote) GIT_REMOTE="$2" ;;
        --access-mode) ACCESS_MODE="$2" ;;
        --hostname) ACCESS_HOSTNAME="$2" ;;
        --reverse-proxy) ACCESS_REVERSE_PROXY="$2" ;;
        --email) ACCESS_EMAIL="$2" ;;
      esac
      shift 2
      ;;
    --check) CHECK_ONLY=1; shift ;;
    --configure-access) CONFIGURE_ACCESS_ONLY=1; shift ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    --skip-codex-login) SKIP_LOGIN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if ((INTERACTIVE < 0)); then
  if [[ -t 0 && -t 1 ]]; then INTERACTIVE=1; else INTERACTIVE=0; fi
fi

if [[ -n "$PACKAGE_ARCHIVE" && "$PACKAGE_ARCHIVE" != /* ]]; then
  PACKAGE_ARCHIVE="$INVOCATION_DIR/$PACKAGE_ARCHIVE"
fi
if [[ -n "$PACKAGE_CHECKSUM" && "$PACKAGE_CHECKSUM" != /* ]]; then
  PACKAGE_CHECKSUM="$INVOCATION_DIR/$PACKAGE_CHECKSUM"
fi

export HOME="${CODEX_DESKTOP_SERVICE_HOME:-/root}"
export PATH="$HOME/.local/bin:$HOME/.codex/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
cd "$SOURCE_DIR"

validate_install_paths() {
  local name value
  for name in SOURCE_DIR STATE_DIR RUNTIME_DIR; do
    value="${!name}"
    [[ "$value" == /* && "$value" != *[$'\r\n\t ']* && "$value" != *..* ]] || {
      printf '%s must be an absolute path without whitespace, control characters, or .. components.\n' "$name" >&2
      return 1
    }
  done
}

rescue_component_exists() {
  [[ -e "$RUNTIME_DIR/rescue" || -L "$RUNTIME_DIR/rescue" ]] \
    || [[ -e "$RUNTIME_DIR/rescue-slot" || -L "$RUNTIME_DIR/rescue-slot" ]] \
    || [[ -e "$RUNTIME_DIR/rescue-active-port" ]] \
    || [[ -d "$RUNTIME_DIR/rescue-slots" && -n "$(find "$RUNTIME_DIR/rescue-slots" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]
}

determine_rescue_install_mode() {
  INITIAL_RESCUE_INSTALL=1
  for path in \
    "$RUNTIME_DIR/rescue" \
    "$RUNTIME_DIR/rescue-active-port" \
    "$RUNTIME_DIR/rescue-slot" \
    /etc/systemd/system/wfl-codex-desktop-rescue.service \
    /etc/systemd/system/wfl-codex-desktop-rescue@.service; do
    if [[ -e "$path" || -L "$path" ]]; then
      INITIAL_RESCUE_INSTALL=0
      break
    fi
  done
  if ((INITIAL_RESCUE_INSTALL)) && rescue_component_exists; then
    INITIAL_RESCUE_INSTALL=0
  fi
}

prompt_choice() {
  local variable="$1" prompt="$2" default="$3" answer suffix
  shift 3
  while true; do
    printf '\n%s\n' "$prompt"
    printf '%s\n' "$@"
    if [[ -n "$default" ]]; then suffix="[$default]"; else suffix="[必选]"; fi
    read -r -p "请选择 $suffix: " answer || return 1
    answer="${answer:-$default}"
    case "$answer" in
      1|2|3) printf -v "$variable" '%s' "$answer"; return 0 ;;
      *) printf '请输入有效编号。\n' >&2 ;;
    esac
  done
}

prompt_value() {
  local variable="$1" prompt="$2" default="${3:-}" answer=""
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " answer || return 1
    answer="${answer:-$default}"
  else
    while [[ -z "$answer" ]]; do
      read -r -p "$prompt: " answer || return 1
    done
  fi
  printf -v "$variable" '%s' "$answer"
}

prompt_yes_no() {
  local prompt="$1" default="$2" answer suffix
  if [[ "$default" == "yes" ]]; then suffix="Y/n"; else suffix="y/N"; fi
  while true; do
    read -r -p "$prompt [$suffix]: " answer || return 1
    answer="${answer,,}"
    if [[ -z "$answer" ]]; then [[ "$default" == "yes" ]]; return; fi
    case "$answer" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) printf '请输入 y 或 n。\n' >&2 ;;
    esac
  done
}

normalize_package_paths() {
  if [[ -n "$PACKAGE_ARCHIVE" && "$PACKAGE_ARCHIVE" != /* ]]; then
    PACKAGE_ARCHIVE="$INVOCATION_DIR/$PACKAGE_ARCHIVE"
  fi
  if [[ -n "$PACKAGE_CHECKSUM" && "$PACKAGE_CHECKSUM" != /* ]]; then
    PACKAGE_CHECKSUM="$INVOCATION_DIR/$PACKAGE_CHECKSUM"
  fi
}

choose_password_plan() {
  if [[ -s "$STATE_DIR/auth.json" ]]; then
    PASSWORD_MODE="preserve"
    return 0
  fi
  if ((!INTERACTIVE)); then PASSWORD_MODE="generate"; return 0; fi

  local first second
  if prompt_yes_no "自动生成高强度网页登录密码（安装时只显示一次）？选择 n 可自定义" yes; then
    PASSWORD_MODE="generate"
    return 0
  fi
  while true; do
    read -r -s -p "输入新密码: " first
    printf '\n'
    read -r -s -p "再次输入: " second
    printf '\n'
    if [[ ${#first} -lt 16 ]]; then
      printf '密码至少需要 16 个字符。\n' >&2
    elif [[ "$first" != "$second" ]]; then
      printf '两次输入不一致。\n' >&2
    else
      CUSTOM_PASSWORD="$first"
      PASSWORD_MODE="custom"
      return 0
    fi
  done
}

choose_owner_username() {
  if [[ -s "$STATE_DIR/auth.json" ]]; then
    OWNER_USERNAME_PLAN="保留现有所有者"
    return 0
  fi
  if ((INTERACTIVE)); then
    prompt_value OWNER_USERNAME "所有者用户名" "${OWNER_USERNAME:-codex}"
  fi
  OWNER_USERNAME="${OWNER_USERNAME:-codex}"
  [[ "$OWNER_USERNAME" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || {
    printf '所有者用户名必须为 1-32 个字母、数字、点、下划线或连字符。\n' >&2
    return 1
  }
  OWNER_USERNAME_PLAN="$OWNER_USERNAME"
}

choose_access_mode() {
  [[ -z "$ACCESS_MODE" ]] || return 0
  if ((!INTERACTIVE)); then ACCESS_MODE="local"; return 0; fi
  local choice
  prompt_choice choice "安装完成后准备如何访问网页？此项必须明确选择。" "" \
    "  1. 域名已解析到本机，现在核对或配置 80/443 与 HTTPS" \
    "  2. 本机无法开放 80/443，现在配置 Cloudflare Tunnel" \
    "  3. 长期仅用本机浏览器或 SSH 转发，本次不配置任何域名"
  case "$choice" in
    1) ACCESS_MODE="existing-domain" ;;
    2) ACCESS_MODE="cloudflare" ;;
    3) ACCESS_MODE="local" ;;
  esac
}

provider_is_configured() {
  command -v node >/dev/null 2>&1 \
    && CODEX_DESKTOP_STATE_DIR="$STATE_DIR" node scripts/configure-provider.mjs --configured >/dev/null 2>&1
}

provider_url_is_loopback() {
  [[ "$1" =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(/|$) ]]
}

validate_provider_plan() {
  [[ -n "$PROVIDER_NAME" && ${#PROVIDER_NAME} -le 64 && ! "$PROVIDER_NAME" =~ [[:cntrl:]] ]] || {
    printf '供应商名称必须为 1-64 个字符且不能包含控制字符。\n' >&2
    return 1
  }
  if [[ "$PROVIDER_BASE_URL" != https://* ]] && ! provider_url_is_loopback "$PROVIDER_BASE_URL"; then
    printf '远程 API Base URL 必须使用 HTTPS；只有本机回环地址可以使用 HTTP。\n' >&2
    return 1
  fi
  [[ ! "$PROVIDER_BASE_URL" =~ [[:space:]?#] && "$PROVIDER_BASE_URL" != *"@"* ]] || {
    printf 'API Base URL 不能包含空白、账号、查询参数或片段。\n' >&2
    return 1
  }
  [[ -z "$PROVIDER_MODEL" || "$PROVIDER_MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$ ]] || {
    printf '模型 ID 格式不正确。\n' >&2
    return 1
  }
  if [[ -z "$PROVIDER_API_KEY" ]] && ! provider_url_is_loopback "$PROVIDER_BASE_URL"; then
    printf '远程 API 供应商需要 API Key。\n' >&2
    return 1
  fi
  ((${#PROVIDER_API_KEY} <= 4096)) && [[ ! "$PROVIDER_API_KEY" =~ [[:cntrl:]] ]] || {
    printf 'API Key 格式不正确。\n' >&2
    return 1
  }
}

choose_codex_auth_plan() {
  local choice
  if provider_is_configured; then
    CODEX_AUTH_MODE="preserve-provider"
    SKIP_LOGIN=1
    return 0
  fi
  if codex login status >/dev/null 2>&1; then
    CODEX_AUTH_MODE="official"
    return 0
  fi
  if ((!INTERACTIVE)); then
    if ((SKIP_LOGIN)); then
      CODEX_AUTH_MODE="later"
      return 0
    fi
    printf 'Non-interactive installation requires --skip-codex-login unless Codex is already authorized.\n' >&2
    return 1
  fi

  prompt_choice choice "首次安装后如何授权 Codex？此项必须明确选择。" "" \
    "  1. 安装过程中立即进行 OpenAI 官方账号设备登录" \
    "  2. 安装过程中立即输入 Responses 兼容 API 供应商" \
    "  3. 只部署程序，登录网页后再配置（配置前不能发送对话）"
  case "$choice" in
    1)
      CODEX_AUTH_MODE="official"
      SKIP_LOGIN=0
      ;;
    2)
      CODEX_AUTH_MODE="provider"
      SKIP_LOGIN=1
      while true; do
        prompt_value PROVIDER_NAME "供应商名称（例如公司 API）"
        prompt_value PROVIDER_BASE_URL "Responses API Base URL（远程地址必须为 HTTPS）"
        read -r -p "初始模型 ID（可留空，之后在主页选择）: " PROVIDER_MODEL
        read -r -s -p "API Key（隐藏输入；本机无鉴权服务可留空）: " PROVIDER_API_KEY
        printf '\n'
        validate_provider_plan && break
        PROVIDER_API_KEY=""
        printf '请重新输入这组 API 供应商设置。\n' >&2
      done
      ;;
    3)
      CODEX_AUTH_MODE="later"
      SKIP_LOGIN=1
      ;;
  esac
}

validate_access_mode() {
  case "$ACCESS_MODE" in
    existing-domain|cloudflare|local) ;;
    *) printf 'Access mode must be existing-domain, cloudflare, or local.\n' >&2; return 1 ;;
  esac
}

prepare_package_inputs() {
  local version archive_default
  version="$(tr -d '\r\n' < VERSION)"

  if [[ "$SOURCE_MODE" == "package" ]]; then
    archive_default="$(dirname "$SOURCE_DIR")/wfl-codex-desktop-v${version}.tar.gz"
    [[ -n "$PACKAGE_ARCHIVE" ]] || PACKAGE_ARCHIVE="$archive_default"
    if [[ ! -f "$PACKAGE_ARCHIVE" && $INTERACTIVE -eq 1 ]]; then
      prompt_value PACKAGE_ARCHIVE "未找到同目录安装包，请输入 .tar.gz 完整路径" "$PACKAGE_ARCHIVE"
    fi
    [[ -n "$PACKAGE_CHECKSUM" ]] || PACKAGE_CHECKSUM="${PACKAGE_ARCHIVE}.sha256"
    if [[ ! -f "$PACKAGE_CHECKSUM" && $INTERACTIVE -eq 1 ]]; then
      prompt_value PACKAGE_CHECKSUM "未找到 SHA-256 文件，请输入 .sha256 完整路径" "$PACKAGE_CHECKSUM"
    fi
    normalize_package_paths

    if [[ -z "$GIT_REMOTE" && $INTERACTIVE -eq 1 ]]; then
      if prompt_yes_no "当前服务器已经配置独立只读 Deploy Key，并要现在启用版本中心远程同步？" no; then
        prompt_value GIT_REMOTE "请输入已配置只读 Deploy Key 的 SSH 仓库地址（例如 git@github.com:OWNER/REPO.git）"
      else
        printf '将以离线包模式安装；版本中心远程同步暂不可用，之后需通过 SSH 配置。\n'
      fi
    fi
  fi
}

prepare_install_wizard() {
  local version update_remote login_plan password_plan access_plan
  version="$(tr -d '\r\n' < VERSION)"

  choose_codex_auth_plan
  choose_owner_username
  choose_password_plan
  choose_access_mode
  validate_access_mode

  if ((!INTERACTIVE)); then return 0; fi
  case "$CODEX_AUTH_MODE" in
    official) login_plan="OpenAI 官方账号；如未登录则安装中设备授权" ;;
    provider)
      if [[ -n "$PROVIDER_MODEL" ]]; then
        login_plan="API 供应商：${PROVIDER_NAME} / ${PROVIDER_MODEL}（密钥隐藏）"
      else
        login_plan="API 供应商：${PROVIDER_NAME}；模型稍后在主页选择（密钥隐藏）"
      fi
      ;;
    preserve-provider) login_plan="保留现有加密 API 供应商" ;;
    later) login_plan="安装后待配置；完成前不能发送对话" ;;
    *) printf 'Unknown Codex authorization mode: %s\n' "$CODEX_AUTH_MODE" >&2; return 1 ;;
  esac
  case "$PASSWORD_MODE" in
    preserve) password_plan="保留现有密码" ;;
    custom) password_plan="使用刚才输入的自定义密码" ;;
    *) password_plan="自动生成并只显示一次" ;;
  esac
  case "$ACCESS_MODE" in
    existing-domain) access_plan="已有域名（稍后核对/配置 HTTPS 反向代理）" ;;
    cloudflare) access_plan="Cloudflare Tunnel（稍后隐藏输入 token）" ;;
    local) access_plan="仅本机或 SSH 转发；本次不会配置任何域名" ;;
    *) printf 'Unknown access mode: %s\n' "$ACCESS_MODE" >&2; return 1 ;;
  esac

  printf '\n========== 安装方案确认 ==========\n'
  printf '版本：v%s\n源码：%s（%s）\n' "$version" "$SOURCE_DIR" "$SOURCE_MODE"
  if [[ "$SOURCE_MODE" == "package" ]]; then
    printf '安装包：%s\n校验文件：%s\n' "$PACKAGE_ARCHIVE" "$PACKAGE_CHECKSUM"
    if [[ -n "$GIT_REMOTE" ]]; then
      update_remote="$GIT_REMOTE"
    else
      update_remote="未启用；版本中心同步不可用，之后需 SSH 配置 Deploy Key"
    fi
    printf '后续更新：%s\n' "$update_remote"
  fi
  printf 'Codex 登录：%s\n所有者用户名：%s\n网页密码：%s\n访问方式：%s\n' "$login_plan" "${OWNER_USERNAME_PLAN:-$OWNER_USERNAME}" "$password_plan" "$access_plan"
  printf '安装检查：快速兼容检查 + 部署后健康检查（不会运行仓库测试或浏览器冒烟）\n'
  printf '服务端口：仅监听 127.0.0.1:4317-4321\n'
  if [[ "$CODEX_AUTH_MODE" == "later" || "$ACCESS_MODE" == "local" || ( "$SOURCE_MODE" == "package" && -z "$GIT_REMOTE" ) ]]; then
    printf '安装后待办：\n'
    [[ "$CODEX_AUTH_MODE" != "later" ]] || printf '  - 登录网页，在 API 供应商中心完成授权后才能发送对话。\n'
    [[ "$ACCESS_MODE" != "local" ]] || printf '  - 当前不会生成公网地址；需要域名时必须重新运行访问向导。\n'
    [[ "$SOURCE_MODE" != "package" || -n "$GIT_REMOTE" ]] || printf '  - 配置独立只读 Deploy Key 前，版本中心不能远程同步。\n'
  fi
  printf '==================================\n'
  prompt_yes_no "确认开始安装？" no || { printf '安装已取消，系统未被修改。\n'; exit 0; }
}

run_access_wizard() {
  local access_args=()
  [[ -n "$ACCESS_MODE" ]] && access_args+=(--mode "$ACCESS_MODE")
  [[ -n "$ACCESS_HOSTNAME" ]] && access_args+=(--hostname "$ACCESS_HOSTNAME")
  [[ -n "$ACCESS_REVERSE_PROXY" ]] && access_args+=(--reverse-proxy "$ACCESS_REVERSE_PROXY")
  [[ -n "$ACCESS_EMAIL" ]] && access_args+=(--email "$ACCESS_EMAIL")
  if ((!INTERACTIVE)); then access_args+=(--non-interactive); fi
  WFL_ACCESS_LOCK_HELD=1 WFL_ACCESS_STATE_FILE="$RUNTIME_DIR/access.json" \
    bash scripts/configure-access.sh "${access_args[@]}"
}

check_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    return 1
  }
}

check_node() {
  command -v node >/dev/null 2>&1 && node -e '
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 22) process.exit(1);
  ' || {
    printf 'Node.js 22 or newer is required. Installed: %s\n' "$(node --version 2>/dev/null || printf 'missing')" >&2
    return 1
  }
}

verify_download_sha256() {
  local filename="$1" expected="$2" actual
  actual="$(sha256sum -- "$filename" | awk '{ print $1 }')"
  [[ "$actual" == "$expected" ]] || {
    printf 'Downloaded file failed its pinned SHA-256 verification: %s\n' "$filename" >&2
    return 1
  }
}

sync_file_and_directory() {
  node -e '
    const fs = require("fs");
    for (const filename of process.argv.slice(1)) {
      const fd = fs.openSync(filename, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  ' "$1" "$2"
}

sync_directory() {
  node -e '
    const fs = require("fs");
    const fd = fs.openSync(process.argv[1], "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  ' "$1"
}

validate_codex_cli_version() {
  [[ "$CODEX_CLI_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    printf 'CODEX_DESKTOP_CODEX_VERSION must be a semantic version such as 0.149.0.\n' >&2
    return 1
  }
}

codex_cli_capabilities_ready() {
  command -v codex >/dev/null 2>&1 || return 1
  local version_line app_server_help
  version_line="$(codex --version 2>/dev/null | head -n 1)" || return 1
  [[ "$version_line" =~ ^codex-cli[[:space:]]+[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)? ]] || return 1
  app_server_help="$(codex app-server --help 2>/dev/null)" || return 1
  [[ "$app_server_help" =~ Usage:[[:space:]]+codex[[:space:]]+app-server || "$app_server_help" == *"Run the app server"* ]]
}

codex_cli_version() {
  codex --version 2>/dev/null \
    | head -n 1 \
    | sed -nE 's/^codex-cli[[:space:]]+([0-9]+\.[0-9]+\.[0-9]+)([-+][0-9A-Za-z.-]+)?.*$/\1/p'
}

codex_cli_meets_baseline() {
  local installed
  installed="$(codex_cli_version)"
  [[ -n "$installed" ]] || return 1
  [[ "$(printf '%s\n' "$CODEX_CLI_VERSION" "$installed" | sort -V | head -n 1)" == "$CODEX_CLI_VERSION" ]]
}

detect_source_mode() {
  if [[ -d "$SOURCE_DIR/.git" || -f "$SOURCE_DIR/.git" ]]; then
    SOURCE_MODE="git"
  elif [[ -s "$SOURCE_DIR/.codex-package.json" ]]; then
    SOURCE_MODE="package"
  else
    printf 'Source must be a Git checkout or an official release package with .codex-package.json.\n' >&2
    return 1
  fi
}

check_git_checkout() {
  test -z "$(git status --porcelain --untracked-files=all)" || {
    printf 'The Git checkout must be clean before installation.\n' >&2
    return 1
  }
  local version head tag upstream upstream_ref
  version="$(tr -d '\r\n' < VERSION)"
  head="$(git rev-parse HEAD)"
  tag="$(git rev-parse "v${version}^{commit}")"
  upstream="$(git rev-parse '@{upstream}')"
  upstream_ref="$(git rev-parse --symbolic-full-name '@{upstream}')"
  test "$head" = "$tag" && test "$head" = "$upstream" && test "$upstream_ref" = "refs/remotes/origin/stable" || {
    printf 'HEAD must match pushed tag v%s and origin/stable before installation.\n' "$version" >&2
    return 1
  }
}

check_release_source() {
  detect_source_mode
  if [[ "$SOURCE_MODE" == "git" ]]; then
    check_git_checkout
  else
    node scripts/verify-package-source.mjs
  fi
}

check_package_archive() {
  [[ "$SOURCE_MODE" == "package" ]] || return 0
  local version archive checksum expected actual root staging entries entry relative extracted current
  local archive_files source_files differences mutable
  version="$(tr -d '\r\n' < VERSION)"
  archive="$PACKAGE_ARCHIVE"
  if [[ -z "$archive" ]]; then
    archive="$(dirname "$SOURCE_DIR")/wfl-codex-desktop-v${version}.tar.gz"
  fi
  checksum="${PACKAGE_CHECKSUM:-${archive}.sha256}"
  [[ -f "$archive" ]] || {
    printf 'Release archive not found: %s\nUse --archive PATH to select the downloaded package.\n' "$archive" >&2
    return 1
  }
  [[ -f "$checksum" ]] || {
    printf 'Release checksum not found: %s\nDownload the matching .sha256 file before installation.\n' "$checksum" >&2
    return 1
  }
  expected="$(awk 'NR == 1 { print $1 }' "$checksum")"
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || {
    printf 'Invalid SHA-256 file: %s\n' "$checksum" >&2
    return 1
  }
  actual="$(sha256sum "$archive" | awk '{ print $1 }')"
  [[ "${actual,,}" == "${expected,,}" ]] || {
    printf 'Release archive SHA-256 mismatch; installation stopped.\n' >&2
    return 1
  }
  root="wfl-codex-desktop-v${version}"
  tar -tzf "$archive" | awk -v root="$root" '
    BEGIN { ok = 1 }
    /^\// || /(^|\/)\.\.($|\/)/ || /[[:cntrl:]]/ { ok = 0 }
    $0 != root "/" && index($0, root "/") != 1 { ok = 0 }
    END { exit ok ? 0 : 1 }
  ' || {
    printf 'Release archive contains an unexpected or unsafe path.\n' >&2
    return 1
  }
  tar -tvzf "$archive" | awk '
    BEGIN { ok = 1 }
    {
      type = substr($1, 1, 1)
      if (type != "d" && type != "-") ok = 0
    }
    END { exit ok ? 0 : 1 }
  ' || {
    printf 'Release archive may contain only regular files and directories.\n' >&2
    return 1
  }

  staging="$(mktemp -d /tmp/wfl-codex-package-verify.XXXXXX)"
  if ! tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$staging"; then
    rm -rf -- "$staging"
    printf 'Unable to extract the verified release archive for content comparison.\n' >&2
    return 1
  fi
  if [[ ! -d "$staging/$root" ]]; then
    rm -rf -- "$staging"
    printf 'Release archive has no expected root directory: %s\n' "$root" >&2
    return 1
  fi
  entries="$(tar -tzf "$archive")"
  while IFS= read -r entry; do
    [[ -n "$entry" && "$entry" != */ ]] || continue
    relative="${entry#"$root/"}"
    extracted="$staging/$root/$relative"
    current="$SOURCE_DIR/$relative"
    if [[ -L "$current" || ! -f "$current" ]] || ! cmp -s -- "$extracted" "$current"; then
      rm -rf -- "$staging"
      printf 'Installed source does not match the verified release archive: %s\n' "$relative" >&2
      return 1
    fi
  done <<<"$entries"

  # Compare both directions. Checking only archive -> source would allow a
  # caller to place an extra executable/module in an extracted package and
  # have it run during npm scripts or a later release. Runtime/user data and
  # dependency trees are intentionally excluded because the release builder
  # excludes those paths and they are regenerated or preserved locally.
  archive_files="$(mktemp)"
  source_files="$(mktemp)"
  differences="$(mktemp)"
  find -P "$staging/$root" -xdev -type f -printf '%P\0' | sort -z >"$archive_files"
  local source_find_expression=( -P "$SOURCE_DIR" -xdev )
  for mutable in \
    "$SOURCE_DIR/.git" \
    "$SOURCE_DIR/.codex-desktop" \
    "$SOURCE_DIR/.codex-runtime" \
    "$SOURCE_DIR/.codex-uploads" \
    "$SOURCE_DIR/generated-images" \
    "$SOURCE_DIR/archive" \
    "$SOURCE_DIR/backups" \
    "$SOURCE_DIR/node_modules" \
    "$SOURCE_DIR/test-results" \
    "$SOURCE_DIR/coverage"; do
    source_find_expression+=( -path "$mutable" -prune -o )
  done
  source_find_expression+=(
    -name .env -prune -o
    -name '*.log' -prune -o
    -name '*.recovery-backup-*' -prune -o
    -type f -printf '%P\0'
  )
  find "${source_find_expression[@]}" | sort -z >"$source_files"
  comm -3 -z "$archive_files" "$source_files" >"$differences"
  if [[ -s "$differences" ]]; then
    printf 'Installed source has files that do not exactly match the verified release archive:\n' >&2
    tr '\0' '\n' <"$differences" | head -n 20 >&2
    rm -f -- "$archive_files" "$source_files" "$differences"
    rm -rf -- "$staging"
    return 1
  fi
  rm -f -- "$archive_files" "$source_files" "$differences"
  rm -rf -- "$staging"
  printf 'Verified package archive SHA-256: %s\n' "$actual"
}

check_secure_source_tree() {
  local current="$SOURCE_DIR" mode unsafe mutable
  [[ -d "$current" && ! -L "$current" ]] || {
    printf 'The installation source must be a real directory.\n' >&2
    return 1
  }
  while [[ "$current" != "/" ]]; do
    [[ -d "$current" ]] || {
      printf 'Installation path component is not a directory: %s\n' "$current" >&2
      return 1
    }
    [[ "$(stat -c '%u' -- "$current")" == "0" ]] || {
      printf 'Installation path must be owned by root: %s\n' "$current" >&2
      return 1
    }
    mode="$(stat -c '%a' -- "$current")"
    mode="${mode: -3}"
    [[ ! "${mode:1:1}" =~ [2367] && ! "${mode:2:1}" =~ [2367] ]] || {
      printf 'Installation path must not be group- or world-writable: %s\n' "$current" >&2
      return 1
    }
    current="$(dirname -- "$current")"
  done
  for mutable in "$STATE_DIR" "$RUNTIME_DIR"; do
    check_secure_path_parent "$mutable"
    if [[ -e "$mutable" || -L "$mutable" ]]; then
      [[ -d "$mutable" && ! -L "$mutable" ]] || {
        printf 'Mutable installation state must be a real directory: %s\n' "$mutable" >&2
        return 1
      }
      check_secure_directory "$mutable"
    fi
  done

  local find_expression=( -P "$SOURCE_DIR" -xdev )
  for mutable in "$STATE_DIR" "$RUNTIME_DIR"; do
    case "$mutable" in
      "$SOURCE_DIR"/*) find_expression+=( -path "$mutable" -prune -o ) ;;
    esac
  done
  for mutable in \
    "$SOURCE_DIR/node_modules" \
    "$SOURCE_DIR/.codex-uploads" \
    "$SOURCE_DIR/generated-images" \
    "$SOURCE_DIR/archive" \
    "$SOURCE_DIR/backups" \
    "$SOURCE_DIR/test-results" \
    "$SOURCE_DIR/coverage"; do
    find_expression+=( -path "$mutable" -prune -o )
  done
  check_secure_directory "$SOURCE_DIR/node_modules"
  unsafe="$(find "${find_expression[@]}" \( ! -user root -o -perm /022 -o -type l \) -print -quit)"
  [[ -z "$unsafe" ]] || {
    printf 'Installation source contains a non-root-owned, writable, or symbolic-link entry: %s\n' "$unsafe" >&2
    return 1
  }
}

check_secure_path_parent() {
  local current="$1" mode
  while [[ ! -e "$current" && ! -L "$current" && "$current" != "/" ]]; do
    current="$(dirname -- "$current")"
  done
  while [[ "$current" != "/" ]]; do
    [[ -d "$current" && ! -L "$current" ]] || {
      printf 'Installation path component is not a real directory: %s\n' "$current" >&2
      return 1
    }
    [[ "$(stat -c '%u' -- "$current")" == "0" ]] || {
      printf 'Installation state path must be owned by root: %s\n' "$current" >&2
      return 1
    }
    mode="$(stat -c '%a' -- "$current")"
    mode="${mode: -3}"
    [[ ! "${mode:1:1}" =~ [2367] && ! "${mode:2:1}" =~ [2367] ]] || {
      printf 'Installation state path must not be group- or world-writable: %s\n' "$current" >&2
      return 1
    }
    current="$(dirname -- "$current")"
  done
}

check_secure_directory() {
  local directory="$1" mode
  [[ -e "$directory" || -L "$directory" ]] || return 0
  [[ -d "$directory" && ! -L "$directory" ]] || {
    printf 'Expected a real directory: %s\n' "$directory" >&2
    return 1
  }
  [[ "$(stat -c '%u' -- "$directory")" == "0" ]] || {
    printf 'Directory must be owned by root: %s\n' "$directory" >&2
    return 1
  }
  mode="$(stat -c '%a' -- "$directory")"
  mode="${mode: -3}"
  [[ ! "${mode:1:1}" =~ [2367] && ! "${mode:2:1}" =~ [2367] ]] || {
    printf 'Directory must not be group- or world-writable: %s\n' "$directory" >&2
    return 1
  }
}

check_auth_record() {
  local auth_file="$STATE_DIR/auth.json" mode
  [[ -f "$auth_file" && ! -L "$auth_file" && -s "$auth_file" ]] || {
    printf 'Password record is missing: %s\n' "$auth_file" >&2
    return 1
  }
  [[ "$(stat -c '%u' -- "$auth_file")" == "0" ]] || {
    printf 'Password record must be owned by root: %s\n' "$auth_file" >&2
    return 1
  }
  mode="$(stat -c '%a' -- "$auth_file")"
  [[ "${mode: -3}" == "600" ]] || {
    printf 'Password record must have mode 0600: %s\n' "$auth_file" >&2
    return 1
  }
  node --input-type=module -e '
    import { loadAuth } from "./lib/auth.mjs";
    const record = await loadAuth(process.argv[1]);
    if (!record) throw new Error("missing authentication record");
  ' "$auth_file"
}

check_disk_space() {
  local available_kb minimum_kb=2097152
  available_kb="$(df -Pk "$SOURCE_DIR" | awk 'NR == 2 { print $4 }')"
  [[ "$available_kb" =~ ^[0-9]+$ ]] && ((available_kb >= minimum_kb)) || {
    printf 'At least 2 GiB of free disk space is required for dependencies and rollback slots.\n' >&2
    return 1
  }
}

validate_git_remote() {
  [[ -n "$GIT_REMOTE" ]] || return 0
  [[ "$GIT_REMOTE" != *[$'\r\n\t ']* ]] || {
    printf 'Git remote must not contain whitespace.\n' >&2
    return 1
  }
  case "$GIT_REMOTE" in
    ssh://*|git@*:*) ;;
    *) printf 'Git remote must use SSH with a read-only deploy key.\n' >&2; return 1 ;;
  esac
}

check_requested_git_remote() {
  [[ "$SOURCE_MODE" == "git" && -n "$GIT_REMOTE" ]] || return 0
  local configured
  configured="$(git remote get-url origin)"
  [[ "$configured" == "$GIT_REMOTE" ]] || {
    printf 'Configured origin does not match --git-remote. Refusing to rewrite repository credentials.\n' >&2
    return 1
  }
}

install_node_if_needed() {
  if check_node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then return; fi
  local installer log
  printf 'Installing Node.js 22 because a supported Node.js and npm were not found.\n'
  installer="$(mktemp)"
  log="$(mktemp)"
  if ! curl --connect-timeout 5 --max-time 30 --retry 1 --retry-delay 1 --retry-max-time 35 \
      -fsSL https://deb.nodesource.com/setup_22.x -o "$installer" \
      || ! verify_download_sha256 "$installer" "$NODE_SOURCE_SETUP_SHA256"; then
    rm -f -- "$installer" "$log"
    return 1
  fi
  if ! bash "$installer" >"$log" 2>&1; then
    cat "$log" >&2
    rm -f "$installer" "$log"
    return 1
  fi
  rm -f "$installer" "$log"
  "${APT_GET[@]}" install -y nodejs
  hash -r
  check_node
  check_command npm
}

prerequisites_ready() {
  local command_name
  [[ -s /etc/ssl/certs/ca-certificates.crt ]] || return 1
  for command_name in bwrap curl ffmpeg git gpg ssh tar flock timeout findmnt setquota setfacl systemd-analyze xauth x11vnc xclip xdotool Xvfb; do
    command -v "$command_name" >/dev/null 2>&1 || return 1
  done
  check_node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1
}

install_codex_if_needed() {
  validate_codex_cli_version
  if codex_cli_capabilities_ready && codex_cli_meets_baseline; then
    printf 'Official Codex CLI is already installed: %s\n' "$(codex --version 2>/dev/null || printf 'version unknown')"
    return 0
  fi

  local installer
  installer="$(mktemp)"
  printf 'Downloading the official Codex installer with a bounded timeout.\n'
  if curl --connect-timeout 5 --max-time 20 --retry 1 --retry-delay 1 --retry-max-time 25 -fsSL \
      https://chatgpt.com/codex/install.sh -o "$installer" \
      && verify_download_sha256 "$installer" "$CODEX_INSTALLER_SHA256" \
      && CODEX_NON_INTERACTIVE=1 sh "$installer"; then
    hash -r
  else
    printf 'The official download endpoint failed its pinned verification; falling back to the configured official npm package.\n' >&2
  fi
  rm -f "$installer"

  if ! codex_cli_capabilities_ready || ! codex_cli_meets_baseline; then
    npm install --global "@openai/codex@${CODEX_CLI_VERSION}" --no-audit --no-fund
    hash -r
  fi
  codex_cli_capabilities_ready && codex_cli_meets_baseline || {
    printf 'Installed Codex CLI does not provide the required app-server capabilities or baseline version %s.\n' "$CODEX_CLI_VERSION" >&2
    return 1
  }
  printf 'Official Codex CLI is ready: %s\n' "$(codex --version)"
}

install_playwright_dependencies_if_needed() {
  local state_dir="${CODEX_DESKTOP_RUNTIME_DIR:-.codex-runtime}/install" marker log fingerprint
  marker="$state_dir/playwright-dependencies-ready"
  check_secure_path_parent "$state_dir"
  if [[ -e "$state_dir" || -L "$state_dir" ]]; then
    check_secure_directory "$state_dir"
  else
    install -d -m 0755 -- "$state_dir"
    check_secure_directory "$state_dir"
  fi
  [[ ! -L "$marker" && ( ! -e "$marker" || -f "$marker" ) ]] || {
    printf 'Playwright dependency marker is not a regular file: %s\n' "$marker" >&2
    return 1
  }
  if [[ -e "$marker" ]]; then
    [[ "$(stat -c '%u' -- "$marker")" == "0" && "$(stat -c '%a' -- "$marker")" == "644" ]] || {
      printf 'Playwright dependency marker must be root-owned with mode 0644: %s\n' "$marker" >&2
      return 1
    }
  fi
  fingerprint="$(playwright_dependency_fingerprint)"
  if [[ -s "$marker" && "$(<"$marker")" == "$fingerprint" ]]; then
    printf 'Playwright operating-system dependencies are already ready; skipping APT.\n'
    return 0
  fi

  printf 'Installing Playwright operating-system dependencies.\n'
  log="$(mktemp)"
  if ! npx playwright install-deps chromium >"$log" 2>&1; then
    cat "$log" >&2
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
  local temporary_marker
  temporary_marker="$(mktemp "$state_dir/.playwright-dependencies-ready.XXXXXX")"
  if ! { printf '%s\n' "$fingerprint" >"$temporary_marker" && chmod 0644 "$temporary_marker"; }; then
    rm -f -- "$temporary_marker"
    return 1
  fi
  sync_file_and_directory "$temporary_marker" "$state_dir"
  mv -f -- "$temporary_marker" "$marker"
  chmod 0644 "$marker"
  sync_directory "$state_dir"
  printf 'Playwright operating-system dependencies are ready.\n'
}

playwright_dependency_fingerprint() {
  local os_id="unknown" os_version="unknown" architecture playwright_version lock_hash node_version
  if [[ -r /etc/os-release ]]; then
    . /etc/os-release
    os_id="${ID:-unknown}"
    os_version="${VERSION_ID:-unknown}"
  fi
  architecture="$(uname -m)"
  playwright_version="$(node -p 'require("./node_modules/playwright/package.json").version')"
  lock_hash="$(sha256sum package-lock.json | awk '{ print $1 }')"
  node_version="$(node --version)"
  PLAYWRIGHT_OS_ID="$os_id" \
    PLAYWRIGHT_OS_VERSION="$os_version" \
    PLAYWRIGHT_ARCHITECTURE="$architecture" \
    PLAYWRIGHT_VERSION="$playwright_version" \
    PLAYWRIGHT_LOCK_HASH="$lock_hash" \
    PLAYWRIGHT_NODE_VERSION="$node_version" \
    node --input-type=module -e '
      process.stdout.write(`${JSON.stringify({
        schema: 1,
        os: process.env.PLAYWRIGHT_OS_ID,
        osVersion: process.env.PLAYWRIGHT_OS_VERSION,
        architecture: process.env.PLAYWRIGHT_ARCHITECTURE,
        playwright: process.env.PLAYWRIGHT_VERSION,
        packageLockSha256: process.env.PLAYWRIGHT_LOCK_HASH,
        node: process.env.PLAYWRIGHT_NODE_VERSION,
      })}\n`);
    '
}

install_playwright_browser() {
  printf 'Checking and preparing the persistent Playwright Chromium cache.\n'
  CODEX_DESKTOP_RUNTIME_DIR="$RUNTIME_DIR" \
    node scripts/ensure-playwright-browser.mjs --install
}

configure_provider() {
  if ! printf '%s\0' "$PROVIDER_NAME" "$PROVIDER_BASE_URL" "$PROVIDER_MODEL" "$PROVIDER_API_KEY" \
      | node scripts/configure-provider.mjs; then
    PROVIDER_API_KEY=""
    return 1
  fi
  PROVIDER_API_KEY=""
}

bootstrap_package_git() {
  [[ "$SOURCE_MODE" == "package" && -n "$GIT_REMOTE" ]] || return 0
  node scripts/bootstrap-package-git.mjs --source "$SOURCE_DIR" --remote "$GIT_REMOTE"
  SOURCE_MODE="git"
  check_git_checkout
  printf 'Prepared read-only Git metadata for future synchronized updates.\n'
}

installation_failed() {
  local status=$?
  PROVIDER_API_KEY=""
  printf '\nInstallation stopped during: %s\n' "$CURRENT_STEP" >&2
  if [[ "$CURRENT_STEP" == "configuring browser access" ]]; then
    printf 'The application is already installed and remains available on http://127.0.0.1:4317.\n' >&2
    printf 'Fix the access setting and rerun only that wizard: sudo bash install.sh --configure-access\n' >&2
    exit "$status"
  fi
  printf 'The previous active service was not intentionally stopped. Fix the reported error and rerun: sudo bash install.sh\n' >&2
  printf 'After service installation, inspect details with: journalctl -u "wfl-codex-*" --since "15 minutes ago"\n' >&2
  exit "$status"
}

if ((CHECK_ONLY)); then
  validate_install_paths
  check_command git
  check_command node
  check_command npm
  check_command systemctl
  check_command systemd-analyze
  check_node
  [[ -d /run/systemd/system ]] || {
    printf 'A systemd-based server is required.\n' >&2
    exit 1
  }
  [[ -r /etc/os-release ]] || {
    printf 'Unable to identify the operating system.\n' >&2
    exit 1
  }
  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu) ;;
    *) printf 'Automatic installation currently supports Debian and Ubuntu only (found %s).\n' "${ID:-unknown}" >&2; exit 1 ;;
  esac
  check_secure_source_tree
  detect_source_mode
  check_package_archive
  check_release_source
  npm run setup:check
  CODEX_DESKTOP_QUICK_CHECK_OFFLINE=1 npm run update:quick-check
  check_auth_record
  systemd_units=(
    /etc/systemd/system/wfl-codex-desktop-gateway.service
    /etc/systemd/system/wfl-codex-desktop-backend@.service
    /etc/systemd/system/wfl-codex-desktop-restore-recovery.service
    /etc/systemd/system/wfl-codex-desktop-codex-recovery.service
    /etc/systemd/system/wfl-codex-desktop-deployment-recovery.service
  )
  doctor_args=(--main-only)
  if [[ -f /etc/systemd/system/wfl-codex-desktop-rescue.service ]]; then
    systemd_units+=(/etc/systemd/system/wfl-codex-desktop-rescue.service)
    doctor_args=(--rescue)
  elif [[ -e "$RUNTIME_DIR/rescue-active-port" || -L "$RUNTIME_DIR/rescue-slot" ]] \
      || rescue_component_exists; then
    printf 'Rescue state exists but its systemd unit is missing; refusing to infer or replace the frozen rescue component.\n' >&2
    exit 1
  fi
  systemd-analyze verify "${systemd_units[@]}"
  node scripts/server-doctor.mjs "${doctor_args[@]}"
  if ((SKIP_LOGIN)); then
    printf 'Codex authorization check skipped by request.\n'
  elif provider_is_configured || codex login status >/dev/null 2>&1; then
    printf 'Codex authorization: configured.\n'
  else
    printf 'Codex authorization: deferred; configure it in the API provider center before starting a conversation.\n'
  fi
  printf 'Server prerequisites are ready for v%s (%s source).\n' "$(tr -d '\r\n' < VERSION)" "$SOURCE_MODE"
  exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
  printf 'Run the installer as root: sudo bash install.sh\n' >&2
  exit 1
fi
if [[ ! -d /run/systemd/system ]]; then
  printf 'A systemd-based server is required.\n' >&2
  exit 1
fi
if [[ ! -r /etc/os-release ]]; then
  printf 'Unable to identify the operating system.\n' >&2
  exit 1
fi
. /etc/os-release
case "${ID:-}" in
  debian|ubuntu) ;;
  *) printf 'Automatic installation currently supports Debian and Ubuntu only (found %s).\n' "${ID:-unknown}" >&2; exit 1 ;;
esac
[[ "$SOURCE_DIR" != *[$'\r\n\t ']* ]] || {
  printf 'The installation path must not contain spaces or control characters.\n' >&2
  exit 1
}
validate_install_paths
determine_rescue_install_mode
export CODEX_DESKTOP_STATE_DIR="$STATE_DIR"
export CODEX_DESKTOP_RUNTIME_DIR="$RUNTIME_DIR"

exec 9>/run/lock/wfl-codex-desktop-install.lock
flock -n 9 || {
  printf 'Another WFL Codex Desktop installation or service preparation is already running.\n' >&2
  exit 1
}

if ((CONFIGURE_ACCESS_ONLY)); then
  check_secure_source_tree
  run_access_wizard
  exit 0
fi

detect_source_mode
check_secure_source_tree
check_disk_space
prepare_package_inputs
validate_git_remote
check_package_archive
if [[ "$SOURCE_MODE" == "git" ]] || command -v node >/dev/null 2>&1; then
  check_release_source
fi
prepare_install_wizard
trap installation_failed ERR

CURRENT_STEP="installing operating-system prerequisites"
printf '[1/10] Installing operating-system prerequisites\n'
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export APT_LISTCHANGES_FRONTEND=none
export NO_COLOR=1
APT_GET=(apt-get -o Dpkg::Use-Pty=0 -o APT::Color=0 -q)
if prerequisites_ready; then
  printf 'Required OS tools, Node.js, and npm are already ready; skipping APT.\n'
else
  "${APT_GET[@]}" update -qq
  "${APT_GET[@]}" install -y acl apparmor bubblewrap ca-certificates curl ffmpeg git gnupg openssh-client quota tar util-linux x11vnc xauth xclip xdotool xvfb
  install_node_if_needed
fi

CURRENT_STEP="verifying the release source"
printf '[2/10] Verifying the release archive, manifest, tag, and update source\n'
check_package_archive
bootstrap_package_git
check_requested_git_remote
check_release_source

CURRENT_STEP="installing the official Codex CLI"
printf '[3/10] Installing the official Codex CLI when needed\n'
install_codex_if_needed

CURRENT_STEP="installing locked application dependencies"
printf '[4/10] Installing locked application and browser dependencies\n'
printf 'Installing platform-specific optional packages required by image processing.\n'
printf 'Preserving an existing bundled Claude Code installation before npm ci.\n'
node scripts/migrate-claude-component.mjs
npm ci
install_playwright_dependencies_if_needed
install_playwright_browser
npm run setup:check

CURRENT_STEP="configuring Codex authorization"
printf '[5/10] Configuring Codex authorization for this server\n'
case "$CODEX_AUTH_MODE" in
  official)
    if ! codex login status >/dev/null 2>&1; then codex login --device-auth; fi
    ;;
  provider) configure_provider ;;
  preserve-provider) printf 'Existing encrypted API provider preserved.\n' ;;
  later) printf 'Codex authorization deferred; configure it in the API provider center.\n' ;;
  *) printf 'Unknown Codex authorization mode: %s\n' "$CODEX_AUTH_MODE" >&2; exit 1 ;;
esac

CURRENT_STEP="preparing password protection and services"
printf '[6/10] Preparing password protection and portable systemd units\n'
if [[ ! -s "$STATE_DIR/auth.json" ]]; then
  if [[ "$PASSWORD_MODE" == "custom" ]]; then
    CODEX_DESKTOP_AUTH_FILE="$STATE_DIR/auth.json" \
      CODEX_DESKTOP_RUNTIME_DIR="$RUNTIME_DIR" \
      CODEX_DESKTOP_USERNAME="$OWNER_USERNAME" CODEX_DESKTOP_NEW_PASSWORD="$CUSTOM_PASSWORD" npm run set-password
    CUSTOM_PASSWORD=""
  else
    CODEX_DESKTOP_AUTH_FILE="$STATE_DIR/auth.json" \
      CODEX_DESKTOP_RUNTIME_DIR="$RUNTIME_DIR" \
      CODEX_DESKTOP_USERNAME="$OWNER_USERNAME" npm run set-password
  fi
else
  printf 'Existing password record preserved.\n'
fi
CODEX_DESKTOP_STATE_DIR="$STATE_DIR" CODEX_DESKTOP_RUNTIME_DIR="$RUNTIME_DIR" \
  node scripts/sync-rescue-credentials.mjs
CODEX_DESKTOP_INSTALL_LOCK_HELD=1 CODEX_DESKTOP_STATE_DIR="$STATE_DIR" CODEX_DESKTOP_RUNTIME_DIR="$RUNTIME_DIR" \
  node scripts/install-service-units.mjs --install-system --main-only

CURRENT_STEP="running the checked blue-green release"
printf '[7/10] Running the durable checked release\n'
release_args=(--wait)
if [[ "$SOURCE_MODE" == "package" ]]; then release_args+=(--package-source); fi
CODEX_DESKTOP_QUICK_CHECK_OFFLINE=1 npm run update:quick-check
if [[ "$SOURCE_MODE" == "package" ]]; then
  precheck_commit="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(".codex-package.json", "utf8")).sourceCommit)')"
else
  precheck_commit="$(git rev-parse HEAD)"
fi
CODEX_DESKTOP_PRECHECK_COMMIT="$precheck_commit" CODEX_DESKTOP_PRECHECK_KIND=package \
  node scripts/release.mjs "${release_args[@]}"

if ((INITIAL_RESCUE_INSTALL)); then
  CURRENT_STEP="installing the initial independent rescue window"
  printf 'Initializing the independent rescue window from the verified active release.\n'
  CODEX_DESKTOP_INSTALL_LOCK_HELD=1 CODEX_DESKTOP_STATE_DIR="$STATE_DIR" CODEX_DESKTOP_RUNTIME_DIR="$RUNTIME_DIR" \
    node scripts/install-service-units.mjs --install-system --include-rescue
else
  printf 'Existing rescue window preserved; ordinary installation path is main-only.\n'
fi

CURRENT_STEP="verifying gateway, backend, Codex, and authentication"
printf '[8/10] Verifying gateway, backend, Codex, and authentication state\n'
node scripts/server-doctor.mjs --rescue

CURRENT_STEP="configuring browser access"
printf '[9/10] Configuring browser access\n'
run_access_wizard

CURRENT_STEP="recording installation result"
printf '[10/10] Installation completed successfully\n'
trap - ERR
printf '\nInstallation complete. Ports 4317-4321 remain private on loopback.\n'
if [[ "$SOURCE_MODE" == "package" ]]; then
  printf 'This offline package has no Git remote. Run sudo npm run server:updates later to configure a read-only Deploy Key.\n'
fi
printf '%s\n' \
  'Post-install settings remain available without rerunning the installer:' \
  '  sudo npm run server:access   # domain, Cloudflare Tunnel, or local access' \
  '  sudo npm run server:password # single-user browser password' \
  '  sudo npm run server:updates  # read-only Git update source'
