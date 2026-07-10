# IoT Platform

木白云 IoT 平台源码。Node.js + Express + MySQL + MQTT，用于 ESP32 控制器/传感器设备管理、计划任务、AI 浇水判断、设备日志与后台管理。

## 主要功能

- 用户端设备管理
- ESP32 控制器/传感器 MQTT 接入
- 手动浇水、固定计划浇水、AI 智能浇水判断
- 天气 API 与大模型 API 配置
- VIP 官方 API 权限控制
- 管理后台：用户、设备、日志、接口配置

## 技术栈

- Node.js / Express
- MySQL / MariaDB
- MQTT.js
- Docker / Docker Compose
- 前端为静态 HTML/CSS/JS

## 宿主机一键部署（Node.js + PM2）

适合直接连接服务器/宝塔已有 MySQL，部署方式和本仓库开发服务器一致：应用直接运行在宿主机，数据库安装页填写宿主机 MySQL 地址。

推荐国内 CDN 下载脚本：

```bash
curl -fsSL --connect-timeout 10 --max-time 30 https://cdn.jsdelivr.net/gh/mubaiqq/iot-platform@main/scripts/deploy-host.sh -o /tmp/iot-deploy-host.sh
bash /tmp/iot-deploy-host.sh
```

默认访问：

```text
http://服务器IP:32180
```

首次打开会进入安装向导。如果 MySQL 就在同一台服务器/宝塔里，数据库 Host 通常填写：

```text
127.0.0.1
```

也可以自定义端口/目录：

```bash
APP_PORT=18080 INSTALL_DIR=/opt/iot-platform bash /tmp/iot-deploy-host.sh
```

## Docker 一键部署（内置 MySQL 容器）

服务器上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/mubaiqq/iot-platform/main/scripts/deploy.sh | bash
```

默认访问：

```text
http://服务器IP:32180
```

默认管理员：

```text
账号：admin
密码：admin123
```

登录后请立即修改默认密码，并进入后台配置天气 API、大模型 API、MQTT 等参数。

Docker 部署内置 MySQL 容器并自动配置数据库，正常不需要再填写数据库信息。

如果改用宿主机部署，首次打开页面会进入安装向导，请填写宿主机 MySQL 数据库信息。同机 MySQL 地址通常填写：

```text
127.0.0.1
```

### 自定义端口/目录

```bash
APP_PORT=18080 \
INSTALL_DIR=/opt/iot-platform \
curl -fsSL https://raw.githubusercontent.com/mubaiqq/iot-platform/main/scripts/deploy.sh | bash
```

### Docker 镜像拉取很慢怎么办

Docker 部署默认内置 MySQL 容器，并在一键脚本里写入国内镜像变量：

```env
NODE_IMAGE=docker.m.daocloud.io/library/node:20-alpine
MYSQL_IMAGE=docker.m.daocloud.io/library/mysql:8.4.4
```

如果你不想使用 Docker，可以改用上面的“宿主机一键部署”。

### 更新程序

已经部署过之后，后续更新只需要执行：

```bash
curl -fsSL https://raw.githubusercontent.com/mubaiqq/iot-platform/main/scripts/update.sh | bash
```

如果部署目录不是默认的 `/opt/iot-platform`，更新时指定目录：

```bash
INSTALL_DIR=/你的部署目录 \
curl -fsSL https://raw.githubusercontent.com/mubaiqq/iot-platform/main/scripts/update.sh | bash
```

更新脚本会自动：

1. 拉取 GitHub 最新代码
2. 保留现有 `.env` 和数据库配置文件
3. 重新 build 应用镜像
4. 重启应用容器
5. 清理悬空镜像

### 常用 Docker 命令

```bash
cd /opt/iot-platform

docker compose ps
docker compose logs -f app
docker compose restart app
docker compose down
```

## 本地开发启动

```bash
npm install
node app.js
```

默认读取本机 MySQL：

```text
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_NAME=iot_platform
```

也可以通过环境变量覆盖：

```bash
DB_HOST=127.0.0.1 DB_USER=root DB_PASSWORD=xxx DB_NAME=iot_platform node app.js
```

## 开发与更新规范

详细规范见根目录：

```text
DEVELOPMENT.md
```

包含开发规范、Docker 部署规范、更新命令、数据库变更注意事项、GitHub 发布流程和故障排查。

## 注意

- 本仓库不包含 `node_modules/`、`backups/`、`.env`、上传文件等运行时内容。
- Docker 首次启动会进入安装页面；填写 MySQL 信息后自动初始化数据库结构和默认管理员。
- 管理员全局 API Key / 用户自定义 API Key 均存数据库，不应提交到 GitHub。
- 如需 Nginx / HTTPS，请自行反代到容器映射端口，默认是 `32180`。
