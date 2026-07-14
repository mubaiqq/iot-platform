const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('API requests are not blocked by fragile reverse-proxy origin checks', () => {
  assert.doesNotMatch(app, /app\.use\(enforceSameOrigin\)/);
  assert.doesNotMatch(app, /请求来源验证失败/);
});

test('authenticated API writes rely on auth and same-site cookies', () => {
  const start = app.indexOf('function createSessionCookieOptions');
  const cookieArea = app.slice(start, app.indexOf('function createSessionCookie()', start));
  assert.match(cookieArea, /sameSite:\s*'lax'/);
});
