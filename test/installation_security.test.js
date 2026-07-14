const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function sourceFiles(dir = root) {
  const ignored = new Set(['.git', 'node_modules', 'data', 'backups']);
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(?:js|json|html|md|sql|sh|ya?ml|env|txt)$/i.test(entry.name)) files.push(full);
  }
  return files;
}

test('repository contains no published legacy administrator credential', () => {
  const legacyCredential = ['admin', '123'].join('');
  for (const file of sourceFiles()) {
    assert.equal(fs.readFileSync(file, 'utf8').includes(legacyCredential), false,
      `${path.relative(root, file)} contains the published legacy credential`);
  }
});

test('fresh SQL initialization creates schema but no reusable administrator account', () => {
  const schema = read('docker/mysql/init/001-schema.sql');
  assert.doesNotMatch(schema, /INSERT\s+INTO\s+users/i);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS users/i);
});

test('installer requires a strong administrator password and stores only its bcrypt hash', () => {
  const app = read('app.js');
  const page = read('public/install.html');
  assert.match(page, /name="admin_password"[^>]*type="password"/);
  assert.match(page, /name="admin_password_confirm"[^>]*type="password"/);
  assert.match(app, /validateAdminPassword\(adminPassword\)/);
  const installFunction = app.slice(app.indexOf('async function installDatabase'), app.indexOf('function validateAdminPassword'));
  assert.ok(installFunction.indexOf('validateAdminPassword(cfg.adminPassword)') < installFunction.indexOf('mysql.createConnection'), 'password must be validated before database side effects');
  assert.match(app, /bcrypt\.hash\(adminPassword,\s*1[02]\)/);
  assert.match(app, /INSERT INTO users[^;]+adminPasswordHash/s);
  const installRoute = app.slice(app.indexOf("app.post('/api/install'"), app.indexOf('// ========== Captcha API'));
  assert.doesNotMatch(installRoute, /error:\s*e\.message/, 'installer must not return raw database errors');
  assert.match(installRoute, /安装失败，请检查数据库配置后重试/);
});

test('Docker deployment generates and passes an administrator password without changing existing data', () => {
  const compose = read('docker-compose.yml');
  const deploy = read('scripts/deploy.sh');
  const app = read('app.js');
  assert.match(compose, /ADMIN_PASSWORD:\s*\$\{ADMIN_PASSWORD:-\}/);
  assert.match(compose, /MYSQL_ROOT_PASSWORD:\s*\$\{MYSQL_ROOT_PASSWORD:\?/);
  assert.match(compose, /DB_PASSWORD:\s*\$\{DB_PASSWORD:\?/);
  assert.match(deploy, /ADMIN_PASSWORD=.*openssl rand/);
  assert.match(app, /COUNT\(\*\).*FROM users/s);
  assert.match(app, /if \(Number\([^)]*count[^)]*\) > 0\) return false/);
});
