-- IoT Platform initial schema/data for Docker deployments
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS users (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  email VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  password VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  vip_expire DATETIME DEFAULT NULL,
  role ENUM('user','admin') COLLATE utf8mb4_unicode_ci DEFAULT 'user',
  status ENUM('active','banned') COLLATE utf8mb4_unicode_ci DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME DEFAULT NULL,
  login_token VARCHAR(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY username (username),
  UNIQUE KEY email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  id INT NOT NULL AUTO_INCREMENT,
  setting_key VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  setting_value TEXT COLLATE utf8mb4_unicode_ci,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY setting_key (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_settings (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  setting_key VARCHAR(100) NOT NULL,
  setting_value TEXT,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_key (user_id, setting_key),
  KEY idx_user (user_id),
  CONSTRAINT user_settings_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_tokens (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  token_hash VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_token (token_hash),
  KEY idx_user (user_id),
  CONSTRAINT login_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llm_configs (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT DEFAULT NULL COMMENT 'NULL=官方全局, 非NULL=用户自定义',
  name VARCHAR(100) NOT NULL COMMENT '自定义名称',
  api_url VARCHAR(500) NOT NULL COMMENT 'API地址',
  api_key VARCHAR(500) NOT NULL COMMENT 'API Key',
  model_id VARCHAR(200) NOT NULL COMMENT '模型ID',
  is_default TINYINT(1) DEFAULT 0 COMMENT '是否默认',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user (user_id),
  CONSTRAINT llm_configs_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS devices (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  device_code VARCHAR(50) NOT NULL,
  device_name VARCHAR(100) NOT NULL DEFAULT '',
  device_type ENUM('controller','sensor') NOT NULL,
  device_model VARCHAR(50) NOT NULL DEFAULT '',
  status ENUM('online','offline') NOT NULL DEFAULT 'offline',
  last_seen DATETIME DEFAULT NULL,
  last_heartbeat DATETIME DEFAULT NULL,
  settings JSON DEFAULT NULL,
  sensor_data JSON DEFAULT NULL,
  firmware_version VARCHAR(30) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_code (device_code),
  KEY idx_user (user_id),
  CONSTRAINT devices_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sensor_data_history (
  id BIGINT NOT NULL AUTO_INCREMENT,
  device_id INT NOT NULL,
  sensor_data JSON NOT NULL,
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_device_time (device_id, recorded_at),
  KEY idx_recorded_at (recorded_at),
  CONSTRAINT sensor_history_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS firmware_versions (
  id INT NOT NULL AUTO_INCREMENT,
  target_type ENUM('controller','sensor') NOT NULL,
  version VARCHAR(30) NOT NULL,
  release_notes TEXT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  file_size BIGINT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  download_token CHAR(64) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_target_version (target_type, version),
  UNIQUE KEY uk_download_token (download_token),
  KEY idx_target_created (target_type, created_at),
  CONSTRAINT firmware_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device_commands (
  id INT NOT NULL AUTO_INCREMENT,
  device_id INT NOT NULL,
  command_type VARCHAR(50) NOT NULL,
  command_data JSON DEFAULT NULL,
  status ENUM('pending','sent','done') DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY device_id (device_id),
  CONSTRAINT device_commands_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device_logs (
  id INT NOT NULL AUTO_INCREMENT,
  device_id INT NOT NULL,
  log_type VARCHAR(50) NOT NULL,
  content TEXT,
  prompt_content TEXT,
  ai_response TEXT,
  result JSON DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  executed_at DATETIME DEFAULT NULL COMMENT '执行完成时间',
  executed_duration INT DEFAULT NULL COMMENT '执行时长(秒)',
  PRIMARY KEY (id),
  KEY device_id (device_id),
  CONSTRAINT device_logs_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS esp32_pending_devices (
  id INT NOT NULL AUTO_INCREMENT,
  device_code VARCHAR(20) NOT NULL,
  username VARCHAR(50) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_username (username),
  KEY idx_device_code (device_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

INSERT INTO settings (setting_key, setting_value) VALUES
('register_open', '1'),
('register_captcha', '1'),
('register_vip_days', '3'),
('mqtt_broker', 'mqtt.mcoud.cn'),
('mqtt_port', '1883'),
('mqtt_protocol', 'mqtt'),
('mqtt_username', ''),
('mqtt_password', ''),
('mqtt_client_id', 'mubaiyun_iot'),
('mqtt_keepalive', '60'),
('mqtt_clean_session', '1'),
('mqtt_qos', '0'),
('mqtt_ws_path', '/mqtt'),
('mqtt_ws_port', '8083'),
('qweather_api_key', '')
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);
