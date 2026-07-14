const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('public authentication routes are not blocked by proxy origin mismatches', () => {
  const paths = app.slice(app.indexOf('const DEVICE_HTTP_PATHS'), app.indexOf('function firstForwardedHeader'));
  for (const route of ['/api/login', '/api/register', '/api/captcha']) assert.match(paths, new RegExp(route.replaceAll('/', '\\/')));
});

test('same-origin protection compares browser Origin with forwarded public origin behind reverse proxies', () => {
  const helperStart = app.indexOf('function firstForwardedHeader');
  const block = app.slice(helperStart, app.indexOf('app.use(enforceSameOrigin)'));
  assert.match(block, /X-Forwarded-Proto/i);
  assert.match(block, /X-Forwarded-Host/i);
  assert.match(block, /split\(','\)/);
  assert.doesNotMatch(block, /new URL\(origin\)\.origin !== `\$\{req\.protocol\}:\/\/\$\{req\.get\('host'\)\}`/);
});
