#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mubaiqq/iot-platform.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/iot-platform}"
APP_NAME="${APP_NAME:-iot-platform}"
APP_PORT="${APP_PORT:-3000}"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

update_source_from_tarball() {
  local tmpdir tarball
  tmpdir="$(mktemp -d)"
  tarball="$tmpdir/source.tar.gz"
  curl -fL --connect-timeout 15 --max-time 120 "https://github.com/mubaiqq/iot-platform/archive/refs/heads/main.tar.gz" -o "$tarball"
  tar -xzf "$tarball" -C "$tmpdir"
  if need_cmd rsync; then
    $SUDO rsync -a --delete \
      --exclude='.git' \
      --exclude='.env' \
      --exclude='data/' \
      --exclude='node_modules/' \
      --exclude='backups/' \
      "$tmpdir"/iot-platform-main/ "$INSTALL_DIR"/
  else
    $SUDO cp -a "$tmpdir"/iot-platform-main/. "$INSTALL_DIR"/
  fi
  rm -rf "$tmpdir"
}

if [ ! -d "$INSTALL_DIR" ]; then
  echo "[host-update] 部署目录不存在，请先执行 scripts/deploy-host.sh" >&2
  exit 1
fi

if need_cmd apt-get; then
  $SUDO apt-get update
  $SUDO apt-get install -y git curl ca-certificates rsync
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[host-update] 更新源码: $INSTALL_DIR"
  if timeout 45s $SUDO git -C "$INSTALL_DIR" fetch --depth=1 origin main; then
    $SUDO git -C "$INSTALL_DIR" reset --hard FETCH_HEAD
  else
    echo "[host-update] git fetch 超时/失败，改用源码包下载..."
    update_source_from_tarball
  fi
else
  echo "[host-update] 当前目录不是 git 仓库，改用源码包下载..."
  update_source_from_tarball
fi

$SUDO chown -R "$(id -u):$(id -g)" "$INSTALL_DIR" 2>/dev/null || true
cd "$INSTALL_DIR"

if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

node -c app.js
node -c mqtt_handler.js

if [ -f .env ] && grep -q '^APP_PORT=' .env; then
  APP_PORT="$(grep '^APP_PORT=' .env | tail -1 | cut -d= -f2-)"
fi

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  PORT="$APP_PORT" DB_CONFIG_PATH="$INSTALL_DIR/data/db-config.json" pm2 restart "$APP_NAME" --update-env
else
  PORT="$APP_PORT" DB_CONFIG_PATH="$INSTALL_DIR/data/db-config.json" pm2 start app.js --name "$APP_NAME" --cwd "$INSTALL_DIR" --update-env
fi
pm2 save
pm2 status "$APP_NAME"

echo "[host-update] 更新完成: http://服务器IP:${APP_PORT}"
