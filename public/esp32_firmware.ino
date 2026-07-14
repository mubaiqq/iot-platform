// ============================================
// 木白云IoT - ESP32 控制器固件 v1.2.3
// 功能：AP配网 + MQTT通信 + 浇水控制 + 计划任务 + HTTPS OTA
// v1.2.3：每次心跳上报版本；OTA绑定设备/类型并校验下载SHA-256
// ============================================

#include <WiFi.h>
#include <WebServer.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <DNSServer.h>
#include <time.h>
#include <esp_task_wdt.h>
#include <esp_system.h>
#include <esp_idf_version.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Update.h>
#include <mbedtls/sha256.h>
#include <mbedtls/pk.h>
#include <mbedtls/base64.h>

// ========== 配置区域 ==========
const char* MQTT_SERVER = "mqtt.mcoud.cn";
const int MQTT_PORT = 1883;
const char* FIRMWARE_VERSION = "1.2.3";
const char OTA_SIGNING_PUBLIC_KEY[] = R"KEY(-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVIKcfGg2ukVtbBbU4OSVwyyZGtwV
/YRNeFHsQE9OAQPPono4I5uw5NSWUMn5SIL8eVKVHSG/gX/GrmGcPKKYtA==
-----END PUBLIC KEY-----
)KEY";
#define RELAY_PIN 16
#define RELAY_ACTIVE_LEVEL HIGH
#define RELAY_INACTIVE_LEVEL LOW
#define HEARTBEAT_INTERVAL 30000
// NTP服务器（北京时间 UTC+8）
#define NTP_SERVER "ntp.aliyun.com"
#define GMT_OFFSET_SEC (8 * 3600)
#define DAYLIGHT_OFFSET_SEC 0
#define WIFI_RECONNECT_INTERVAL 10000
#define WIFI_RECONNECT_AP_AFTER 10
#define MQTT_RECONNECT_INTERVAL 5000
#define MQTT_SOCKET_TIMEOUT 3
#define MQTT_KEEPALIVE 30
#define WDT_TIMEOUT_SECONDS 15
#define MAX_WATERING_SECONDS 600
#define AUTO_COOLDOWN_MULTIPLIER 3
#define SCHEDULE_MISSED_GRACE_MINUTES 0
#define REPORT_RETRY_INTERVAL 10000
// 计划任务检查间隔(毫秒)
#define SCHEDULE_CHECK_INTERVAL 10000
// ==============================

// 前向声明
bool startWatering(int seconds, bool isSchedule);
void stopWatering();
void reportWateringResult(int duration, bool isSchedule);
void publishWateringStarted(int duration, bool isSchedule);
void handleSafetyTimers();
void publishStatusEvent(const char* event, bool success, const char* reason);
bool requestAIWatering(int duration, bool isRetry);
int getCurrentMinuteOfDay();
int parseTimeToMinute(const char* hm);
void setupWatchdog();
void flushPendingReports();
void handleSerialCommands();
void factoryReset();
void stopAP();
void performOTA(const String& url, const String& version, const String& expectedSha256, int versionId);
bool verifyOTACommandSignature(const String& targetDevice, const String& targetType, const String& version, const String& sha256, int versionId, const String& signature);
bool isNewerFirmwareVersion(const String& candidate);

WiFiClient espClient;
PubSubClient mqtt(espClient);
WebServer server(80);
Preferences prefs;
DNSServer dnsServer;

// 设备信息
String deviceCode = "";
String username = "";
String wifiSSID = "";
String wifiPass = "";
String mqttHost = MQTT_SERVER;
bool isConfigured = false;
bool isWatering = false;
unsigned long wateringStartTime = 0;
unsigned long wateringEndTime = 0;
unsigned long lastHeartbeat = 0;
int heartbeatCount = 0;
int currentWateringDuration = 0;
bool currentWateringIsSchedule = false;
String currentWateringRequestId = "";
String currentWateringSource = "";
String nextWateringRequestId = "";
String nextWateringSource = "";
bool pendingWateringReport = false;
int pendingWateringDuration = 0;
bool pendingWateringIsSchedule = false;
String pendingWateringRequestId = "";
String pendingWateringSource = "";
bool lastStartWateringSucceeded = false;
unsigned long lastReportRetry = 0;
bool apStarted = false;
unsigned long lastWifiReconnect = 0;
int wifiReconnectAttempts = 0;
unsigned long lastAutoWateringEnd = 0;
unsigned long autoCooldownUntil = 0;

// ========== 计划任务 ==========
#define MAX_SCHEDULES 10
struct ScheduleTask {
  char time[6];      // "HH:MM"
  int duration;       // 浇水秒数
  bool enabled;
  bool fixedWatering; // true=固定, false=智能
};
ScheduleTask schedules[MAX_SCHEDULES];
int scheduleCount = 0;
bool executedToday[MAX_SCHEDULES]; // 今天是否已执行
int lastCheckedDay = -1;           // 用于日期翻转重置
unsigned long lastScheduleCheck = 0;

// 智能浇水等待状态（支持重试）
bool waitingForAI = false;
unsigned long aiWaitStartTime = 0;
int aiRetryCount = 0;           // 0=首次, 1=第一次重试, 2=放弃
int aiPendingDuration = 0;      // 待执行的浇水时长
String aiRequestId = "";
#define AI_WAIT_FIRST  60000    // 首次等待60秒
#define AI_WAIT_RETRY  100000   // 重试等待100秒
#define AI_MAX_RETRIES 1        // 最多重试1次（共请求2次）

// ========== NTP时间 ==========
void syncTime() {
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
  Serial.println("[NTP] 同步时间中...");
  int retry = 0;
  struct tm t;
  while (!getLocalTime(&t) && retry < 20) {
    esp_task_wdt_reset();
    delay(500);
    retry++;
  }
  if (getLocalTime(&t)) {
    Serial.printf("[NTP] 当前时间: %04d-%02d-%02d %02d:%02d:%02d\n",
      t.tm_year+1900, t.tm_mon+1, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec);
  } else {
    Serial.println("[NTP] 时间同步失败");
  }
}

// 获取当前 "HH:MM" 字符串
String getCurrentTimeHM() {
  struct tm t;
  if (!getLocalTime(&t)) return "??:??";
  char buf[6];
  snprintf(buf, sizeof(buf), "%02d:%02d", t.tm_hour, t.tm_min);
  return String(buf);
}

