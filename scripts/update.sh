#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/iot-platform}"
BRANCH="${BRANCH:-main}"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

if [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "[update] 未找到已部署项目: $INSTALL_DIR"
  echo "[update] 请先执行一键部署命令。"
  exit 1
fi

cd "$INSTALL_DIR"

mkdir -p data
$SUDO chown -R "${APP_UID:-1000}:${APP_GID:-1000}" data 2>/dev/null || true

echo "[update] 拉取最新代码..."
$SUDO git fetch origin "$BRANCH"
$SUDO git reset --hard "origin/$BRANCH"
$SUDO chown -R "$(id -u):$(id -g)" "$INSTALL_DIR" 2>/dev/null || true

echo "[update] 重新构建并滚动启动容器..."
$SUDO docker compose up -d --build

echo "[update] 清理悬空镜像..."
$SUDO docker image prune -f >/dev/null 2>&1 || true

echo
$SUDO docker compose ps

echo
echo "更新完成。"
echo "查看日志: cd $INSTALL_DIR && docker compose logs -f app"
