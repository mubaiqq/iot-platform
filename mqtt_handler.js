// mqtt_handler.js - 全局MQTT消息处理
const mqtt = require('mqtt');

let globalMqttClient = null;
const pendingAcks = new Map();

async function initGlobalMqtt(pool) {
  try {
    // 从数据库获取MQTT配置
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE "mqtt_%"');
    const cfg = {};
    rows.forEach(r => { cfg[r.setting_key] = r.setting_value; });
    
    if (!cfg.mqtt_broker) {
      console.log('[MQTT] 未配置MQTT Broker，跳过全局连接');
      return;
    }
    
    const proto = cfg.mqtt_protocol || 'mqtt';
    const port = cfg.mqtt_port || '1883';
    const url = `${proto}://${cfg.mqtt_broker}:${port}`;
    
    const opts = {};
    if (cfg.mqtt_username) opts.username = cfg.mqtt_username;
    if (cfg.mqtt_password) opts.password = cfg.mqtt_password;
    opts.clientId = (cfg.mqtt_client_id || 'mubaiyun_server') + '_global_' + Math.random().toString(16).slice(2, 6);
    opts.clean = cfg.mqtt_clean_session !== '0';
    if (cfg.mqtt_keepalive) opts.keepalive = parseInt(cfg.mqtt_keepalive) || 60;
    
    globalMqttClient = mqtt.connect(url, opts);
    
    globalMqttClient.on('connect', () => {
      console.log('[MQTT] 全局连接成功:', url);
      
      const topics = [
        { topic: 'device/+/heartbeat', qos: 0 },
        { topic: 'device/+/watering_request', qos: 1 },
        { topic: 'device/+/status', qos: 1 },
        { topic: 'device/+/watering_complete', qos: 1 },
        { topic: 'device/+/register', qos: 1 }
      ];
      
      topics.forEach(({ topic, qos }) => {
        globalMqttClient.subscribe(topic, { qos }, (err) => {
          if (err) console.error(`[MQTT] 订阅 ${topic} 失败:`, err.message);
          else console.log(`[MQTT] 已订阅: ${topic}`);
        });
      });
    });
    
    globalMqttClient.on('message', async (topic, message, packet) => {
      try {
        const parts = topic.split('/');
        if (parts.length < 3) return;
        
        const deviceCode = parts[1];
        const action = parts[2];
        
        // 清理 retained 消息（旧固件可能遗留）
        if (packet.retain) {
          console.log(`[MQTT] 忽略 retained 消息: ${topic}`);
          globalMqttClient.publish(topic, null, { retain: true, qos: 1 });
          return;
        }
        
        // console.log(`[MQTT] 收到消息: ${topic}`);
        
        if (action === 'heartbeat') {
          await handleHeartbeat(pool, deviceCode, message.toString());
        } else if (action === 'watering_request') {
          await handleWateringRequest(pool, deviceCode, message.toString());
        } else if (action === 'status') {
          await handleDeviceStatus(pool, deviceCode, message.toString());
        } else if (action === 'watering_complete') {
          await handleWateringComplete(pool, deviceCode, message.toString());
        } else if (action === 'register') {
          await handleDeviceRegister(pool, deviceCode, message.toString());
        }
      } catch (e) {
        console.error('[MQTT] 处理消息错误:', e.message);
      }
    });
    
    globalMqttClient.on('error', (err) => {
      console.error('[MQTT] 全局连接错误:', err.message);
    });
    
    globalMqttClient.on('close', () => {
      console.log('[MQTT] 全局连接已关闭');
    });
    
  } catch (e) {
    console.error('[MQTT] 初始化全局连接失败:', e.message);
  }
}

// ========== 工具函数 ==========

// 发布消息到设备（不使用 retained）
function publishToDevice(deviceCode, data) {
  if (!globalMqttClient || !globalMqttClient.connected) {
    console.error('[MQTT] 全局连接未就绪，无法发布消息');
    return;
  }
  
  const topic = `device/${deviceCode}/command`;
  globalMqttClient.publish(topic, JSON.stringify(data), { qos: 1 }, (err) => {
    if (err) {
      console.error('[MQTT] 发布消息失败:', err.message);
    } else {
      console.log(`[MQTT] 已发布到 ${topic}:`, JSON.stringify(data));
    }
  });
}

