#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mubaiqq/iot-platform.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/iot-platform}"
APP_PORT="${APP_PORT:-32180}"

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
    $SUDO apt-get install -y git curl ca-certificates rsync openssl
  fi
}

install_docker() {
  if need_cmd docker && docker compose version >/dev/null 2>&1; then
    return
  fi
  echo "[deploy] Docker / Docker Compose 未安装，开始安装..."
  install_base_tools
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable docker >/dev/null 2>&1 || true
  $SUDO systemctl start docker >/dev/null 2>&1 || true
}

prepare_source() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "[deploy] 更新源码: $INSTALL_DIR"
    echo "[deploy] 若 git fetch 长时间无输出，通常是 GitHub 网络阻塞；将自动超时并改用源码包更新。"
    if timeout 45s $SUDO git -C "$INSTALL_DIR" fetch --depth=1 origin main; then
      $SUDO git -C "$INSTALL_DIR" reset --hard FETCH_HEAD
    else
      echo "[deploy] git fetch 超时/失败，改用 GitHub 源码包下载..."
      update_source_from_tarball
    fi
  else
    echo "[deploy] 克隆源码到: $INSTALL_DIR"
    $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
    if ! timeout 90s $SUDO git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"; then
      echo "[deploy] git clone 超时/失败，改用 GitHub 源码包下载..."
      $SUDO mkdir -p "$INSTALL_DIR"
      update_source_from_tarball
    fi
  fi
  $SUDO chown -R "$(id -u):$(id -g)" "$INSTALL_DIR" 2>/dev/null || true
}

update_source_from_tarball() {
  local tmpdir tarball
  tmpdir="$(mktemp -d)"
  tarball="$tmpdir/source.tar.gz"
  curl -fL --connect-timeout 15 --max-time 120 "https://github.com/mubaiqq/iot-platform/archive/refs/heads/main.tar.gz" -o "$tarball"
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

write_env() {
  cd "$INSTALL_DIR"
  if [ ! -f .env ]; then
    cat > .env <<EOF
APP_PORT=${APP_PORT}
NODE_IMAGE=${NODE_IMAGE:-docker.m.daocloud.io/library/node:20-alpine}
MYSQL_IMAGE=${MYSQL_IMAGE:-docker.m.daocloud.io/library/mysql:8.4.4}
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)}
DB_NAME=${DB_NAME:-iot_platform}
DB_USER=${DB_USER:-iot_user}
DB_PASSWORD=${DB_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-Aa1_$(openssl rand -hex 16)}
EOF
    echo "[deploy] 已生成 .env（包含内置 MySQL 配置）"
  else
    echo "[deploy] 已存在 .env，保留原配置"
    if ! grep -q '^NODE_IMAGE=' .env; then
      echo "NODE_IMAGE=${NODE_IMAGE:-docker.m.daocloud.io/library/node:20-alpine}" >> .env
      echo "[deploy] 已追加 NODE_IMAGE"
    fi
    if ! grep -q '^MYSQL_IMAGE=' .env; then
      echo "MYSQL_IMAGE=${MYSQL_IMAGE:-docker.m.daocloud.io/library/mysql:8.4.4}" >> .env
      echo "[deploy] 已追加 MYSQL_IMAGE"
    fi
    if ! grep -q '^MYSQL_ROOT_PASSWORD=' .env; then
      echo "MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)}" >> .env
      echo "[deploy] 已追加 MYSQL_ROOT_PASSWORD"
    fi
    if ! grep -q '^DB_NAME=' .env; then
      echo "DB_NAME=${DB_NAME:-iot_platform}" >> .env
      echo "[deploy] 已追加 DB_NAME"
    fi
    if ! grep -q '^DB_USER=' .env; then
      echo "DB_USER=${DB_USER:-iot_user}" >> .env
      echo "[deploy] 已追加 DB_USER"
    fi
    if ! grep -q '^DB_PASSWORD=' .env; then
      echo "DB_PASSWORD=${DB_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)}" >> .env
      echo "[deploy] 已追加 DB_PASSWORD"
    fi
    if ! grep -q '^ADMIN_PASSWORD=' .env; then
      echo "ADMIN_PASSWORD=${ADMIN_PASSWORD:-Aa1_$(openssl rand -hex 16)}" >> .env
      echo "[deploy] 已生成首次安装管理员密码"
    fi
  fi
}

start_stack() {
  cd "$INSTALL_DIR"
  mkdir -p data
  $SUDO chown -R "${APP_UID:-1000}:${APP_GID:-1000}" data
  echo "[deploy] 构建并启动 Docker 服务..."
  echo "[deploy] 不再拉取 MySQL 镜像；启动后请访问安装页面填写已有 MySQL 信息。"
  $SUDO docker compose up -d --build
  echo "[deploy] 等待服务启动..."
  sleep 5
  $SUDO docker compose ps
}

print_result() {
  echo
  echo "部署完成"
  echo "访问地址: http://服务器IP:${APP_PORT}"
  echo "首次安装: 打开上面的地址；内置 MySQL 已自动配置，通常无需再填写数据库信息。"
  echo "数据库数据卷: docker volume iot-platform_mysql_data（会随 compose 持久化）"
  echo "管理员账号: admin"
  echo "管理员密码已安全生成并保存在 ${INSTALL_DIR}/.env 的 ADMIN_PASSWORD 中。"
  echo "请妥善保管，并在后台配置天气/API/大模型等参数。"
  echo
  echo "常用命令:"
  echo "  cd ${INSTALL_DIR} && docker compose ps"
  echo "  cd ${INSTALL_DIR} && docker compose logs -f app"
  echo "  cd ${INSTALL_DIR} && docker compose restart app"
}

install_base_tools
install_docker
prepare_source
write_env
start_stack
print_result
