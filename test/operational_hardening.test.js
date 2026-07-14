const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('legacy framework JavaScript remains syntactically deployable', () => {
  const source = read('framework/assets/admin.js');
  assert.doesNotMatch(source, /^\s*\d+\|/m, 'legacy JavaScript contains copied line-number prefixes');
});

test('container runs the application as a non-root user', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^USER\s+node\s*$/m, 'Dockerfile must drop root privileges');
  assert.match(read('docker-compose.yml'), /user:\s*"\$\{APP_UID:-1000\}:\$\{APP_GID:-1000\}"/);
  assert.match(read('scripts/deploy.sh'), /chown -R .*data/);
  assert.match(read('scripts/update.sh'), /chown -R .*data/);
});

test('host updater verifies tests before restarting the service', () => {
  const script = read('scripts/update-host.sh');
  assert.match(script, /npm test/, 'host updater must run regression tests before restart');
});