// 等待设备确认
function waitForDeviceAck(deviceCode, eventType, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const key = `${deviceCode}:${eventType}`;
    if (pendingAcks.has(key)) {
      const old = pendingAcks.get(key);
      clearTimeout(old.timer);
      old.reject(new Error('replaced'));
    }
    const timer = setTimeout(() => {
      pendingAcks.delete(key);
      reject(new Error('timeout'));
    }, timeout);
    pendingAcks.set(key, { resolve, reject, timer });
  });
}

// 获取设备ID（通用）
async function getDeviceId(pool, deviceCode) {
  const [rows] = await pool.query('SELECT id FROM devices WHERE device_code = ?', [deviceCode]);
  return rows.length ? rows[0].id : null;
}

// source 映射为中文
function sourceToText(source) {
  const map = {
    'manual': '手动',
    'schedule_fixed': '计划固定',
    'schedule_ai': '智能计划'
  };
  return map[source] || source;
}

// ========== 处理函数 ==========

// 处理设备注册
async function handleDeviceRegister(pool, deviceCode, payload) {
  try {
    const data = JSON.parse(payload);
    const username = data.username || null;
    console.log(`[ESP32注册] 设备 ${deviceCode}, 用户: ${username || '未填写'}`);
    
    // 检查设备码是否已存在于设备表
    const [existing] = await pool.query('SELECT id FROM devices WHERE device_code = ?', [deviceCode]);
    if (existing.length) {
      console.log(`[ESP32注册] 设备 ${deviceCode} 已存在，跳过`);
      publishToDevice(deviceCode, { command: 'register_ack', success: true });
      return;
    }
    
    // 检查是否已在待绑定表中
    const [pending] = await pool.query('SELECT id FROM esp32_pending_devices WHERE device_code = ?', [deviceCode]);
    if (pending.length) {
      console.log(`[ESP32注册] 设备 ${deviceCode} 已在待绑定列表`);
      publishToDevice(deviceCode, { command: 'register_ack', success: true });
      return;
    }
    
    // 插入待绑定表
    await pool.query(
      'INSERT INTO esp32_pending_devices (device_code, username) VALUES (?, ?)',
      [deviceCode, username]
    );
    
    console.log(`[ESP32注册] 新设备注册成功: ${deviceCode}`);
    publishToDevice(deviceCode, { command: 'register_ack', success: true });
  } catch (e) {
    console.error('[ESP32注册] 处理错误:', e.message);
  }
}

// 处理设备心跳
async function handleHeartbeat(pool, deviceCode, payload) {
  try {
    const data = JSON.parse(payload);
    // console.log(`[心跳] 设备 ${deviceCode}:`, data);
    
    const [result] = await pool.query(
      'UPDATE devices SET last_heartbeat = NOW(), status = "online", sensor_data = ? WHERE device_code = ?',
      [JSON.stringify(data.sensor_data || {}), deviceCode]
    );
    
    if (result.affectedRows === 0) {
      // console.log(`[心跳] 设备 ${deviceCode} 不存在`);
    } else {
      // 传感器设备每次上线/心跳时补发数据库里的休眠与校准参数，避免设备睡眠期间错过即时 MQTT 下发。
      const [rows] = await pool.query('SELECT device_type, settings FROM devices WHERE device_code = ? LIMIT 1', [deviceCode]);
      if (rows.length && rows[0].device_type === 'sensor') {
        let settings = rows[0].settings || {};
        if (typeof settings === 'string') {
          try { settings = JSON.parse(settings); } catch (_) { settings = {}; }
        }
        const sensorCfg = settings.sensor_config || {};
        publishToDevice(deviceCode, {
          command: 'sensor_config',
          sleep_seconds: Math.max(30, parseInt(sensorCfg.sleep_seconds || settings.sleep_seconds || 30, 10) || 30),
          dry_adc: sensorCfg.dry_adc !== null && sensorCfg.dry_adc !== undefined ? Number(sensorCfg.dry_adc) : undefined,
          wet_adc: sensorCfg.wet_adc !== null && sensorCfg.wet_adc !== undefined ? Number(sensorCfg.wet_adc) : undefined
        });
      }
    }
  } catch (e) {
    console.error('[心跳] 处理错误:', e.message);
  }
}

