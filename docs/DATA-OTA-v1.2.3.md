# 木白云 IoT v1.2.3 商用数据与 OTA 说明

## 传感器数据

- 控制器和传感器通过 MQTT `device/{code}/heartbeat` 上报的非空 `sensor_data` 都会写入 `sensor_data_history`。
- 兼容保留的 HTTP 心跳接口同样写入历史记录。
- `devices.sensor_data` 保存最新快照；`sensor_data_history` 保存曲线原始点。
- 平台每小时清理超过 30 天的数据，单批最多删除 10000 条，避免长事务。
- 用户 API：
  - `GET /api/data/realtime`
  - `GET /api/data/history?device_id={id}&hours=1..720`
- 用户端“实时数据”每 5 秒刷新；“历史数据”支持 6小时、24小时、7天、30天，查询条件自动保存并按指标独立展示。

## ESP32 配网热点

控制器和传感器固件都实现 `stopAP()`。设备从 AP+STA 模式恢复到 STA 联网后，会停止 DNS/WebServer、执行 `WiFi.softAPdisconnect(true)` 并切回 `WIFI_STA`，不会继续广播配网热点。

## OTA 升级

1. 管理员进入“系统管理 → 版本管理”。
2. 选择控制器或传感器，填写语义版本号和更新说明，上传 Arduino 编译产生的 `.bin`。
3. 平台检查文件大小、ESP32 image magic `0xE9`，计算并保存 SHA-256。
4. 用户进入设备详情，点击管理菜单最后的“关于”。页面显示当前版本、最新版本和全部历史说明。
5. 点击更新后，平台按设备 ID、设备码和类型下发 MQTT `ota` 命令；设备通过 HTTPS 下载、校验 SHA-256 后使用 ESP32 `Update` 写入，状态通过 `ota_status` 上报。
6. 成功状态会更新 `devices.firmware_version`，并写入设备 OTA 日志。

### OTA 安全与操作注意

- 控制器固件不能下发给传感器，反之亦然。
- 固件文件最大 16MB，数据库中保存 SHA-256 和不可预测下载令牌。
- 首次启用当前加固 OTA 前，必须先通过 USB 烧录支持设备绑定和 SHA-256 校验的 v1.2.3 固件；旧固件本身无法执行该协议。
- 升级期间保持稳定电源与网络，不要断电。
- 当前设备端会计算并比对下载固件 SHA-256，下载 URL 绑定目标设备。TLS 当前仍使用兼容模式 `setInsecure()`，因此尚未达到证书校验级别；高安全部署应进一步加入 CA/公钥固定或固件签名验证。

## 一键更新与数据库迁移

- Docker 一键更新执行 `docker compose up -d --build`，应用容器启动时会自动运行幂等迁移。
- 宿主机一键更新安装依赖并重启 PM2，应用启动时同样自动运行幂等迁移。
- 当前自动迁移会创建 `sensor_data_history`、`firmware_versions`，并在旧 `devices` 表缺少时添加 `firmware_version` 字段。
- `docker/mysql/init/001-schema.sql` 负责全新数据库初始化；已有数据库不会依赖该初始化脚本重复执行，而由 `app.js` 启动迁移补齐。

## 导航变化

首页工作台已经包含完整设备列表，因此用户侧栏“我的设备”入口已移除。设备删除成功后会返回并刷新工作台。
