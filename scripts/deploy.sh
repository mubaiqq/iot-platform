#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mubaiqq/iot-platform.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/iot-platform}"
APP_PORT="${APP_PORT:-32180}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-iot_platform_root_password}"
DB_NAME="${DB_NAME:-iot_platform}"

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
    $SUDO apt-get install -y git curl ca-certificates
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
    $SUDO git -C "$INSTALL_DIR" fetch origin main
    $SUDO git -C "$INSTALL_DIR" reset --hard origin/main
  else
    echo "[deploy] 克隆源码到: $INSTALL_DIR"
    $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
    $SUDO git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  $SUDO chown -R "$(id -u):$(id -g)" "$INSTALL_DIR" 2>/dev/null || true
}

write_env() {
  cd "$INSTALL_DIR"
  if [ ! -f .env ]; then
    cat > .env <<EOF
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD}
DB_NAME=${DB_NAME}
APP_PORT=${APP_PORT}
EOF
    echo "[deploy] 已生成 .env"
  else
    echo "[deploy] 已存在 .env，保留原配置"
  fi
}

start_stack() {
  cd "$INSTALL_DIR"
  echo "[deploy] 构建并启动 Docker 服务..."
  $SUDO docker compose up -d --build
  echo "[deploy] 等待服务启动..."
  sleep 5
  $SUDO docker compose ps
}

print_result() {
  echo
  echo "部署完成"
  echo "访问地址: http://服务器IP:${APP_PORT}"
  echo "默认管理员: admin"
  echo "默认密码: admin123"
  echo "请登录后立即修改默认密码，并在后台配置天气/API/大模型等参数。"
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
