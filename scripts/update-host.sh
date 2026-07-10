#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mubaiqq/iot-platform.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/iot-platform}"
APP_NAME="${APP_NAME:-iot-platform}"
APP_PORT="${APP_PORT:-32180}"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

update_source_from_tarball() {
  local tmpdir tarball url ok
  tmpdir="$(mktemp -d)"
  tarball="$tmpdir/source.tar.gz"
  ok=0
  for url in \
    "https://gh-proxy.com/https://github.com/mubaiqq/iot-platform/archive/refs/heads/main.tar.gz" \
    "https://gh.llkk.cc/https://github.com/mubaiqq/iot-platform/archive/refs/heads/main.tar.gz" \
    "https://github.com/mubaiqq/iot-platform/archive/refs/heads/main.tar.gz" \
    "https://codeload.github.com/mubaiqq/iot-platform/tar.gz/refs/heads/main"; do
    echo "[host-update] 下载源码包: $url"
    if curl -fL --connect-timeout 10 --max-time 45 "$url" -o "$tarball" && [ -s "$tarball" ]; then
      ok=1
      break
    fi
    echo "[host-update] 当前源码包地址下载失败，尝试下一个..."
  done
  if [ "$ok" != "1" ]; then
    echo "[host-update] 源码包下载失败，请稍后重试或检查服务器访问 GitHub/CDN 网络。" >&2
    rm -rf "$tmpdir"
    exit 1
  fi
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
