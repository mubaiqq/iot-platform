const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('public settings endpoint exposes only the registration allowlist', () => {
  const app = read('app.js');
  assert.match(app, /PUBLIC_SETTING_KEYS\s*=\s*new Set\(\['register_open',\s*'register_captcha'\]\)/);
  assert.match(app, /if \(!PUBLIC_SETTING_KEYS\.has\(req\.params\.key\)\) return res\.status\(404\)/);
});

test('device command, log and pending-device mutations enforce ownership with explicit admin bypass', () => {
  const app = read('app.js');
  assert.match(app, /function deviceOwnerClause\(user, alias = 'd'\)/);
  assert.match(app, /FROM device_commands c JOIN devices d ON d\.id = c\.device_id/);
  assert.match(app, /UPDATE device_commands c JOIN devices d ON d\.id = c\.device_id/);
  const logRoute = app.slice(app.indexOf("app.post('/api/device-logs'"), app.indexOf('// 手动浇水API'));
  assert.match(logRoute, /deviceOwnerClause\(req\.user\)/);
  assert.match(logRoute, /INSERT INTO device_logs/);
  assert.match(app, /DELETE p FROM esp32_pending_devices p LEFT JOIN devices d ON d\.device_code = p\.device_code/);
  assert.match(app, /p\.username = \? OR d\.user_id = \? OR \? = 'admin'/);
});

test('MQTT test sessions are random, user-bound, topic-scoped and never retained', () => {
  const app = read('app.js');
  assert.match(app, /crypto\.randomBytes\(24\)\.toString\('hex'\)/);
  assert.match(app, /const session = \{ client, sseListeners, userId: req\.user\.id,/);
  assert.match(app, /function getOwnedMqttSession\(sessionId, userId\)/);
  assert.match(app, /topic\.includes\('\#'\) \|\| topic\.includes\('\+'\)/);
  assert.match(app, /SELECT id FROM devices WHERE user_id = \? AND device_code = \?/);
  assert.match(app, /if \(retain\) return res\.status\(400\)/);
  assert.match(app, /retain: false/);
});

test('account security revokes persisted tokens and provides logout-all', () => {
  const app = read('app.js');
  assert.ok(app.includes("app.post('/api/account/logout-all', requireAuth"));
  assert.match(app, /DELETE FROM login_tokens WHERE user_id = \?/);
  const usernameRoute = app.slice(app.indexOf("app.put('/api/account/username'"), app.indexOf("app.put('/api/account/password'"));
  const passwordRoute = app.slice(app.indexOf("app.put('/api/account/password'"), app.indexOf('// Multi-device login setting'));
  assert.match(usernameRoute, /DELETE FROM login_tokens WHERE user_id = \?/);
  assert.match(passwordRoute, /DELETE FROM login_tokens WHERE user_id = \?/);
});

test('baseline HTTP hardening adds limits, headers, same-origin checks and auth throttling', () => {
  const app = read('app.js');
  assert.match(app, /app\.disable\('x-powered-by'\)/);
  assert.match(app, /express\.json\(\{ limit: '256kb' \}\)/);
  assert.match(app, /express\.urlencoded\(\{ extended: true, limit: '64kb' \}\)/);
  for (const header of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']) assert.ok(app.includes(header));
  assert.match(app, /function enforceSameOrigin\(req, res, next\)/);
  assert.match(app, /req\.method === 'GET' \|\| req\.method === 'HEAD' \|\| req\.method === 'OPTIONS'/);
  assert.match(app, /DEVICE_HTTP_PATHS/);
  assert.match(app, /function authRateLimit\(/);
  assert.match(app, /app\.post\('\/api\/login', authRateLimit/);
  assert.match(app, /app\.post\('\/api\/register', authRateLimit/);
  assert.match(app, /app\.get\('\/api\/captcha', authRateLimit/);
});

test('LLM config listing masks API keys and updates preserve omitted keys', () => {
  const app = read('app.js');
  const adminList = app.slice(app.indexOf("app.get('/api/admin/llm-configs'"), app.indexOf('// User: get user'));
  const userList = app.slice(app.indexOf("app.get('/api/user/llm-configs'"), app.indexOf('// Admin: add global config'));
  assert.doesNotMatch(adminList, /SELECT \*/);
  assert.doesNotMatch(userList, /SELECT \*/);
  assert.match(adminList, /has_api_key/);
  assert.match(userList, /has_api_key/);
  const updates = app.slice(app.indexOf('// Admin: update global config'), app.indexOf('// Admin: set default'));
  assert.match(updates, /const sql = api_key/);
  assert.match(updates, /const params = api_key/g);
  assert.match(updates, /: 'UPDATE llm_configs SET name=\?, api_url=\?, model_id=\?/);
});

test('saved weather and LLM credentials can be tested without returning secrets to the browser', () => {
  const app = read('app.js');
  assert.match(app, /app\.get\('\/api\/admin\/weather-key\/status', requireAuth, requireAdmin/);
  assert.match(app, /app\.post\('\/api\/admin\/llm-configs\/:id\/test', requireAuth, requireAdmin/);
  assert.match(app, /app\.post\('\/api\/user\/llm-configs\/:id\/test', requireAuth/);
  for (const file of ['public/admin/pages/llm_settings.html', 'public/user/pages/llm_custom.html']) {
    const src = read(file);
    assert.match(src, /fetch\(`\$\{API_BASE\}\/\$\{id\}\/test`/);
    assert.doesNotMatch(src, /cfg\.api_key/);
  }
  const weather = read('public/admin/pages/weather_settings.html');
  assert.match(weather, /\/api\/admin\/weather-key\/status/);
  assert.doesNotMatch(weather, /\/api\/settings\/qweather_api_key/);
});

test('LLM requests reject literal local/private targets and disable redirects', () => {
  for (const file of ['app.js', 'mqtt_handler.js']) {
    const src = read(file);
    assert.match(src, /function validateLlmUrl\(/, `${file} missing URL validation`);
    assert.match(src, /dns\.promises\.lookup/, `${file} does not resolve hostnames before requests`);
    assert.match(src, /assertPublicLlmUrl/, `${file} does not reject private DNS answers`);
    assert.match(src, /127\.0\.0\.1|0x7f000001/, `${file} missing loopback denial`);
    assert.match(src, /redirect: 'manual'/, `${file} permits redirects`);
  }
});

test('manual watering awaits broker acceptance and reports publish failure', () => {
  const app = read('app.js');
  const route = app.slice(app.indexOf("app.post('/api/manual-watering'"), app.indexOf('// 浇水判断API'));
  assert.match(route, /const sent = await publishToDevice/);
  assert.match(route, /if \(!sent\) return res\.status\(503\)/);
});