int getCurrentDay() {
  struct tm t;
  if (!getLocalTime(&t)) return -1;
  return t.tm_mday;
}

int getCurrentMinuteOfDay() {
  struct tm t;
  if (!getLocalTime(&t)) return -1;
  return t.tm_hour * 60 + t.tm_min;
}

int parseTimeToMinute(const char* hm) {
  if (!hm || strlen(hm) != 5 || hm[2] != ':') return -1;
  if (!isDigit(hm[0]) || !isDigit(hm[1]) || !isDigit(hm[3]) || !isDigit(hm[4])) return -1;
  int hour = (hm[0] - '0') * 10 + (hm[1] - '0');
  int minute = (hm[3] - '0') * 10 + (hm[4] - '0');
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return -1;
  return hour * 60 + minute;
}

void handleSafetyTimers() {
  if (isWatering && wateringStartTime > 0 && millis() - wateringStartTime >= (unsigned long)MAX_WATERING_SECONDS * 1000UL) {
    Serial.println("[安全] 达到最大浇水时长600秒，强制关闭继电器");
    stopWatering();
    return;
  }
  if (isWatering && (long)(millis() - wateringEndTime) >= 0) {
    stopWatering();
  }
}

void publishStatusEvent(const char* event, bool success, const char* reason) {
  if (!mqtt.connected()) return;
  DynamicJsonDocument doc(192);
  doc["event"] = event;
  doc["success"] = success;
  if (reason && reason[0]) doc["reason"] = reason;
  String out;
  serializeJson(doc, out);
  String topic = "device/" + deviceCode + "/status";
  mqtt.publish(topic.c_str(), out.c_str(), false);
}

bool isAutoSource(const String& source) {
  return source == "auto" || source == "ai" || source == "schedule_ai";
}

bool isInAutoCooldown() {
  if (lastAutoWateringEnd == 0) return false;
  return (long)(millis() - autoCooldownUntil) < 0;
}

void setRelayOn() {
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LEVEL);
}

void setRelayOff() {
  digitalWrite(RELAY_PIN, RELAY_INACTIVE_LEVEL);
}

void setupWatchdog() {
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t wdtConfig = {};
  wdtConfig.timeout_ms = WDT_TIMEOUT_SECONDS * 1000;
  wdtConfig.idle_core_mask = (1 << portNUM_PROCESSORS) - 1;
  wdtConfig.trigger_panic = true;
  esp_task_wdt_init(&wdtConfig);
#else
  esp_task_wdt_init(WDT_TIMEOUT_SECONDS, true);
#endif
  esp_task_wdt_add(NULL);
}

// ========== 设备码生成 ==========
String generateDeviceCode() {
  String code = "K";
  const char chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (int i = 0; i < 10; i++) {
    code += chars[esp_random() % (sizeof(chars) - 1)];
  }
  return code;
}

// ========== 保存/加载计划任务到NVS ==========
void saveSchedulesToNVS() {
  prefs.begin("iot", false);
  prefs.putInt("sch_count", scheduleCount);
  for (int i = 0; i < scheduleCount; i++) {
    String key = "sch" + String(i);
    // 打包为JSON字符串存储
    DynamicJsonDocument doc(128);
    doc["t"] = schedules[i].time;
    doc["d"] = schedules[i].duration;
    doc["e"] = schedules[i].enabled;
    doc["f"] = schedules[i].fixedWatering;
    String json;
    serializeJson(doc, json);
    prefs.putString(key.c_str(), json);
  }
  prefs.end();
  Serial.println("[计划] 已保存 " + String(scheduleCount) + " 个任务到NVS");
}

void loadSchedulesFromNVS() {
  prefs.begin("iot", true);
  scheduleCount = prefs.getInt("sch_count", 0);
  if (scheduleCount > MAX_SCHEDULES) scheduleCount = MAX_SCHEDULES;
  for (int i = 0; i < scheduleCount; i++) {
    String key = "sch" + String(i);
    String json = prefs.getString(key.c_str(), "{}");
    DynamicJsonDocument doc(128);
    if (deserializeJson(doc, json)) continue;
    strlcpy(schedules[i].time, doc["t"] | "08:00", sizeof(schedules[i].time));
    schedules[i].duration = doc["d"] | 30;
    if (schedules[i].duration < 1) schedules[i].duration = 30;
    if (schedules[i].duration > MAX_WATERING_SECONDS) schedules[i].duration = MAX_WATERING_SECONDS;
    schedules[i].enabled = doc["e"] | true;
    schedules[i].fixedWatering = doc["f"] | false;
  }
  prefs.end();
  // 初始化执行标记
  for (int i = 0; i < MAX_SCHEDULES; i++) executedToday[i] = false;
  Serial.println("[计划] 从NVS加载 " + String(scheduleCount) + " 个任务");
}

