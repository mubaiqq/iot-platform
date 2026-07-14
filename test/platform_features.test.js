const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('schema keeps sensor history for 30-day analytics', () => {
  const sql = read('docker/mysql/init/001-schema.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sensor_data_history/i);
  assert.match(sql, /recorded_at DATETIME/i);
  assert.match(sql, /KEY idx_device_time \(device_id, recorded_at\)/i);
});

test('both heartbeat paths persist sensor history', () => {
  const mqtt = read('mqtt_handler.js');
  const app = read('app.js');
  assert.match(mqtt, /INSERT INTO sensor_data_history/);
  assert.match(app, /INSERT INTO sensor_data_history/);
  assert.match(app, /INTERVAL 30 DAY/);
});

test('data and firmware APIs exist', () => {
  const app = read('app.js');
  for (const route of ['/api/data/realtime', '/api/data/history', '/api/firmware/versions', '/api/admin/firmware', '/api/devices/:id/ota']) {
    assert.ok(app.includes(route), `missing route ${route}`);
  }
  assert.match(app, /SUBSTRING_INDEX\(version/, 'firmware history should use semantic version ordering');
});

test('startup migration makes one-click updates database-safe', () => {
  const app = read('app.js');
  assert.match(app, /await ensureCommercialSchema\(\)/, 'startup does not run schema migration');
  assert.match(app, /CREATE TABLE IF NOT EXISTS sensor_data_history/, 'history table migration missing');
  assert.match(app, /CREATE TABLE IF NOT EXISTS firmware_versions/, 'firmware table migration missing');
  assert.match(app, /SHOW COLUMNS FROM devices LIKE 'firmware_version'/, 'devices firmware column migration missing');
  assert.match(app, /device_type === 'controller' && heartbeatAge/, 'offline or sleeping devices must keep OTA pending');
  assert.equal((app.match(/ORDER BY recorded_at DESC,id DESC LIMIT 5000\) recent ORDER BY recorded_at ASC,id ASC/g) || []).length, 2, 'history APIs must return the newest 5000 points in chronological order');
  assert.match(app, /otaCommand\.ota_signature = signOTACommand\(otaCommand\)/, 'server must sign OTA commands');
  assert.match(app, /if \(fs\.existsSync\(finalPath\)\) throw Object\.assign/, 'duplicate uploads must not overwrite existing firmware');
  assert.match(app, /if \(ownsFinalPath && finalPath && fs\.existsSync\(finalPath\)\) fs\.unlinkSync\(finalPath\)/, 'failed firmware inserts must remove only request-owned files');
  assert.match(read('scripts/update.sh'), /docker compose up -d --build/, 'Docker updater does not restart migrated app');
  assert.match(read('scripts/update-host.sh'), /pm2 (restart|start)/, 'host updater does not restart migrated app');
});

test('firmware shuts down provisioning AP and supports OTA', () => {
  for (const file of ['public/esp32_firmware.ino', 'public/esp32_sensor_firmware.ino']) {
    const src = read(file);
    assert.match(src, /void stopAP\(\)/, `${file} missing stopAP`);
    assert.match(src, /WiFi\.softAPdisconnect\(true\)/, `${file} does not disable AP`);
    assert.match(src, /firmware_version/, `${file} heartbeat missing firmware version`);
    assert.match(src, /command.*ota|"ota"/, `${file} missing OTA command`);
    assert.match(src, /Update\.begin/, `${file} missing Update OTA implementation`);
    assert.match(src, /verifyOTACommandSignature/, `${file} does not authenticate OTA commands`);
    assert.match(src, /OTA_SIGNING_PUBLIC_KEY/, `${file} missing embedded OTA public key`);
    assert.match(src, /!isNewerFirmwareVersion\(version\)/, `${file} permits signed downgrade replay`);
    assert.match(src, /v1\.2\.3/, `${file} version not updated`);
  }
});

test('navigation and pages expose requested commercial UI', () => {
  const user = read('public/user/index.html');
  const admin = read('public/admin/index.html');
  const detail = read('public/user/pages/device_detail.html');
  assert.doesNotMatch(user, /data-page="my_devices"/);
  assert.match(admin, /data-page="firmware"/);
  assert.match(detail, /openAbout/);
  assert.match(read('public/user/pages/data_realtime.html'), /\/api\/data\/realtime/);
  assert.match(read('public/user/pages/data_history.html'), /\/api\/data\/history/);
});
