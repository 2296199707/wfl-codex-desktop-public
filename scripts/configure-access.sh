#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ACCESS_MODE=""
HOSTNAME_VALUE=""
REVERSE_PROXY=""
CERTBOT_EMAIL=""
PREVIEW_BASE_DOMAIN=""
PREVIEW_SLOT_COUNT="0"
INTERACTIVE=-1
STATE_FILE="${WFL_ACCESS_STATE_FILE:-$SOURCE_DIR/.codex-runtime/access.json}"
ETC_DIR="${WFL_ACCESS_ETC_DIR:-/etc}"
SKIP_PUBLIC_CHECK="${WFL_ACCESS_SKIP_PUBLIC_CHECK:-0}"
CLOUDFLARE_MAIN_GPG_SHA256="1bd95f4082b320d541bee351560fc2765aa9f9cd8efa4c9e32135e63f252721d"

usage() {
  printf '%s\n' \
    "Usage: sudo bash scripts/configure-access.sh [options]" \
    "" \
    "Guides access setup while keeping ports 4317-4321 bound to loopback." \
    "" \
    "Options:" \
    "  --mode MODE             existing-domain, cloudflare, or local" \
    "  --hostname HOST         Public hostname for domain or tunnel modes" \
    "  --reverse-proxy MODE    existing or nginx (existing-domain only)" \
    "  --email ADDRESS         Certbot address for managed Nginx HTTPS" \
    "  --preview-base-domain HOST  Optional fixed preview base domain (explicit opt-in)" \
    "  --preview-slots COUNT   Number of preview-N hosts to include (1-16)" \
    "  --non-interactive       Never prompt; omitted values use safe defaults" \
    "  -h, --help              Show this help" \
    "" \
    "For non-interactive Cloudflare setup, pass the token only through" \
    "WFL_CLOUDFLARE_TUNNEL_TOKEN. Never put it in command arguments."
}

while (($#)); do
  case "$1" in
    --mode|--hostname|--reverse-proxy|--email|--preview-base-domain|--preview-slots)
      option="$1"
      (($# >= 2)) || { printf '%s requires a value.\n' "$option" >&2; exit 2; }
      case "$option" in
        --mode) ACCESS_MODE="$2" ;;
        --hostname) HOSTNAME_VALUE="$2" ;;
        --reverse-proxy) REVERSE_PROXY="$2" ;;
        --email) CERTBOT_EMAIL="$2" ;;
        --preview-base-domain) PREVIEW_BASE_DOMAIN="$2" ;;
        --preview-slots) PREVIEW_SLOT_COUNT="$2" ;;
      esac
      shift 2
      ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if ((INTERACTIVE < 0)); then
  if [[ -t 0 && -t 1 ]]; then INTERACTIVE=1; else INTERACTIVE=0; fi
fi

if [[ "${WFL_ACCESS_LOCK_HELD:-0}" != "1" && "${EUID}" -eq 0 ]]; then
  exec 8>/run/lock/wfl-codex-desktop-install.lock
  flock -n 8 || {
    printf 'Another WFL Codex Desktop installation or access configuration is already running.\n' >&2
    exit 1
  }
fi