// 处理设备状态事件
async function handleDeviceStatus(pool, deviceCode, payload) {
  try {
    const data = JSON.parse(payload);
    const event = data.event;
    const requestId = data.request_id;
    
    // 处理需要等待确认的事件（用于 waitForDeviceAck）
    const key = `${deviceCode}:${event}`;
    const pending = pendingAcks.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(data);
      pendingAcks.delete(key);
    }
    
    // === watering_started: 创建浇水开始日志 ===
    if (event === 'watering_started') {
      console.log(`[浇水开始] 收到 watering_started: request_id=${requestId}, 设备=${deviceCode}`);
      const deviceId = await getDeviceId(pool, deviceCode);
      if (!deviceId) return;
      
      const duration = data.duration || 0;
      const source = data.source || 'manual';
      const sourceText = sourceToText(source);
      
      // 检查是否已存在相同 request_id 的日志
      if (requestId) {
        const [existing] = await pool.query(
          "SELECT id FROM device_logs WHERE device_id = ? AND log_type = 'watering' AND JSON_UNQUOTE(JSON_EXTRACT(result, '$.request_id')) = ? LIMIT 1",
          [deviceId, requestId]
        );
        if (existing.length) {
          console.log(`[浇水开始] 设备 ${deviceCode} request_id=${requestId} 已存在日志 (id=${existing[0].id})，跳过`);
          return;
        }
      }
      
      const [insertResult] = await pool.query(
        'INSERT INTO device_logs (device_id, log_type, content, result) VALUES (?, ?, ?, ?)',
        [deviceId, 'watering', `${sourceText}浇水 ${duration}秒`, JSON.stringify({ request_id: requestId, source, duration })]
      );
      console.log(`[浇水开始] 设备 ${deviceCode} ${sourceText}浇水 ${duration}秒, request_id=${requestId}, insertId=${insertResult.insertId}`);
      return;
    }
    
    // === watering_ack: 忽略，仅用于调试 ===
    if (event === 'watering_ack') {
      // console.log(`[调试] 设备 ${deviceCode} watering_ack`);
      return;
    }
    
    // === schedule_ack success=true: 忽略 ===
    if (event === 'schedule_ack' && data.success) {
      return;
    }
    
    // === register_ack: 忽略 ===
    if (event === 'register_ack') {
      return;
    }
    
    // === 以下异常事件记录为 status_event ===
    const abnormalEvents = ['watering_reject', 'schedule_ack', 'schedule_skipped', 'schedule_missed', 'schedule_invalid'];
    if (abnormalEvents.includes(event)) {
      // schedule_ack success=true 已在上面忽略，这里只记录失败
      if (event === 'schedule_ack' && data.success) return;
      
      const deviceId = await getDeviceId(pool, deviceCode);
      if (!deviceId) return;
      
      const reason = data.reason || '';
      const description = `设备事件: ${event}` + (reason ? ` (${reason})` : '');
      
      await pool.query(
        'INSERT INTO device_logs (device_id, log_type, content, result) VALUES (?, ?, ?, ?)',
        [deviceId, 'status_event', description, JSON.stringify(data)]
      );
      console.log(`[设备异常] ${deviceCode} - ${description}`);
      return;
    }
    
    // 其他未知事件，记录但不刷屏
    // console.log(`[设备状态] ${deviceCode} - ${event}`);
    
  } catch (e) {
    console.error('[设备状态] 处理错误:', e.message);
  }
}

