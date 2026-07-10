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
- MySQL
- MQTT.js
- PM2
- 前端为静态 HTML/CSS/JS

## 本地启动

```bash
npm install
node app.js
```

生产环境建议使用 PM2：

```bash
pm2 start app.js --name iot-platform --cwd /path/to/iot-platform
pm2 save
```

## 注意

- 本仓库不包含 `node_modules/`、`backups/`、`.env`、上传文件等运行时内容。
- 数据库结构和线上配置需要单独准备。
- 管理员全局 API Key / 用户自定义 API Key 均存数据库，不应提交到 GitHub。
