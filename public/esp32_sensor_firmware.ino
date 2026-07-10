// ============================================
// 木白云IoT - 土壤湿度传感器固件 v2
// 功能：AP配网 + MQTT注册 + 土壤湿度滤波采集 + 数据上报
// 接线：土壤湿度 AO -> GPIO34，传感器供电 -> GPIO25
// ============================================

#include <WiFi.h>
#include <WebServer.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <DNSServer.h>
#include <esp_task_wdt.h>
#include <esp_system.h>

// ========== 配置区域 ==========
const char* MQTT_SERVER = "mqtt.mcoud.cn";
const int MQTT_PORT = 1883;
#define HEARTBEAT_INTERVAL 30000  // 兼容保留：当前固件按 sleepSeconds 深睡眠周期上报
#define DEFAULT_SLEEP_SECONDS 30   // 默认每次上报后休眠 30 秒

// 土壤湿度传感器接线（按旧平台代码迁移）
#define SOIL_SENSOR_PIN 34     // 土壤湿度 AO，ADC 输入
#define SENSOR_POWER_PIN 25    // 传感器供电脚，采样时拉高，采样后关闭

// 土壤湿度校准值（旧平台参数）
const float DEFAULT_DRY_ADC = 2320.0f;  // 干燥 ADC
const float DEFAULT_WET_ADC = 475.0f;   // 湿润 ADC
const int NUM_READINGS = 30;            // 每次采样次数

// WiFi / MQTT
#define WIFI_RECONNECT_INTERVAL 10000
#define WIFI_RECONNECT_AP_AFTER 10
#define MQTT_RECONNECT_INTERVAL 5000
#define MQTT_SOCKET_TIMEOUT 3
#define MQTT_KEEPALIVE 30
#define WDT_TIMEOUT_SECONDS 15
// ==============================

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
unsigned long lastHeartbeat = 0;
int heartbeatCount = 0;
bool apStarted = false;
unsigned long lastWifiReconnect = 0;
int wifiReconnectAttempts = 0;
uint32_t sleepSeconds = DEFAULT_SLEEP_SECONDS;
bool shouldSleep = false;

// 校准参数
float g_dry_adc = DEFAULT_DRY_ADC;
float g_wet_adc = DEFAULT_WET_ADC;

// ========== 看门狗 ==========
void setupWatchdog() {
  esp_task_wdt_config_t wdtConfig = {};
  wdtConfig.timeout_ms = WDT_TIMEOUT_SECONDS * 1000;
  wdtConfig.idle_core_mask = (1 << portNUM_PROCESSORS) - 1;
  wdtConfig.trigger_panic = true;
  esp_task_wdt_init(&wdtConfig);
  esp_task_wdt_add(NULL);
}

// ========== 设备码生成 (C开头) ==========
String generateDeviceCode() {
  String code = "C";
  const char chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (int i = 0; i < 8; i++) {
    code += chars[esp_random() % (sizeof(chars) - 1)];
  }
  return code;
}

// ========== 校准参数 ==========
void loadCalibration() {
  prefs.begin("iot", true);
  float storedDry = prefs.getFloat("dry_adc", DEFAULT_DRY_ADC);
  float storedWet = prefs.getFloat("wet_adc", DEFAULT_WET_ADC);
  sleepSeconds = prefs.getUInt("sleep_sec", DEFAULT_SLEEP_SECONDS);
  prefs.end();

  if (storedDry > 0 && storedWet > 0 && storedDry > storedWet) {
    g_dry_adc = storedDry;
    g_wet_adc = storedWet;
    Serial.println("[校准] 已从NVS恢复校准参数");
  } else {
    g_dry_adc = DEFAULT_DRY_ADC;
    g_wet_adc = DEFAULT_WET_ADC;
    Serial.println("[校准] NVS参数无效，使用默认校准参数");
  }
  Serial.printf("[校准] Dry: %.0f, Wet: %.0f\n", g_dry_adc, g_wet_adc);
  if (sleepSeconds < 30) sleepSeconds = 30;
  Serial.printf("[配置] 休眠时间: %lu秒\n", (unsigned long)sleepSeconds);
}

void saveCalibration(float dry, float wet) {
  if (dry <= wet || dry <= 0 || wet <= 0) return;
  g_dry_adc = dry;
  g_wet_adc = wet;
  prefs.begin("iot", false);
  prefs.putFloat("dry_adc", dry);
  prefs.putFloat("wet_adc", wet);
  prefs.end();
  Serial.printf("[校准] 已保存 Dry: %.0f, Wet: %.0f\n", dry, wet);
}