// 处理浇水完成
async function handleWateringComplete(pool, deviceCode, payload) {
  try {
    const data = JSON.parse(payload);
    const requestId = data.request_id;
    const duration = data.duration || 0;
    const source = data.source || 'manual';
    const executedAt = data.timestamp ? new Date(data.timestamp) : new Date();
    
    console.log(`[浇水完成] 收到 watering_complete: request_id=${requestId}, 设备=${deviceCode}, ${duration}秒, source=${source}`);
    
    const deviceId = await getDeviceId(pool, deviceCode);
    if (!deviceId) return;
    
    // 优先根据 request_id 更新已有日志
    if (requestId) {
      const [result] = await pool.query(
        `UPDATE device_logs 
         SET executed_at = ?, executed_duration = ?, result = JSON_SET(result, '$.completed', true)
         WHERE device_id = ? 
           AND log_type = 'watering' 
           AND JSON_UNQUOTE(JSON_EXTRACT(result, '$.request_id')) = ?
           AND executed_at IS NULL
         LIMIT 1`,
        [executedAt, duration, deviceId, requestId]
      );
      
      if (result.affectedRows > 0) {
        console.log(`[浇水完成] 设备 ${deviceCode} 已更新 request_id=${requestId} 的日志, affectedRows=${result.affectedRows}`);
        
        // 同时更新 watering_judge 的 executed_at（智能浇水的情况）
        if (source === 'schedule_ai') {
          await pool.query(
            `UPDATE device_logs 
             SET executed_at = ?, executed_duration = ?
             WHERE device_id = ? 
               AND log_type = 'watering_judge' 
               AND JSON_UNQUOTE(JSON_EXTRACT(result, '$.request_id')) = ?
               AND executed_at IS NULL
             LIMIT 1`,
            [executedAt, duration, deviceId, requestId]
          );
        }
        return;
      }
    }
    
    // 备用方案：按设备+来源+时间窗口匹配（处理 request_id 为 null 的情况）
    console.log(`[浇水完成] request_id 匹配失败，尝试备用方案: device=${deviceCode}, source=${source}`);
    const [result2] = await pool.query(
      `UPDATE device_logs 
       SET executed_at = ?, executed_duration = ?, result = JSON_SET(result, '$.completed', true)
       WHERE device_id = ? 
         AND log_type = 'watering' 
         AND content LIKE ?
         AND executed_at IS NULL
         AND created_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
       ORDER BY created_at DESC
       LIMIT 1`,
      [executedAt, duration, deviceId, `%${sourceToText(source)}%`]
    );
    
    if (result2.affectedRows > 0) {
      console.log(`[浇水完成] 设备 ${deviceCode} 备用方案匹配成功, affectedRows=${result2.affectedRows}`);
      return;
    }
    
    // 最终兜底：插入补记日志
    console.log(`[浇水完成] 设备 ${deviceCode} 未找到 request_id=${requestId} 的开始日志，插入兜底记录`);
    const sourceText = sourceToText(source);
    await pool.query(
      'INSERT INTO device_logs (device_id, log_type, content, executed_at, executed_duration, result) VALUES (?, ?, ?, ?, ?, ?)',
      [deviceId, 'watering', `${sourceText}浇水 ${duration}秒 (补记)`, executedAt, duration, JSON.stringify({ request_id: requestId, source, duration, fallback: true })]
    );
    
  } catch (e) {
    console.error('[浇水完成] 处理错误:', e.message);
  }
}

