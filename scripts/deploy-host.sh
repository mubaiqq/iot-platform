#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mubaiqq/iot-platform.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/iot-platform}"
APP_PORT="${APP_PORT:-32180}"
APP_NAME="${APP_NAME:-iot-platform}"
NODE_MAJOR="${NODE_MAJOR:-20}"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_base_tools() {
  if need_cmd apt-get; then
    $SUDO apt-get update
    $SUDO apt-get install -y git curl ca-certificates rsync openssl build-essential
  fi
}

install_node() {
  if need_cmd node && node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >/dev/null 2>&1; then
    echo "[host-deploy] Node 已安装: $(node -v)"
    return
  fi

  echo "[host-deploy] 安装 Node.js ${NODE_MAJOR}.x ..."
  if need_cmd apt-get; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO bash -
    $SUDO apt-get install -y nodejs
  else
    echo "[host-deploy] 未检测到 apt-get，请先手动安装 Node.js 18+" >&2
    exit 1
  fi
}

install_pm2() {
  if need_cmd pm2; then
    echo "[host-deploy] PM2 已安装: $(pm2 -v)"
    return
  fi
  echo "[host-deploy] 安装 PM2 ..."
  $SUDO npm install -g pm2
}

prepare_source() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "[host-deploy] 更新源码: $INSTALL_DIR"
    echo "[host-deploy] 若 git fetch 长时间无输出，通常是 GitHub 网络阻塞；将自动超时并改用源码包更新。"
    if timeout 45s $SUDO git -C "$INSTALL_DIR" fetch --depth=1 origin main; then
      $SUDO git -C "$INSTALL_DIR" reset --hard FETCH_HEAD
    else
      echo "[host-deploy] git fetch 超时/失败，改用 GitHub 源码包下载..."
      update_source_from_tarball
    fi
  else
    echo "[host-deploy] 克隆源码到: $INSTALL_DIR"
    $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
    if ! timeout 90s $SUDO git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"; then
      echo "[host-deploy] git clone 超时/失败，改用 GitHub 源码包下载..."
      $SUDO mkdir -p "$INSTALL_DIR"
      update_source_from_tarball
    fi
  fi
  $SUDO chown -R "$(id -u):$(id -g)" "$INSTALL_DIR" 2>/dev/null || true
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
    echo "[host-deploy] 下载源码包: $url"
    if curl -fL --connect-timeout 10 --max-time 45 "$url" -o "$tarball" && [ -s "$tarball" ]; then
      ok=1
      break
    fi
    echo "[host-deploy] 当前源码包地址下载失败，尝试下一个..."
  done
  if [ "$ok" != "1" ]; then
    echo "[host-deploy] 源码包下载失败，请稍后重试或检查服务器访问 GitHub/CDN 网络。" >&2
    rm -rf "$tmpdir"
    exit 1
  fi
  tar -xzf "$tarball" -C "$tmpdir"
  $SUDO mkdir -p "$INSTALL_DIR"
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

install_dependencies() {
  cd "$INSTALL_DIR"
  echo "[host-deploy] 安装生产依赖..."
  if [ -f package-lock.json ]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
}

write_env_file() {
  cd "$INSTALL_DIR"
  mkdir -p data logs
  if [ ! -f .env ]; then
    cat > .env <<EOF
APP_PORT=${APP_PORT}
EOF
    echo "[host-deploy] 已生成 .env（仅保存宿主机端口；数据库请在安装页填写）"
  else
    echo "[host-deploy] 已存在 .env，保留原配置"
    if grep -q '^APP_PORT=' .env; then
      sed -i "s|^APP_PORT=.*|APP_PORT=${APP_PORT}|" .env
    else
      echo "APP_PORT=${APP_PORT}" >> .env
    fi
  fi
}

setup_pm2_startup() {
  echo "[host-deploy] 配置 PM2 开机自启..."
  if [ "$(id -u)" -eq 0 ]; then
    pm2 startup systemd -u root --hp /root >/tmp/iot-pm2-startup.log 2>&1 || true
  else
    pm2 startup systemd -u "$(whoami)" --hp "$HOME" >/tmp/iot-pm2-startup.log 2>&1 || true
  fi
  # pm2 startup may print a command for unusual environments; show it if systemd service is not active.
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable pm2-$(whoami) >/dev/null 2>&1 || true
  fi
}

start_app() {
  cd "$INSTALL_DIR"
  echo "[host-deploy] 检查语法..."
  node -c app.js
  node -c mqtt_handler.js

  echo "[host-deploy] 使用 PM2 启动服务..."
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  fi
  PORT="$APP_PORT" DB_CONFIG_PATH="$INSTALL_DIR/data/db-config.json" pm2 start app.js --name "$APP_NAME" --cwd "$INSTALL_DIR" --update-env
  pm2 save
  setup_pm2_startup

  echo "[host-deploy] 等待服务启动..."
  sleep 3
  pm2 status "$APP_NAME"
}

print_result() {
  echo
  echo "宿主机部署完成"
  echo "访问地址: http://服务器IP:${APP_PORT}"
  echo "首次安装: 打开上面的地址，填写宿主机 MySQL 信息后完成初始化。"
  echo "如果 MySQL 就在同一台服务器上，数据库 Host 通常填: 127.0.0.1"
  echo "管理员账号: admin"
  echo "请在首次安装页面设置强密码，并在后台配置天气/API/大模型等参数。"
  echo
  echo "常用命令:"
  echo "  pm2 status ${APP_NAME}"
  echo "  pm2 logs ${APP_NAME} --lines 50"
  echo "  pm2 restart ${APP_NAME} --update-env"
  echo "  pm2 save"
  echo "  pm2 startup systemd -u root --hp /root"
  echo "  cd ${INSTALL_DIR} && node -c app.js && node -c mqtt_handler.js"
}

install_base_tools
install_node
install_pm2
prepare_source
install_dependencies
write_env_file
start_app
print_result
