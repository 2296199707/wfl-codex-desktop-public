#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
AUTH_FILE="${CODEX_DESKTOP_AUTH_FILE:-$SOURCE_DIR/.codex-desktop/auth.json}"
STATE_DIR="${CODEX_DESKTOP_STATE_DIR:-$SOURCE_DIR/.codex-desktop}"
RUNTIME_DIR="${CODEX_DESKTOP_RUNTIME_DIR:-$SOURCE_DIR/.codex-runtime}"

usage() {
  printf '%s\n' \
    "Usage: sudo npm run server:password" \
    "" \
    "Resets the single-user browser password and restarts only the active backend." \
    "When multi-user mode is configured, change the owner password in Personal Account instead."
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac

[[ "${EUID}" -eq 0 ]] || { printf 'Run this wizard as root: sudo npm run server:password\n' >&2; exit 1; }
[[ -t 0 && -t 1 ]] || { printf 'This password wizard requires an interactive terminal.\n' >&2; exit 1; }
cd "$SOURCE_DIR"

if node --input-type=module -e '
  import fs from "node:fs/promises";
  const file = process.argv[1];
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    process.exit(value?.ownerId ? 0 : 1);
  } catch (error) {
    if (error.code === "ENOENT") process.exit(1);
    throw error;
  }
' "$STATE_DIR/multi-user.json"; then
  printf '%s\n' \
    'Multi-user mode is configured. This command will not rewrite only the legacy password.' \
    'Open /#account and change the owner password in Personal Account.' >&2
  exit 1
fi

USERNAME="codex"
if [[ -s "$AUTH_FILE" ]]; then
  USERNAME="$(node --input-type=module -e '
    import { loadAuth } from "./lib/auth.mjs";
    const record = await loadAuth(process.argv[1]);
    if (!record) process.exit(1);
    process.stdout.write(record.username);
  ' "$AUTH_FILE")"
fi

printf '当前单用户账号：%s\n' "$USERNAME"
printf '%s\n' \
  '  1. 自动生成高强度密码并显示一次' \
  '  2. 隐藏输入自定义密码（至少 16 个字符）'
while true; do
  read -r -p '请选择 [必选]: ' choice
  case "$choice" in
    1|2) break ;;
    *) printf '请输入 1 或 2。\n' >&2 ;;
  esac
done

read -r -p '修改密码会断开当前网页会话，确认继续？[y/N]: ' confirmation
case "${confirmation,,}" in
  y|yes) ;;
  *) printf '未修改网页密码。\n'; exit 0 ;;
esac

if [[ "$choice" == "1" ]]; then
  CODEX_DESKTOP_AUTH_FILE="$AUTH_FILE" CODEX_DESKTOP_RUNTIME_DIR="$RUNTIME_DIR" \
    CODEX_DESKTOP_USERNAME="$USERNAME" node scripts/set-password.mjs
else
  while true; do
    read -r -s -p '输入新密码: ' password
    printf '\n'
    read -r -s -p '再次输入新密码: ' confirmation
    printf '\n'
    if [[ ${#password} -lt 16 ]]; then
      printf '密码至少需要 16 个字符。\n' >&2
    elif [[ "$password" != "$confirmation" ]]; then
      printf '两次输入不一致。\n' >&2
    else
      break
    fi
  done
  CODEX_DESKTOP_AUTH_FILE="$AUTH_FILE" \
    CODEX_DESKTOP_RUNTIME_DIR="$RUNTIME_DIR" \
    CODEX_DESKTOP_USERNAME="$USERNAME" \
    CODEX_DESKTOP_NEW_PASSWORD="$password" \
    CODEX_DESKTOP_HIDE_PASSWORD=1 \
    node scripts/set-password.mjs
  password=""
  confirmation=""
fi

if [[ -s "$RUNTIME_DIR/active-port" ]]; then
  active_port="$(tr -d '\r\n' < "$RUNTIME_DIR/active-port")"
  case "$active_port" in
    4318|4319)
      systemctl restart "wfl-codex-desktop-backend@${active_port}.service"
      systemctl is-active --quiet "wfl-codex-desktop-backend@${active_port}.service"
      printf '活动后端已重启，请使用新密码重新登录。\n'
      ;;
    *) printf '密码已修改，但活动端口记录无效；请运行 npm run server:doctor。\n' >&2; exit 1 ;;
  esac
else
  printf '密码已修改。服务尚未发布，无需重启。\n'
fi
