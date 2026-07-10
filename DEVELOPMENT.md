# 开发规范与更新规范

本文档用于约束木白云 IoT 平台的后续开发、部署、更新和发布流程。目标是：降低线上故障、避免覆盖用户配置、保证 Docker 部署可重复、方便后续多人维护。

## 1. 项目结构

```text
app.js                         # Express 后端入口、HTTP API、页面路由
mqtt_handler.js                # 全局 MQTT 订阅、设备心跳、AI 浇水判断、设备日志
public/                        # 前端静态页面与 ESP32 固件源码
public/user/                   # 用户端 iframe SPA
public/admin/                  # 管理端 iframe SPA
framework/                     # 旧后台框架静态页，已从 PHP 转成 HTML
docker-compose.yml             # Docker Compose 服务编排
Dockerfile                     # Node.js 应用镜像
.env.example                   # Docker 环境变量示例
docker/mysql/init/001-schema.sql # Docker 首次部署数据库初始化脚本
scripts/deploy.sh              # 一键首次部署脚本
scripts/update.sh              # 一键更新脚本
```

## 2. 分支与提交规范

- 默认分支：`main`
- 小改动可以直接提交到 `main`。
- 每次提交前必须确认：

```bash
node -c app.js
node -c mqtt_handler.js
bash -n scripts/deploy.sh
bash -n scripts/update.sh
```

- 推荐提交信息格式：

```text
Add xxx
Fix xxx
Update xxx
Refactor xxx
```

示例：

```bash
git add app.js mqtt_handler.js public/user/pages/device_prompt.html
git commit -m "Fix smart watering VIP check"
git push
```

## 3. 敏感信息规范

严禁提交以下内容：

- `.env` / `.env.*`
- API Key、模型 Key、天气 Key
- 数据库密码
- 用户数据、设备数据、日志数据
- `node_modules/`
- `backups/`
- `uploads/` / `public/uploads/`
- `*.bak` / `*.bak_*`
- 临时压缩包：`*.zip`、临时 `*.tar.gz`

管理员全局配置存数据库 `settings` 表；普通用户配置存 `user_settings` 表，按 `user_id` 隔离。

## 4. UI / 前端开发规范

### 4.1 基础风格

- 浅色主题优先。
- 图标必须使用 Font Awesome，不使用 emoji 作为正式图标。
- 移动端输入框必须避免 iOS Safari 自动放大：

```css
input, textarea, select, button { font-size: 16px !important; }
```

- 不使用浏览器原生：

```js
alert()
prompt()
confirm()
```

正式页面应使用自定义 toast / modal / confirm。

### 4.2 成功反馈

保存、登录、添加、发布等操作成功后，按钮本身要变色并显示成功文字，不能只弹 toast。

推荐：

```text
保存中... → ✓ 保存成功 → 2秒后恢复
```

注意：不要在 `finally` 中无条件重置按钮，否则会覆盖成功状态。

### 4.3 iframe SPA 通信

用户端和管理端采用 iframe SPA：

- 打开普通弹窗：`parent.openModal()`
- 打开 POST 数据弹窗：`parent.openModalPost()`
- 打开标签页：`parent.openTab()`
- 设备详情标签 ID 约定：`device_${id}`

删除设备后应关闭当前详情 tab，刷新设备列表，不要直接跳转。

## 5. IoT / MQTT 业务规范

### 5.1 MQTT Topic

```text
device/{code}/heartbeat
device/{code}/command
device/{code}/status
device/{code}/watering_request
device/{code}/watering_complete
device/{code}/register
```

### 5.2 设备码大小写

设备码大小写敏感，不能 `.toUpperCase()`。

ESP32 生成的设备码可能是混合大小写，MQTT topic 必须保留原始大小写。

### 5.3 浇水指令格式

平台发给设备的浇水命令必须保持简化格式：

```json
{ "water": true, "duration": 30 }
```

AI 判断无需浇水：

```json
{ "water": false, "reason": "湿度高，无需浇水" }
```

设备确认必须包含 `event` 字段：

```json
{
  "event": "watering_ack",
  "success": true,
  "water": true,
  "duration": 30,
  "request_id": "..."
}
```

### 5.4 request_id 规范

- 真实 ESP32 智能浇水请求必须带 `request_id`。
- 模拟器也应带 `request_id`，避免日志中出现 `request_id=null` 或 `undefined`。
- 后端回复设备时，只有 `request_id` 存在才下发，不要发送：

```json
{ "request_id": null }
```

### 5.5 AI 智能浇水时长

AI 只决定是否浇水和原因。

计划任务里的智能浇水时长来自计划任务本身：

```json
{
  "time": "08:00",
  "duration": 30,
  "fixed_watering": false
}
```

提示词模板输出格式应保持：

```json
{
  "should_water": true或false,
  "reason": "一句话简短理由"
}
```

不要让 AI 返回 `duration`，除非产品逻辑明确改成 AI 决定时长，同时后端也同步改造。

## 6. VIP 权限规范

官方天气 API 和官方大模型是 VIP 权益。

必须两层校验：

1. 保存设置时，非 VIP 不能保存：

```json
"weather_api": "official"
"llm_api": "official"
```

2. 运行时，设备旧设置如果仍为 `official`，但用户 VIP 已过期，后端也不能继续调用管理员全局资源。

运行时发现 VIP 过期，应返回清晰原因，例如：