[[ "$STATE_FILE" == /* && "$STATE_FILE" != *[$'\r\n\t ']* && "$STATE_FILE" != *..* ]] || {
  printf 'WFL_ACCESS_STATE_FILE must be an absolute path without whitespace, control characters, or .. components.\n' >&2
  exit 1
}
[[ "$ETC_DIR" == /* && "$ETC_DIR" != *[$'\r\n\t ']* && "$ETC_DIR" != *..* ]] || {
  printf 'WFL_ACCESS_ETC_DIR must be an absolute path without whitespace, control characters, or .. components.\n' >&2
  exit 1
}
check_safe_existing_path() {
  local target="$1" current mode
  current="$target"
  while [[ ! -e "$current" && ! -L "$current" && "$current" != "/" ]]; do
    current="$(dirname -- "$current")"
  done
  while [[ "$current" != "/" ]]; do
    [[ -d "$current" && ! -L "$current" ]] || {
      printf 'Access configuration path must contain only real directories: %s\n' "$current" >&2
      return 1
    }
    if [[ "${EUID}" -eq 0 && "${WFL_ACCESS_TEST_MODE:-0}" != "1" ]]; then
      [[ "$(stat -c '%u' -- "$current")" == "0" ]] || {
        printf 'Access configuration path must be root-owned: %s\n' "$current" >&2
        return 1
      }
      mode="$(stat -c '%a' -- "$current")"
      mode="${mode: -3}"
      [[ ! "${mode:1:1}" =~ [2367] && ! "${mode:2:1}" =~ [2367] ]] || {
        printf 'Access configuration path must not be group- or world-writable: %s\n' "$current" >&2
        return 1
      }
    fi
    current="$(dirname -- "$current")"
  done
}

ensure_real_directory() {
  local directory="$1" mode="$2"
  check_safe_existing_path "$directory"
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" ]] || {
      printf 'Expected a real directory: %s\n' "$directory" >&2
      return 1
    }
  else
    mkdir -p -- "$directory"
  fi
  [[ -d "$directory" && ! -L "$directory" ]] || {
    printf 'Expected a real directory: %s\n' "$directory" >&2
    return 1
  }
  chmod "$mode" "$directory"
}

sync_directory() {
  node -e '
    const fs = require("fs");
    const fd = fs.openSync(process.argv[1], "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  ' "$1"
}

check_safe_existing_path "$ETC_DIR"
check_safe_existing_path "$(dirname "$STATE_FILE")"
[[ ! -L "$STATE_FILE" ]] || {
  printf 'Access state must not be a symbolic link: %s\n' "$STATE_FILE" >&2
  exit 1
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

validate_mode() {
  case "$ACCESS_MODE" in
    existing-domain|cloudflare|local) ;;
    *) printf 'Access mode must be existing-domain, cloudflare, or local.\n' >&2; return 1 ;;
  esac
}

validate_hostname() {
  [[ "$HOSTNAME_VALUE" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || {
    printf '请输入不带 https://、端口或路径的有效域名。\n' >&2
    return 1
  }
  HOSTNAME_VALUE="${HOSTNAME_VALUE,,}"
}

validate_email() {
  [[ "$CERTBOT_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || {
    printf 'Certbot email address is invalid.\n' >&2
    return 1
  }
}

validate_preview_settings() {
  if [[ -z "$PREVIEW_BASE_DOMAIN" ]]; then
    PREVIEW_SLOT_COUNT="0"
    return 0
  fi
  [[ "$PREVIEW_BASE_DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || {
    printf '预览基础域名格式无效。\n' >&2
    return 1
  }
  PREVIEW_BASE_DOMAIN="${PREVIEW_BASE_DOMAIN,,}"
  [[ "$PREVIEW_SLOT_COUNT" =~ ^[0-9]+$ && "$PREVIEW_SLOT_COUNT" -ge 1 && "$PREVIEW_SLOT_COUNT" -le 16 ]] || {
    printf '预览槽位必须是 1-16 的整数。\n' >&2
    return 1
  }
}

preview_server_names() {
  local index
  PREVIEW_SERVER_NAMES="$HOSTNAME_VALUE"
  [[ -n "$PREVIEW_BASE_DOMAIN" ]] || return 0
  for ((index = 1; index <= PREVIEW_SLOT_COUNT; index += 1)); do
    PREVIEW_SERVER_NAMES+=" preview-${index}.${PREVIEW_BASE_DOMAIN}"
  done
}

require_root() {
  if [[ "${EUID}" -eq 0 ]]; then return 0; fi
  if [[ "${WFL_ACCESS_TEST_MODE:-0}" == "1" && "$ETC_DIR" != "/etc" ]]; then return 0; fi
  printf '%s requires root.\n' "$1" >&2
  return 1
}

choose_mode() {
  [[ -z "$ACCESS_MODE" ]] || return 0
  if ((!INTERACTIVE)); then ACCESS_MODE="local"; return 0; fi
  local choice
  prompt_choice choice "请选择浏览器访问方式，此项不会自动替你决定：" "" \
    "  1. 域名已解析到本机，现在核对或配置 80/443 与 HTTPS" \
    "  2. 本机无法开放 80/443，现在配置 Cloudflare Tunnel" \
    "  3. 长期仅用本机浏览器或 SSH 转发，本次不配置任何域名"
  case "$choice" in
    1) ACCESS_MODE="existing-domain" ;;
    2) ACCESS_MODE="cloudflare" ;;
    3) ACCESS_MODE="local" ;;
  esac
}

check_local_gateway() {
  if command -v curl >/dev/null 2>&1; then
    local status
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 http://127.0.0.1:4317/ || true)"
    case "$status" in
      200|401) ;;
      *) printf 'Local gateway check failed on http://127.0.0.1:4317 (HTTP %s).\n' "${status:-unavailable}" >&2; return 1 ;;
    esac
  fi
}

record_state() {
  local managed_by="$1"
  ensure_real_directory "$(dirname "$STATE_FILE")" 0700
  [[ ! -L "$STATE_FILE" ]] || {
    printf 'Access state must not be a symbolic link: %s\n' "$STATE_FILE" >&2
    return 1
  }
  node -e '
    const crypto = require("crypto");
    const fs = require("fs");
    const [file, mode, hostname, managedBy, previewBaseDomain, previewSlotCount] = process.argv.slice(1);
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const content = `${JSON.stringify({
      mode,
      hostname: hostname || null,
      managedBy,
      previewBaseDomain: previewBaseDomain || null,
      previewSlotCount: Number(previewSlotCount) || 0,
      configuredAt: Date.now(),
    }, null, 2)}\n`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temporary, file);
      fs.chmodSync(file, 0o600);
      const directory = fs.openSync(require("path").dirname(file), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  ' "$STATE_FILE" "$ACCESS_MODE" "$HOSTNAME_VALUE" "$managed_by" "$PREVIEW_BASE_DOMAIN" "$PREVIEW_SLOT_COUNT"
}

verify_public_url() {
  [[ "$SKIP_PUBLIC_CHECK" == "1" || -z "$HOSTNAME_VALUE" ]] && return 0
  local status
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 15 "https://$HOSTNAME_VALUE/" || true)"
  case "$status" in
    200|401) printf 'Public HTTPS check passed: https://%s/ (HTTP %s)\n' "$HOSTNAME_VALUE" "$status" ;;
    *) printf '提示：公网地址暂未就绪（HTTP %s）。请检查 DNS、证书或等待解析生效。\n' "${status:-unavailable}" ;;
  esac
}

configure_local() {
  check_local_gateway
  if systemctl is-active --quiet cloudflared.service 2>/dev/null \
    || [[ -e "$ETC_DIR/nginx/sites-enabled/wfl-codex-desktop.conf" ]]; then
    printf '提示：检测到已有公网代理服务；本地模式不会自动停止或删除现有配置。\n'
  fi
  record_state "none"
  printf '\n未修改防火墙、反向代理或 Cloudflare。\n'
  printf '服务器本机打开：http://127.0.0.1:4317\n'
  printf 'Windows 远程访问：请在本地电脑的 PowerShell（不是服务器终端）运行：\n'
  printf '  ssh -N -L 4317:127.0.0.1:4317 -p <SSH端口> <SSH用户>@<服务器IP>\n'
  printf '保持 PowerShell 窗口运行，再在本地浏览器打开 http://127.0.0.1:4317\n'
}

install_nginx_dependencies() {
  if command -v nginx >/dev/null 2>&1 && command -v certbot >/dev/null 2>&1; then return 0; fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y nginx certbot python3-certbot-nginx
}

managed_nginx_https_ready() {
  local site_file="$ETC_DIR/nginx/sites-available/wfl-codex-desktop.conf"
  preview_server_names
  [[ -f "$site_file" && ! -L "$site_file" ]] \
    && grep -Fqx '# Managed by WFL Codex Desktop access wizard.' "$site_file" \
    && grep -Fq "server_name $PREVIEW_SERVER_NAMES;" "$site_file" \
    && grep -Eq 'listen[[:space:]]+443([[:space:]]|;).*ssl' "$site_file"
}

configure_managed_nginx() {
  require_root "Managed Nginx setup"
  install_nginx_dependencies
  preview_server_names

  local available_dir="$ETC_DIR/nginx/sites-available"
  local enabled_dir="$ETC_DIR/nginx/sites-enabled"
  local site_file="$available_dir/wfl-codex-desktop.conf"
  local enabled_file="$enabled_dir/wfl-codex-desktop.conf"
  local conflicts="" conflict
  if [[ -L "$site_file" ]]; then
    printf '向导站点路径是符号链接，拒绝覆盖：%s\n' "$site_file" >&2
    return 1
  fi
  if [[ -e "$site_file" ]] && ! grep -Fqx '# Managed by WFL Codex Desktop access wizard.' "$site_file"; then
    printf '向导站点文件已存在但不是本项目创建的，拒绝覆盖：%s\n' "$site_file" >&2
    return 1
  fi
  if [[ -e "$enabled_file" && ! -L "$enabled_file" ]]; then
    printf '启用目录中存在同名普通文件，拒绝覆盖：%s\n' "$enabled_file" >&2
    return 1
  fi
  if [[ -L "$enabled_file" && "$(readlink -f "$enabled_file" 2>/dev/null || true)" != "$site_file" ]]; then
    printf '启用目录中的同名链接指向其他站点，拒绝覆盖：%s\n' "$enabled_file" >&2
    return 1
  fi
  if [[ -d "$ETC_DIR/nginx" ]]; then
    conflicts="$(grep -Rsl --include='*.conf' -E "server_name[[:space:]]+${HOSTNAME_VALUE//./\\.}([[:space:];])" "$ETC_DIR/nginx" 2>/dev/null || true)"
    while IFS= read -r conflict; do
      [[ -z "$conflict" || "$conflict" == "$site_file" || "$conflict" == "$enabled_file" ]] && continue
      printf '域名已出现在其他 Nginx 配置中，向导不会覆盖：\n%s\n' "$conflict" >&2
      printf '请保留现有配置并重新选择“已有反向代理”。\n' >&2
      return 1
    done <<<"$conflicts"
  fi

  mkdir -p "$available_dir" "$enabled_dir"
  if managed_nginx_https_ready; then
    ln -sfn "$site_file" "$enabled_file"
    nginx -t
    systemctl enable --now nginx
    systemctl reload nginx
    record_state "nginx-certbot"
    printf '检测到向导已经配置 HTTPS，已保留证书和现有站点配置。\n'
    verify_public_url
    return 0
  fi

  validate_email
  local temporary
  temporary="$(mktemp)"
  sed "s/__WFL_SERVER_NAMES__/$PREVIEW_SERVER_NAMES/g" >"$temporary" <<'EOF'
# Managed by WFL Codex Desktop access wizard.
server {
    listen 80;
    listen [::]:80;
    server_name __WFL_SERVER_NAMES__;

    client_max_body_size 2g;

    location / {
        proxy_pass http://127.0.0.1:4317;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
  install -m 0644 "$temporary" "$site_file"
  rm -f "$temporary"
  ln -sfn "$site_file" "$enabled_file"
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
  local certbot_domains=(-d "$HOSTNAME_VALUE")
  if [[ -n "$PREVIEW_BASE_DOMAIN" ]]; then
    local index
    for ((index = 1; index <= PREVIEW_SLOT_COUNT; index += 1)); do
      certbot_domains+=(-d "preview-${index}.${PREVIEW_BASE_DOMAIN}")
    done
  fi
  certbot --nginx --non-interactive --agree-tos --redirect --email "$CERTBOT_EMAIL" "${certbot_domains[@]}"
  nginx -t
  systemctl reload nginx
  record_state "nginx-certbot"
  printf 'Nginx 与 HTTPS 已配置，源站仍只连接 127.0.0.1:4317。\n'
  if [[ -n "$PREVIEW_BASE_DOMAIN" ]]; then
    printf '固定预览域池已加入证书和 Nginx：preview-1..%s.%s；请回到管理员后台确认同一 Origin。\n' "$PREVIEW_SLOT_COUNT" "$PREVIEW_BASE_DOMAIN"
  fi
  verify_public_url
}

configure_existing_domain() {
  if [[ -z "$HOSTNAME_VALUE" ]]; then
    ((INTERACTIVE)) || { printf '--hostname is required for existing-domain mode.\n' >&2; return 1; }
    prompt_value HOSTNAME_VALUE "请输入已解析到本服务器的域名（不带 https://）"
  fi
  validate_hostname
  validate_preview_settings

  if [[ -z "$REVERSE_PROXY" ]]; then
    if ((!INTERACTIVE)); then REVERSE_PROXY="existing"; else
      local choice
      prompt_choice choice "这个域名现在如何连接到 Codex Desktop？此项必须明确选择。" "" \
        "  1. 我已经配置 Nginx/Caddy/面板反向代理，现在只核对参数" \
        "  2. 还没有反向代理，现在由向导安装 Nginx 并申请 HTTPS" \
        "  3. 这次不配置该域名，明确改用本机或 SSH 转发"
      case "$choice" in
        1) REVERSE_PROXY="existing" ;;
        2) REVERSE_PROXY="nginx" ;;
        3) ACCESS_MODE="local"; configure_local; return ;;
      esac
    fi
  fi

  case "$REVERSE_PROXY" in
    existing)
      check_local_gateway
      if ((INTERACTIVE)); then
        printf '\n请在现有反向代理中确认：\n'
        printf '  域名：%s\n  源站：http://127.0.0.1:4317\n  WebSocket：启用\n  HTTPS：启用\n' "$HOSTNAME_VALUE"
        if [[ -n "$PREVIEW_BASE_DOMAIN" ]]; then
          printf '  预览域池：preview-1..%s.%s（需同一 HTTPS 证书并转发到相同源站）\n' "$PREVIEW_SLOT_COUNT" "$PREVIEW_BASE_DOMAIN"
        fi
        prompt_yes_no "以上设置已经完成并保留现有配置？" no || { printf '未记录公网配置，可稍后重新运行向导。\n'; return 1; }
      fi
      record_state "existing-proxy"
      verify_public_url
      ;;
    nginx)
      if [[ -z "$CERTBOT_EMAIL" ]] && ! managed_nginx_https_ready; then
        ((INTERACTIVE)) || { printf '--email is required for managed Nginx HTTPS.\n' >&2; return 1; }
        prompt_value CERTBOT_EMAIL "请输入接收证书到期通知的邮箱"
      fi
      if ((INTERACTIVE)); then
        printf '\n即将为 %s 安装/更新独立 Nginx 站点并申请 HTTPS。\n' "$HOSTNAME_VALUE"
        printf '要求：DNS 已指向本机，公网 80/443 可访问，且该域名未被其他站点占用。\n'
        prompt_yes_no "确认继续？" no || { printf '已取消 Nginx 配置。\n'; return 1; }
      fi
      configure_managed_nginx
      ;;
    *) printf 'Reverse proxy mode must be existing or nginx.\n' >&2; return 1 ;;
  esac
}

install_cloudflared_if_needed() {
  command -v cloudflared >/dev/null 2>&1 && return 0
  require_root "Installing cloudflared"
  export DEBIAN_FRONTEND=noninteractive
  ensure_real_directory "$ETC_DIR/apt/keyrings" 0755
  ensure_real_directory "$ETC_DIR/apt/sources.list.d" 0755
  local key_temporary source_temporary key_file source_file source_line
  key_file="$ETC_DIR/apt/keyrings/cloudflare-main.gpg"
  source_file="$ETC_DIR/apt/sources.list.d/cloudflared.list"
  [[ ! -L "$key_file" && ( ! -e "$key_file" || -f "$key_file" ) ]] || {
    printf 'Cloudflare APT key is not a regular file; refusing to replace it.\n' >&2
    return 1
  }
  [[ ! -L "$source_file" && ( ! -e "$source_file" || -f "$source_file" ) ]] || {
    printf 'Cloudflare APT source is not a regular file; refusing to replace it.\n' >&2
    return 1
  }
  source_line="deb [signed-by=$ETC_DIR/apt/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main"
  key_temporary="$(mktemp)"
  if ! curl --connect-timeout 5 --max-time 20 --retry 1 --retry-delay 1 --retry-max-time 25 \
      -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o "$key_temporary" \
      || ! verify_download_sha256 "$key_temporary" "$CLOUDFLARE_MAIN_GPG_SHA256"; then
    rm -f -- "$key_temporary"
    return 1
  fi
  install -m 0644 "$key_temporary" "$key_file"
  sync_directory "$ETC_DIR/apt/keyrings"
  rm -f "$key_temporary"
  source_temporary="$(mktemp "$ETC_DIR/apt/sources.list.d/.cloudflared.list.XXXXXX")"
  if ! { printf '%s\n' "$source_line" >"$source_temporary" && chmod 0644 "$source_temporary"; }; then
    rm -f -- "$source_temporary"
    return 1
  fi
  if [[ -e "$source_file" ]] && ! grep -Fqx "$source_line" "$source_file"; then
    rm -f -- "$source_temporary"
    printf 'Existing Cloudflare APT source is not managed by this installer; refusing to overwrite it.\n' >&2
    return 1
  fi
  mv -f -- "$source_temporary" "$source_file"
  sync_directory "$ETC_DIR/apt/sources.list.d"
  apt-get update
  apt-get install -y cloudflared
}

verify_download_sha256() {
  local filename="$1" expected="$2" actual
  actual="$(sha256sum -- "$filename" | awk '{ print $1 }')"
  [[ "$actual" == "$expected" ]] || {
    printf 'Downloaded Cloudflare key failed its pinned SHA-256 verification.\n' >&2
    return 1
  }
}

install_cloudflared_token_service() {
  local token="$1" cloudflared_bin token_dir token_file unit_file unit_temporary token_temporary
  cloudflared_bin="$(command -v cloudflared)"
  token_dir="$ETC_DIR/cloudflared"
  token_file="$token_dir/token"
  unit_file="$ETC_DIR/systemd/system/cloudflared.service"
  ensure_real_directory "$token_dir" 0755
  ensure_real_directory "$ETC_DIR/systemd/system" 0755
  [[ ! -L "$token_file" && ( ! -e "$token_file" || -f "$token_file" ) ]] || {
    printf 'Cloudflare token path is not a regular file; refusing to replace it.\n' >&2
    return 1
  }
  [[ ! -L "$unit_file" && ( ! -e "$unit_file" || -f "$unit_file" ) ]] || {
    printf 'Cloudflare systemd unit is not a regular file; refusing to replace it.\n' >&2
    return 1
  }
  token_temporary="$(mktemp "$token_dir/.token.XXXXXX")"
  if ! { printf '%s' "$token" >"$token_temporary" && chmod 0600 "$token_temporary"; }; then
    rm -f -- "$token_temporary"
    return 1
  fi
  mv -f -- "$token_temporary" "$token_file"
  sync_directory "$token_dir"

  unit_temporary="$(mktemp "$ETC_DIR/systemd/system/.cloudflared.service.XXXXXX")"
  if ! printf '%s\n' \
    '[Unit]' \
    'Description=Cloudflare Tunnel client' \
    '# Managed by WFL Codex Desktop access wizard.' \
    'After=network-online.target' \
    'Wants=network-online.target' \
    '' \
    '[Service]' \
    'Type=notify' \
    'TimeoutStartSec=15' \
    "ExecStart=$cloudflared_bin --no-autoupdate tunnel run --token-file $token_file" \
    'Restart=on-failure' \
    'RestartSec=5s' \
    '' \
    '[Install]' \
    'WantedBy=multi-user.target' >"$unit_temporary"; then
    rm -f -- "$unit_temporary"
    return 1
  fi
  chmod 0644 "$unit_temporary"
  if [[ -e "$unit_file" ]] && ! grep -Fqx '# Managed by WFL Codex Desktop access wizard.' "$unit_file"; then
    rm -f -- "$unit_temporary"
    printf 'Existing cloudflared.service is not managed by this installer; refusing to overwrite it.\n' >&2
    return 1
  fi
  mv -f -- "$unit_temporary" "$unit_file"
  sync_directory "$ETC_DIR/systemd/system"
  systemctl daemon-reload
}

configure_cloudflare() {
  if [[ -z "$HOSTNAME_VALUE" ]]; then
    ((INTERACTIVE)) || { printf '--hostname is required for cloudflare mode.\n' >&2; return 1; }
    prompt_value HOSTNAME_VALUE "请输入 Cloudflare 中准备使用的域名（不带 https://）"
  fi
  validate_hostname
  validate_preview_settings
  check_local_gateway

  if systemctl is-active --quiet cloudflared.service 2>/dev/null; then
    printf '检测到 cloudflared 服务已经运行，向导不会替换现有 Tunnel。\n'
    if ((INTERACTIVE)); then
      prompt_yes_no "确认现有 Tunnel 已将 $HOSTNAME_VALUE 指向 http://127.0.0.1:4317？" no || return 1
    fi
    record_state "existing-cloudflared"
    verify_public_url
    return 0
  fi

  if systemctl cat cloudflared.service >/dev/null 2>&1; then
    printf '检测到已有但未运行的 cloudflared 服务，向导不会覆盖其凭据。\n'
    if ((INTERACTIVE)); then
      prompt_yes_no "尝试启动现有 cloudflared 服务？" no || return 1
    fi
    systemctl enable --now cloudflared.service
    systemctl is-active --quiet cloudflared.service || {
      printf '现有 cloudflared 服务启动失败，请先检查 journalctl -u cloudflared。\n' >&2
      return 1
    }
    record_state "existing-cloudflared"
    verify_public_url
    return 0
  fi

  if ((INTERACTIVE)); then
    printf '\n请先在 Cloudflare Zero Trust 控制台完成：\n'
    printf '  1. Networks -> Tunnels -> Create a tunnel\n'
    printf '  2. 添加 Public Hostname：%s\n' "$HOSTNAME_VALUE"
    printf '  3. Service Type 选 HTTP，URL 填 127.0.0.1:4317\n'
    printf '  4. 复制 Linux connector 的 Tunnel token\n'
    prompt_yes_no "控制台配置和 token 都已准备好？" no || { printf '未修改 Cloudflare 配置。\n'; return 1; }
  fi

  local tunnel_token="${WFL_CLOUDFLARE_TUNNEL_TOKEN:-}"
  if [[ -z "$tunnel_token" ]]; then
    ((INTERACTIVE)) || { printf 'Set WFL_CLOUDFLARE_TUNNEL_TOKEN for non-interactive Cloudflare setup.\n' >&2; return 1; }
    read -r -s -p "粘贴 Tunnel token（输入不会显示）: " tunnel_token
    printf '\n'
  fi
  [[ ${#tunnel_token} -ge 40 && "$tunnel_token" != *[$'\r\n\t ']* ]] || {
    printf 'Tunnel token 格式无效，未执行安装。\n' >&2
    unset tunnel_token
    return 1
  }

  install_cloudflared_if_needed
  require_root "Cloudflare service setup" || { unset tunnel_token; return 1; }
  install_cloudflared_token_service "$tunnel_token"
  unset tunnel_token WFL_CLOUDFLARE_TUNNEL_TOKEN
  systemctl enable --now cloudflared.service
  systemctl is-active --quiet cloudflared.service
  record_state "cloudflared-token-file"
  printf 'Cloudflare Tunnel connector 已启动，源站为 http://127.0.0.1:4317。\n'
  verify_public_url
}

choose_mode
validate_mode

printf '\n访问配置：%s\n' "$ACCESS_MODE"
case "$ACCESS_MODE" in
  existing-domain) configure_existing_domain ;;
  cloudflare) configure_cloudflare ;;
  local) configure_local ;;
esac

printf '访问方式已记录在 %s（不含密码、令牌或证书私钥）。\n' "$STATE_FILE"