void saveSleepSeconds(uint32_t seconds) {
  if (seconds < 30) seconds = 30;
  sleepSeconds = seconds;
  prefs.begin("iot", false);
  prefs.putUInt("sleep_sec", sleepSeconds);
  prefs.end();
  Serial.printf("[配置] 已保存休眠时间: %lu秒\n", (unsigned long)sleepSeconds);
}

void goToSleep() {
  Serial.printf("[休眠] %lu秒后再次上报\n", (unsigned long)sleepSeconds);
  mqtt.disconnect();
  delay(100);
  esp_sleep_enable_timer_wakeup((uint64_t)sleepSeconds * 1000000ULL);
  esp_deep_sleep_start();
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
<title>木白云IoT 传感器配网</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f6fa;color:#1e293b;padding:16px;min-height:100vh}
.card{background:#fff;border-radius:14px;padding:18px;margin:0 auto 14px;box-shadow:0 2px 8px rgba(0,0,0,.06);max-width:480px}
h2{font-size:20px;margin-bottom:4px;color:#064e3b}.desc{font-size:12px;color:#94a3b8;margin-bottom:16px}
label{font-size:13px;font-weight:500;color:#475569;display:block;margin-bottom:4px;margin-top:12px}label:first-child{margin-top:0}
input{width:100%;height:44px;border:1.5px solid #e2e8f0;border-radius:8px;padding:0 12px;font-size:16px;outline:none;background:#fff}
input:focus{border-color:#059669}.btn{width:100%;height:44px;border:none;border-radius:10px;background:#059669;color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-top:16px}.btn:disabled{opacity:.7;cursor:not-allowed}.btn.success{background:#16a34a}.btn.error{background:#dc2626}
.wifi-list{margin:8px 0;max-height:240px;overflow-y:auto;-webkit-overflow-scrolling:touch;border:1.5px solid #e2e8f0;border-radius:10px;padding:6px;background:#f8fafc}
.wifi-item{display:flex;align-items:center;gap:8px;padding:10px;border:1.5px solid #e2e8f0;border-radius:8px;margin-bottom:6px;cursor:pointer;transition:all .2s}.wifi-item:last-child{margin-bottom:0}.wifi-item.selected{border-color:#059669;background:#ecfdf5}.wifi-dot{width:8px;height:8px;border-radius:50%;background:#059669;flex:none}.ssid{flex:1;min-width:0;font-weight:500;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rssi,.lock{font-size:11px;color:#94a3b8}.hint{font-size:11px;color:#94a3b8;margin-top:4px}.ok{background:#dcfce7;border:1px solid #86efac;color:#166534;border-radius:10px;padding:14px;text-align:center;display:none}.ok-mark{width:42px;height:42px;border-radius:50%;background:#16a34a;color:#fff;display:flex;align-items:center;justify-content:center;margin:0 auto 8px;font-size:24px;font-weight:700}
.toast{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:9px 16px;border-radius:9px;font-size:13px;opacity:0;pointer-events:none;transition:.25s;z-index:9}.toast.show{opacity:1}.toast.error{background:#dc2626}.toast.success{background:#059669}
</style></head><body>
<div id="toast" class="toast"></div>
<div class="card" id="formCard">
  <h2>传感器配网</h2>
  <div class="desc">选择WiFi并配置平台信息。土壤传感器 AO 接 GPIO34，供电脚接 GPIO25。</div>
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
  <button class="btn" id="submitBtn" onclick="submitConfig()">保存并连接</button>
</div>
<div class="card ok" id="okCard">
  <div class="ok-mark">✓</div>
  <div style="font-size:16px;font-weight:600">配置成功！</div>
  <div style="font-size:13px;color:#64748b;margin-top:4px">设备正在连接WiFi和平台...</div>
  <div style="font-size:12px;color:#64748b;margin-top:8px">设备码：<b id="devCode"></b></div>
  <div style="font-size:12px;color:#166534;margin-top:8px;font-weight:700">请复制设备码，到平台“添加设备”中绑定传感器</div>
</div>
<script>
var selectedSSID = "";
function showToast(msg,type){var t=document.getElementById('toast');t.textContent=msg;t.className='toast show '+(type||'');clearTimeout(t._timer);t._timer=setTimeout(function(){t.className='toast'},2200)}
function scanWifi(){fetch('/scan').then(function(r){return r.json()}).then(function(list){var box=document.getElementById('wifiList');box.innerHTML='';if(!list.length){box.innerHTML='<div class="hint">未发现WiFi</div>';return;}list.forEach(function(w){var item=document.createElement('div');item.className='wifi-item';item.onclick=function(){selectWifi(item,w.ssid)};item.innerHTML='<span class="wifi-dot"></span><span class="ssid"></span><span class="rssi"></span><span class="lock"></span>';item.querySelector('.ssid').textContent=w.ssid;item.querySelector('.rssi').textContent=w.rssi+'dBm';item.querySelector('.lock').textContent=w.enc?'加密':'';box.appendChild(item);});}).catch(function(){document.getElementById('wifiList').innerHTML='<div class="hint">扫描失败，刷新重试</div>';});}
function selectWifi(el,ssid){document.querySelectorAll('.wifi-item').forEach(function(e){e.classList.remove('selected')});el.classList.add('selected');selectedSSID=ssid;}
function setBtn(text,cls,disabled){var btn=document.getElementById('submitBtn');btn.textContent=text;btn.className='btn '+(cls||'');btn.disabled=!!disabled;}
function submitConfig(){if(!selectedSSID){showToast('请选择WiFi','error');return;}var pass=document.getElementById('wifiPass').value;var mqtt=document.getElementById('mqttServer').value.trim();var user=document.getElementById('username').value.trim();if(!mqtt){showToast('请填写MQTT服务器','error');return;}setBtn('保存中...','',true);fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid:selectedSSID,pass:pass,mqtt:mqtt,username:user})}).then(function(r){return r.json()}).then(function(d){if(d.success){setBtn('✓ 保存成功','success',true);document.getElementById('devCode').textContent=d.device_code;document.getElementById('okCard').style.display='block';document.getElementById('formCard').style.display='none';}else{setBtn('✗ 保存失败','error',false);showToast(d.error||'保存失败','error');setTimeout(function(){setBtn('保存并连接','',false)},2000);}}).catch(function(){setBtn('✗ 网络错误','error',false);showToast('网络错误','error');setTimeout(function(){setBtn('保存并连接','',false)},2000);});}
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
  username.trim();

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
  prefs.putBool("registered", false);
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
  WiFi.softAP("木白云IoT-传感器", "12345678");
  dnsServer.start(53, "*", WiFi.softAPIP());
  server.on("/", handleRoot);
  server.on("/scan", handleScan);
  server.on("/save", HTTP_POST, handleSave);
  server.begin();
  Serial.println("[配网] AP模式已启动: 木白云IoT-传感器");
  Serial.println("[配网] 访问: http://" + WiFi.softAPIP().toString());
}

// ========== 读取土壤湿度（从旧平台代码迁移） ==========
float readSoilMoisture(float* outRaw = nullptr) {
  pinMode(SENSOR_POWER_PIN, OUTPUT);
  digitalWrite(SENSOR_POWER_PIN, HIGH);
  delay(100);

  long total = 0;
  for (int i = 0; i < NUM_READINGS; i++) {
    total += analogRead(SOIL_SENSOR_PIN);
    delay(50);
    esp_task_wdt_reset();
  }

  float avgRaw = (float)total / (float)NUM_READINGS;
  float range = g_dry_adc - g_wet_adc;
  float moisture = 0.0f;

  if (range < 10.0f) {
    moisture = 0.0f;
    Serial.println("[传感器] 警告：干湿差值过小，校准参数可能错误");
  } else if (avgRaw <= g_wet_adc) {
    moisture = 100.0f;
  } else if (avgRaw >= g_dry_adc) {
    moisture = 0.0f;
  } else {
    moisture = (avgRaw - g_dry_adc) / (g_wet_adc - g_dry_adc) * 100.0f;
  }

  moisture = constrain(moisture, 0.0f, 100.0f);
  digitalWrite(SENSOR_POWER_PIN, LOW);
  pinMode(SENSOR_POWER_PIN, INPUT);

  if (outRaw) *outRaw = avgRaw;
  return round(moisture * 10.0f) / 10.0f;
}

// ========== 心跳 ==========
void sendHeartbeat() {
  if (!mqtt.connected()) return;
  heartbeatCount++;

  float rawValue = 0.0f;
  float soil = readSoilMoisture(&rawValue);

  String topic = "device/" + deviceCode + "/heartbeat";
  DynamicJsonDocument doc(512);
  doc["device_code"] = deviceCode;
  JsonObject sensor = doc.createNestedObject("sensor_data");
  sensor["soil_moisture"] = soil;
  sensor["soil_raw"] = (int)round(rawValue);
  sensor["dry_adc"] = (int)round(g_dry_adc);
  sensor["wet_adc"] = (int)round(g_wet_adc);
  sensor["sleep_seconds"] = sleepSeconds;

  String out;
  serializeJson(doc, out);
  mqtt.publish(topic.c_str(), out.c_str());
  Serial.println("[心跳] #" + String(heartbeatCount) + " 土壤:" + String(soil, 1) + "% 原始值:" + String(rawValue, 0));
}

// ========== MQTT回调 ==========
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  Serial.println("[MQTT] 收到: " + msg);

  DynamicJsonDocument doc(512);
  DeserializationError err = deserializeJson(doc, msg);
  if (err) return;

  if (doc.containsKey("command") && doc["command"] == "register_ack") {
    bool success = doc["success"] | false;
    if (success) {
      prefs.begin("iot", false);
      prefs.putBool("registered", true);
      prefs.end();
      Serial.println("[MQTT] 注册已确认");
      shouldSleep = true;
    }
    return;
  }

  if (doc.containsKey("command") && (doc["command"] == "sensor_config" || doc["command"] == "calibrate_soil")) {
    if (doc.containsKey("sleep_seconds")) {
      uint32_t sec = doc["sleep_seconds"] | sleepSeconds;
      saveSleepSeconds(sec);
    }
    if (doc.containsKey("dry_adc") || doc.containsKey("wet_adc")) {
      float dry = doc["dry_adc"] | g_dry_adc;
      float wet = doc["wet_adc"] | g_wet_adc;
      if (dry > wet && dry > 0 && wet > 0) saveCalibration(dry, wet);
    }
    shouldSleep = true;
    return;
  }
}

// ========== 连接MQTT ==========
void connectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;
  String clientId = "sensor_" + deviceCode + "_" + String((uint32_t)esp_random(), HEX);
  Serial.println("[MQTT] 连接 " + mqttHost + ":" + String(MQTT_PORT));

  if (mqtt.connect(clientId.c_str())) {
    Serial.println("[MQTT] 已连接");

    String commandTopic = "device/" + deviceCode + "/command";
    mqtt.subscribe(commandTopic.c_str());
    Serial.println("[MQTT] 已订阅 " + commandTopic);

    prefs.begin("iot", true);
    bool registered = prefs.getBool("registered", false);
    prefs.end();

    if (!registered) {
      DynamicJsonDocument regDoc(160);
      regDoc["device_code"] = deviceCode;
      regDoc["username"] = username;
      regDoc["device_type"] = "sensor";
      String regOut;
      serializeJson(regDoc, regOut);
      String regTopic = "device/" + deviceCode + "/register";
      mqtt.publish(regTopic.c_str(), regOut.c_str(), false);
      Serial.println("[MQTT] 已发送注册消息");
    }

    sendHeartbeat();
    unsigned long waitStart = millis();
    while (millis() - waitStart < 5000) {
      esp_task_wdt_reset();
      mqtt.loop();
      if (shouldSleep) break;
      delay(20);
    }
    goToSleep();
  } else {
    Serial.println("[MQTT] 连接失败，rc=" + String(mqtt.state()));
  }
}

void factoryReset() {
  Serial.println("[factory] clearing NVS and restarting...");
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
      } else if (serialCommand == "SHOW_CAL") {
        Serial.printf("[校准] Dry: %.0f, Wet: %.0f\n", g_dry_adc, g_wet_adc);
      } else if (serialCommand.length() > 0) {
        Serial.println("[serial] unknown command: " + serialCommand);
        Serial.println("[serial] available: FACTORY_RESET, SHOW_CAL");
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
  setupWatchdog();
  Serial.println("\n========== 木白云IoT 土壤湿度传感器 v2 ==========");
  Serial.println("[serial] send FACTORY_RESET to clear config and restart");

  pinMode(SOIL_SENSOR_PIN, INPUT);
  pinMode(SENSOR_POWER_PIN, INPUT);
  loadCalibration();

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

  mqtt.setServer(mqttHost.c_str(), MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(512);
  mqtt.setSocketTimeout(MQTT_SOCKET_TIMEOUT);
  mqtt.setKeepAlive(MQTT_KEEPALIVE);
  connectMQTT();
}

void loop() {
  esp_task_wdt_reset();
  handleSerialCommands();

  // AP配网模式 / WiFi重连
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

  // MQTT重连
  if (!mqtt.connected()) {
    static unsigned long lastReconnect = 0;
    if (millis() - lastReconnect > MQTT_RECONNECT_INTERVAL) {
      lastReconnect = millis();
      connectMQTT();
    }
  }
  mqtt.loop();

  // 心跳
  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL) {
    lastHeartbeat = millis();
    sendHeartbeat();
  }
}