```text
VIP已过期，官方大模型不可用，请续费VIP或改用自定义模型
```

## 7. 数据库规范

### 7.1 Docker 首次初始化

Docker 首次部署使用：

```text
docker/mysql/init/001-schema.sql
```

该脚本只在 MySQL 数据卷首次创建时执行。

后续如果需要修改表结构，不能只改 `001-schema.sql`，因为老用户的数据卷不会重新执行初始化脚本。应新增迁移方案或在后端启动时做兼容检查。

### 7.2 默认管理员

Docker 初始化默认管理员：

```text
账号：admin
密码：admin123
```

部署后必须立即修改默认密码。

### 7.3 数据保留

不要把线上数据库 dump、用户数据、设备日志提交到 GitHub。

## 8. Docker 部署规范

### 8.1 首次部署

```bash
curl -fsSL https://raw.githubusercontent.com/mubaiqq/iot-platform/main/scripts/deploy.sh | bash
```

默认部署目录：

```text
/opt/iot-platform
```

默认对外端口：

```text
32180
```

默认访问：

```text
http://服务器IP:32180
```

### 8.2 自定义部署

```bash
APP_PORT=18080 \
INSTALL_DIR=/opt/iot-platform \
MYSQL_ROOT_PASSWORD='change_this_password' \
curl -fsSL https://raw.githubusercontent.com/mubaiqq/iot-platform/main/scripts/deploy.sh | bash
```

### 8.3 端口规范

宿主机默认端口使用 `32180`，避免占用常见的 `3000`。

容器内部仍监听 `3000`：

```yaml
ports:
  - "${APP_PORT:-32180}:3000"
```

如需 Nginx / HTTPS，反代到宿主机的 `32180` 或自定义 `APP_PORT`。

## 9. 更新规范

### 9.1 标准更新命令

已部署服务器后续更新执行：

```bash
curl -fsSL https://raw.githubusercontent.com/mubaiqq/iot-platform/main/scripts/update.sh | bash
```

如果部署目录不是 `/opt/iot-platform`：

```bash
INSTALL_DIR=/你的部署目录 \
curl -fsSL https://raw.githubusercontent.com/mubaiqq/iot-platform/main/scripts/update.sh | bash
```

### 9.2 更新脚本行为

`update.sh` 会：

1. `git fetch origin main`
2. `git reset --hard origin/main`
3. 保留服务器现有 `.env`
4. 保留 Docker MySQL 数据卷
5. `docker compose up -d --build`
6. 清理悬空镜像

### 9.3 更新前检查

推送 GitHub 前，本地必须执行：

```bash
node -c app.js
node -c mqtt_handler.js
bash -n scripts/deploy.sh
bash -n scripts/update.sh
```

如修改 Docker Compose：

```bash
python3 - <<'PY'
import yaml
with open('docker-compose.yml') as f:
    yaml.safe_load(f)
print('compose yaml ok')
PY
```

### 9.4 数据库变更注意

如果改了数据库结构，必须考虑老部署的数据迁移。

不能只依赖：

```text
docker/mysql/init/001-schema.sql
```

因为它只会在首次创建 MySQL 数据卷时执行。

## 10. 运维命令

进入部署目录：

```bash
cd /opt/iot-platform
```

查看容器：

```bash
docker compose ps
```

查看应用日志：

```bash
docker compose logs -f app
```

查看 MySQL 日志：

```bash
docker compose logs -f mysql
```

重启应用：

```bash
docker compose restart app
```

重启全部：

```bash
docker compose restart
```

停止服务但保留数据：

```bash
docker compose down
```

危险：删除数据库数据卷会清空数据，不要随便执行：

```bash
docker compose down -v
```

## 11. 发布到 GitHub 流程

```bash
cd /home/ubuntu/iot-platform

git status --short
node -c app.js
node -c mqtt_handler.js
bash -n scripts/deploy.sh
bash -n scripts/update.sh

git add <changed-files>
git commit -m "Update xxx"
git push
```

注意：`framework.zip` 等生成文件保持未跟踪，不提交。

## 12. 故障排查

### 12.1 页面打不开

```bash
cd /opt/iot-platform
docker compose ps
docker compose logs -f app
```

### 12.2 数据库未就绪

```bash
docker compose logs -f mysql
```

确认 MySQL 健康检查通过后，app 容器会自动启动。

### 12.3 MQTT 不通

检查后台 MQTT 配置：

```text
mqtt_broker = mqtt.mcoud.cn
mqtt_port = 1883
mqtt_protocol = mqtt
```

前端浏览器 MQTT 使用：

```text
wss://mqtt.mcoud.cn/mqtt
```

### 12.4 API Key 不生效

- 管理员官方配置在 `settings` 表。
- 用户自定义配置在 `user_settings` 或 `llm_configs` 中。
- VIP 过期用户不能继续使用官方天气和官方大模型。

## 13. 代码质量底线

- 不提交不能启动的代码。
- 不提交敏感配置。
- 不破坏设备 MQTT topic 和 payload 格式。
- 不随意改 ESP32 固件协议，改协议必须同步更新：
  - `public/esp32_firmware.ino`
  - `public/esp32_sensor_firmware.ino`
  - 对应说明页面
  - `mqtt_handler.js`
  - 模拟器页面
- 修改 UI 前优先备份线上文件；Git 开发分支中则通过提交历史回滚。
