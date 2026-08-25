#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEFAULT_KEY="/root/.ssh/wfl-codex-desktop-deploy"
KEY_FILE="${WFL_DEPLOY_KEY_FILE:-$DEFAULT_KEY}"

usage() {
  printf '%s\n' \
    "Usage: sudo npm run server:updates" \
    "" \
    "Configures this server's independent read-only SSH Deploy Key and Git origin." \
    "The private key stays outside the project and is never submitted to the web UI."
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac

[[ "${EUID}" -eq 0 ]] || { printf 'Run this wizard as root: sudo npm run server:updates\n' >&2; exit 1; }
[[ -t 0 && -t 1 ]] || { printf 'This update-source wizard requires an interactive terminal.\n' >&2; exit 1; }
[[ "$KEY_FILE" == /* && "$KEY_FILE" != *[$'\r\n\t ']* ]] || {
  printf 'Deploy Key path must be absolute and contain no whitespace.\n' >&2
  exit 1
}

configured_remote=""
if [[ -d "$SOURCE_DIR/.git" ]]; then
  configured_remote="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)"
fi

printf '%s\n' \
  '此向导只配置读取权限：' \
  '  - 每台服务器使用不同的 Deploy Key' \
  '  - GitHub 中必须关闭 Allow write access' \
  '  - 私钥不会进入项目、网页或命令参数'
if [[ -n "$configured_remote" ]]; then
  read -r -p "SSH 仓库地址 [$configured_remote]: " remote
  remote="${remote:-$configured_remote}"
else
  while [[ -z "${remote:-}" ]]; do
    read -r -p 'SSH 仓库地址（例如 git@github.com:OWNER/REPO.git）: ' remote
  done
fi

[[ "$remote" != *[$'\r\n\t ']* ]] || { printf 'Git remote must not contain whitespace.\n' >&2; exit 1; }
case "$remote" in
  ssh://*|git@*:*) ;;
  *) printf 'Git remote must use SSH with a read-only Deploy Key.\n' >&2; exit 1 ;;
esac
if [[ -n "$configured_remote" && "$remote" != "$configured_remote" ]]; then
  printf 'Existing origin differs from the requested repository; refusing to rewrite it.\n' >&2
  exit 1
fi

mkdir -p "$(dirname "$KEY_FILE")"
chmod 700 "$(dirname "$KEY_FILE")"
if [[ -e "$KEY_FILE" || -e "$KEY_FILE.pub" ]]; then
  [[ -s "$KEY_FILE" && -s "$KEY_FILE.pub" ]] || {
    printf 'Deploy Key files are incomplete at %s; repair or remove them manually.\n' "$KEY_FILE" >&2
    exit 1
  }
  read -r -p "复用现有 Deploy Key $KEY_FILE？[y/N]: " reuse
  case "${reuse,,}" in
    y|yes) ;;
    *) printf '未修改更新源。\n'; exit 0 ;;
  esac
else
  ssh-keygen -q -t ed25519 -N '' -C "wfl-codex-desktop@$(hostname)" -f "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"
chmod 644 "$KEY_FILE.pub"

printf '\n请把下面的公钥添加到该私人仓库 Settings > Deploy keys，并关闭 Allow write access：\n\n'
sed -n '1p' "$KEY_FILE.pub"
printf '\n'
read -r -p '添加完成后输入 YES 继续验证: ' confirmation
[[ "$confirmation" == "YES" ]] || { printf '验证已取消，公钥保留供稍后继续。\n'; exit 0; }

ssh_command="ssh -i $KEY_FILE -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
GIT_SSH_COMMAND="$ssh_command" git ls-remote --exit-code "$remote" HEAD >/dev/null

if [[ -d "$SOURCE_DIR/.git" ]]; then
  git -C "$SOURCE_DIR" config core.sshCommand "$ssh_command"
else
  GIT_SSH_COMMAND="$ssh_command" node "$SOURCE_DIR/scripts/bootstrap-package-git.mjs" \
    --source "$SOURCE_DIR" --remote "$remote"
  git -C "$SOURCE_DIR" config core.sshCommand "$ssh_command"
fi

GIT_SSH_COMMAND="$ssh_command" git -C "$SOURCE_DIR" ls-remote --exit-code origin HEAD >/dev/null
printf '%s\n' \
  '只读更新源配置完成。' \
  '可运行 npm run app:update:check 检查远程稳定版本。'