// ========== WiFi扫描 ==========
String scanWiFi() {
  int n = WiFi.scanNetworks();
  DynamicJsonDocument doc(2048);
  JsonArray arr = doc.to<JsonArray>();
  for (int i = 0; i < n; i++) {
    JsonObject obj = arr.createNestedObject();
    obj["ssid"] = WiFi.SSID(i);
    obj["rssi"] = WiFi.RSSI(i);
    obj["enc"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
  }
  String json;
  serializeJson(doc, json);
  return json;
}

// ========== AP配网页面 ==========
void handleRoot() {
  String html = R"rawliteral(
<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>木白云IoT 配网</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#f5f6fa;color:#1e293b;padding:16px;min-height:100vh}
.card{background:#fff;border-radius:14px;padding:18px;margin:0 auto 14px;box-shadow:0 2px 8px rgba(0,0,0,.06);max-width:480px}
h2{font-size:20px;margin-bottom:4px;display:flex;align-items:center;gap:8px}
h2 i{color:#3b82f6}
.desc{font-size:12px;color:#94a3b8;margin-bottom:16px}
label{font-size:13px;font-weight:500;color:#475569;display:block;margin-bottom:4px;margin-top:12px}
label:first-child{margin-top:0}
input,select{width:100%;height:44px;border:1.5px solid #e2e8f0;border-radius:8px;padding:0 12px;font-size:16px;outline:none;background:#fff}
input:focus,select:focus{border-color:#3b82f6}
.btn{width:100%;height:44px;border:none;border-radius:10px;background:#3b82f6;color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-top:16px}
.btn:hover{background:#2563eb}
.btn:disabled{opacity:.5;cursor:not-allowed}
.wifi-list{margin:8px 0;max-height:240px;overflow-y:auto;-webkit-overflow-scrolling:touch;border:1.5px solid #e2e8f0;border-radius:10px;padding:6px;background:#f8fafc}
.wifi-item{display:flex;align-items:center;gap:8px;padding:10px;border:1.5px solid #e2e8f0;border-radius:8px;margin-bottom:6px;cursor:pointer;transition:all .2s}
.wifi-item:last-child{margin-bottom:0}
.wifi-item:hover,.wifi-item.selected{border-color:#3b82f6;background:#eff6ff}
.wifi-item .ssid{flex:1;min-width:0;font-weight:500;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wifi-item .rssi{font-size:11px;color:#94a3b8}
.wifi-item .lock{color:#94a3b8;font-size:12px}
.hint{font-size:11px;color:#94a3b8;margin-top:4px}
.ok{background:#dcfce7;border:1px solid #86efac;color:#166534;border-radius:10px;padding:14px;text-align:center;display:none}
.ok i{font-size:32px;display:block;margin-bottom:8px;color:#16a34a}
</style></head><body>
<div class="card">
  <h2><i class="fas fa-microchip"></i> 木白云IoT 配网</h2>
  <div class="desc">选择WiFi并配置平台信息</div>
  <label>WiFi网络</label>
  <div class="wifi-list" id="wifiList"><div class="hint">正在扫描...</div></div>
  <label>WiFi密码</label>
  <input type="password" id="wifiPass" placeholder="输入WiFi密码">
  <label>MQTT服务器</label>
  <input type="text" id="mqttServer" value="MQTT_SERVER_PLACEHOLDER">
  <div class="hint">MQTT Broker 地址</div>
  <label>用户名 <span style="color:#94a3b8;font-weight:400">(选填)</span></label>
  <input type="text" id="username" placeholder="平台用户名，填了会自动绑定">
  <div class="hint">填写后设备会自动关联到你的账号</div>
  <button class="btn" id="submitBtn" onclick="submit()">保存并连接</button>
</div>
<div class="card ok" id="okCard">
  <i class="fas fa-check-circle"></i>
  <div style="font-size:16px;font-weight:600">配置成功！</div>
  <div style="font-size:13px;color:#94a3b8;margin-top:4px">设备正在连接WiFi和平台...</div>
  <div style="font-size:12px;color:#64748b;margin-top:8px">设备码：<b id="devCode"></b></div>
  <div style="font-size:12px;color:#166534;margin-top:8px;font-weight:700">复制设备码去平台绑定，如已填写用户名则忽略。</div>
</div>
<script>
var selectedSSID = "";
function scanWifi() {
  fetch('/scan').then(r=>r.json()).then(list => {
    var html = '';
    list.forEach(function(w) {
      html += '<div class="wifi-item" onclick="selectWifi(this,\'' + w.ssid.replace(/'/g,"\\'") + '\')">' +
        '<i class="fas fa-wifi" style="color:#3b82f6"></i>' +
        '<span class="ssid">' + w.ssid + '</span>' +
        '<span class="rssi">' + w.rssi + 'dBm</span>' +
        (w.enc ? '<i class="fas fa-lock lock"></i>' : '') +
        '</div>';
    });
    document.getElementById('wifiList').innerHTML = html || '<div class="hint">未发现WiFi</div>';
  }).catch(function() {
    document.getElementById('wifiList').innerHTML = '<div class="hint">扫描失败，刷新重试</div>';
  });
}
function selectWifi(el, ssid) {
  document.querySelectorAll('.wifi-item').forEach(function(e){e.classList.remove('selected')});
  el.classList.add('selected');
  selectedSSID = ssid;
}
function submit() {
  if (!selectedSSID) { alert('请选择WiFi'); return; }
  var pass = document.getElementById('wifiPass').value;
  var mqtt = document.getElementById('mqttServer').value.trim();
  var user = document.getElementById('username').value.trim();
  if (!mqtt) { alert('请填写MQTT服务器'); return; }
  document.getElementById('submitBtn').disabled = true;
  document.getElementById('submitBtn').textContent = '保存中...';
  fetch('/save', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ssid:selectedSSID,pass:pass,mqtt:mqtt,username:user})
  }).then(r=>r.json()).then(function(d) {
    if (d.success) {
      document.getElementById('devCode').textContent = d.device_code;
      document.getElementById('okCard').style.display = 'block';
      document.querySelector('.card:first-child').style.display = 'none';
    } else {
      alert('保存失败: ' + (d.error||'未知错误'));
      document.getElementById('submitBtn').disabled = false;
      document.getElementById('submitBtn').textContent = '保存并连接';
    }
  }).catch(function() {
    alert('网络错误');
    document.getElementById('submitBtn').disabled = false;
    document.getElementById('submitBtn').textContent = '保存并连接';
  });
}
scanWifi();
</script></body></html>
)rawliteral";
  html.replace("MQTT_SERVER_PLACEHOLDER", MQTT_SERVER);
  server.send(200, "text/html", html);
}

void handleScan() {
  server.send(200, "application/json", scanWiFi());
}

void handleSave() {
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"no data\"}");
    return;
  }
  DynamicJsonDocument doc(1024);
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"bad json\"}");
    return;
  }
  wifiSSID = doc["ssid"].as<String>();
  wifiPass = doc["pass"].as<String>();
  String mqttSrv = doc["mqtt"].as<String>();
  username = doc["username"].as<String>();
  wifiSSID.trim();
  mqttSrv.trim();
  if (wifiSSID.length() == 0 || mqttSrv.length() == 0) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"ssid and mqtt required\"}");
    return;
  }
  deviceCode = generateDeviceCode();

  prefs.begin("iot", false);
  prefs.putString("ssid", wifiSSID);
  prefs.putString("pass", wifiPass);
  prefs.putString("mqtt", mqttSrv);
  prefs.putString("code", deviceCode);
  prefs.putString("user", username);
  prefs.putBool("configured", true);
  prefs.end();

  DynamicJsonDocument resp(256);
  resp["success"] = true;
  resp["device_code"] = deviceCode;
  String out;
  serializeJson(resp, out);
  server.send(200, "application/json", out);
  delay(2000);
  ESP.restart();
}

// ========== AP配网模式 ==========
void startAP() {
  if (apStarted) return;
  apStarted = true;
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP("木白云IoT-配网", "12345678");
  dnsServer.start(53, "*", WiFi.softAPIP());
  server.on("/", handleRoot);
  server.on("/scan", handleScan);
  server.on("/save", HTTP_POST, handleSave);
  server.begin();
  Serial.println("[配网] AP模式已启动: 木白云IoT-配网");
  Serial.println("[配网] 访问: http://" + WiFi.softAPIP().toString());
}

void stopAP() {
  if (!apStarted) return;
  dnsServer.stop(); server.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  apStarted = false;
  Serial.println("[配网] STA已恢复，配网热点已关闭");
}

void publishOTAStatus(const char* status, const String& version, const String& message, int versionId = 0) {
  if (!mqtt.connected()) return;
  DynamicJsonDocument doc(256);
  doc["event"] = "ota_status"; doc["status"] = status; doc["version"] = version; doc["version_id"] = versionId; doc["message"] = message;
  String out; serializeJson(doc, out);
  String topic = "device/" + deviceCode + "/status";
  mqtt.publish(topic.c_str(), out.c_str());
}

bool verifyOTACommandSignature(const String& targetDevice, const String& targetType, const String& version, const String& sha256, int versionId, const String& signature) {
  if (signature.length() < 80 || signature.length() > 128) return false;
  String canonical = targetDevice + "|" + targetType + "|" + version + "|" + sha256 + "|" + String(versionId);
  unsigned char hash[32];
  mbedtls_sha256_ret((const unsigned char*)canonical.c_str(), canonical.length(), hash, 0);
  unsigned char decoded[96]; size_t decodedLen = 0;
  if (mbedtls_base64_decode(decoded, sizeof(decoded), &decodedLen, (const unsigned char*)signature.c_str(), signature.length()) != 0) return false;
  mbedtls_pk_context key; mbedtls_pk_init(&key);
  int parsed = mbedtls_pk_parse_public_key(&key, (const unsigned char*)OTA_SIGNING_PUBLIC_KEY, strlen(OTA_SIGNING_PUBLIC_KEY) + 1);
  int verified = parsed == 0 ? mbedtls_pk_verify(&key, MBEDTLS_MD_SHA256, hash, sizeof(hash), decoded, decodedLen) : -1;
  mbedtls_pk_free(&key);
  return verified == 0;
}

bool isNewerFirmwareVersion(const String& candidate) {
  int c1, c2, c3, f1, f2, f3;
  if (sscanf(candidate.c_str(), "%d.%d.%d", &c1, &c2, &c3) != 3 || sscanf(FIRMWARE_VERSION, "%d.%d.%d", &f1, &f2, &f3) != 3) return false;
  if (c1 != f1) return c1 > f1;
  if (c2 != f2) return c2 > f2;
  return c3 > f3;
}

void performOTA(const String& url, const String& version, const String& expectedSha256, int versionId) {
  if (url.length() == 0 || version.length() == 0 || expectedSha256.length() != 64 || !isNewerFirmwareVersion(version)) {
    publishOTAStatus("failed", version, "升级参数无效或版本不高于当前版本", versionId); return;
  }
  if (isWatering || waitingForAI) { publishOTAStatus("failed", version, "设备正在浇水或等待AI，拒绝升级", versionId); return; }
  publishOTAStatus("downloading", version, "开始下载固件", versionId);
  WiFiClientSecure secureClient; secureClient.setInsecure();
  HTTPClient http;
  http.setConnectTimeout(10000); http.setTimeout(30000);
  if (!http.begin(secureClient, url)) { publishOTAStatus("failed", version, "无法打开下载地址", versionId); return; }
  int code = http.GET(); int length = http.getSize();
  if (code != HTTP_CODE_OK || length <= 0) { publishOTAStatus("failed", version, "固件下载失败", versionId); http.end(); return; }
  if (!Update.begin(length)) { publishOTAStatus("failed", version, "升级空间不足", versionId); http.end(); return; }
  publishOTAStatus("installing", version, "正在校验并写入固件", versionId);
  WiFiClient* stream = http.getStreamPtr();
  mbedtls_sha256_context shaCtx; mbedtls_sha256_init(&shaCtx); mbedtls_sha256_starts_ret(&shaCtx, 0);
  uint8_t buffer[1024]; size_t written = 0;
  while (http.connected() && written < (size_t)length) {
    size_t available = stream->available();
    if (!available) { delay(1); esp_task_wdt_reset(); continue; }
    size_t readLen = stream->readBytes(buffer, min(available, sizeof(buffer)));
    if (!readLen) break;
    mbedtls_sha256_update_ret(&shaCtx, buffer, readLen);
    if (Update.write(buffer, readLen) != readLen) break;
    written += readLen; esp_task_wdt_reset();
  }
  unsigned char digest[32]; mbedtls_sha256_finish_ret(&shaCtx, digest); mbedtls_sha256_free(&shaCtx);
  String actualSha; for (int i=0;i<32;i++){ if(digest[i]<16) actualSha += "0"; actualSha += String(digest[i], HEX); }
  bool hashOK = actualSha.equalsIgnoreCase(expectedSha256);
  bool ok = written == (size_t)length && hashOK && Update.end(true) && Update.isFinished();
  http.end();
  if (!ok) { Update.abort(); publishOTAStatus("failed", version, hashOK ? "固件写入失败" : "固件SHA-256校验失败", versionId); return; }
  publishOTAStatus("success", version, "升级成功，设备即将重启", versionId);
  delay(1200); ESP.restart();
}

// ========== 发送浇水执行结果 ==========
void reportWateringResult(int duration, bool isSchedule) {
  String reportRequestId = currentWateringRequestId.length() ? currentWateringRequestId : pendingWateringRequestId;
  String reportSource = currentWateringSource.length() ? currentWateringSource : pendingWateringSource;
  if (reportRequestId.length() == 0) reportRequestId = String((uint32_t)esp_random(), HEX);
  if (reportSource.length() == 0) reportSource = isSchedule ? "schedule" : "manual";
  if (!mqtt.connected()) {
    pendingWateringReport = true;
    pendingWateringDuration = duration;
    pendingWateringIsSchedule = isSchedule;
    pendingWateringRequestId = reportRequestId;
    pendingWateringSource = reportSource;
    lastReportRetry = millis();
    return;
  }
  DynamicJsonDocument doc(256);
  doc["event"] = "watering_complete";
  doc["request_id"] = reportRequestId;
  doc["timestamp"] = "";
  doc["duration"] = duration;
  doc["source"] = reportSource;
  String out;
  serializeJson(doc, out);
  String topic = "device/" + deviceCode + "/watering_complete";
  if (mqtt.publish(topic.c_str(), out.c_str(), false)) {
    pendingWateringReport = false;
    pendingWateringRequestId = "";
    pendingWateringSource = "";
  } else {
    pendingWateringReport = true;
    pendingWateringDuration = duration;
    pendingWateringIsSchedule = isSchedule;
    pendingWateringRequestId = reportRequestId;
    pendingWateringSource = reportSource;
    lastReportRetry = millis();
  }
  Serial.println("[报告] 已发送执行结果: " + String(duration) + "秒, 来源=" + (isSchedule?"计划":"手动"));
}

void publishWateringStarted(int duration, bool isSchedule) {
  if (!mqtt.connected()) return;
  DynamicJsonDocument doc(256);
  doc["event"] = "watering_started";
  doc["success"] = true;
  doc["water"] = true;
  if (currentWateringRequestId.length() && currentWateringRequestId != "null") doc["request_id"] = currentWateringRequestId;
  doc["duration"] = duration;
  doc["source"] = currentWateringSource.length() ? currentWateringSource : (isSchedule ? "schedule" : "manual");
  String out;
  serializeJson(doc, out);
  String topic = "device/" + deviceCode + "/status";
  bool ok = mqtt.publish(topic.c_str(), out.c_str(), false);
  Serial.println(String("[status] watering_started publish ") + (ok ? "ok: " : "failed: ") + out);
}

void flushPendingReports() {
  if (pendingWateringReport && mqtt.connected() && millis() - lastReportRetry > REPORT_RETRY_INTERVAL) {
    lastReportRetry = millis();
    reportWateringResult(pendingWateringDuration, pendingWateringIsSchedule);
  }
}

// ========== 发送智能浇水请求 ==========
bool requestAIWatering(int duration, bool isRetry) {
  if (!mqtt.connected()) return false;
  if (!isRetry) aiRequestId = String((uint32_t)esp_random(), HEX);
  DynamicJsonDocument doc(256);
  doc["device_code"] = deviceCode;
  doc["request_id"] = aiRequestId;
  doc["request_type"] = "schedule";
  doc["duration"] = duration;
  if (isRetry) doc["retry"] = aiRetryCount;
  String out;
  serializeJson(doc, out);
  String topic = "device/" + deviceCode + "/watering_request";
  bool ok = mqtt.publish(topic.c_str(), out.c_str(), false);
  if (!ok) {
    Serial.println("[智能] AI浇水请求发布失败，不进入等待状态");
    return false;
  }
  waitingForAI = true;
  aiWaitStartTime = millis();
  aiPendingDuration = duration;
  int waitSec = isRetry ? (AI_WAIT_RETRY/1000) : (AI_WAIT_FIRST/1000);
  Serial.println("[智能] " + String(isRetry?"重试":"首次") + "请求AI浇水, 等待" + String(waitSec) + "秒 (第" + String(aiRetryCount+1) + "次)");
  return true;
}

// ========== 上报AI请求失败日志 ==========
void reportAIError(int duration, int retries) {
  if (!mqtt.connected()) return;
  DynamicJsonDocument doc(256);
  doc["event"] = "watering_failed";
  doc["timestamp"] = "";
  doc["duration"] = duration;
  doc["source"] = "schedule_ai_failed";
  doc["error"] = "AI响应超时, 已重试" + String(retries) + "次";
  String out;
  serializeJson(doc, out);
  String topic = "device/" + deviceCode + "/watering_complete";
  mqtt.publish(topic.c_str(), out.c_str(), false);
  Serial.println("[智能] AI请求彻底失败, 已上报错误日志");
}

// ========== 计划任务检查 ==========
void checkSchedules() {
  if (scheduleCount == 0) return;

  int today = getCurrentDay();
  // 日期翻转，重置执行标记
  if (today != lastCheckedDay && today > 0) {
    lastCheckedDay = today;
    for (int i = 0; i < MAX_SCHEDULES; i++) executedToday[i] = false;
    Serial.println("[计划] 新的一天，重置执行标记");
  }

  String now = getCurrentTimeHM();
  int nowMinute = getCurrentMinuteOfDay();
  if (now.indexOf("?") >= 0 || nowMinute < 0) return; // 时间未同步

  for (int i = 0; i < scheduleCount; i++) {
    if (!schedules[i].enabled) continue;
    if (executedToday[i]) continue;
    int taskMinute = parseTimeToMinute(schedules[i].time);
    if (taskMinute < 0) {
      executedToday[i] = true;
      continue;
    }
    int lateMinutes = nowMinute - taskMinute;
    if (lateMinutes < 0) continue;
    // 浇水设备不补执行错过的计划：只在计划所在分钟执行，重启后超过该分钟直接跳过
    if (lateMinutes > SCHEDULE_MISSED_GRACE_MINUTES) {
      Serial.println("[计划] #" + String(i+1) + " 已错过 " + String(lateMinutes) + " 分钟，跳过不补执行");
      executedToday[i] = true;
      continue;
    }

    // 到达计划时间！
    Serial.println("[计划] #" + String(i+1) + " 到达时间 " + now + ", fixed=" + (schedules[i].fixedWatering?"是":"否"));

    if (isWatering || waitingForAI) {
      // 用户要求：手动浇水中触发计划任务时直接跳过；AI等待中也避免覆盖旧请求
      executedToday[i] = true;
      Serial.println("[计划] 当前忙碌，跳过本次计划任务");
      break;
    }

    if (schedules[i].fixedWatering) {
      // 固定浇水：直接执行
      nextWateringRequestId = String((uint32_t)esp_random(), HEX);
      nextWateringSource = "schedule_fixed";
      if (startWatering(schedules[i].duration, true)) {
        executedToday[i] = true;
      } else {
        nextWateringRequestId = "";
        nextWateringSource = "";
      }
    } else {
      // 智能浇水：请求AI判断
      aiRetryCount = 0;
      if (requestAIWatering(schedules[i].duration, false)) {
        executedToday[i] = true;
      }
    }
    // 一次只触发一个任务，避免同时浇水
    break;
  }
}

// ========== MQTT回调 ==========
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }
  Serial.println("[MQTT] 收到: " + msg);

  DynamicJsonDocument doc(1024);
  DeserializationError err = deserializeJson(doc, msg);
  if (err) return;

  // 处理浇水指令 {water:true, duration:30}
  if (doc.containsKey("water")) {
    bool incomingWater = doc["water"].as<bool>();

    if (waitingForAI && doc.containsKey("request_id")) {
      String replyId = doc["request_id"].as<String>();
      if (replyId != aiRequestId) {
        Serial.println("[AI] 忽略过期或不匹配的AI回复: " + replyId);
        return;
      }
    } else if (waitingForAI && !incomingWater) {
      // 没有 request_id 的 water:false 不能取消正在等待的AI请求，避免旧消息/手动停止误取消计划AI
      Serial.println("[AI] 忽略无request_id的water=false，当前正在等待AI request_id=" + aiRequestId);
      setRelayOff();
      return;
    }

    if (incomingWater) {
      int duration = doc["duration"].as<int>();
      if (duration < 1) duration = 30;
      if (duration > MAX_WATERING_SECONDS) duration = MAX_WATERING_SECONDS;
      bool isSchedule = waitingForAI && doc.containsKey("request_id"); // 只有带匹配 request_id 的AI回复才算计划
      if (isSchedule) waitingForAI = false;

      // 用户要求：计划任务浇水中收到手动浇水时不回复ACK，让网页端超时失败
      if (isWatering) {
        Serial.println("[浇水] 正在浇水中，忽略新的浇水指令且不回复ACK");
        nextWateringRequestId = "";
        nextWateringSource = "";
        return;
      }

      if (doc.containsKey("request_id")) {
        nextWateringRequestId = doc["request_id"].as<String>();
      } else {
        nextWateringRequestId = "";
      }
      if (nextWateringRequestId == "null") nextWateringRequestId = "";
      if (nextWateringRequestId.length() == 0) nextWateringRequestId = String((uint32_t)esp_random(), HEX);
      nextWateringSource = isSchedule ? "schedule_ai" : "manual";
      bool started = startWatering(duration, isSchedule);
      if (!started) {
        nextWateringRequestId = "";
        nextWateringSource = "";
        return;
      }

      // 回复确认
      String statusTopic = "device/" + deviceCode + "/status";
      DynamicJsonDocument ackDoc(128);
      ackDoc["event"] = "watering_ack";
      ackDoc["success"] = true;
      ackDoc["water"] = true;
      ackDoc["duration"] = duration;
      if (currentWateringRequestId.length() && currentWateringRequestId != "null") ackDoc["request_id"] = currentWateringRequestId;
      String ack;
      serializeJson(ackDoc, ack);
      bool ackOk = mqtt.publish(statusTopic.c_str(), ack.c_str());
      Serial.println(String("[status] watering_ack publish ") + (ackOk ? "ok: " : "failed: ") + ack);
    } else {
      // water:false 同时作为“停止/不浇水”安全指令：无论来自AI还是手动停止，都先确保继电器关闭
      Serial.println("[MQTT] 收到停止/不浇水指令: " + (doc.containsKey("reason") ? doc["reason"].as<String>() : "无原因"));
      if (isWatering) {
        Serial.println("[安全] water=false，立即停止当前浇水");
        stopWatering();
      } else {
        setRelayOff();
      }
      if (waitingForAI) {
        waitingForAI = false;
        Serial.println("[智能] AI拒绝浇水，计划任务结束");
      }

      String statusTopic = "device/" + deviceCode + "/status";
      DynamicJsonDocument ackDoc(160);
      ackDoc["event"] = "watering_ack";
      ackDoc["success"] = true;
      ackDoc["water"] = false;
      if (doc.containsKey("request_id")) ackDoc["request_id"] = doc["request_id"].as<String>();
      String ack;
      serializeJson(ackDoc, ack);
      mqtt.publish(statusTopic.c_str(), ack.c_str());
    }
    return;
  }

  if (doc.containsKey("command") && doc["command"] == "ota") {
    String targetDevice = doc["device_code"] | "";
    String targetType = doc["target_type"] | "";
    String version = doc["version"] | "";
    String sha256 = doc["sha256"] | "";
    int versionId = doc["version_id"] | 0;
    String otaSignature = doc["ota_signature"] | "";
    if (targetDevice != deviceCode || targetType != "controller") {
      publishOTAStatus("failed", version, "升级指令与当前设备不匹配", versionId); return;
    }
    if (!verifyOTACommandSignature(targetDevice, targetType, version, sha256, versionId, otaSignature)) {
      publishOTAStatus("failed", version, "升级指令签名无效", versionId); return;
    }
    performOTA(doc["url"].as<String>(), version, sha256, versionId);
    return;
  }

  // 处理计划任务同步 {command:"schedule", tasks:[...]}
  if (doc.containsKey("command") && doc["command"] == "schedule") {
    if (!doc["tasks"].is<JsonArray>()) {
      publishStatusEvent("schedule_ack", false, "tasks must be array");
      return;
    }
    JsonArray tasks = doc["tasks"].as<JsonArray>();
    scheduleCount = 0;
    for (JsonObject task : tasks) {
      if (scheduleCount >= MAX_SCHEDULES) break;
      String t = task["time"] | "08:00";
      if (parseTimeToMinute(t.c_str()) < 0) continue;
      strlcpy(schedules[scheduleCount].time, t.c_str(), sizeof(schedules[scheduleCount].time));
      schedules[scheduleCount].duration = task["duration"] | 30;
      if (schedules[scheduleCount].duration < 1) schedules[scheduleCount].duration = 30;
      if (schedules[scheduleCount].duration > MAX_WATERING_SECONDS) schedules[scheduleCount].duration = MAX_WATERING_SECONDS;
      schedules[scheduleCount].enabled = task["enabled"] | true;
      schedules[scheduleCount].fixedWatering = task["fixed_watering"] | false;
      scheduleCount++;
    }
    saveSchedulesToNVS();
    // 重置执行标记
    for (int i = 0; i < MAX_SCHEDULES; i++) executedToday[i] = false;

    String statusTopic = "device/" + deviceCode + "/status";
    DynamicJsonDocument schAck(64);
    schAck["event"] = "schedule_ack";
    schAck["success"] = true;
    schAck["count"] = scheduleCount;
    String ack;
    serializeJson(schAck, ack);
    mqtt.publish(statusTopic.c_str(), ack.c_str());
    Serial.println("[计划] 收到 " + String(scheduleCount) + " 个计划任务");
    return;
  }

  if (doc.containsKey("command") && doc["command"] == "register_ack") {
    bool success = doc["success"] | false;
    if (success) {
      prefs.begin("iot", false);
      prefs.putBool("registered", true);
      prefs.end();
      Serial.println("[MQTT] 注册已确认");
    }
  }
}

// ========== 浇水控制 ==========
bool startWatering(int seconds, bool isSchedule) {
  if (isWatering) {
    publishWateringStarted(currentWateringDuration, currentWateringIsSchedule);
    Serial.println("[浇水] 已在浇水，拒绝新的浇水指令");
    return false;
  }
  if (seconds < 1) seconds = 30;
  if (seconds > MAX_WATERING_SECONDS) seconds = MAX_WATERING_SECONDS;

  String source = nextWateringSource.length() ? nextWateringSource : (isSchedule ? "schedule" : "manual");
  if (isAutoSource(source) && isInAutoCooldown()) {
    Serial.println("[浇水] 智能浇水冷却中，拒绝自动浇水");
    publishStatusEvent("watering_ack", false, "auto watering cooldown");
    return false;
  }

  Serial.println("[浇水] 开始浇水 " + String(seconds) + "秒" + (isSchedule ? " (计划)" : " (手动)") + ", source=" + source);
  setRelayOn();
  isWatering = true;
  currentWateringDuration = seconds;
  currentWateringIsSchedule = isSchedule;
  currentWateringRequestId = nextWateringRequestId.length() ? nextWateringRequestId : String((uint32_t)esp_random(), HEX);
  currentWateringSource = source;
  nextWateringRequestId = "";
  nextWateringSource = "";
  wateringStartTime = millis();
  wateringEndTime = millis() + (unsigned long)seconds * 1000;
  publishWateringStarted(seconds, isSchedule);
  return true;
}

void stopWatering() {
  setRelayOff();
  isWatering = false;
  Serial.println("[浇水] 浇水完成");

  // 发送执行结果报告
  reportWateringResult(currentWateringDuration, currentWateringIsSchedule);
  if (isAutoSource(currentWateringSource)) {
    lastAutoWateringEnd = millis();
    autoCooldownUntil = millis() + (unsigned long)currentWateringDuration * 1000UL * AUTO_COOLDOWN_MULTIPLIER;
    Serial.println("[浇水] 智能浇水冷却 " + String(currentWateringDuration * AUTO_COOLDOWN_MULTIPLIER) + "秒");
  }
  currentWateringDuration = 0;
  currentWateringIsSchedule = false;
  currentWateringRequestId = "";
  currentWateringSource = "";
  wateringStartTime = 0;

  if (waitingForAI) {
    waitingForAI = false;
  }
}

// ========== 心跳 ==========
void sendHeartbeat() {
  if (!mqtt.connected()) return;
  heartbeatCount++;
  String topic = "device/" + deviceCode + "/heartbeat";
  DynamicJsonDocument doc(768);
  doc["device_code"] = deviceCode;
  doc["firmware_version"] = FIRMWARE_VERSION;
  doc["timestamp"] = "";
  doc["wifi_connected"] = WiFi.status() == WL_CONNECTED;
  doc["device_ip"] = WiFi.localIP().toString();
  doc["wifi_rssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : -100;
  doc["relay_pin"] = RELAY_PIN;
  doc["relay_active_level"] = RELAY_ACTIVE_LEVEL == HIGH ? "HIGH" : "LOW";
  doc["watering"] = isWatering;
  doc["current_duration"] = currentWateringDuration;
  doc["auto_cooldown"] = isInAutoCooldown();
  JsonObject sensor = doc.createNestedObject("sensor_data");
  #ifdef SOIL_PIN
    sensor["soil_moisture"] = map(analogRead(SOIL_PIN), 4095, 0, 0, 100);
  #endif
  #ifdef DHT_PIN
    // sensor["temperature"] = dht.readTemperature();
    // sensor["air_humidity"] = dht.readHumidity();
  #endif
  // 附加计划任务状态
  doc["schedule_count"] = scheduleCount;
  doc["current_time"] = getCurrentTimeHM();
  String out;
  serializeJson(doc, out);
  mqtt.publish(topic.c_str(), out.c_str());
  Serial.println("[心跳] #" + String(heartbeatCount));
}

// ========== 连接MQTT ==========
void connectMQTT() {
  handleSafetyTimers();
  if (WiFi.status() != WL_CONNECTED) return;
  String clientId = "esp32_" + deviceCode + "_" + String((uint32_t)esp_random(), HEX);
  Serial.println("[MQTT] 连接 " + String(MQTT_SERVER) + ":" + String(MQTT_PORT));
  if (mqtt.connect(clientId.c_str())) {
    Serial.println("[MQTT] 已连接");
    String cmdTopic = "device/" + deviceCode + "/command";
    mqtt.subscribe(cmdTopic.c_str());
    Serial.println("[MQTT] 已订阅: " + cmdTopic);
    
    // 首次连接时通过MQTT注册设备（替代HTTP注册）
    prefs.begin("iot", true);
    bool registered = prefs.getBool("registered", false);
    prefs.end();
    if (!registered) {
      DynamicJsonDocument regDoc(128);
      regDoc["device_code"] = deviceCode;
      regDoc["username"] = username;
      String regOut;
      serializeJson(regDoc, regOut);
      String regTopic = "device/" + deviceCode + "/register";
      mqtt.publish(regTopic.c_str(), regOut.c_str(), false);
      Serial.println("[MQTT] 已发送注册消息: " + regTopic);
    }
    
    sendHeartbeat();
    flushPendingReports();
  } else {
    Serial.println("[MQTT] 连接失败，rc=" + String(mqtt.state()));
  }
}

void factoryReset() {
  Serial.println("[factory] clearing NVS and restarting...");
  setRelayOff();
  isWatering = false;
  wateringStartTime = 0;
  mqtt.disconnect();
  WiFi.disconnect(true, true);
  prefs.begin("iot", false);
  prefs.clear();
  prefs.end();
  delay(500);
  ESP.restart();
}

void handleSerialCommands() {
  static String serialCommand = "";
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      serialCommand.trim();
      serialCommand.toUpperCase();
      if (serialCommand == "FACTORY_RESET") {
        factoryReset();
      } else if (serialCommand == "RELAY_ON") {
        // 安全起见，RELAY_ON 不再裸开继电器，而是走 30 秒倒计时，防止忘记关闭导致一直浇水
        nextWateringRequestId = String((uint32_t)esp_random(), HEX);
        nextWateringSource = "serial_test";
        if (startWatering(30, false)) {
          Serial.println("[serial] relay safe on: GPIO" + String(RELAY_PIN) + " 30s countdown");
        }
      } else if (serialCommand == "RELAY_OFF") {
        if (isWatering) stopWatering();
        else setRelayOff();
        Serial.println("[serial] relay off: GPIO" + String(RELAY_PIN) + " level=" + String(RELAY_INACTIVE_LEVEL == HIGH ? "HIGH" : "LOW"));
      } else if (serialCommand == "RELAY_TEST") {
        Serial.println("[serial] relay test: ON 3s then OFF, GPIO" + String(RELAY_PIN));
        setRelayOn();
        delay(3000);
        setRelayOff();
        Serial.println("[serial] relay test done");
      } else if (serialCommand.length() > 0) {
        Serial.println("[serial] unknown command: " + serialCommand);
        Serial.println("[serial] available: FACTORY_RESET, RELAY_ON, RELAY_OFF, RELAY_TEST");
      }
      serialCommand = "";
    } else if (serialCommand.length() < 64) {
      serialCommand += c;
    }
  }
}

// ========== 主程序 ==========
void setup() {
  Serial.begin(115200);
  Serial.println("\n[启动] 木白云IoT 控制器固件 v" + String(FIRMWARE_VERSION));
  // 最高优先级：启动后立即把继电器脚置为关闭电平，避免复位/启动阶段误动作
  pinMode(RELAY_PIN, OUTPUT);
  setRelayOff();
  setupWatchdog();
  Serial.println("\n========== 木白云IoT 控制器 v" + String(FIRMWARE_VERSION) + " ==========");
  Serial.println("[serial] send FACTORY_RESET to clear config and restart");
  Serial.println("[serial] relay commands: RELAY_ON / RELAY_OFF / RELAY_TEST");
  Serial.println("[relay] GPIO" + String(RELAY_PIN) + ", ON=" + String(RELAY_ACTIVE_LEVEL == HIGH ? "HIGH" : "LOW") + ", OFF=" + String(RELAY_INACTIVE_LEVEL == HIGH ? "HIGH" : "LOW"));

  prefs.begin("iot", true);
  isConfigured = prefs.getBool("configured", false);
  wifiSSID = prefs.getString("ssid", "");
  wifiPass = prefs.getString("pass", "");
  deviceCode = prefs.getString("code", "");
  username = prefs.getString("user", "");
  mqttHost = prefs.getString("mqtt", MQTT_SERVER);
  prefs.end();

  if (!isConfigured) {
    Serial.println("[启动] 首次启动，进入配网模式");
    startAP();
    return;
  }

  Serial.println("[启动] 设备码: " + deviceCode);
  Serial.println("[启动] WiFi: " + wifiSSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSSID.c_str(), wifiPass.c_str());
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    esp_task_wdt_reset();
    handleSafetyTimers();
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\n[WiFi] 连接失败，进入配网模式");
    startAP();
    return;
  }
  Serial.println("\n[WiFi] 已连接: " + WiFi.localIP().toString());
  stopAP();

  // NTP时间同步
  syncTime();

  // 加载计划任务
  loadSchedulesFromNVS();

  mqtt.setServer(mqttHost.c_str(), MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(1024);
  mqtt.setSocketTimeout(MQTT_SOCKET_TIMEOUT);
  mqtt.setKeepAlive(MQTT_KEEPALIVE);
  connectMQTT();
}

void loop() {
  esp_task_wdt_reset();
  handleSerialCommands();
  handleSafetyTimers();

  // AP配网模式
  if (!isConfigured || WiFi.status() != WL_CONNECTED) {
    if (isConfigured && millis() - lastWifiReconnect > WIFI_RECONNECT_INTERVAL) {
      lastWifiReconnect = millis();
      wifiReconnectAttempts++;
      if (wifiReconnectAttempts >= WIFI_RECONNECT_AP_AFTER) startAP();
      WiFi.disconnect(false);
      WiFi.begin(wifiSSID.c_str(), wifiPass.c_str());
    }
    dnsServer.processNextRequest();
    server.handleClient();
    return;
  }
  wifiReconnectAttempts = 0;
  stopAP();

  // MQTT重连
  if (!mqtt.connected()) {
    static unsigned long lastReconnect = 0;
    if (millis() - lastReconnect > MQTT_RECONNECT_INTERVAL) {
      lastReconnect = millis();
      connectMQTT();
    }
  }
  mqtt.loop();
  flushPendingReports();

  // 心跳
  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL) {
    lastHeartbeat = millis();
    sendHeartbeat();
  }

  // 计划任务检查
  if (millis() - lastScheduleCheck > SCHEDULE_CHECK_INTERVAL) {
    lastScheduleCheck = millis();
    checkSchedules();
  }

  // 智能浇水超时检测（支持重试）
  if (waitingForAI) {
    unsigned long waitLimit = (aiRetryCount == 0) ? AI_WAIT_FIRST : AI_WAIT_RETRY;
    if (millis() - aiWaitStartTime > waitLimit) {
      if (aiRetryCount < AI_MAX_RETRIES) {
        // 还可以重试
        aiRetryCount++;
        Serial.println("[智能] 第" + String(aiRetryCount) + "次等待超时, 重试中...");
        requestAIWatering(aiPendingDuration, true);
      } else {
        // 重试用尽，放弃并上报错误
        waitingForAI = false;
        reportAIError(aiPendingDuration, aiRetryCount);
      }
    }
  }

  handleSafetyTimers();
}