// 处理AI浇水判断请求
async function handleWateringRequest(pool, deviceCode, payload) {
  let currentWeatherData = null;
  
  try {
    let requestData = {};
    try {
      requestData = JSON.parse(payload || '{}');
    } catch (parseErr) {
      console.error('[浇水判断] 请求JSON解析失败:', parseErr.message, 'payload=', String(payload).slice(0, 120));
      return;
    }
    const requestDuration = Math.max(1, Math.min(600, parseInt(requestData.duration, 10) || 30));
    const requestId = requestData.request_id || null;
    console.log(`[浇水判断] 设备 ${deviceCode} 请求, 时长=${requestDuration}秒, request_id=${requestId}`);
    
    const [devices] = await pool.query(
      'SELECT id, user_id, device_name, device_code, settings, sensor_data FROM devices WHERE device_code = ?',
      [deviceCode]
    );
    
    if (!devices.length) {
      console.log(`[浇水判断] 设备 ${deviceCode} 不存在或未绑定`);
      const reason = '设备未绑定，请先在平台添加设备后再使用AI浇水';
      const [pendingRows] = await pool.query('SELECT id FROM esp32_pending_devices WHERE device_code = ? LIMIT 1', [deviceCode]);
      if (pendingRows.length) {
        console.log(`[浇水判断] 设备 ${deviceCode} 当前在待绑定列表，pending_id=${pendingRows[0].id}`);
      }
      const reply = { water: false, reason };
      if (requestId) reply.request_id = requestId;
      publishToDevice(deviceCode, reply);
      return;
    }
    
    const device = devices[0];
    const userId = device.user_id;
    const settings = typeof device.settings === 'string' ? JSON.parse(device.settings) : (device.settings || {});
    device.sensor_data = typeof device.sensor_data === 'string' ? JSON.parse(device.sensor_data) : (device.sensor_data || {});
    const [[owner]] = await pool.query('SELECT role, vip_expire FROM users WHERE id = ? AND status = "active"', [userId]);
    const ownerIsVip = !!(owner && (owner.role === 'admin' || (owner.vip_expire && new Date(owner.vip_expire) > new Date())));
    
    // 1. 获取天气数据
    let weatherInfo = '天气数据获取失败';
    let weatherToday = '--', weatherTomorrow = '--', weatherDayAfter = '--';
    const weatherSource = settings.weather_api || 'official';
    const location = settings.location_name || '';
    
    if (!location) {
      weatherInfo = '设备未设置所在地，无法获取天气';
    } else {
      let apiKey = null;
      if (weatherSource === 'official') {
        if (!ownerIsVip) {
          weatherInfo = 'VIP已过期，官方天气不可用';
        } else {
          const [adminWeather] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "qweather_api_key"');
          apiKey = adminWeather[0]?.setting_value;
        }
      } else {
        const [userWeather] = await pool.query(
          'SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = "qweather_api_key"',
          [userId]
        );
        apiKey = userWeather[0]?.setting_value;
      }
      
      if (apiKey) {
        try {
          const geoRes = await fetch('https://geoapi.qweather.com/v2/city/lookup?location=' + encodeURIComponent(location) + '&key=' + apiKey);
          const geoData = await geoRes.json();
          if (geoData.code === '200' && geoData.location && geoData.location.length) {
            const cityId = geoData.location[0].id;
            
            const weatherRes = await fetch('https://devapi.qweather.com/v7/weather/now?location=' + cityId + '&key=' + apiKey);
            const weatherData = await weatherRes.json();
            
            const forecastRes = await fetch('https://devapi.qweather.com/v7/weather/3d?location=' + cityId + '&key=' + apiKey);
            const forecastData = await forecastRes.json();
            
            currentWeatherData = weatherData;
            
            if (weatherData.code === '200') {
              const now = weatherData.now;
              weatherInfo = now.text + '，温度' + now.temp + '℃，湿度' + now.humidity + '%，风向' + now.windDir + '，风力' + now.windScale + '级';
            }
            
            if (forecastData.code === '200' && forecastData.daily) {
              const days = forecastData.daily;
              const dayNames = ['今天', '明天', '后天'];
              
              days.forEach((day, i) => {
                if (i < 3) {
                  const dayText = day.textDay === day.textNight ? day.textDay : day.textDay + '转' + day.textNight;
                  let info = dayNames[i] + '（' + day.fxDate + '）：' + dayText;
                  info += '，' + day.tempMin + '°/' + day.tempMax + '°';
                  info += '，湿度' + day.humidity + '%';
                  if (day.precip && parseFloat(day.precip) > 0) {
                    info += '，降水' + day.precip + 'mm';
                  }
                  info += '，' + day.windDirDay + day.windScaleDay + '级';
                  if (i === 0) weatherToday = info;
                  else if (i === 1) weatherTomorrow = info;
                  else if (i === 2) weatherDayAfter = info;
                }
              });
            }
          }
        } catch (e) {
          console.error('[天气API] 错误:', e.message);
        }
      } else if (!apiKey && weatherInfo !== 'VIP已过期，官方天气不可用') {
        weatherInfo = '未配置天气API Key';
      }
    }
    
    // 2. 获取大模型配置
    let llmConfig = null;
    const llmSource = settings.llm_api || 'official';
    
    if (llmSource === 'official') {
      if (ownerIsVip) {
        const [adminLlm] = await pool.query('SELECT * FROM llm_configs WHERE user_id IS NULL AND is_default = 1 LIMIT 1');
        if (adminLlm.length) llmConfig = adminLlm[0];
      }
    } else {
      const modelId = llmSource.replace('custom_', '');
      const [userLlm] = await pool.query('SELECT * FROM llm_configs WHERE id = ? AND user_id = ?', [modelId, userId]);
      if (userLlm.length) llmConfig = userLlm[0];
    }
    
    if (!llmConfig) {
      const noLlmReason = (llmSource === 'official' && !ownerIsVip)
        ? 'VIP已过期，官方大模型不可用，请续费VIP或改用自定义模型'
        : '未配置大模型';
      await pool.query(
        'INSERT INTO device_logs (device_id, log_type, content, result) VALUES (?, ?, ?, ?)',
        [device.id, 'watering_judge', noLlmReason, JSON.stringify({ error: noLlmReason, request_id: requestId })]
      );
      const reply = {
        water: false,
        reason: noLlmReason
      };
      if (requestId) reply.request_id = requestId;
      publishToDevice(deviceCode, reply);
      return;
    }
    
    // 3. 编辑提示词
    const userPrompt = settings.prompt || '';
    
    let prompt;
    if (userPrompt) {
      prompt = userPrompt
        .replace(/\{\{device_name\}\}/g, device.device_name || '未命名')
        .replace(/\{\{device_code\}\}/g, device.device_code || '--')
        .replace(/\{\{device_type\}\}/g, device.device_type === 'controller' ? '控制器' : '传感器')
        .replace(/\{\{location\}\}/g, settings.location_name || '未设置')
        .replace(/\{\{time\}\}/g, new Date().toLocaleString('zh-CN'))
        .replace(/\{\{date\}\}/g, new Date().toLocaleDateString('zh-CN'))
        .replace(/\{\{weather_current\}\}/g, weatherInfo)
        .replace(/\{\{weather_today\}\}/g, weatherToday)
        .replace(/\{\{weather_tomorrow\}\}/g, weatherTomorrow)
        .replace(/\{\{weather_day_after\}\}/g, weatherDayAfter)
        .replace(/\{\{weather\}\}/g, weatherInfo)
        .replace(/\{\{humidity\}\}/g, currentWeatherData?.now?.humidity ? currentWeatherData.now.humidity + '%' : '--')
        .replace(/\{\{wind\}\}/g, currentWeatherData?.now ? currentWeatherData.now.windDir + currentWeatherData.now.windScale + '级' : '--')
        .replace(/\{\{soil_moisture\}\}/g, device.sensor_data?.soil_moisture !== undefined ? device.sensor_data.soil_moisture + '%' : '--')
        .replace(/\{\{air_humidity\}\}/g, device.sensor_data?.air_humidity !== undefined ? device.sensor_data.air_humidity + '%' : '--')
        .replace(/\{\{temperature\}\}/g, device.sensor_data?.temperature !== undefined ? device.sensor_data.temperature + '℃' : (currentWeatherData?.now?.temp ? currentWeatherData.now.temp + '℃' : '--'))
        .replace(/\{\{light\}\}/g, device.sensor_data?.light !== undefined ? device.sensor_data.light + 'lux' : '--');

      // 替换外部传感器变量 {{sensor_CODE_field}}
      const sensorVarPattern = /\{\{sensor_(\w+)_(soil_moisture|air_humidity|temperature|light)\}\}/g;
      const sensorVars = [...new Set([...prompt.matchAll(sensorVarPattern)].map(m => m[1]))];
      if (sensorVars.length > 0) {
        const [sensorRows] = await pool.query(
          'SELECT device_code, sensor_data FROM devices WHERE user_id = ? AND device_type = "sensor" AND device_code IN (?)',
          [device.user_id, sensorVars]
        );
        const sensorMap = {};
        sensorRows.forEach(r => {
          sensorMap[r.device_code] = typeof r.sensor_data === 'string' ? JSON.parse(r.sensor_data) : (r.sensor_data || {});
        });
        const fieldUnits = { soil_moisture: '%', air_humidity: '%', temperature: '℃', light: 'lux' };
        prompt = prompt.replace(sensorVarPattern, (_, code, field) => {
          const val = sensorMap[code]?.[field];
          return val !== undefined ? val + (fieldUnits[field] || '') : '--';
        });
      }
    } else {
      prompt = '你是一个智能浇花助手。请根据以下信息判断是否需要浇水：\n\n【设备信息】\n设备：' + device.device_name + '（' + device.device_code + '）\n位置：' + (settings.location_name || '未设置') + '\n时间：' + new Date().toLocaleString('zh-CN') + '\n\n【当前天气】\n' + weatherInfo + '\n\n【今天天气】\n' + weatherToday + '\n\n【明天天气】\n' + weatherTomorrow + '\n\n【后天天气】\n' + weatherDayAfter + '\n\n请综合分析以上信息，判断是否需要浇水，并返回JSON格式：\n{"should_water": true或false, "reason": "简短原因（20字以内）"}';
    }
    
    // 4. 调用大模型API
    let aiResult = null;
    let aiRawResponse = '';
    let aiError = '';
    try {
      // 与 /api/llm-test 保持一致：允许用户填写 base URL，自动补 /chat/completions
      let llmUrl = (llmConfig.api_url || '').replace(/\/+$/, '');
      if (!llmUrl.endsWith('/chat/completions')) llmUrl += '/chat/completions';

      const llmRes = await fetch(llmUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + llmConfig.api_key
        },
        body: JSON.stringify({
          model: llmConfig.model_id,
          messages: [
            { role: 'system', content: '你是一个智能浇花助手，只返回JSON格式结果。只输出 {"should_water":true或false,"reason":"简短原因"}，不要输出Markdown。' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.3
        }),
        signal: AbortSignal.timeout(30000)
      });

      const rawText = await llmRes.text();
      let llmData = null;
      try {
        llmData = rawText ? JSON.parse(rawText) : null;
      } catch (jsonErr) {
        aiError = '大模型响应不是JSON: HTTP ' + llmRes.status;
        aiRawResponse = rawText.slice(0, 2000);
        console.error('[AI] 响应JSON解析失败:', jsonErr.message, 'status=', llmRes.status, 'raw=', rawText.slice(0, 300));
      }

      if (llmData) {
        if (!llmRes.ok || llmData.error) {
          const errMsg = llmData.error?.message || llmData.error || ('HTTP ' + llmRes.status);
          aiError = typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg);
          aiRawResponse = JSON.stringify(llmData).slice(0, 2000);
          console.error('[AI] 调用返回错误:', aiError);
        } else {
          let content = '';
          if (llmData.choices && llmData.choices.length > 0) {
            const c = llmData.choices[0];
            content = c.message?.content || c.text || c.content || '';
          }
          if (!content && llmData.content) content = llmData.content;
          if (!content && llmData.result) content = llmData.result;
          aiRawResponse = content || JSON.stringify(llmData).slice(0, 2000);

          try {
            const jsonMatch = aiRawResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              aiResult = JSON.parse(jsonMatch[0]);
            } else {
              aiError = '大模型未返回JSON判断结果';
              console.error('[AI] 未找到JSON结果, response=', aiRawResponse.slice(0, 300));
            }
          } catch (e) {
            aiError = 'AI结果JSON解析失败: ' + e.message;
            console.error('[AI] 解析结果失败:', e.message, 'response=', aiRawResponse.slice(0, 300));
          }
        }
      }
    } catch (e) {
      aiError = e.message;
      console.error('[AI] 调用失败:', e.message);
    }
    
    // 5. 保存AI判断日志（包含 request_id）
    const logContent = aiResult
      ? '浇水判断：' + (aiResult.should_water ? '需要浇水' : '无需浇水') + '，原因：' + aiResult.reason
      : 'AI判断失败';
    
    await pool.query(
      'INSERT INTO device_logs (device_id, log_type, content, prompt_content, ai_response, result) VALUES (?, ?, ?, ?, ?, ?)',
      [device.id, 'watering_judge', logContent, prompt, aiRawResponse, JSON.stringify({ ...(aiResult || { error: aiError || 'AI判断失败' }), request_id: requestId })]
    );
    
    // 6. 发送AI回复：真实控制器会带 request_id，测试页/旧请求可能没有；没有时不下发 null 字段
    if (aiResult && aiResult.should_water) {
      const reply = {
        water: true,
        duration: requestDuration
      };
      if (requestId) reply.request_id = requestId;
      publishToDevice(deviceCode, reply);
      console.log(`[浇水判断] 设备 ${deviceCode} AI判断需要浇水, 时长=${requestDuration}秒`);
    } else {
      const reply = {
        water: false,
        reason: aiResult ? aiResult.reason : 'AI判断失败'
      };
      if (requestId) reply.request_id = requestId;
      publishToDevice(deviceCode, reply);
      console.log(`[浇水判断] 设备 ${deviceCode} AI判断无需浇水`);
    }
    
  } catch (e) {
    console.error('[浇水判断] 处理错误:', e.message);
  }
}

module.exports = { initGlobalMqtt, publishToDevice, waitForDeviceAck };
